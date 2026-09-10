import {
  estimateTokens,
  MEETING_CHUNK_SYSTEM,
  MEETING_NOTES_SYSTEM,
  MEETING_NOTES_TASKS_SYSTEM,
  MEETING_TASKS_SYSTEM,
  MEETING_TASK_VERIFY_SYSTEM,
  type LlmClient,
} from '@wouice/llm'
import {
  allFailed,
  assembleCondensed,
  chunkTranscript,
  contextAround,
  isMine,
  looksLikeCommitment,
  parseCandidates,
  parseNoteTasks,
  parseVerdict,
  reduceInput,
  renderChunk,
  renderLine,
  sentenceWith,
  type Chunk,
  type ChunkOutcome,
  type ParsedTask,
  type TranscriptLine,
  type Verdict,
} from './notes.js'

/**
 * Notes and tasks for one meeting, after it has ended.
 *
 * NO LATENCY BUDGET, AND THAT CHANGES THE DESIGN. Dictation is a two second
 * interaction and every millisecond is argued over. This runs once, on a
 * transcript nobody is waiting on with their cursor in a text field, so it can
 * afford to be careful: separate calls for prose and for structured data, and a
 * second, narrower call to check every task the first one proposed.
 *
 * IT MEASURES BEFORE IT SENDS. The first version estimated chunk sizes from a
 * character count calibrated on dictation. On a real hour-long meeting that
 * estimate was out by 1.5 to 1.8x, three of four chunks overflowed the model's
 * context, and the summary and every task came from the last six minutes -
 * while reporting success. The model's own tokenizer is now asked, and the
 * budget comes from the prompts that will actually be sent.
 *
 * A FAILED CHUNK IS A GAP, NOT A FAILED RUN, AND THE GAP IS REPORTED. Only a run
 * where every chunk failed is a failure. Anything else produces notes with the
 * missing stretch marked, and returns exactly which minutes were not read, so
 * the interface can say so instead of presenting a partial summary as whole.
 */

export interface NotesProgress {
  stage: 'condensing' | 'extracting' | 'checking' | 'writing'
  /** 1-based, and 0 for the reduce step, which is not per-chunk. */
  chunk: number
  chunks: number
}

export interface NotesRun {
  notesMd: string
  tasks: ParsedTask[]
  chunks: number
  failedChunks: number
  /** How much of the transcript the summary was built from. */
  coveredLines: number
  totalLines: number
  /** The stretches that could not be read, so the gap can be named. */
  gapsAt: { fromMs: number; toMs: number }[]
  /** Proposed by the extractor, dropped by the word filter, refused by the checker. */
  candidates: number
  filtered: number
  rejected: number
  ms: number
}

export interface NotesInput {
  lines: readonly TranscriptLine[]
  /** What the person typed during the call. May be empty. */
  scratch: string
  startedAt: number
  /** Who recorded the meeting, so a task given to them by name is theirs. */
  me?: { name: string }
  onProgress?(progress: NotesProgress): void
  signal?: AbortSignal
}

/** Asks the model's own tokenizer. Null when it cannot, and the estimate is used. */
export type TokenCounter = (text: string) => Promise<number | null>

export class NotesUnavailable extends Error {}

/** What the local model runs with. See `desktop/src/shared/models.ts`. */
const CONTEXT_TOKENS = 4096
const MAX_CHUNK_TOKENS = 700
const MAX_NOTES_TOKENS = 900
const MAX_VERDICT_TOKENS = 160
/** Headroom for chat-template tokens the prompt text does not show. */
const SAFETY_MARGIN = 150
/** How many times condensed output may be condensed again before giving up. */
const MAX_FOLDS = 2
/** Generous: this is a backstop for a stopped model, not a prediction. */
const STALL_MS = 20_000
/**
 * When the tokenizer cannot be asked: the estimate, padded to the worst ratio
 * measured on a real meeting. Wrong in the safe direction.
 */
const FALLBACK_FACTOR = 1.9
/** Parallel tokenizer calls. They are tiny, and there are hundreds of lines. */
const TOKENIZE_WORKERS = 6

export class MeetingNotesEngine {
  constructor(
    private readonly llm: () => LlmClient,
    private readonly countTokens?: TokenCounter
  ) {}

