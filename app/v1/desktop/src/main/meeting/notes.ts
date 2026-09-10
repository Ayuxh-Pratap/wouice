import { estimateTokens } from '@wouice/llm'
import { TASK_AREAS, TASK_KINDS, type MeetingChannel, type TaskArea, type TaskKind } from '@wouice/store'

/**
 * Turning a transcript into notes and tasks: everything about it that is
 * arithmetic and parsing rather than a model call.
 *
 * WHY THE CHUNK SIZE IS A TOKEN BUDGET AND NOT A CHARACTER COUNT. The spec set
 * 36,000 characters per chunk. The local model runs with a 4,096 token context.
 * Thirty-six thousand characters is around 9,000 tokens of English and well
 * over 20,000 with Devanagari in it - so the specified chunk could not fit,
 * would not fail loudly, and would have silently dropped the middle of every
 * long meeting. A character constant is correct for at most one script; the
 * token estimate is calibrated against the model's own tokeniser for all three
 * this app sees.
 *
 * NO OVERLAP BETWEEN CHUNKS, DELIBERATELY. The spec carries 1,500 characters
 * forward for continuity, which is the right fix when you are cutting a wall of
 * text at an arbitrary offset. We are not: the segmenter has already cut the
 * transcript at pauses, so every chunk boundary is an utterance boundary. The
 * overlap would buy nothing and would make the same commitment appear in two
 * chunks, which is worse than a clean seam.
 */

/** What the local model runs with. See `desktop/src/shared/models.ts`. */
const MODEL_CONTEXT_TOKENS = 4096
/** The system prompt, measured generously. */
const RESERVED_FOR_SYSTEM = 400
/** Room for the answer, which is the half that gets silently truncated. */
const RESERVED_FOR_OUTPUT = 900

export const CHUNK_TOKEN_BUDGET = MODEL_CONTEXT_TOKENS - RESERVED_FOR_SYSTEM - RESERVED_FOR_OUTPUT

export interface TranscriptLine {
  id: number
  channel: MeetingChannel
  startMs: number
  text: string
  echo: boolean
}

export interface Chunk {
  lines: TranscriptLine[]
  tokens: number
  startMs: number
  endMs: number
}

/**
 * Split a transcript into slices the model can actually hold.
 *
 * Echo lines are dropped rather than chunked: they are the far side repeated
 * back through the microphone, so including them spends context on duplicates
 * and invites the model to double-count a commitment.
 */
export function chunkTranscript(
  lines: readonly TranscriptLine[],
  budget: number = CHUNK_TOKEN_BUDGET,
  /**
   * What a rendered line costs, in the model's own tokens.
   *
   * INJECTED, BECAUSE THE ESTIMATE WAS WRONG. `estimateTokens` was calibrated on
   * dictation and undercounts a meeting chunk by 1.5 to 1.8x: every line
   * carries a "[12345] Them (56:40):" prefix, and digits, brackets and colons
   * are expensive. Measured on a real hour, three of four chunks overflowed the
   * context and the summary was written from the last six minutes. The engine
   * passes the real count from the model's tokenizer; the estimate is only the
   * fallback, and a padded one.
   */
  costOf: (rendered: string) => number = (text) => Math.ceil(estimateTokens(text) * 1.9)
): Chunk[] {
  const usable = lines.filter((line) => !line.echo && line.text.trim().length > 0)
  if (usable.length === 0) return []

  const chunks: Chunk[] = []
  let current: TranscriptLine[] = []
  let tokens = 0

  for (const line of usable) {
    // +1 for the newline that joins it to the next line.
    const cost = costOf(renderLine(line)) + 1
    // One utterance longer than the whole budget cannot be split without
    // cutting mid-sentence, so it gets a chunk to itself and the model sees as
    // much of it as it can hold. Vanishingly rare: the segmenter caps a segment
    // at fifteen seconds.
    if (current.length > 0 && tokens + cost > budget) {
      chunks.push(seal(current, tokens))
      current = []
      tokens = 0
    }
    current.push(line)
    tokens += cost
  }

  if (current.length > 0) chunks.push(seal(current, tokens))
  return chunks
}

