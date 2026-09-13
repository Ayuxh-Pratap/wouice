import type { DictionaryEntry } from '@wouice/dictionary'
import type { VocabularyEntry, VocabularyUse } from '@wouice/store'
import { prepare, soundsIn } from './phonetic.js'

/**
 * What the vocabulary gives each request: the entries the text calls for,
 * written the way the models can use them. See docs/design/09-vocabulary.md.
 *
 * NOT THE WHOLE LIST. Every product and paper on this says the same: a long
 * list sent with everything makes the model "correct" words into names nobody
 * said. So a request gets only the entries whose spelling or sound-alike is in
 * its own text, the pinned ones, and the people in the meeting.
 *
 * WITH WHAT THEY SOUND LIKE. "Claude" alone did not undo Meet's "लॉर्ड";
 * "Claude (heard as: Lord, लॉर्ड)" tells the model which mishearing is which.
 */

/** Entries per request: enough for a busy stretch of a meeting, few enough not to crowd it. */
export const MAX_PER_REQUEST = 30

export interface Choice {
  /** Who is in the meeting: their entries are always sent. */
  people?: readonly string[]
  cap?: number
  /** Add each entry's meaning - for the notes, not for the English. */
  meanings?: boolean
}

const LETTER = /[\p{L}\p{N}]/u

/**
 * Is this word or phrase in the text? Whole words for Latin script, so "Bump"
 * is not found inside "Finchy"; as a run of characters for Devanagari, where the
 * recogniser joins and splits words freely.
 */
export function appears(needle: string, text: string): boolean {
  const n = needle.trim().toLowerCase()
  if (!n) return false
  const hay = text.toLowerCase()
  if (/[ऀ-ॿ]/.test(n)) return hay.includes(n)
  let from = 0
  for (;;) {
    const at = hay.indexOf(n, from)
    if (at < 0) return false
    const before = at === 0 ? '' : hay[at - 1]!
    const after = hay[at + n.length] ?? ''
    if (!LETTER.test(before) && !LETTER.test(after)) return true
    from = at + 1
  }
}

/**
 * The entries whose spelling or any sound-alike is in the text - as spelled, or
 * by sound across Devanagari and Latin (see phonetic.ts), so "Lord" typed once
 * finds "लॉर्ड" in the captions and "Claude" finds "क्लॉड".
 */
export function mentionedIn(text: string, entries: readonly VocabularyEntry[]): VocabularyEntry[] {
  const prepared = prepare(text)
  return entries.filter(
    (e) => e.state === 'active' && [e.term, ...e.aliases.map((a) => a.text)].some((form) => soundsIn(form, prepared))
  )
}

/** Seen in a meeting this recently, an entry ranks above the ones that have gone quiet. */
const FRESH_MS = 90 * 86_400_000

/**
 * The entries this stretch of text calls for, most relevant first, at most
 * `cap`: the ones it mentions (as spelled or by sound), the ones you pinned,
 * and the people on the call. Nothing else - no filling up to the cap. Filled,
 * meeting 10's English had "Atlas" four times, "Claude reads" and "Gemini", each
 * put on a garbled word that only resembled a name in the list.
 */
export function entriesFor(text: string, entries: readonly VocabularyEntry[], choice: Choice = {}): VocabularyEntry[] {
  const active = entries.filter((e) => e.state === 'active')
  const people = (choice.people ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean)
  const inMeeting = (e: VocabularyEntry): boolean => {
    const term = e.term.toLowerCase()
    return people.some((p) => p === term || (e.kind === 'person' && (p.startsWith(`${term} `) || term.startsWith(`${p} `))))
  }
  const mentioned = new Set(mentionedIn(text, active).map((e) => e.id))
  const weight = (e: VocabularyEntry): number =>
    (mentioned.has(e.id) ? 4 : 0) + (e.pinned ? 2 : 0) + (inMeeting(e) ? 2 : 0)
  // Fading: an entry nobody has said in three months still counts, below the live ones.
  const now = Date.now()
  const fresh = (e: VocabularyEntry): number => (e.lastSeenAt !== null && now - e.lastSeenAt < FRESH_MS ? 1 : 0)
  const byUse = (a: VocabularyEntry, b: VocabularyEntry): number =>
    fresh(b) - fresh(a) || b.meetings - a.meetings || b.hits - a.hits || a.term.localeCompare(b.term)
  return active
    .filter((e) => weight(e) > 0)
    .sort((a, b) => weight(b) - weight(a) || byUse(a, b))
    .slice(0, choice.cap ?? MAX_PER_REQUEST)
}

