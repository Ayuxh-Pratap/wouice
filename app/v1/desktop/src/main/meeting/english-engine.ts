import { estimateTokens, MEETING_ENGLISH_SYSTEM, type LlmClient } from '@wouice/llm'
import {
  batchLines,
  batchUsable,
  parseEnglish,
  renderBatch,
  type Line,
  type Rendered,
} from './translate.js'

/**
 * Render a stored transcript into English, alongside what was said.
 *
 * WHY THIS EXISTS AT ALL. The project's own first principle is that the speech
 * model is a commodity and the language model is the product: Hindi is handled
 * by one instruction in a prompt rather than by a translation component.
 * Dictation has always worked that way. Meetings did not - they stored raw
 * recognition output - and a real meeting made the consequence obvious: a
 * transcript of "स्थमाल" and "रंबाली" that is technically what was heard and
 * useless to read, and notes built on top of it that never had a chance.
 *
 * IT RUNS AFTER THE MEETING, so there is no latency budget and no contention
 * with live transcription for the card. That is what lets it be careful:
 * batched for context, checked for coverage, and abandoned rather than half
 * applied.
 */

export interface EnglishProgress {
  batch: number
  batches: number
  lines: number
}

export interface EnglishRun {
  rendered: Rendered[]
  /** Lines the model did not render. They keep their original text. */
  missed: number
  batches: number
  failedBatches: number
  ms: number
}

export interface EnglishInput {
  lines: readonly Line[]
  /**
   * The person's own notes, used only as a spelling reference.
   *
   * A scribbled "priya = decision maker" or "Runbali" is the difference between
   * a name rendered correctly and one rendered phonetically. Handed over as
   * reference, never as content: the prompt says so, and the parser only ever
   * accepts lines numbered from the transcript.
   */
  context?: string
  /** The people in the meeting, for spelling their names. Reference, like `context`. */
  people?: readonly string[]
  /** Names and words your meetings use, from settings. Reference, like `context`. See `glossaryTerms`. */
  glossary?: readonly string[]
  /**
   * How many lines to have in flight at once. One unless the server was started
   * with that many slots: more requests than slots only queue inside it.
   */
  concurrency?: number
  onProgress?(progress: EnglishProgress): void
  signal?: AbortSignal
}

export class EnglishUnavailable extends Error {}

const STALL_MS = 20_000

export class MeetingEnglishEngine {
  /** Why the last call failed, so "could not render any of it" can say why. */
  private lastFailure: string | null = null

  constructor(private readonly llm: () => LlmClient) {}

  async render(input: EnglishInput): Promise<EnglishRun> {
    const started = Date.now()
    const batches = batchLines(input.lines)
    if (batches.length === 0) {
      throw new EnglishUnavailable('there is no transcript to render')
    }

    let failedBatches = 0
    let renderedLines = 0
    this.lastFailure = null

    // The context each request is shown with is what was SAID just before it,
    // never what came back for it. So no request waits on another's answer,
    // and with more than one slot on the server they can run side by side.
    const said = batches.flat()
    let offset = 0
    const jobs = batches.map((batch) => {
      const before = said.slice(Math.max(0, offset - CONTEXT_LINES), offset)
      offset += batch.length
      return { batch, before }
    })

    // Filed by position, and read back in order, so the answer to a line that
    // finished early still lands on that line and nowhere else.
    const results: (Rendered[] | null)[] = jobs.map(() => null)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        input.signal?.throwIfAborted()
        const index = next++
        const { batch, before } = jobs[index]!
        input.onProgress?.({ batch: index + 1, batches: jobs.length, lines: renderedLines })

        // Numbered from 1 in each request, and put back to the stored ids here:
        // copying a long id back, the model wrote "[900043]" as "[900343]", and
        // a line rendered perfectly well stayed in Hindi.
        const numbered = batch.map((line, i) => ({ ...line, id: i + 1 }))
        const answer = await this.tryComplete(
          withContext(renderBatch(numbered, before), input.context, input.people, input.glossary),
          input.signal
        )
        if (answer === null) {
          failedBatches++
          continue
        }

        const parsed = parseEnglish(answer, numbered).map((r) => ({ id: batch[r.id - 1]!.id, textEn: r.textEn }))
        // A batch that mostly did not come back is a batch where the model lost
        // the format. Keeping the few lines it did return would leave the
        // transcript half in English and half not, with nothing saying so.
        if (!batchUsable(batch, parsed)) {
          failedBatches++
          continue
        }
        results[index] = parsed
        renderedLines += parsed.length
      }
    }
    const width = Math.max(1, Math.min(input.concurrency ?? 1, jobs.length))
    await Promise.all(Array.from({ length: width }, worker))
    const rendered = results.flatMap((r) => r ?? [])

    if (rendered.length === 0) {
      throw new EnglishUnavailable(
        'the model could not render any of this transcript' +
          (this.lastFailure ? ` (${this.lastFailure})` : '')
      )
    }

    return {
      rendered,
      missed: input.lines.filter((l) => l.text.trim()).length - rendered.length,
      batches: batches.length,
      failedBatches,
      ms: Date.now() - started,
    }
  }

  /** @returns the model's text, or null when the call failed. */
  private async tryComplete(user: string, signal?: AbortSignal): Promise<string | null> {
    const inputTokens = estimateTokens(user)
    try {
      const result = await this.llm().complete({
        system: MEETING_ENGLISH_SYSTEM,
        user,
        // The answer is about as long as the input, plus the numbering.
        maxTokens: Math.max(256, Math.round(inputTokens * 1.6)),
        // The same transcript renders the same way every time, or it is not a
        // record of anything.
        temperature: 0,
        firstTokenTimeoutMs: Math.max(20_000, inputTokens * 40),
        stallTimeoutMs: STALL_MS,
        timeoutMs: Math.max(60_000, inputTokens * 200),
        signal,
      })
      return result.text
    } catch (err) {
      if (signal?.aborted) throw err
      this.lastFailure = err instanceof Error ? err.message : String(err)
      console.warn('[meeting] english pass failed:', this.lastFailure)
      return null
    }
  }
}

/** Cap on the reference text, so a long scratch pad cannot crowd out the batch. */
const MAX_CONTEXT_CHARS = 400
/** The lines said just before, shown with each request as context. */
const CONTEXT_LINES = 2

function withContext(
  batch: string,
  context?: string,
  people?: readonly string[],
  glossary?: readonly string[]
): string {
  const notes = (context ?? '').trim().slice(0, MAX_CONTEXT_CHARS)
  const names = (people ?? []).filter((name) => name.trim())
  const terms = (glossary ?? []).filter((term) => term.trim())
  if (!notes && names.length === 0 && terms.length === 0) return batch
  const parts: string[] = []
  if (names.length > 0) parts.push(`Reference only - the people in this meeting: ${names.join(', ')}.`)
  if (terms.length > 0) {
    parts.push(`Reference only - names and words these meetings use, spelled right: ${terms.join(', ')}.`)
  }
  if (notes) {
    parts.push("Reference only - the person's own notes, for spelling names and terms.", 'Do not render these lines.', notes)
  }
  parts.push('', 'Transcript:', batch)
  return parts.join('\n')
}
