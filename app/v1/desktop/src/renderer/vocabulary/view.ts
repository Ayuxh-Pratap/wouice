import type { VocabularyDraft, VocabularyEntry, VocabularyKind, VocabularySuggestion } from '../../shared/ipc.js'

/**
 * What the Vocabulary page shows, worked out without React: which tab holds
 * what, what a search finds, how an entry's history reads, which key answers a
 * suggestion. Apart from the components so it can be tested, and so they only
 * draw. See docs/design/10-vocabulary-page.md.
 */

export const KINDS: readonly VocabularyKind[] = ['person', 'product', 'tool', 'term', 'place']

export const KIND_LABEL: Record<VocabularyKind, { tab: string; one: string }> = {
  person: { tab: 'People', one: 'Person' },
  product: { tab: 'Products', one: 'Product' },
  tool: { tab: 'Tools', one: 'Tool' },
  term: { tab: 'Terms', one: 'Term' },
  place: { tab: 'Places', one: 'Place' },
}

export type TabId = 'all' | VocabularyKind | 'not'

export const EMPTY_DRAFT: VocabularyDraft = { term: '', kind: 'term', aliases: [], meaning: '', pinned: false }

const active = (entries: readonly VocabularyEntry[]): VocabularyEntry[] => entries.filter((e) => e.state === 'active')
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * The tabs over the table. Places and Not words only when they hold
 * something: an empty tab is a question with nothing behind it.
 */
export function tabsFor(entries: readonly VocabularyEntry[], notWords: number): { id: TabId; label: string; badge: number }[] {
  const words = active(entries)
  const count = (kind: VocabularyKind): number => words.filter((e) => e.kind === kind).length
  return [
    { id: 'all', label: 'All', badge: words.length },
    ...KINDS.filter((kind) => kind !== 'place' || count(kind) > 0).map((kind) => ({
      id: kind as TabId,
      label: KIND_LABEL[kind].tab,
      badge: count(kind),
    })),
    ...(notWords > 0 ? [{ id: 'not' as TabId, label: 'Not words', badge: notWords }] : []),
  ]
}

/** A search finds a word by its spelling, a sound-alike, or its meaning. */
export function matches(entry: VocabularyEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    entry.term.toLowerCase().includes(q) ||
    entry.meaning.toLowerCase().includes(q) ||
    entry.aliases.some((a) => a.text.toLowerCase().includes(q))
  )
}

/** The words a tab shows, for a search. */
export function wordsIn(tab: TabId, entries: readonly VocabularyEntry[], query: string): VocabularyEntry[] {
  return active(entries).filter((e) => (tab === 'all' || e.kind === tab) && matches(e, query))
}

/** The line above the table: "59 words · 4 from Meet · 2 always sent". */
export function summary(entries: readonly VocabularyEntry[]): string {
  const words = active(entries)
  const meet = words.filter((e) => e.source === 'roster').length
  const pinned = words.filter((e) => e.pinned).length
  return [plural(words.length, 'word'), meet > 0 ? `${meet} from Meet` : '', pinned > 0 ? `${pinned} always sent` : '']
    .filter(Boolean)
    .join(' · ')
}

const DAY = 86_400_000
const startOfDay = (at: number): number => new Date(at).setHours(0, 0, 0, 0)

/** For a column: "today", "3d", "2w", then a date. */
export function shortAgo(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY)
  if (days <= 0) return 'today'
  if (days < 7) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** For a sentence: "today", "yesterday", "Tue", then a date. */
