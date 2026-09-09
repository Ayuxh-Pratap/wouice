import {
  estimateTokens,
  MEETING_CHUNK_SYSTEM,
  MEETING_NOTES_SYSTEM,
  MEETING_TASKS_SYSTEM,
  type LlmClient,
} from '@wouice/llm'
import {
  allFailed,
  assembleCondensed,
  chunkTranscript,
  parseTasks,
  reduceInput,
  renderChunk,
  CHUNK_TOKEN_BUDGET,
  type Chunk,
  type ChunkOutcome,
  type ParsedTask,
  type TranscriptLine,
} from './notes.js'

/**
 * Notes and tasks for one meeting, after it has ended.
 *
 * NO LATENCY BUDGET, AND THAT CHANGES THE DESIGN. Dictation is a two second
 * interaction and every millisecond is argued over. This runs once, on a
 * transcript nobody is waiting on with their cursor in a text field, so it can
 * afford to be careful: separate calls for prose and for structured data,
 * sequential rather than parallel, and a second reduce pass when the first
 * round of condensing is still too long.
 *
 * ONE REQUEST AT A TIME. `llama-server` runs with a single slot on a 6 GB card,
 * so parallel calls would queue anyway - and running them in sequence keeps
 * progress reportable, which matters when this takes half a minute.
 *
 * A FAILED CHUNK IS A GAP, NOT A FAILED RUN. Only a run where every chunk
 * failed is a failure. Anything else produces notes with the missing stretch
 * marked, because notes that look complete and are not are the worst outcome:
 * you would act on them.
 */

export interface NotesProgress {
  stage: 'condensing' | 'extracting' | 'writing'
  /** 1-based, and 0 for the reduce step, which is not per-chunk. */
  chunk: number
  chunks: number
}

export interface NotesRun {
  notesMd: string
  tasks: ParsedTask[]
  chunks: number
  failedChunks: number
  ms: number
}

export interface NotesInput {
  lines: readonly TranscriptLine[]
  /** What the person typed during the call. May be empty. */
  scratch: string
  startedAt: number
  onProgress?(progress: NotesProgress): void
  signal?: AbortSignal
}

export class NotesUnavailable extends Error {}

/** Generous: this is a backstop for a stopped model, not a prediction. */
const STALL_MS = 20_000
const MAX_CHUNK_TOKENS = 700
const MAX_NOTES_TOKENS = 900
/** How many times condensed output may be condensed again before giving up. */
const MAX_FOLDS = 2

export class MeetingNotesEngine {
  constructor(private readonly llm: () => LlmClient) {}

  async generate(input: NotesInput): Promise<NotesRun> {
    const started = Date.now()
    const chunks = chunkTranscript(input.lines)
    if (chunks.length === 0) {
      throw new NotesUnavailable('there is no transcript to write notes from')
    }

    const outcomes: ChunkOutcome[] = []
    const tasks: ParsedTask[] = []

    for (const [index, chunk] of chunks.entries()) {
      input.signal?.throwIfAborted()
      const rendered = renderChunk(chunk)

      input.onProgress?.({ stage: 'condensing', chunk: index + 1, chunks: chunks.length })
      outcomes.push({ chunk, text: await this.tryComplete(MEETING_CHUNK_SYSTEM, rendered, MAX_CHUNK_TOKENS, input.signal) })

      input.onProgress?.({ stage: 'extracting', chunk: index + 1, chunks: chunks.length })
      const raw = await this.tryComplete(
        MEETING_TASKS_SYSTEM,
        `Meeting date: ${new Date(input.startedAt).toISOString().slice(0, 10)}\n\n${rendered}`,
        MAX_CHUNK_TOKENS,
        input.signal
      )
      if (raw !== null) {
        // Only THIS chunk's lines: the model can only cite, and only quote
        // from, what it was actually shown.
        tasks.push(...parseTasks(raw, chunk.lines))
      }
    }

    if (allFailed(outcomes)) {
      throw new NotesUnavailable('the model could not summarise any part of this meeting')
    }

    let condensed = assembleCondensed(outcomes)
    condensed = await this.fold(condensed, input)

    input.onProgress?.({ stage: 'writing', chunk: 0, chunks: chunks.length })
    const notes = await this.tryComplete(
      MEETING_NOTES_SYSTEM,
      reduceInput(condensed, input.scratch, new Date(input.startedAt)),
      MAX_NOTES_TOKENS,
      input.signal
    )
    if (notes === null || !notes.trim()) {
      throw new NotesUnavailable('the model could not write the final notes')
    }

    return {
      notesMd: notes.trim(),
      tasks,
      chunks: chunks.length,
      failedChunks: outcomes.filter((o) => o.text === null).length,
      ms: Date.now() - started,
    }
  }

