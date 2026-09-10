import { estimateTokens } from '@wouice/llm'
import {
  TASK_AREAS,
  TASK_KINDS,
  type MeetingChannel,
  type TaskArea,
  type TaskKind,
  type TaskStatus,
} from '@wouice/store'

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

/**
 * WHAT A TASK IS. Work somebody has to do after the meeting: a feature asked
 * for or agreed, a bug reported, a change to something that exists, something
 * to find out, something to make, a follow-up somebody took on. Not a promise
 * hunted for in one sentence - the first version looked for "I will", and a
 * product meeting holding fifteen real pieces of work gave it one, from a line
 * the speech model had invented over silence.
 *
 * A task is a one-line title, a description that tells the story, and every
 * line of the transcript it came from. Found in three steps: each part of the
 * meeting lists its work items, one whole-meeting pass groups the same work
 * found in different parts and says where the meeting landed on it, and each
 * surviving group is written up from its own lines.
 */

/** A line of the transcript a task came from, and the words quoted from it. */
export interface Evidence {
  segmentId: number
  /** Words copied from the line; empty when it was cited without a quote. */
  quote: string
}

/** A finished task, as the engine hands it to the store. */
export interface ParsedTask {
  /** One line, starting with a verb: what has to be done. */
  text: string
  /** The story: what exactly, how it should work, why - from what was said. */
  description?: string
  owner: string | null
  /** ISO date, or null when none was said. */
  due: string | null
  /** The earliest line it came from; null only for a task from your own notes. */
  segmentId: number | null
  /** Every line it came from, in the order they were said. */
  evidence?: Evidence[]
  /** Where the meeting landed on it. */
  status?: TaskStatus
  area?: TaskArea
  kind?: TaskKind
  mine?: boolean
  source?: 'transcript' | 'notes'
  noteQuote?: string | null
  reason?: string
}

/**
 * Where one part of a meeting, or the whole meeting, left a piece of work.
 * Only agreed and proposed work becomes a task. Parked is work pushed back on
 * or left for another time - "not on the engineering call", "I'm just not
 * crazy about it" - which is discussion, not a job anybody took away.
 */
export type WorkStatus = 'agreed' | 'proposed' | 'parked' | 'rejected' | 'done'
const WORK_STATUSES: readonly WorkStatus[] = ['agreed', 'proposed', 'parked', 'rejected', 'done']

/** One piece of work, as one part of the meeting described it. */
export interface WorkItem {
  title: string
  story: string
  kind: TaskKind
  area: TaskArea
  owner: string | null
  status: WorkStatus
  /** The lines of its part that discuss it, each checked to exist. */
  evidence: Evidence[]
  /** When it first came up; null for an item from your own notes. */
  atMs: number | null
  source: 'transcript' | 'notes'
  /** For an item from your own notes: the words it came from. */
  noteQuote?: string
}

const MAX_TASK_CHARS = 200
const MAX_STORY_CHARS = 900
/** Lines kept on one work item: the ones its quote spans, then the closest of the rest. */
const MAX_ITEM_LINES = 8

/** Letters and digits only, for comparing what was said against what was quoted. */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** A name, or null for nothing, "null" and "none". */
function nameOrNull(value: unknown): string | null {
  const name = str(value)
  return name && !['null', 'none', 'n/a'].includes(name.toLowerCase()) ? name : null
}

/**
 * Every JSON object in a model's answer, however it was laid out.
 *
 * Asked for one object per line, models fence them, pretty-print them across
 * lines and wrap them in prose. Scanning for balanced braces reads all of
 * those; an object that does not parse is skipped rather than fatal.
 */
export function jsonObjects(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      if (depth > 0) inString = true
    } else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          const parsed: unknown = JSON.parse(raw.slice(start, i + 1))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            out.push(parsed as Record<string, unknown>)
          }
        } catch {
          // Not JSON after all. The rest of the answer may still be.
        }
        start = -1
      }
    }
  }
  return out
}

/** Words models use for a type, mapped onto the ones the app knows. */
const KIND_WORDS: Record<string, TaskKind> = {
  enhancement: 'feature',
  improvement: 'feature',
  fix: 'bug',
  issue: 'bug',
  defect: 'bug',
  rename: 'change',
  redesign: 'change',
  refactor: 'change',
  update: 'change',
  investigate: 'research',
  investigation: 'research',
  explore: 'research',
  exploration: 'research',
  spike: 'research',
  video: 'content',
  docs: 'content',
  documentation: 'content',
  copy: 'content',
  followup: 'followup',
  action: 'followup',
}