function seal(lines: TranscriptLine[], tokens: number): Chunk {
  return {
    lines,
    tokens,
    startMs: lines[0]!.startMs,
    endMs: lines[lines.length - 1]!.startMs,
  }
}

/**
 * One line, as the model sees it.
 *
 * The `[n]` is the segment's own database id, and it is what a task cites. A
 * running counter would be cheaper to read and would mean nothing outside the
 * one prompt that produced it.
 */
export function renderLine(line: TranscriptLine): string {
  const who = line.channel === 'me' ? 'You' : 'Them'
  return `[${line.id}] ${who} (${stamp(line.startMs)}): ${line.text}`
}

export function renderChunk(chunk: Chunk): string {
  return chunk.lines.map(renderLine).join('\n')
}

function stamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/* --------------------------------------------------------------- tasks ---- */

export interface ParsedTask {
  text: string
  owner: string | null
  /** ISO date, or null when none was said. */
  due: string | null
  /** The segment this was taken from; null only for a task from your own notes. */
  segmentId: number | null
  area?: TaskArea
  kind?: TaskKind
  mine?: boolean
  source?: 'transcript' | 'notes'
  noteQuote?: string | null
  reason?: string
}

const MAX_TASK_CHARS = 300

/** Letters and digits only, for comparing what was said against what was quoted. */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Read the task lines back, and refuse anything that cannot be traced.
 *
 * TWO GUARDS, AND THE SECOND IS THE ONE THAT MATTERS. The first is the line
 * number: a task citing a line the model was not shown is dropped, because it
 * cannot have read it. That alone is not enough - handed a casual conversation
 * about salaries and university, a model will happily cite a real line and
 * report "assume salary of fifteen hundred rupees" as a task.
 *
 * So the model must also QUOTE the words that prove somebody committed to
 * something, and the quote must actually appear in the line it cites. It cannot
 * quote a commitment out of a sentence that contains none. That turns "is this
 * really a task" from the model's judgement into something checkable here,
 * which is the whole of criterion B9.
 *
 * Everything else is dropped rather than guessed. An owner is only an owner if
 * the model returned a name; guessing one quietly moves work to somebody who
 * never agreed to it.
 */
export function parseTasks(raw: string, lines: readonly TranscriptLine[]): ParsedTask[] {
  return parseCandidates(raw, lines).map((c) => c.task)
}

/** A task the extractor proposed, with the words it quoted as evidence. */
export interface Candidate {
  task: ParsedTask
  quote: string
}

/**
 * The same parse as `parseTasks`, keeping the model's quote.
 *
 * The quote is what the commitment filter and the verifier read: they judge
 * the sentence the task was taken from, not the model's paraphrase of it.
 */
