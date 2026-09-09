import { estimateTokens } from '@wouice/llm'
import type { MeetingChannel } from '@wouice/store'

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
  budget: number = CHUNK_TOKEN_BUDGET
): Chunk[] {
  const usable = lines.filter((line) => !line.echo && line.text.trim().length > 0)
  if (usable.length === 0) return []

  const chunks: Chunk[] = []
  let current: TranscriptLine[] = []
  let tokens = 0

  for (const line of usable) {
    const cost = estimateTokens(renderLine(line))
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
function renderLine(line: TranscriptLine): string {
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
  /** The segment this was taken from. Never null: unciteable tasks are dropped. */
  segmentId: number
}

const MAX_TASK_CHARS = 300

/**
 * Read the task lines back, and refuse anything that cannot be traced.
 *
 * THIS IS WHERE B9 IS ENFORCED, not in the prompt. A prompt rule is a request;
 * this is the thing that makes an invented citation impossible to ship. A task
 * whose `line` is not one of the ids actually handed to the model is dropped
 * outright - the model may have hallucinated the whole commitment, and a task
 * you cannot check against what was said is worse than a missing one.
 *
 * Every other malformed field is dropped rather than guessed. An owner is only
 * an owner if the model returned a string; a due date is only a date if it
 * looks like one. Guessing an owner quietly moves work to somebody who never
 * agreed to it.
 */
export function parseTasks(raw: string, allowedIds: Iterable<number>): ParsedTask[] {
  const allowed = new Set(allowedIds)
  const seen = new Set<string>()
  const tasks: ParsedTask[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    // Models fence JSON even when told not to. Skipping the fence costs one
    // line of code and rescues the whole response.
    if (!trimmed || trimmed.startsWith('```')) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Prose the model added despite being asked for JSON only.
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue

    const record = parsed as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (!text || text.length > MAX_TASK_CHARS) continue

    const segmentId = typeof record.line === 'number' ? record.line : Number(record.line)
    if (!Number.isInteger(segmentId) || !allowed.has(segmentId)) continue

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

    tasks.push({ text, owner, due, segmentId })
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