export function toKind(value: unknown): TaskKind {
  const word = str(value).toLowerCase().replace(/[^a-z]/g, '')
  if ((TASK_KINDS as readonly string[]).includes(word)) return word as TaskKind
  return KIND_WORDS[word] ?? 'other'
}

/** Words models use for an area, mapped onto the ones the app knows. */
const AREA_WORDS: Record<string, TaskArea> = {
  ui: 'frontend',
  ux: 'frontend',
  web: 'frontend',
  mobile: 'frontend',
  app: 'frontend',
  api: 'backend',
  server: 'backend',
  ai: 'backend',
  data: 'backend',
  content: 'product',
  marketing: 'business',
  legal: 'business',
  infra: 'ops',
  devops: 'ops',
}

export function toArea(value: unknown): TaskArea {
  const word = str(value).toLowerCase().replace(/[^a-z]/g, '')
  if ((TASK_AREAS as readonly string[]).includes(word)) return word as TaskArea
  return AREA_WORDS[word] ?? 'other'
}

/** A title somebody could pick up: short enough to be one line, and says what. */
function sayWhat(title: string): boolean {
  return title.length > 0 && title.length <= MAX_TASK_CHARS && contentWords(title).size >= 2
}

/**
 * Read one part's work items back, keeping only what can be traced.
 *
 * EVERY ITEM MUST QUOTE A LINE. The model lists the lines where the work is
 * discussed and copies words from one of them, and those words have to be in a
 * line it was shown. A model that cannot copy words about a piece of work out
 * of the transcript is describing work nobody discussed - the one mistake a
 * task list cannot survive. The line the quote is in is cited even when the
 * model forgot to list it; cited lines it was never shown are dropped.
 *
 * AND IT MUST SAY WHAT. A title with fewer than two words of substance - "fix
 * it", "do this" - is not something anybody can pick up.
 *
 * @returns the items, and how many were dropped for failing either check.
 */
export function parseWorkItems(
  raw: string,
  lines: readonly TranscriptLine[]
): { items: WorkItem[]; dropped: number } {
  const byId = new Map(lines.map((line) => [line.id, line]))
  const items: WorkItem[] = []
  let dropped = 0

  const position = new Map(lines.map((line, i) => [line.id, i]))

  for (const r of jsonObjects(raw)) {
    const title = str(r.title ?? r.text)
    const story = str(r.description ?? r.story)
    const quote = str(r.quote)
    const cited = (Array.isArray(r.lines) ? r.lines : [r.line])
      .map((value) => Number(value))
      .filter((id) => Number.isInteger(id) && byId.has(id))
    const span = quoteSpan(quote, lines, cited)
    if (!sayWhat(title) || span === null) {
      dropped++
      continue
    }

    // The lines the quote spans, then - of everything else it cited, which is
    // often a whole forty-line stretch - the ones right beside them or about
    // the same thing.
    const about = contentWords(`${title} ${story}`)
    const beside = (id: number): boolean =>
      span.some((s) => Math.abs(position.get(s)! - position.get(id)!) <= 2)
    const related = (id: number): boolean => {
      const words = contentWords(byId.get(id)!.text)
      let shared = 0
      for (const word of about) if (words.has(word)) shared++
      return shared >= 2
    }
    const extra = cited.filter((id) => !span.includes(id) && (beside(id) || related(id)))
    const room = Math.max(0, MAX_ITEM_LINES - span.length)
    const ids = [...new Set([...span, ...extra.slice(0, room)])].sort(
      (a, b) => position.get(a)! - position.get(b)!
    )
    const evidence = ids.map((id) => ({ segmentId: id, quote: id === span[0] ? quote : '' }))
    const status = str(r.status).toLowerCase()

    // The same work listed twice in one part is one item with both sets of lines.
    const twin = items.find((item) => item.title.toLowerCase() === title.toLowerCase())
    if (twin) {
      for (const e of evidence) {
        if (!twin.evidence.some((known) => known.segmentId === e.segmentId)) twin.evidence.push(e)
      }
      continue
    }

    items.push({
      title,
      story: str(r.description ?? r.story).slice(0, MAX_STORY_CHARS),
      kind: toKind(r.type ?? r.kind),
      area: toArea(r.area),
      owner: nameOrNull(r.owner),
      status: (WORK_STATUSES as readonly string[]).includes(status) ? (status as WorkStatus) : 'proposed',
      evidence,
      atMs: byId.get(ids[0]!)!.startMs,
      source: 'transcript',
    })
  }
  return { items, dropped }
}