export function parseCandidates(raw: string, lines: readonly TranscriptLine[]): Candidate[] {
  const byId = new Map(lines.map((line) => [line.id, bare(line.text)]))
  const seen = new Set<string>()
  const tasks: Candidate[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    // Models fence JSON even when told not to. Skipping the fence costs one
    // line of code and rescues the whole response.
    if (!trimmed || trimmed.startsWith('```')) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue

    const record = parsed as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (!text || text.length > MAX_TASK_CHARS) continue

    const segmentId = typeof record.line === 'number' ? record.line : Number(record.line)
    if (!Number.isInteger(segmentId) || !byId.has(segmentId)) continue

    // The grounding check. A quote that is not in the line is a quote the model
    // wrote rather than read, and a task built on one is an invention.
    const quote = typeof record.quote === 'string' ? bare(record.quote) : ''
    if (quote.length < 8 || !byId.get(segmentId)!.includes(quote)) continue

    const owner =
      typeof record.owner === 'string' && record.owner.trim() && record.owner.trim() !== 'null'
        ? record.owner.trim()
        : null
    const due =
      typeof record.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.due.trim())
        ? record.due.trim()
        : null

    // The same commitment can be restated. Keyed on the line and the words, so
    // two genuinely different tasks from one sentence both survive.
    const key = `${segmentId}:${text.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    tasks.push({
      task: { text, owner, due, segmentId },
      quote: typeof record.quote === 'string' ? record.quote.trim() : '',
    })
  }

  return tasks
}

/* ------------------------------------------------------------ assembly ---- */

export interface ChunkOutcome {
  chunk: Chunk
  /** Null when the chunk failed. */
  text: string | null
}

/**
 * Condensed chunks, joined, with failures left visible.
 *
 * A FAILED CHUNK IS A MARKED GAP, NOT A MISSING TWENTY MINUTES. Quietly joining
 * what survived produces notes that look complete and are not, which is the
 * worst possible outcome: you would act on them. The marker names the time
 * range so the transcript can be read directly for that stretch.
 */
export function assembleCondensed(outcomes: readonly ChunkOutcome[]): string {
  return outcomes
    .map((outcome) => {
      if (outcome.text !== null && outcome.text.trim()) return outcome.text.trim()
      if (outcome.text !== null) return ''
      return `_[${stamp(outcome.chunk.startMs)}–${stamp(outcome.chunk.endMs)}: this part could not be summarised. Read the transcript for it.]_`
    })
    .filter(Boolean)
    .join('\n\n')
}

/** True when every chunk failed, which is a failed run rather than a gappy one. */
export function allFailed(outcomes: readonly ChunkOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o.text === null)
}

/**
 * Build the reduce step's input.
 *
 * The person's own notes go in LAST and are labelled as theirs. They are a
 * signal about what mattered, not a source of facts - a scribbled "priya =
 * decision maker" is a hint to weight, not a line to quote.
 */
export function reduceInput(condensed: string, scratch: string, when: Date): string {
  const parts = [`Meeting date: ${when.toISOString().slice(0, 10)}`, '', condensed]
  const notes = scratch.trim()
  if (notes) {
    parts.push('', "The person's own notes, typed during the meeting:", notes)
  }
  return parts.join('\n')
}

/* --------------------------------------------------------- the filter ---- */

/**
 * A refusal, not a negative.
 *
 * NOT "not". Bug reports are full of negatives - "the dialog is not closing",
 * "images don't load" - and those are exactly the tasks worth keeping. What
 * marks a non-commitment is refusing to DO something, so that is all this
 * matches.
 */
const REFUSAL =
  /\b(not doing|not going to|not gonna|won'?t (?:do|be doing|build|handle|take|work on)|don'?t (?:need to|have to|want to)|no need to|let'?s not|leave it|not my (?:job|problem|area)|can'?t (?:do|take|handle) (?:it|that|this))\b/i

/**
 * A first-person maybe.
 *
 * "maybe I need to handle it" is a musing; "maybe it's a caching issue" inside
 * a bug report is not. Hedges about the speaker's own action are the only kind
 * matched. Questions are NOT matched here at all: "can you fix the login bug?"
 * is an assignment, and telling a request from a wondering is the verifier's
 * job, not a regex's.
 */
const HEDGE =
  /\b(maybe (?:i|we)|(?:i|we) might|perhaps (?:i|we)|what about|should we|could we|i guess|i wonder|not sure (?:if|whether))\b/i

/**
 * The sentence of a line that a quote came from.
 *
 * A line can hold "we'll fix the login bug. Not doing the Instagram thing." -
 * one commitment and one refusal. Judging the whole line would let either
 * sentence decide for the other.
 */
export function sentenceWith(line: string, quote: string): string {
  const target = bare(quote)
  if (!target) return line
  const sentences = line.split(/(?<=[.!?।])\s+/)
  return sentences.find((sentence) => bare(sentence).includes(target)) ?? line
}

/**
 * Whether a sentence can possibly be a commitment, by its words alone.
 *
 * DETERMINISTIC, AND DELIBERATELY NARROW. It only removes what is plainly not a
 * commitment - a refusal, a first-person maybe - so the model is never asked
 * about them. On a real meeting that is "I'm not doing it" and "maybe I need to
 * handle it", both of which the extractor had reported as tasks. It does not
 * try to recognise a commitment; that is the verifier's job, and a regex that
 * tried would be wrong in both directions.
 */
export function looksLikeCommitment(sentence: string): boolean {
  if (REFUSAL.test(sentence)) return false
  if (HEDGE.test(sentence)) return false
  return true
}

/** The cited line with a little either side, which is what the verifier reads. */
export function contextAround(
  lines: readonly TranscriptLine[],
  id: number,
  radius = 2
): string {
  const at = lines.findIndex((line) => line.id === id)
  if (at < 0) return ''
  return lines
    .slice(Math.max(0, at - radius), at + radius + 1)
    .map((line) => (line.id === id ? `>> ${renderLine(line)}` : `   ${renderLine(line)}`))
    .join('\n')
}

/* -------------------------------------------------------- the verdict ---- */

export interface Verdict {
  task: boolean
  reason: string
  area: TaskArea
  kind: TaskKind
  owner: string | null
}

/**
 * Read the verifier's one JSON object.
 *
 * Unparseable is null, and the caller treats null as "not a task". A verifier
 * that could not be read has not said yes, and a task list padded with things
 * nobody confirmed is the problem this whole pass exists to fix.
 */
export function parseVerdict(raw: string): Verdict | null {
  const match = /\{[\s\S]*\}/.exec(raw)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  if (typeof r.task !== 'boolean') return null

  const area = typeof r.area === 'string' ? r.area.toLowerCase().trim() : ''
  const kind = typeof r.kind === 'string' ? r.kind.toLowerCase().trim() : ''
  const owner =
    typeof r.owner === 'string' && r.owner.trim() && r.owner.trim().toLowerCase() !== 'null'
      ? r.owner.trim()
      : null

  return {
    task: r.task,
    reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 200) : '',
    area: (TASK_AREAS as readonly string[]).includes(area) ? (area as TaskArea) : 'other',
    kind: (TASK_KINDS as readonly string[]).includes(kind) ? (kind as TaskKind) : 'other',
    owner,
  }
}

/**
 * Whether a task is yours.
 *
 * "You" is the extractor's word for the person who recorded the meeting, and
 * a configured name catches the case where somebody said it out loud: "Ayush,
 * can you take the login bug". With no name configured, only "You" counts.
 */
export function isMine(owner: string | null, name: string): boolean {
  if (!owner) return false
  const who = owner.trim().toLowerCase()
  if (who === 'you' || who === 'me') return true
  const mine = name.trim().toLowerCase()
  if (!mine) return false
  return who === mine || who.split(/[\s,&/]+/).includes(mine)
}

/* ------------------------------------------------- tasks from notes ------ */

export interface NoteCandidate {
  text: string
  owner: string | null
  due: string | null
  quote: string
}

/**
 * Tasks proposed from the person's own notes.
 *
 * The same rule as the transcript: the quote must actually be in the notes.
 * The notes were typed by the person who cares, but the model still read them,
 * and a quote it did not find there is one it made up.
 */
export function parseNoteTasks(raw: string, notes: string): NoteCandidate[] {
  const haystack = bare(notes)
  const out: NoteCandidate[] = []
  const seen = new Set<string>()

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('```')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const r = parsed as Record<string, unknown>

    const text = typeof r.text === 'string' ? r.text.trim() : ''
    const quote = typeof r.quote === 'string' ? r.quote.trim() : ''
    if (!text || text.length > MAX_TASK_CHARS) continue
    if (bare(quote).length < 8 || !haystack.includes(bare(quote))) continue

    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      text,
      quote,
      owner:
        typeof r.owner === 'string' && r.owner.trim() && r.owner.trim() !== 'null'
          ? r.owner.trim()
          : null,
      due:
        typeof r.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.due.trim()) ? r.due.trim() : null,
    })
  }
  return out
}