  async generate(input: NotesInput): Promise<NotesRun> {
    const started = Date.now()
    const usable = input.lines.filter((line) => !line.echo && line.text.trim())
    if (usable.length === 0) {
      throw new NotesUnavailable('there is no transcript to write notes from')
    }

    // The budget, from what will actually be sent. The tasks prompt is the
    // larger of the two and is sent with the same chunk plus a dated header.
    const system = Math.max(
      await this.count(MEETING_CHUNK_SYSTEM),
      (await this.count(MEETING_TASKS_SYSTEM)) + 24
    )
    const budget = CONTEXT_TOKENS - system - MAX_CHUNK_TOKENS - SAFETY_MARGIN

    const costs = await this.costs(usable)
    const chunks = chunkTranscript(usable, budget, (text) => costs.get(text) ?? padded(text))

    const outcomes: ChunkOutcome[] = []
    const proposed: { candidate: ReturnType<typeof parseCandidates>[number]; lines: readonly TranscriptLine[] }[] = []
    const date = new Date(input.startedAt).toISOString().slice(0, 10)

    for (const [index, chunk] of chunks.entries()) {
      input.signal?.throwIfAborted()
      const rendered = renderChunk(chunk)

      input.onProgress?.({ stage: 'condensing', chunk: index + 1, chunks: chunks.length })
      outcomes.push({
        chunk,
        text: await this.tryComplete(MEETING_CHUNK_SYSTEM, rendered, MAX_CHUNK_TOKENS, input.signal),
      })

      input.onProgress?.({ stage: 'extracting', chunk: index + 1, chunks: chunks.length })
      const raw = await this.tryComplete(
        MEETING_TASKS_SYSTEM,
        `Meeting date: ${date}\n\n${rendered}`,
        MAX_CHUNK_TOKENS,
        input.signal
      )
      if (raw !== null) {
        // Only THIS chunk's lines: the model can only cite, and only quote
        // from, what it was actually shown.
        for (const candidate of parseCandidates(raw, chunk.lines)) {
          proposed.push({ candidate, lines: chunk.lines })
        }
      }
    }

    if (allFailed(outcomes)) {
      throw new NotesUnavailable('the model could not summarise any part of this meeting')
    }

    const checked = await this.checkTasks(proposed, input, date)

    // The reduce step has to fit too: its own prompt, the person's notes and
    // room for the answer come out of the same 4096.
    const reduceTarget =
      CONTEXT_TOKENS -
      (await this.count(MEETING_NOTES_SYSTEM)) -
      (await this.count(input.scratch)) -
      MAX_NOTES_TOKENS -
      SAFETY_MARGIN -
      40
    const condensed = await this.fold(assembleCondensed(outcomes), reduceTarget, input)

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

    const failed = outcomes.filter((o) => o.text === null)
    return {
      notesMd: notes.trim(),
      tasks: checked.tasks,
      chunks: chunks.length,
      failedChunks: failed.length,
      coveredLines: outcomes
        .filter((o) => o.text !== null)
        .reduce((n, o) => n + o.chunk.lines.length, 0),
      totalLines: usable.length,
      gapsAt: failed.map((o) => ({ fromMs: o.chunk.startMs, toMs: o.chunk.endMs })),
      candidates: checked.candidates,
      filtered: checked.filtered,
      rejected: checked.rejected,
      ms: Date.now() - started,
    }
  }

