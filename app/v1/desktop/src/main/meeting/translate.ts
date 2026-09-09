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
}

export interface Rendered {
  id: number
  textEn: string
}

/** Reserve for the answer, which is about as long as the input. */
const OUTPUT_SHARE = 0.55

/**
 * Lines per request, and the number matters more than it looks.
 *
 * MEASURED, NOT GUESSED. Handed twenty numbered lines, qwen3-4b stops
 * translating and starts TRANSLITERATING - "कि इतने सारी फेलियर" comes back as
 * "Ki itne saari failiyar", which is the same sounds in Latin letters and is
 * not English. Handed the same line on its own it answers "So many failures,
 * what's going on?". The format instruction appears to crowd out the semantic
 * one as the list grows, so the list stays short. A few neighbours are still
 * worth having: "हाँ वही" renders very differently depending on what came
 * before it.
 */
const MAX_LINES_PER_BATCH = 6

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

export function renderBatch(batch: readonly Line[]): string {
  return batch.map((line) => `[${line.id}] ${line.text}`).join('\n')
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
  const out: Rendered[] = []
  const seen = new Set<number>()

  for (const line of raw.split('\n')) {
    const match = /^\s*\[(\d{1,10})\]\s*(.*)$/.exec(line)
    if (!match) continue

    const id = Number(match[1])
    if (!allowed.has(id) || seen.has(id)) continue

    const text = match[2]!.trim()
    // An empty answer is the model saying it could not carry the meaning. The
    // raw line stays, which is better than an invented English sentence.
    if (!text) continue
    // A rendering many times longer than the line is the model elaborating
    // rather than translating.
    if (text.length > Math.max(120, allowed.get(id)!.length * 4)) continue

    seen.add(id)
    out.push({ id, textEn: text })
  }

  return out
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
