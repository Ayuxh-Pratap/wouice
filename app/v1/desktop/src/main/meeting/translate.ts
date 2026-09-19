import { estimateTokens } from '@wouice/llm'
import { CHUNK_TOKEN_BUDGET } from './notes.js'

/**
 * Rendering a transcript into English: the parts that are arithmetic and
 * parsing rather than a model call.
 *
 * ONE LINE IN, ONE LINE OUT, MATCHED BY NUMBER. A meeting transcript is a
 * sequence of moments, each belonging to one person. A renderer that merged two
 * lines would lose who said what and when, and the segment timings would stop
 * pointing at the audio they came from. So the mapping is explicit, and a line
 * the model did not return simply keeps its original text rather than being
 * replaced by a guess.
 */

export interface Line {
  id: number
  text: string
  /** Who said it, when known. Shown to the model as context; never rendered. */
  speaker?: string | null
}

export interface Rendered {
  id: number
  textEn: string
}

/** Reserve for the answer, which is about as long as the input. */
const OUTPUT_SHARE = 0.55

/**
 * Lines per request: one.
 *
 * MEASURED, NOT GUESSED, TWICE. Handed twenty numbered lines, qwen3-4b stops
 * translating and starts TRANSLITERATING - "कि इतने सारी फेलियर" comes back as
 * "Ki itne saari failiyar", which is the same sounds in Latin letters and is
 * not English. Handed six, in a real call, it merged a line that ended
 * mid-sentence into the next and gave every later line the English of the one
 * after it: the right words on the wrong lines, which the numbers cannot catch
 * and which "Redo English" repeated exactly. One line per request cannot
 * drift. What the neighbours gave - "हाँ वही" renders very differently
 * depending on what came before it - is kept by showing the lines before it
 * as context (see `renderBatch`).
 */
const MAX_LINES_PER_BATCH = 1

/**
 * Group lines into batches the model can hold with room to answer.
 *
 * Batched rather than one call per line for the obvious reason - a hundred
 * round trips over a meeting - and also because neighbouring lines are the only
 * context this has. "हाँ वही" renders very differently depending on what came
 * before it.
 */
export function batchLines(
  lines: readonly Line[],
  budget: number = Math.floor(CHUNK_TOKEN_BUDGET * OUTPUT_SHARE),
  maxLines: number = MAX_LINES_PER_BATCH
): Line[][] {
  const batches: Line[][] = []
  let current: Line[] = []
  let tokens = 0

  for (const line of lines) {
    if (!line.text.trim()) continue
    const cost = estimateTokens(`[${line.id}] ${line.text}`)
    if (current.length > 0 && (tokens + cost > budget || current.length >= maxLines)) {
      batches.push(current)
      current = []
      tokens = 0
    }
    current.push(line)
    tokens += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * A batch as the model reads it: each line numbered and named, after the lines
 * said just before it, marked as context. A reply - "हाँ वही", "मैं कर दूंगा" -
 * means little without what it answers, and the first line of a batch would
 * otherwise have nothing before it.
 */
export function renderBatch(batch: readonly Line[], before: readonly Line[] = []): string {
  const numbered = batch.map((line) => `[${line.id}] ${named(line)}${line.text}`)
  if (before.length === 0) return numbered.join('\n')
  return [
    'Before this (context only):',
    ...before.map((line) => `${named(line)}${tail(line.text)}`),
    '',
    'Render only this:',
    ...numbered,
  ].join('\n')
}

/**
 * Words of each earlier line shown as context: its end, nearest the line being
 * rendered. Shown whole, a sixty-word line before a two-word "ठीक है" was
 * rendered in its place.
 */
const CONTEXT_WORDS = 20

function tail(text: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  return words.length <= CONTEXT_WORDS ? words.join(' ') : `… ${words.slice(-CONTEXT_WORDS).join(' ')}`
}

function named(line: Line): string {
  return line.speaker ? `(${line.speaker}) ` : ''
}

/** The name a line was shown with, when the model repeats it back despite being told not to. */
function withoutName(text: string, name: string | null | undefined): string {
  if (!name) return text
  for (const prefix of [`(${name})`, `${name}:`]) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).trim()
  }
  return text
}