  /**
   * Find, filter, verify.
   *
   * The extractor is asked to be generous; this is where generosity is paid
   * for. A word filter removes what is plainly not a commitment - a refusal, a
   * first-person maybe - for free, and every survivor is then judged on its
   * own by a narrow yes-or-no call that can see the lines around it. Your own
   * notes are a second source, checked the same way.
   */
  private async checkTasks(
    proposed: { candidate: ReturnType<typeof parseCandidates>[number]; lines: readonly TranscriptLine[] }[],
    input: NotesInput,
    date: string
  ): Promise<{ tasks: ParsedTask[]; candidates: number; filtered: number; rejected: number }> {
    const name = input.me?.name ?? ''
    const tasks: ParsedTask[] = []
    let filtered = 0
    let rejected = 0

    // Tasks from your notes, proposed first so they can be checked in the same
    // loop and deduplicated against the transcript's.
    const fromNotes = input.scratch.trim()
      ? parseNoteTasks(
          (await this.tryComplete(
            MEETING_NOTES_TASKS_SYSTEM,
            `Meeting date: ${date}\n\nNotes:\n${input.scratch}`,
            MAX_CHUNK_TOKENS,
            input.signal
          )) ?? '',
          input.scratch
        )
      : []

    const total = proposed.length + fromNotes.length
    let step = 0

    for (const { candidate, lines } of proposed) {
      input.signal?.throwIfAborted()
      input.onProgress?.({ stage: 'checking', chunk: ++step, chunks: total })

      const id = candidate.task.segmentId!
      const line = lines.find((l) => l.id === id)
      if (!line || !looksLikeCommitment(sentenceWith(line.text, candidate.quote))) {
        filtered++
        continue
      }

      const verdict = await this.verify(
        name,
        candidate.task.text,
        `line [${id}]`,
        candidate.quote,
        `The lines around it:\n${contextAround(lines, id)}`,
        input.signal
      )
      if (!verdict?.task) {
        rejected++
        continue
      }
      const owner = verdict.owner ?? candidate.task.owner
      tasks.push({
        ...candidate.task,
        owner,
        area: verdict.area,
        kind: verdict.kind,
        reason: verdict.reason,
        source: 'transcript',
        mine: isMine(owner, name),
      })
    }

    const seen = new Set(tasks.map((t) => t.text.toLowerCase()))
    for (const note of fromNotes) {
      input.signal?.throwIfAborted()
      input.onProgress?.({ stage: 'checking', chunk: ++step, chunks: total })

      if (seen.has(note.text.toLowerCase())) continue
      if (!looksLikeCommitment(sentenceWith(input.scratch, note.quote))) {
        filtered++
        continue
      }
      const verdict = await this.verify(
        name,
        note.text,
        "the person's own notes",
        note.quote,
        `Their notes:\n${input.scratch.slice(0, 1_200)}`,
        input.signal
      )
      if (!verdict?.task) {
        rejected++
        continue
      }
      const owner = verdict.owner ?? note.owner
      seen.add(note.text.toLowerCase())
      tasks.push({
        text: note.text,
        owner,
        due: note.due,
        segmentId: null,
        noteQuote: note.quote,
        area: verdict.area,
        kind: verdict.kind,
        reason: verdict.reason,
        source: 'notes',
        mine: isMine(owner, name),
      })
    }

    return { tasks, candidates: total, filtered, rejected }
  }

  /** One candidate, one narrow question. Null - unreadable - counts as no. */
  private async verify(
    name: string,
    text: string,
    where: string,
    quote: string,
    context: string,
    signal?: AbortSignal
  ): Promise<Verdict | null> {
    const raw = await this.tryComplete(
      MEETING_TASK_VERIFY_SYSTEM,
      [
        `The person who recorded this meeting: ${name.trim() || 'not given'}`,
        `Candidate task: ${text}`,
        `Taken from ${where}, where it was quoted as: "${quote}"`,
        '',
        context,
      ].join('\n'),
      MAX_VERDICT_TOKENS,
      signal
    )
    return raw === null ? null : parseVerdict(raw)
  }

  /**
   * Condense the condensed notes, when there are too many of them.
   *
   * A one hour meeting fits the reduce step comfortably once each chunk is
   * condensed. A three hour one does not, and without this the reduce call
   * would silently lose whatever did not fit - the exact failure map-reduce
   * exists to prevent, reappearing one level up.
   */
  private async fold(condensed: string, target: number, input: NotesInput): Promise<string> {
    let text = condensed
    for (let depth = 0; depth < MAX_FOLDS; depth++) {
      if ((await this.count(text)) <= target) return text
      const parts = splitParagraphs(text, Math.floor(target / 1.2))
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
    if ((await this.count(text)) > target) {
      const keep = Math.floor(target * 2.5)
      return `${text.slice(0, keep)}\n\n_[the rest could not be condensed enough to fit; read the transcript]_`
    }
    return text
  }

  private async count(text: string): Promise<number> {
    if (!text) return 0
    const real = this.countTokens ? await this.countTokens(text) : null
    return real ?? padded(text)
  }

  /** Every line's real cost, asked once, a few at a time. */
  private async costs(lines: readonly TranscriptLine[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (!this.countTokens) return out
    const rendered = lines.map(renderLine)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < rendered.length) {
        const text = rendered[next++]!
        const n = await this.countTokens!(text)
        if (n !== null) out.set(text, n)
      }
    }
    await Promise.all(Array.from({ length: TOKENIZE_WORKERS }, worker))
    return out
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

function padded(text: string): number {
  return Math.ceil(estimateTokens(text) * FALLBACK_FACTOR)
}

/** Split on blank lines, filling to a token budget. Never mid-paragraph. */
function splitParagraphs(text: string, budget: number): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim())
  const parts: string[] = []
  let current: string[] = []
  let tokens = 0

  for (const paragraph of paragraphs) {
    const cost = padded(paragraph)
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
