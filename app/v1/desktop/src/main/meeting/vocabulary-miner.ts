import { estimateTokens, VOCABULARY_MINE_SYSTEM, type LlmClient } from '@wouice/llm'
import type { VocabularyEntry, VocabularyKind } from '@wouice/store'
import { soundKey, wordsOf } from './phonetic.js'

/**
 * After a meeting: what its transcript suggests for your vocabulary.
 *
 * Two kinds of finding - a name or term you do not have yet, and a word that
 * looks like an entry you do have, misheard ("Lord" where Claude makes sense).
 * Each is checked against the line it quotes, exactly as a task is: a finding
 * whose quote is not in the line it names, or whose word is not in its quote's
 * line, is dropped. What survives goes to `Vocabulary.propose`, which decides
 * whether it has earned a place in front of you. See docs/design/09-vocabulary.md.
 */

export interface MinedItem {
  type: 'new' | 'heard'
  /** The new word, or the entry a mishearing belongs to, spelled as the entry is. */
  term: string
  /** The mishearing, for 'heard'. */
  heard: string
  kind: VocabularyKind
  lineId: number
  quote: string
}

export interface MineInput {
  lines: readonly { id: number; text: string; speaker: string | null }[]
  known: readonly VocabularyEntry[]
  signal?: AbortSignal
  /**
   * No new part is started after this long, and what was found is kept: the
   * card is held from dictation meanwhile, and a long meeting's 147 s was too
   * much for suggestions. Default 60 s.
   */
  budgetMs?: number
}

const BUDGET_MS = 60_000

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]!
}

/**
 * Does the word the model calls a mishearing sound like the entry? Checked on
 * the same sound keys the matching uses, because the model's judgement alone
 * was not enough: asked for mishearings, it offered "Jack" for Claude, "eyes"
 * for FAQ and "open it again" for OpenAI. At most one sound apart, and never
 * more than a third of the longer key: "coin" and Qwen, "AskThomp" and Ask
 * Bump. Between short keys only a sound added or dropped ("kn", "kvn"), never
 * one changed: "bum" and Bible ("bm", "bl") are half a word apart. "Lord" and
 * Claude are two apart - that kind is yours to add.
 */
export function soundsLike(heard: string, term: string): boolean {
  const key = (s: string): string => wordsOf(s).map(soundKey).join('')
  const a = key(heard)
  const b = key(term)
  if (a.length < 2 || b.length < 2) return false
  const apart = distance(a, b)
  if (Math.min(a.length, b.length) <= 2) return apart <= 1 && apart === Math.abs(a.length - b.length)
  return apart <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 3))
}

/** Words of transcript per request: a few minutes of a meeting, with room for the vocabulary and the answer. */
const PART_TOKENS = 1800
/** The vocabulary shown with each part: enough to recognise a mishearing, few enough to leave room. */
const MAX_KNOWN = 150
const MAX_ANSWER_TOKENS = 500

/** For comparing a quote with its line: a model quoting drops and adds commas freely, and that is not a misquote. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()

/** New names kept from one meeting, the most mentioned first: a garbled meeting offered 63, nearly all noise. */
const MAX_NEW = 10

/**
 * A name is written as one in the English - capitalised, or with a digit
 * ("iPhone 17"). Meeting 10's noise was mostly lower case: "pink pong", "net
 * raio", "pint". Looked up as the line writes it, not as the model returned it.
 */
function writtenAsName(term: string, line: string): boolean {
  const at = line.toLowerCase().indexOf(term.toLowerCase())
  const spelled = at >= 0 ? line.slice(at, at + term.length) : term
  return /[\p{Lu}\p{N}]/u.test(spelled)
}

/** A term that repeats itself inside its own line ("Ajay Ajay Ajay") is noise, whatever the model thought. */
function repeatsIn(term: string, line: string): boolean {
  const t = norm(term)
  if (!t) return false
  return norm(line).split(t).length - 1 >= 3
}

/**
 * The findings in one answer, kept only when they hold up: a known line, a
 * quote that is in that line, and the word in it; a mishearing only of an entry
 * that exists, by a word that is not that entry.
 */