/** One entry as the models see it: "Claude (heard as: Lord, लॉर्ड; means: the AI we build with)". */
export function referenceLine(entry: VocabularyEntry, meanings = false): string {
  const parts: string[] = []
  const heard = entry.aliases.map((a) => a.text).filter(Boolean)
  if (heard.length > 0) parts.push(`heard as: ${heard.join(', ')}`)
  if (meanings && entry.meaning.trim()) parts.push(`means: ${entry.meaning.trim()}`)
  return parts.length > 0 ? `${entry.term} (${parts.join('; ')})` : entry.term
}

/**
 * For the engines: given a stretch of text, the reference lines it calls for.
 * A meaning only for an entry the text mentions: sent for one it does not, it
 * reads as a topic, and meeting 16's summary had "the Bible" as the data source
 * of a meeting that never said the word.
 */
export function glossaryFor(entries: readonly VocabularyEntry[], choice: Choice = {}): (text: string) => string[] {
  return (text) => linesFor(text, entries, choice)
}

function linesFor(
  text: string,
  entries: readonly VocabularyEntry[],
  choice: Choice,
  onUse?: (sent: readonly VocabularyEntry[]) => void
): string[] {
  const list = entriesFor(text, entries, choice)
  onUse?.(list)
  const said = choice.meanings ? new Set(mentionedIn(text, list).map((e) => e.id)) : new Set<number>()
  return list.map((e) => referenceLine(e, said.has(e.id)))
}

/** `glossaryFor`, keeping every entry it hands out - for the run's record. */
export function trackedGlossary(
  entries: readonly VocabularyEntry[],
  choice: Choice = {}
): { glossary: (text: string) => string[]; used(): VocabularyEntry[] } {
  const used = new Map<number, VocabularyEntry>()
  return {
    glossary: (text) => linesFor(text, entries, choice, (sent) => sent.forEach((e) => used.set(e.id, e))),
    used: () => [...used.values()],
  }
}

/** The English of a line is written with the lines before it in view: a name said there counts. */
const HEARD_BEFORE = 2
const CHECK_SHOWN = 5
const clip = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * What the vocabulary did to an English run. For every entry that was sent,
 * or that the English wrote anyway: the lines that said it, the lines that
 * wrote it, which heard-as forms turned up, and the lines that wrote it though
 * nothing said there (or just before) sounded like it. Those last are how
 * meeting 10's four invented "Atlas" would have shown without reading 514
 * lines. See docs/design/09-vocabulary.md §7.
 */
export function vocabularyUse(
  lines: readonly { startMs: number; text: string; textEn: string | null }[],
  sent: readonly VocabularyEntry[],
  entries: readonly VocabularyEntry[],
  at = Date.now()
): VocabularyUse {
  const spoken = lines.map((l) => prepare(l.text))
  const sentIds = new Set(sent.map((e) => e.id))
  const report: VocabularyUse['entries'] = []
  for (const e of entries) {
    if (e.state !== 'active') continue
    const forms = [e.term, ...e.aliases.map((a) => a.text)]
    const saidAt = spoken.map((p) => forms.some((f) => soundsIn(f, p)))
    const writtenAt = lines.map((l) => l.textEn !== null && appears(e.term, l.textEn))
    const said = saidAt.filter(Boolean).length
    const written = writtenAt.filter(Boolean).length
    if (written === 0 && (said === 0 || !sentIds.has(e.id))) continue
    const unheardAt = lines.flatMap((l, i) =>
      writtenAt[i] && !saidAt.slice(Math.max(0, i - HEARD_BEFORE), i + 1).some(Boolean)
        ? [{ atMs: l.startMs, said: clip(l.text), written: clip(l.textEn ?? '') }]
        : []
    )
    report.push({
      term: e.term,
      said,
      written,
      as: e.aliases.map((a) => a.text).filter((f) => spoken.some((p) => soundsIn(f, p))),
      unheard: unheardAt.length,
      check: unheardAt.slice(0, CHECK_SHOWN),
    })
  }
  report.sort((a, b) => b.unheard - a.unheard || b.written - a.written || a.term.localeCompare(b.term))
  return { at, sent: sent.length, entries: report }
}