export function lastDay(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return new Date(at).toLocaleDateString(undefined, { weekday: 'short' })
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The Seen column: meetings it came up in, and when last. "5 · 2d", or "—". */
export function seenLabel(entry: VocabularyEntry, now = Date.now()): string {
  if (entry.meetings === 0 || entry.lastSeenAt === null) return '—'
  return `${entry.meetings} · ${shortAgo(entry.lastSeenAt, now)}`
}

const SOURCE: Record<VocabularyEntry['source'], string> = {
  you: 'added by you',
  roster: 'from a Meet call',
  learned: 'learned from your meetings',
  shipped: 'built in',
}

/** Under the editor: "5 meetings, last Tue · added by you". */
export function historyLine(entry: VocabularyEntry, now = Date.now()): string {
  const seen =
    entry.meetings === 0 || entry.lastSeenAt === null
      ? 'Not in a meeting yet'
      : `${plural(entry.meetings, 'meeting')}, last ${lastDay(entry.lastSeenAt, now)}`
  return `${seen} · ${SOURCE[entry.source]}`
}

/** Under a suggestion: "2 meetings · last Tue". */
export function reviewMeta(s: VocabularySuggestion, now = Date.now()): string {
  const last = s.evidence.reduce((latest, e) => Math.max(latest, e.at), 0)
  return plural(s.meetings, 'meeting') + (last > 0 ? ` · last ${lastDay(last, now)}` : '')
}

/** The suggestion's latest quote, split around its word so the word can be marked. */
export function quoteParts(s: VocabularySuggestion): { before: string; word: string; after: string } | null {
  const quote = s.evidence[s.evidence.length - 1]?.quote
  if (!quote) return null
  const word = s.type === 'new' ? s.term : s.heard
  const at = quote.toLowerCase().indexOf(word.toLowerCase())
  if (at < 0) return { before: quote, word: '', after: '' }
  return { before: quote.slice(0, at), word: quote.slice(at, at + word.length), after: quote.slice(at + word.length) }
}

export type ReviewAction = 'add' | 'edit' | 'reject' | 'prev' | 'next'

/** A key on the review card - never while typing, or with a modifier held. */
export function reviewKey(key: string, modified: boolean, typing: boolean): ReviewAction | null {
  if (modified || typing) return null
  switch (key.toLowerCase()) {
    case 'y':
      return 'add'
    case 'e':
      return 'edit'
    case 'n':
      return 'reject'
    case 'arrowleft':
      return 'prev'
    case 'arrowright':
      return 'next'
    default:
      return null
  }
}

/** The editor, filled from a suggestion: a new word as found, a sound-alike added to its entry. */
export function draftFor(s: VocabularySuggestion, entries: readonly VocabularyEntry[]): VocabularyDraft {
  if (s.type === 'new') return { ...EMPTY_DRAFT, term: s.term, kind: s.kind }
  const heard = { text: s.heard, rewrite: false }
  const e = entries.find((x) => x.term.toLowerCase() === s.term.toLowerCase())
  return e
    ? { id: e.id, term: e.term, kind: e.kind, aliases: [...e.aliases, heard], meaning: e.meaning, pinned: e.pinned }
    : { ...EMPTY_DRAFT, term: s.term, kind: s.kind, aliases: [heard] }
}

/** A word that is out: a suggestion you turned down, or a Meet name you removed. */
export interface NotWord {
  key: string
  term: string
  why: string
  undo: { suggestion: number } | { entry: VocabularyEntry }
}

export function notWords(entries: readonly VocabularyEntry[], suggestions: readonly VocabularySuggestion[]): NotWord[] {
  return [
    ...entries
      .filter((e) => e.state === 'rejected')
      .map((e) => ({
        key: `e${e.id}`,
        term: e.term,
        why: e.source === 'roster' ? 'removed from a Meet call' : 'removed',
        undo: { entry: e },
      })),
    ...suggestions
      .filter((s) => s.state === 'rejected')
      .map((s) => ({
        key: `s${s.id}`,
        term: s.type === 'new' ? s.term : s.heard,
        why: s.type === 'new' ? 'turned down' : `heard as → ${s.term}, turned down`,
        undo: { suggestion: s.id },
      })),
  ].sort((a, b) => a.term.localeCompare(b.term))
}