/**
 * The lines of a part a quote was copied from, or null when it was not.
 *
 * ACROSS LINE BREAKS. The transcript is cut at pauses, and people do not pause
 * at the ends of sentences, so one sentence is often spread over two or three
 * lines - and the model quotes the sentence. Checking one line at a time
 * dropped twelve of twenty-one real pieces of work on a real meeting. So the
 * quote is looked for in the part read straight through.
 *
 * AND NEARLY WORD FOR WORD, BESIDE WHAT IT CITED. A model that writes "I like
 * Fincha. Finally, you came right back around" from "Fincha, yes. Finally, you
 * came right back around. Yeah, I like Fincha" read that line. So when the exact
 * words are not there, a few consecutive lines holding nearly all of the
 * quote's words count - but only lines touching ones the model itself cited.
 * A quote lifted from another part of the meeting has nothing here to touch,
 * and a model describing work nobody discussed has nothing to point at at all.
 */
export function quoteSpan(
  quote: string,
  lines: readonly TranscriptLine[],
  cited: readonly number[]
): number[] | null {
  const wanted = bare(quote)
  if (wanted.length < 8) return null

  let stream = ''
  const starts: number[] = []
  for (const line of lines) {
    starts.push(stream.length)
    stream += bare(line.text)
  }
  const at = stream.indexOf(wanted)
  if (at >= 0) {
    const end = at + wanted.length
    return lines
      .filter((_, i) => starts[i]! < end && (starts[i + 1] ?? stream.length) > at)
      .map((line) => line.id)
  }

  const words = contentWords(quote)
  if (words.size < 3 || cited.length === 0) return null
  const touches = new Set(cited)
  for (let size = 1; size <= 4; size++) {
    for (let i = 0; i + size <= lines.length; i++) {
      const window = lines.slice(i, i + size)
      if (!window.some((line) => touches.has(line.id))) continue
      const have = contentWords(window.map((line) => line.text).join(' '))
      let hit = 0
      for (const word of words) if (have.has(word)) hit++
      if (hit / words.size >= 0.8) return window.map((line) => line.id)
    }
  }
  return null
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** Jobs shown when placing one item: plenty for an hour, and always inside the context. */
const MAX_JOBS_SHOWN = 30

/**
 * What placing one item sends: the jobs found so far, one short line each,
 * then the item. Each job is shown by its latest item, usually its clearest
 * wording. When there are more jobs than fit, the ones sharing the most words
 * with the item are shown, and `shown` maps each job number back.
 */
export function placeInput(
  jobs: readonly { members: readonly number[] }[],
  items: readonly WorkItem[],
  next: number,
  cap = MAX_JOBS_SHOWN
): { text: string; shown: number[] } {
  const item = items[next]!
  const all = jobs.map((_, i) => i)
  const shown =
    jobs.length <= cap
      ? all
      : all
          .map((i) => ({
            i,
            score: Math.max(...jobs[i]!.members.map((m) => similarity(items[m]!.title, item.title))),
          }))
          .sort((a, b) => b.score - a.score || a.i - b.i)
          .slice(0, cap)
          .map((s) => s.i)
          .sort((a, b) => a - b)
  const listed = shown.map((j, k) => `g${k + 1} ${jobLine(items[jobs[j]!.members.at(-1)!]!, 110)}`)
  return { text: ['Jobs so far:', ...listed, '', 'New item:', jobLine(item, 300)].join('\n'), shown }
}

function jobLine(item: WorkItem, story: number): string {
  const when = item.atMs === null ? 'notes' : stamp(item.atMs)
  return `[${when}] ${item.title}${item.story ? ` - ${clip(item.story, story)}` : ''}`
}

/** The same work, found one or more times, and where the meeting landed on it. */
export interface Group {
  /** Indexes into the item list. */
  members: number[]
  status: WorkStatus
}

/** Where a group landed from its members alone: the last word on it wins. */
export function settledStatus(items: readonly WorkItem[]): WorkStatus {
  const timed = items.filter((item) => item.atMs !== null).sort((a, b) => a.atMs! - b.atMs!)
  return timed.at(-1)?.status ?? items[0]?.status ?? 'proposed'
}

/** How a new item relates to a job found before it. */
export type Relation = 'same' | 'replaces' | 'new'

export interface Placement {
  /** Index into the jobs that were shown; null for a new job. */
  job: number | null
  relation: Relation
}

/**
 * Read one placement back. Naming a job that was not shown is a new job - a
 * model that loses track costs a duplicate, never a task. An answer with no
 * placement in it at all is null, and the item is placed by wording instead.
 */
export function parsePlacement(raw: string, shown: number): Placement | null {
  const [r] = jsonObjects(raw)
  if (!r) return null
  const relation = str(r.relation).toLowerCase()
  if (relation !== 'same' && relation !== 'replaces' && relation !== 'new') return null
  const job = Number(String(r.job ?? '').replace(/^g/i, '')) - 1
  if (relation === 'new' || !Number.isInteger(job) || job < 0 || job >= shown) {
    return { job: null, relation: 'new' }
  }
  return { job, relation }
}

/** Items found to be one piece of work; replaced when a later decision dropped it. */
export interface Job {
  members: number[]
  replaced: boolean
}

/**
 * One item into the jobs so far, as it was placed.
 *
 * "replaces" drops the job it names - chat history, replaced by clipping
 * answers into the FAQ - but only a job about the same thing. One sharing no
 * word at all with the new item was misread, and is left alone. And never work
 * the meeting agreed to: replacing that is the work changing - "Finchy", then
 * "Lil Finch", then "Finch Bot, done" - so the item joins it, and the write-up,
 * reading its latest lines, says where it landed. Dropping it instead lost the
 * whole rename on a real call. An extra task costs a click; a lost one is gone.
 */
export function placeItem(
  jobs: readonly Job[],
  items: readonly WorkItem[],
  next: number,
  target: number | null,
  relation: Relation
): Job[] {
  const fresh = { members: [next], replaced: false }
  if (target === null || relation === 'new') return [...jobs, fresh]
  const members = jobs[target]!.members
  if (relation === 'replaces') {
    const title = items[next]!.title
    if (!members.some((m) => similarity(items[m]!.title, title) > 0)) return [...jobs, fresh]
    if (!members.some((m) => items[m]!.status === 'agreed')) {
      return [...jobs.map((job, i) => (i === target ? { ...job, replaced: true } : job)), fresh]
    }
  }
  return jobs.map((job, i) => (i === target ? { ...job, members: [...members, next] } : job))
}

/** Jobs as groups, each with where the meeting landed: dropped, or its own last word. */
export function jobGroups(jobs: readonly Job[], items: readonly WorkItem[]): Group[] {
  return jobs.map((job) => ({
    members: [...job.members],
    status: job.replaced ? 'rejected' : settledStatus(job.members.map((m) => items[m]!)),
  }))
}

/**
 * Placing without the model, for when it cannot be asked: the job holding an
 * item with mostly the same words, if any. Worse at "the same work, worded
 * differently" than the model is, and never wrong about work that is not.
 */
export function placeByWording(
  jobs: readonly { members: readonly number[] }[],
  items: readonly WorkItem[],
  next: number
): number | null {
  const at = jobs.findIndex((job) =>
    job.members.some((m) => similarity(items[m]!.title, items[next]!.title) >= 0.4)
  )
  return at < 0 ? null : at
}

/** Of one group's lines, the share that must sit inside another's for them to be one piece of work. */
const SAME_LINES = 2 / 3

/**
 * Groups that point at the same stretch of talk are the same work.
 *
 * The grouping step reads one short line per item, so "Add question chips
 * under each reply" and "Add a backend call that pulls questions out of
 * replies" look like two jobs to it - yet both were found in the same three
 * lines, because they are one feature and its plumbing. When nearly all of one
 * group's lines are inside another's they merge, and the later word on them
 * wins. Sharing a line or two is not enough: one stretch of talk often holds
 * two pieces of work, like "change settings that don't touch money" and "read
 * back past bets".
 */
export function mergeOverlapping(groups: readonly Group[], items: readonly WorkItem[]): Group[] {
  const linesOf = (members: readonly number[]): Set<number> =>
    new Set(members.flatMap((i) => items[i]!.evidence.map((e) => e.segmentId)))
  const lastOf = (members: readonly number[]): number =>
    Math.max(-1, ...members.map((i) => items[i]!.atMs ?? -1))
  const same = (a: Set<number>, b: Set<number>): boolean => {
    const [small, big] = a.size <= b.size ? [a, b] : [b, a]
    if (small.size < 2) return false
    let shared = 0
    for (const id of small) if (big.has(id)) shared++
    return shared / small.size >= SAME_LINES
  }

  const merged: { members: number[]; status: WorkStatus; lines: Set<number> }[] = []
  for (const group of groups) {
    const lines = linesOf(group.members)
    const home = merged.find((m) => same(m.lines, lines))
    if (!home) {
      merged.push({ members: [...group.members], status: group.status, lines })
      continue
    }
    if (lastOf(group.members) > lastOf(home.members)) home.status = group.status
    home.members = [...home.members, ...group.members].sort((a, b) => a - b)
    for (const id of lines) home.lines.add(id)
  }
  return merged
    .map(({ members, status }) => ({ members, status }))
    .sort((a, b) => a.members[0]! - b.members[0]!)
}

/**
 * At most `cap` of a list, in order: the first few, then the latest.
 *
 * A decision that changes over a meeting ends where its last lines are - "Bump
 * Bot, done" came forty minutes after the name first came up - so a cap that
 * kept only the earliest lines cut exactly the one that settled it.
 */
export function keepEnds<T>(items: readonly T[], cap: number, head = 4): T[] {
  if (items.length <= cap) return [...items]
  const first = Math.min(head, cap)
  return [...items.slice(0, first), ...items.slice(items.length - (cap - first))]
}

/** One task, as the write-up step wrote it. */
export interface WriteUp {
  title: string
  description: string
  kind: TaskKind
  area: TaskArea
  owner: string | null
  /** Where the lines themselves leave it; null when the answer does not say. */
  status: WorkStatus | null
}

/** Read the write-up back. Null when there is no usable title in it. */
export function parseWriteUp(raw: string): WriteUp | null {
  const [r] = jsonObjects(raw)
  if (!r) return null
  const title = str(r.title ?? r.text)
  if (!sayWhat(title)) return null
  const said = str(r.status).toLowerCase()
  return {
    title,
    description: str(r.description ?? r.story).slice(0, MAX_STORY_CHARS),
    kind: toKind(r.type ?? r.kind),
    area: toArea(r.area),
    owner: nameOrNull(r.owner),
    status: WORK_STATUSES.includes(said as WorkStatus) ? (said as WorkStatus) : null,
  }
}

/**
 * The transcript a write-up reads: every cited line, and the line after each -
 * usually the answer ("yeah, we are doing it right now") that says where the
 * request landed. In time order, capped so it fits beside the instructions -
 * keeping the first few and the latest, since the last word is at the end.
 */
export function linesFor(
  lines: readonly TranscriptLine[],
  ids: readonly number[],
  cap = 14
): TranscriptLine[] {
  const index = new Map(lines.map((line, i) => [line.id, i]))
  const wanted = new Set<number>()
  for (const id of ids) {
    const at = index.get(id)
    if (at === undefined) continue
    wanted.add(at)
    if (at + 1 < lines.length) wanted.add(at + 1)
  }
  return keepEnds(
    [...wanted].sort((a, b) => a - b),
    cap
  ).map((i) => lines[i]!)
}

/** What the write-up step is given for one task. */
export function writeUpInput(
  found: readonly WorkItem[],
  cited: readonly TranscriptLine[],
  date: string
): string {
  const parts = [`Meeting date: ${date}`, '', 'What was found about this task:']
  for (const item of found) {
    const from = item.source === 'notes' ? " (from the person's own notes)" : ''
    parts.push(`- ${item.title}${item.story ? ` - ${item.story}` : ''}${from}`)
  }
  if (cited.length > 0) parts.push('', 'The lines it came from:', ...cited.map(renderLine))
  const noted = found.map((item) => item.noteQuote).filter((q): q is string => Boolean(q))
  if (noted.length > 0) {
    parts.push('', 'What the person wrote in their own notes:', ...noted.map((q) => `- ${q}`))
  }
  return parts.join('\n')
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

/** A line with a little either side of it, the cited one marked. */
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

/* ---------------------------------------------------------- the owner ---- */

const YOU = new Set(['you', 'me', 'myself', 'yourself'])
const FAR_SIDE = new Set(['them', 'they', 'he', 'she', 'him', 'her'])
const NOBODY_IN_PARTICULAR = new Set([
  'we',
  'us',
  'everyone',
  'everybody',
  'someone',
  'somebody',
  'anyone',
  'team',
  'the team',
  'all',
  'both',
])

/**
 * Who a task belongs to, in the transcript's own words.
 *
 * THE CHECKER'S OWNER IS A CLAIM, NOT A FACT. On a real meeting it came back as
 * "I", "them", "Them" and "Zhaal" - the last a misheard word promoted to a
 * person and handed a task. So:
 *
 * - A pronoun is resolved against who SPOKE the line. "I" on the far side is
 *   Them; "I" in your own notes is You. "You" is always the person recording.
 * - "We" and "the team" are nobody in particular, which is what unassigned is.
 * - A name is kept only if it appears in the lines the checker was shown. A
 *   name nobody said is one the model supplied, and moving work to somebody who
 *   never heard about it is worse than leaving it unassigned.
 *
 * What this cannot catch is a name the English pass invented and wrote into the
 * line itself: the check is against the text the model read, and that text
 * already says it.
 */
export function resolveOwner(
  owner: string | null,
  speaker: MeetingChannel | 'notes',
  said: string
): string | null {
  const who = owner?.trim() ?? ''
  if (!who) return null
  const lower = who.toLowerCase()
  if (YOU.has(lower)) return 'You'
  if (lower === 'i') return speaker === 'them' ? 'Them' : 'You'
  if (FAR_SIDE.has(lower)) return speaker === 'notes' ? null : 'Them'
  if (NOBODY_IN_PARTICULAR.has(lower)) return null

  const heard = new Set(said.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u))
  const parts = lower.split(/[\s,&/]+/).filter((part) => part.length >= 3)
  return parts.some((part) => heard.has(part)) ? who : null
}

/* ----------------------------------------------------- the same task ---- */

/** What two tasks are compared on. */
export interface TaskProbe {
  text: string
  /** The line it cites; null for a task from your own notes. */
  segmentId: number | null
  quote: string
  /** When that line was said; null for your notes. */
  atMs: number | null
}

/** How close two lines have to be for similar wording to mean the same task. */
const NEAR_MS = 120_000

const FILLER = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'and',
  'or',
  'with',
  'from',
  'by',
  'it',
  'its',
  'is',
  'be',
  'this',
  'that',
  'will',
  'would',
  'should',
  'can',
  'need',
  'needs',
  'i',
  'we',
  'you',
  'they',
  'them',
])

