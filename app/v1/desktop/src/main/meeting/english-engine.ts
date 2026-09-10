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

    const rendered: Rendered[] = []
    let failedBatches = 0
    this.lastFailure = null

    for (const [index, batch] of batches.entries()) {
      input.signal?.throwIfAborted()
      input.onProgress?.({ batch: index + 1, batches: batches.length, lines: rendered.length })

      const answer = await this.tryComplete(
        withContext(renderBatch(batch), input.context),
        input.signal
      )
      if (answer === null) {
        failedBatches++
        continue
      }

      const parsed = parseEnglish(answer, batch)
      // A batch that mostly did not come back is a batch where the model lost
      // the format. Keeping the few lines it did return would leave the
      // transcript half in English and half not, with nothing saying so.
      if (!batchUsable(batch, parsed)) {
        failedBatches++
        continue
      }
      rendered.push(...parsed)
    }

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

function withContext(batch: string, context?: string): string {
  const notes = (context ?? '').trim().slice(0, MAX_CONTEXT_CHARS)
  if (!notes) return batch
  return [
    "Reference only - the person's own notes, for spelling names and terms.",
    'Do not render these lines.',
    notes,
    '',
    'Transcript:',
    batch,
  ].join('\n')
}