export function parseMined(
  raw: string,
  lines: readonly { id: number; text: string }[],
  known: readonly VocabularyEntry[]
): MinedItem[] {
  const byTerm = new Map(known.filter((e) => e.state === 'active').map((e) => [e.term.toLowerCase(), e]))
  const everyTerm = new Set(known.map((e) => e.term.toLowerCase()))
  const out: MinedItem[] = []
  for (const text of raw.split(/\r?\n/)) {
    const json = /\{.*\}/.exec(text)?.[0]
    if (!json) continue
    let item: Record<string, unknown>
    try {
      item = JSON.parse(json) as Record<string, unknown>
    } catch {
      continue
    }
    const at = typeof item.line === 'number' ? item.line : Number(item.line)
    const line = lines[at - 1]
    const quote = typeof item.quote === 'string' ? item.quote.trim() : ''
    if (!line || !quote || !norm(line.text).includes(norm(quote))) continue

    if (item.type === 'new') {
      const term = typeof item.term === 'string' ? item.term.trim() : ''
      if (term.length < 2 || term.length > 60 || everyTerm.has(term.toLowerCase())) continue
      if (!norm(line.text).includes(norm(term)) || repeatsIn(term, line.text) || !writtenAsName(term, line.text)) continue
      const kind = typeof item.kind === 'string' && ['person', 'product', 'tool', 'term', 'place'].includes(item.kind) ? item.kind : 'term'
      out.push({ type: 'new', term, heard: '', kind: kind as VocabularyKind, lineId: line.id, quote })
    } else if (item.type === 'heard') {
      const entry = typeof item.entry === 'string' ? byTerm.get(item.entry.trim().toLowerCase()) : undefined
      const heard = typeof item.as === 'string' ? item.as.trim() : ''
      if (!entry || heard.length < 2) continue
      // A word with the entry inside it, or inside the entry, is another word: "Finchy" was a name the
      // meeting proposed, not Bump misheard.
      const [h, t] = [norm(heard), norm(entry.term)]
      if (h.includes(t) || t.includes(h)) continue
      if (!norm(line.text).includes(h) || !soundsLike(heard, entry.term)) continue
      out.push({ type: 'heard', term: entry.term, heard, kind: entry.kind, lineId: line.id, quote })
    }
  }
  return out
}

export class VocabularyMiner {
  constructor(private readonly llm: () => LlmClient) {}

  async mine(input: MineInput): Promise<MinedItem[]> {
    const lines = input.lines.filter((l) => l.text.trim())
    if (lines.length === 0) return []
    const known = input.known
      .filter((e) => e.state === 'active')
      .sort((a, b) => b.meetings - a.meetings || b.hits - a.hits)
      .slice(0, MAX_KNOWN)
    const vocabulary = known.map((e) => e.term).join(', ') || '(empty)'

    // Parts by size, so a long meeting is read a few minutes at a time.
    const parts: (typeof lines)[] = []
    let part: (typeof lines)[number][] = []
    let size = 0
    for (const line of lines) {
      const cost = estimateTokens(line.text) + 6
      if (part.length > 0 && size + cost > PART_TOKENS) {
        parts.push(part)
        part = []
        size = 0
      }
      part.push(line)
      size += cost
    }
    if (part.length > 0) parts.push(part)

    const found: MinedItem[] = []
    const started = Date.now()
    for (const [i, lines] of parts.entries()) {
      input.signal?.throwIfAborted()
      if (i > 0 && Date.now() - started >= (input.budgetMs ?? BUDGET_MS)) break
      const user = [
        `Vocabulary: ${vocabulary}`,
        '',
        'Transcript:',
        ...lines.map((l, i) => `[${i + 1}] ${l.speaker ? `(${l.speaker}) ` : ''}${l.text}`),
      ].join('\n')
      try {
        const result = await this.llm().complete({
          system: VOCABULARY_MINE_SYSTEM,
          user,
          maxTokens: MAX_ANSWER_TOKENS,
          temperature: 0,
          firstTokenTimeoutMs: 60_000,
          stallTimeoutMs: 20_000,
          timeoutMs: 120_000,
          signal: input.signal,
        })
        found.push(...parseMined(result.text, lines, input.known))
      } catch (err) {
        if (input.signal?.aborted) throw err
        // One part that could not be read costs its findings, nothing more.
        console.warn('[vocabulary] could not read part of a meeting for names:', err instanceof Error ? err.message : err)
      }
    }

    // Each finding once per meeting: the first line it came up in.
    const seen = new Set<string>()
    const once = found.filter((f) => {
      const key = `${f.type}|${f.term.toLowerCase()}|${f.heard.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    // Every mishearing of an entry you have; of the new names, only the ones
    // the meeting mentions most.
    const said = lines.map((l) => norm(l.text)).join(' ')
    const mentions = (term: string): number => said.split(norm(term)).length - 1
    const fresh = once
      .filter((f) => f.type === 'new')
      .sort((a, b) => mentions(b.term) - mentions(a.term))
      .slice(0, MAX_NEW)
    return once.filter((f) => f.type === 'heard' || fresh.includes(f))
  }
}