/**
 * Read the rendered lines back, keeping only ones we asked for.
 *
 * A number that was not in the batch is dropped. The model cannot have rendered
 * a line it was never shown, so a citation to one is an invention - and the
 * cost of dropping it is that the raw line stands alone, which is the safe
 * failure.
 */
export function parseEnglish(raw: string, batch: readonly Line[]): Rendered[] {
  const allowed = new Map(batch.map((line) => [line.id, line.text]))
  const speakers = new Map(batch.map((line) => [line.id, line.speaker]))
  // Each answer, with any lines that ran on under its number.
  const out: { id: number; textEn: string; more: string[] }[] = []
  const seen = new Set<number>()
  let numbered = false
  let open: (typeof out)[number] | null = null

  for (const line of raw.split('\n')) {
    const match = /^\s*\[(\d{1,10})\]\s*(.*)$/.exec(line)
    if (!match) {
      // A blank line ends an answer: what follows is not the line's.
      const more = line.trim()
      if (!more) open = null
      else if (open) open.more.push(more)
      continue
    }
    numbered = true
    open = null

    const id = Number(match[1])
    if (!allowed.has(id) || seen.has(id)) continue

    const text = withoutName(match[2]!.trim(), speakers.get(id))
    // An empty answer is the model saying it could not carry the meaning. The
    // raw line stays, which is better than an invented English sentence.
    if (!text) continue

    seen.add(id)
    open = { id, textEn: text, more: [] }
    out.push(open)
  }

  // One line asked for, answered without its number: a small model given a
  // single line often just answers, and on a real call two lines stayed in
  // Hindi for it. Unnumbered, the answer can only be that line. A number with
  // nothing after it is still the model saying it could not, and stands.
  const only = batch.length === 1 ? batch[0]! : null
  if (only && !numbered) {
    const [first, ...more] = (raw.trim().split(/\n\s*\n/)[0] ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
    const text = first ? withoutName(first.replace(/^(output|english)\s*:\s*/i, ''), only.speaker) : ''
    if (text) out.push({ id: only.id, textEn: text, more })
  }

  return out.flatMap(({ id, textEn, more }) => {
    const source = allowed.get(id)!
    // The rest of an answer cut short, on the lines after it, is taken only
    // then: taken always, a next line's English written without its number
    // would run into this one.
    for (const text of [textEn, [textEn, ...more].join(' ')]) {
      if (fits(text, source)) return [{ id, textEn: text }]
    }
    // What cannot stand for its line leaves the line as it was said.
    return []
  })
}

/** Below this share of a long line's words, a rendering has lost most of it. */
const SHORTEST = 0.35
/** Only a line this long is judged by it: "अरे भाई साहब" is fairly "Hey brother". */
const SHORT_FROM_WORDS = 8

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length

/**
 * Whether a rendering can stand for its line: not many times longer - the
 * model elaborating rather than translating - and not missing most of it, as a
 * rendering cut off after its first sentence would. Across 486 lines of eight
 * words or more in six meetings, no rendering fell under 0.46 of its line.
 */
function fits(text: string, source: string): boolean {
  if (text.length > Math.max(120, source.length * 4)) return false
  const words = wordCount(source)
  return words < SHORT_FROM_WORDS || wordCount(text) >= words * SHORTEST
}

/** How much of a batch came back usable. Below this the batch is not trusted. */
export const MIN_BATCH_COVERAGE = 0.5

/**
 * Whether a rendered batch is worth keeping.
 *
 * A model that returns three lines for a batch of twenty has lost the format,
 * and the seventeen it dropped would silently stay in Hindi while the three
 * appear in English - a transcript half-rendered in a way nothing reports.
 * Better to keep the whole batch raw and say the pass did not work.
 */
export function batchUsable(batch: readonly Line[], rendered: readonly Rendered[]): boolean {
  if (batch.length === 0) return true
  return rendered.length / batch.length >= MIN_BATCH_COVERAGE
}