/** A pasted entry: the word, and its meaning when the line gave one. */
export interface Pasted {
  term: string
  meaning: string
}

/**
 * At most this many from one paste. The vocabulary itself has no limit - each
 * request only gets what its text calls for - so this only stops a pasted
 * document being taken for a list.
 */
const MAX_PASTED = 2000

/**
 * A pasted list. One entry a line - "Bible - the team's knowledge base" or
 * "Bible: the team's knowledge base" gives a meaning with it - or a line of
 * comma-separated words, like the list from a chat. Each term once.
 */
export function parseVocabularyList(text: string): Pasted[] {
  const out: Pasted[] = []
  const seen = new Set<string>()
  const push = (term: string, meaning = ''): void => {
    const t = term.trim().replace(/^[-*•\d.)\s]+/, '').trim().slice(0, 60)
    if (!t || seen.has(t.toLowerCase()) || out.length >= MAX_PASTED) return
    seen.add(t.toLowerCase())
    out.push({ term: t, meaning: meaning.trim() })
  }
  for (const line of text.split(/\r?\n/)) {
    const bare = line.trim()
    if (!bare) continue
    // "Term - meaning" or "Term: meaning", when the meaning is words rather than more terms.
    const split = /^(.{1,60}?)\s+[-–—]\s+(.+)$/.exec(bare) ?? /^([^:,]{1,60}):\s+(.+)$/.exec(bare.replace(/^[-*•]\s*/, ''))
    if (split && !split[2]!.includes(',') && split[2]!.split(/\s+/).length >= 2) {
      push(split[1]!, split[2]!)
      continue
    }
    for (const part of bare.split(/[,;]+/)) push(part)
  }
  return out
}

/**
 * The kinds the language model gave a pasted list, one JSON object a line.
 * Anything it did not answer for, or answered oddly, is a plain term.
 */
export function parseKinds(raw: string, terms: readonly string[]): Map<string, VocabularyEntry['kind']> {
  const kinds = new Map<string, VocabularyEntry['kind']>()
  const wanted = new Map(terms.map((t) => [t.toLowerCase(), t]))
  for (const line of raw.split(/\r?\n/)) {
    const json = /\{[^{}]*\}/.exec(line)?.[0]
    if (!json) continue
    try {
      const parsed = JSON.parse(json) as { term?: unknown; kind?: unknown }
      const term = typeof parsed.term === 'string' ? wanted.get(parsed.term.trim().toLowerCase()) : undefined
      const kind = typeof parsed.kind === 'string' ? parsed.kind.trim().toLowerCase() : ''
      if (term && ['person', 'product', 'tool', 'term', 'place'].includes(kind)) {
        kinds.set(term, kind as VocabularyEntry['kind'])
      }
    } catch {
      // One unreadable line costs that term its kind, nothing more.
    }
  }
  return kinds
}

/**
 * The vocabulary as dictation's dictionary. Every entry is a hint to the
 * recogniser; a sound-alike marked always-rewrite is also a correction - and
 * only those, so "coin" for Qwen never rewrites the word coin.
 */
export function asDictionary(entries: readonly VocabularyEntry[]): DictionaryEntry[] {
  const out: DictionaryEntry[] = []
  for (const e of entries) {
    if (e.state !== 'active') continue
    for (const a of e.aliases) {
      if (a.rewrite) out.push({ kind: 'correction', hear: a.text, write: e.term, enabled: true, hits: e.hits })
    }
    out.push({ kind: 'term', hear: e.term, enabled: true, hits: e.hits + e.meetings })
  }
  return out
}