  /**
   * Condense the condensed notes, when there are too many of them.
   *
   * A one hour meeting produces roughly five chunks and fits the reduce step
   * comfortably. A three hour one does not, and without this the reduce call
   * would silently lose whatever did not fit - the exact failure map-reduce
   * exists to prevent, reappearing one level up.
   */
  private async fold(condensed: string, input: NotesInput): Promise<string> {
    let text = condensed
    for (let depth = 0; depth < MAX_FOLDS; depth++) {
      if (estimateTokens(text) <= CHUNK_TOKEN_BUDGET) return text
      const parts = splitParagraphs(text, CHUNK_TOKEN_BUDGET)
      const folded: string[] = []
      for (const part of parts) {
        input.signal?.throwIfAborted()
        const result = await this.tryComplete(MEETING_CHUNK_SYSTEM, part, MAX_CHUNK_TOKENS, input.signal)
        folded.push(result ?? part)
      }
      text = folded.join('\n\n')
    }
    // Still too long after folding twice. Truncating is a visible loss and the
    // alternative is an invisible one.
    if (estimateTokens(text) > CHUNK_TOKEN_BUDGET) {
      const keep = Math.floor(CHUNK_TOKEN_BUDGET * 3.6)
      return `${text.slice(0, keep)}\n\n_[the rest could not be condensed enough to fit; read the transcript]_`
    }
    return text
  }

  /**
   * @returns the model's text, or null when the call failed.
   *
   * Failure is a value here rather than an exception because a single failed
   * chunk must not end the run - and a caller that has to remember to catch is
   * a caller that will one day forget.
   */
  private async tryComplete(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal
  ): Promise<string | null> {
    const inputTokens = estimateTokens(user)
    try {
      const result = await this.llm().complete({
        system,
        user,
        maxTokens,
        // The same transcript should produce the same notes. A meeting summary
        // that changes when you regenerate it is one you cannot cite.
        temperature: 0,
        firstTokenTimeoutMs: Math.max(20_000, inputTokens * 40),
        stallTimeoutMs: STALL_MS,
        timeoutMs: Math.max(60_000, (inputTokens + maxTokens) * 120),
        signal,
      })
      return result.text
    } catch (err) {
      if (signal?.aborted) throw err
      console.warn('[meeting] notes step failed:', err instanceof Error ? err.message : err)
      return null
    }
  }
}

/** Split on blank lines, filling to a token budget. Never mid-paragraph. */
function splitParagraphs(text: string, budget: number): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim())
  const parts: string[] = []
  let current: string[] = []
  let tokens = 0

  for (const paragraph of paragraphs) {
    const cost = estimateTokens(paragraph)
    if (current.length > 0 && tokens + cost > budget) {
      parts.push(current.join('\n\n'))
      current = []
      tokens = 0
    }
    current.push(paragraph)
    tokens += cost
  }
  if (current.length > 0) parts.push(current.join('\n\n'))
  return parts
}

export type { Chunk, ParsedTask, TranscriptLine }