export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter((word) => word.length > 1 && !FILLER.has(word))
  )
}

/** Shared words over all words: 1 is the same words in any order. */
function similarity(a: string, b: string): number {
  const x = contentWords(a)
  const y = contentWords(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / (x.size + y.size - shared)
}

/** Shared words, over all words, above which two written-up titles are one job. */
const SAME_TITLE = 0.6

/**
 * Two written-up tasks that are one job, found in parts far apart and grouped
 * apart: "Rename bot to Finch Bot" from minute four and "Rename chatbot to Bump
 * Bot" from minute seventeen. By then the write-up has named each one, so
 * nearly the same title is the same work, however far apart it came up.
 */
export function sameTitle(a: string, b: string): boolean {
  return similarity(a, b) >= SAME_TITLE
}

/** The same quoted words, or one quote sitting inside the other. */
function sameQuote(a: string, b: string): boolean {
  const x = bare(a)
  const y = bare(b)
  if (x.length < 8 || y.length < 8) return false
  return x.includes(y) || y.includes(x)
}

/**
 * Whether two tasks are one task said twice.
 *
 * Exact text was the only check, and a real meeting produced "will check on the
 * leader board page" and "will check in the leader board page" twenty-five
 * seconds apart, plus a third task quoting the same words of the same line.
 * Three rules, each narrow:
 *
 * - The same line and the same quoted words: one piece of evidence proves one
 *   commitment, however many ways it is paraphrased.
 * - The same line and mostly the same words.
 * - Lines within two minutes and nearly the same words. People restate what
 *   they have just agreed; the same thing agreed again an hour later is worth
 *   keeping as its own.
 *
 * A task from your notes has no time, so it is compared on its words alone.
 */
export function isDuplicate(a: TaskProbe, b: TaskProbe): boolean {
  if (a.segmentId !== null && a.segmentId === b.segmentId) {
    return sameQuote(a.quote, b.quote) || similarity(a.text, b.text) >= 0.5
  }
  const words = similarity(a.text, b.text)
  if (a.atMs === null || b.atMs === null) return words >= 0.6
  return Math.abs(a.atMs - b.atMs) <= NEAR_MS && words >= 0.6
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
