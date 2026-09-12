import type { DictionaryEntry } from './types.js'

/**
 * Build the short glossary string handed to the ASR decoder before it runs.
 *
 * This is the *other* half of the dictionary, and it is only a nudge. Whisper's
 * initial prompt conditions the decoder toward the vocabulary it names, which
 * raises the odds of the right word and guarantees nothing. `correct()` is what
 * guarantees.
 *
 * THE LENGTH CAP IS THE WHOLE POINT. A long initial prompt makes Whisper drift
 * and hallucinate text on quiet audio, inventing sentences from the prompt when
 * there is nothing to transcribe. So this returns the *most valuable* terms that
 * fit, not all of them, and the default budget is deliberately small.
 *
 * Note which side of a correction gets biased: the `write` value. Biasing toward
 * "cloud code" would be asking the engine for the mistake we are about to fix.
 */
export const DEFAULT_BIAS_CHARS = 220

export interface BiasOptions {
  /** Hard character budget for the returned string. */
  maxChars?: number
  /** Prefix, counted against the budget. */
  prefix?: string
  /**
   * Entries that go ahead of all the others, whatever their hits: your own
   * vocabulary before the shipped list. The budget is small, and a colleague's
   * name is worth more of it than a framework you mention once a month.
   */
  preferred?: readonly DictionaryEntry[]
}

/**
 * Priority: entries that have actually fired most often come first, because a
 * term the engine keeps getting wrong is worth more prompt budget than one it
 * has never missed. Ties break alphabetically so the output is deterministic,
 * which matters because a changing prompt changes the transcript.
 */
function rank(entries: readonly DictionaryEntry[]): string[] {
  const seen = new Set<string>()
  const out: { word: string; hits: number }[] = []

  for (const e of entries) {
    if (!e.enabled) continue
    const word = (e.kind === 'correction' ? e.write : e.hear)?.trim()
    if (!word) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ word, hits: e.hits ?? 0 })
  }

  out.sort((a, b) => b.hits - a.hits || a.word.localeCompare(b.word))
  return out.map((x) => x.word)
}

export function biasPrompt(
  entries: readonly DictionaryEntry[],
  options: BiasOptions = {}
): string {
  const maxChars = options.maxChars ?? DEFAULT_BIAS_CHARS
  const prefix = options.prefix ?? 'Glossary: '

  const seen = new Set<string>()
  const words = [...rank(options.preferred ?? []), ...rank(entries)].filter((w) => {
    const key = w.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (words.length === 0) return ''

  const picked: string[] = []
  // +1 for the trailing period.
  let used = prefix.length + 1

  for (const w of words) {
    const cost = w.length + (picked.length ? 2 : 0) // ", "
    if (used + cost > maxChars) break
    picked.push(w)
    used += cost
  }

  if (picked.length === 0) return ''
  return `${prefix}${picked.join(', ')}.`
}
