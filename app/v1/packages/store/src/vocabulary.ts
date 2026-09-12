import { rows, row, type Db } from './db.js'
import {
  VOCABULARY_KINDS,
  type SuggestionEvidence,
  type SuggestionInput,
  type SuggestionState,
  type VocabularySuggestion,
  type VocabularyAlias,
  type VocabularyEntry,
  type VocabularyInput,
  type VocabularyKind,
  type VocabularySource,
  type VocabularyState,
} from './types.js'

/**
 * Your vocabulary: the names and words your meetings and dictation use, what
 * they tend to be misheard as, and what they mean.
 *
 * One list for both, replacing the dictation dictionary and the meetings
 * glossary box - a name taught once is right everywhere. Entries come from your
 * own hands, from the participant list of a Meet call, or (later) from a
 * suggestion you accepted; nothing heard only in recognised speech gets in on
 * its own. See docs/design/09-vocabulary.md.
 */

interface Row {
  id: number
  term: string
  kind: string
  aliases: string
  meaning: string
  source: string
  state: string
  pinned: number
  hits: number
  created_at: number
  updated_at: number
  meetings: number
  last_seen: number | null
}

const SELECT = `
  SELECT v.id, v.term, v.kind, v.aliases, v.meaning, v.source, v.state, v.pinned, v.hits,
         v.created_at, v.updated_at,
         (SELECT COUNT(*) FROM vocabulary_seen s WHERE s.entry_id = v.id) AS meetings,
         (SELECT MAX(s.at) FROM vocabulary_seen s WHERE s.entry_id = v.id) AS last_seen
  FROM vocabulary v`

function aliasesOf(json: string): VocabularyAlias[] {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((a) =>
      a && typeof a === 'object' && typeof (a as VocabularyAlias).text === 'string' && (a as VocabularyAlias).text.trim()
        ? [{ text: (a as VocabularyAlias).text.trim(), rewrite: (a as VocabularyAlias).rewrite === true }]
        : []
    )
  } catch {
    // A hand-edited row that is not JSON loses its sound-alikes, not the entry.
    return []
  }
}

function toEntry(r: Row): VocabularyEntry {
  return {
    id: r.id,
    term: r.term,
    kind: (VOCABULARY_KINDS as readonly string[]).includes(r.kind) ? (r.kind as VocabularyKind) : 'term',
    aliases: aliasesOf(r.aliases),
    meaning: r.meaning,
    source: (['you', 'roster', 'learned', 'shipped'].includes(r.source) ? r.source : 'you') as VocabularySource,
    state: (['active', 'suggested', 'rejected'].includes(r.state) ? r.state : 'active') as VocabularyState,
    pinned: Number(r.pinned) === 1,
    hits: Number(r.hits ?? 0),
    meetings: Number(r.meetings ?? 0),
    lastSeenAt: r.last_seen ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Each sound-alike once, never the term itself. */
function tidyAliases(term: string, aliases: readonly VocabularyAlias[]): VocabularyAlias[] {
  const seen = new Set([term.trim().toLowerCase()])
  const out: VocabularyAlias[] = []
  for (const a of aliases) {
    const text = a.text.trim()
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    out.push({ text, rewrite: a.rewrite === true })
  }
  return out
}

export class Vocabulary {
  constructor(private readonly db: Db) {}

  /** Everything, in alphabetical order. */
  all(): VocabularyEntry[] {
    return rows<Row>(this.db.raw.prepare(`${SELECT} ORDER BY lower(v.term)`).all()).map(toEntry)
  }

  /** What the models and dictation use. */
  active(): VocabularyEntry[] {
    return rows<Row>(this.db.raw.prepare(`${SELECT} WHERE v.state = 'active' ORDER BY lower(v.term)`).all()).map(toEntry)
  }

  byId(id: number): VocabularyEntry | null {
    const found = row<Row>(this.db.raw.prepare(`${SELECT} WHERE v.id = ?`).get(id))
    return found ? toEntry(found) : null
  }

  /** The same term whatever its capitals. */
  byTerm(term: string): VocabularyEntry | null {
    const found = row<Row>(this.db.raw.prepare(`${SELECT} WHERE lower(v.term) = lower(?)`).get(term.trim()))
    return found ? toEntry(found) : null
  }

  /** Add one. Its id, or null when you already have that term. */
  add(input: VocabularyInput): number | null {
    const term = input.term.trim()
    if (!term) return null
    const now = Date.now()
    const info = this.db.raw
      .prepare(
        `INSERT OR IGNORE INTO vocabulary (term, kind, aliases, meaning, source, state, pinned, hits, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        term,
        input.kind,
        JSON.stringify(tidyAliases(term, input.aliases)),
        input.meaning.trim(),
        input.source,
        input.state,
        input.pinned ? 1 : 0,
        now,
        now
      )
    return info.changes > 0 ? Number(info.lastInsertRowid) : null
  }

  /** Change one. False when the new spelling is already another entry's. */
  update(id: number, patch: Partial<VocabularyInput>): boolean {
    const current = this.byId(id)
    if (!current) return false
    const term = (patch.term ?? current.term).trim()
    const other = this.byTerm(term)
    if (other && other.id !== id) return false
    this.db.raw
      .prepare(
        `UPDATE vocabulary SET term = ?, kind = ?, aliases = ?, meaning = ?, source = ?, state = ?, pinned = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        term,
        patch.kind ?? current.kind,
        JSON.stringify(tidyAliases(term, patch.aliases ?? current.aliases)),
        (patch.meaning ?? current.meaning).trim(),
        patch.source ?? current.source,
        patch.state ?? current.state,
        (patch.pinned ?? current.pinned) ? 1 : 0,
        Date.now(),
        id
      )
    return true
  }

  remove(id: number): void {
    this.db.raw.prepare('DELETE FROM vocabulary_seen WHERE entry_id = ?').run(id)
    this.db.raw.prepare('DELETE FROM vocabulary WHERE id = ?').run(id)
  }

  /**
   * The people on a Meet call's participant list, spelled by Google.
   *
   * Added on their own - the one source trusted enough for that - unless the
   * name is already there in any state: one you changed stays as you left it,
   * and one you said is not a word stays out. Returns the ids of the new ones.
   */
  addPeople(names: readonly string[]): number[] {
    const added: number[] = []
    for (const raw of names) {
      const name = raw.trim()
      if (!name || this.byTerm(name)) continue
      const id = this.add({ term: name, kind: 'person', aliases: [], meaning: '', pinned: false, source: 'roster', state: 'active' })
      if (id !== null) added.push(id)
    }
    return added
  }

  /** These entries came up in this meeting. Once per meeting, however often it is recorded. */
  markSeen(entryIds: readonly number[], meetingId: number, at = Date.now()): void {
    const stmt = this.db.raw.prepare('INSERT OR IGNORE INTO vocabulary_seen (entry_id, meeting_id, at) VALUES (?, ?, ?)')
    for (const id of entryIds) stmt.run(id, meetingId, at)
  }

  /**
   * Dictation rewrites that fired, by the text they matched: counted on the
   * entry whose sound-alike it was, so a rewrite that never fires is visible.
   */
  recordHits(fired: readonly { text: string; count: number }[]): void {
    if (fired.length === 0) return
    const entries = this.active()
    const stmt = this.db.raw.prepare('UPDATE vocabulary SET hits = hits + ? WHERE id = ?')
    for (const f of fired) {
      const key = f.text.trim().toLowerCase()
      const owner = entries.find((e) => e.aliases.some((a) => a.text.toLowerCase() === key))
      if (!owner) continue
      try {
        stmt.run(f.count, owner.id)
      } catch {
        // Counting is bookkeeping; never let it interrupt a dictation.
      }
    }
  }

  count(): number {
    return Number(row<{ n: number }>(this.db.raw.prepare('SELECT COUNT(*) AS n FROM vocabulary').get())?.n ?? 0)
  }

  /* ---------------------------------------------------------- suggestions -- */

  /** Suggestions in these states, the ones seen in the most meetings first. */
  suggestions(states: readonly SuggestionState[] = ['suggested']): VocabularySuggestion[] {
    const all = rows<SuggestionRow>(this.db.raw.prepare(`SELECT * FROM vocabulary_suggestions`).all()).map(toSuggestion)
    return all
      .filter((s) => states.includes(s.state))
      .sort((a, b) => b.meetings - a.meetings || b.updatedAt - a.updatedAt)
  }

  suggestionById(id: number): VocabularySuggestion | null {
    const found = row<SuggestionRow>(this.db.raw.prepare('SELECT * FROM vocabulary_suggestions WHERE id = ?').get(id))
    return found ? toSuggestion(found) : null
  }

  /**
   * Something the mining step found in a meeting. Kept as evidence, once per
   * meeting, and shown to you only once it has earned it: a new word when it
   * has come up in two meetings or is backed by something outside the
   * transcript, a suspected mishearing of an entry you have at once. Nothing
   * that is already in your vocabulary, in any state, and nothing you have
   * turned down. Returns its state now, or null when it was not kept at all.
   */
  propose(input: SuggestionInput): SuggestionState | null {
    const term = input.term.trim()
    const heard = (input.heard ?? '').trim()
    if (!term || term.length > 60 || (input.type === 'heard' && !heard)) return null
    if (input.type === 'new' && this.byTerm(term)) return null
    let canonical = term
    if (input.type === 'heard') {
      const entry = this.byTerm(term)
      if (!entry || entry.state !== 'active') return null
      if (entry.term.toLowerCase() === heard.toLowerCase() || entry.aliases.some((a) => a.text.toLowerCase() === heard.toLowerCase())) return null
      // A word that is an entry of its own is not a mishearing of another one.
      if (this.byTerm(heard)) return null
      canonical = entry.term
    }

    const existing = row<SuggestionRow>(
      this.db.raw
        .prepare('SELECT * FROM vocabulary_suggestions WHERE type = ? AND lower(term) = lower(?) AND lower(heard) = lower(?)')
        .get(input.type, canonical, heard)
    )
    const now = Date.now()
    if (existing) {
      const current = toSuggestion(existing)
      if (current.state === 'rejected' || current.state === 'accepted') return current.state
      const evidence = current.evidence.some((e) => e.meetingId === input.meetingId)
        ? current.evidence
        : [...current.evidence, { meetingId: input.meetingId, quote: input.quote, at: now }]
      const state = current.state === 'suggested' || earned(input, evidence) ? 'suggested' : 'candidate'
      this.db.raw
        .prepare('UPDATE vocabulary_suggestions SET evidence = ?, state = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(evidence), state, now, current.id)
      return state
    }
    const evidence = [{ meetingId: input.meetingId, quote: input.quote, at: now }]
    const state = earned(input, evidence) ? 'suggested' : 'candidate'
    this.db.raw
      .prepare(
        `INSERT INTO vocabulary_suggestions (type, term, heard, kind, evidence, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.type, canonical, heard, input.kind ?? 'term', JSON.stringify(evidence), state, now, now)
    return state
  }

  /**
   * Take a suggestion as it stands: a new word becomes an entry of yours, a
   * mishearing becomes one of its entry's sound-alikes. Returns the entry's id.
   */
  accept(id: number): number | null {
    const s = this.suggestionById(id)
    if (!s || s.state === 'accepted' || s.state === 'rejected') return null
    let entryId: number | null = null
    if (s.type === 'new') {
      entryId =
        this.add({ term: s.term, kind: s.kind, aliases: [], meaning: '', pinned: false, source: 'learned', state: 'active' }) ??
        this.byTerm(s.term)?.id ??
        null
    } else {
      const entry = this.byTerm(s.term)
      if (entry) {
        this.update(entry.id, { aliases: [...entry.aliases, { text: s.heard, rewrite: false }] })
        entryId = entry.id
      }
    }
    this.setSuggestionState(id, 'accepted')
    return entryId
  }

  /** "Not a word" (or "not this" for a mishearing): kept, so it never comes back. */
  reject(id: number): void {
    this.setSuggestionState(id, 'rejected')
  }

  /** You changed your mind about "not a word". */
  revive(id: number): void {
    this.setSuggestionState(id, 'suggested')
  }

  /** Marked done without adding anything here - the entry was saved from the editor. */
  setSuggestionState(id: number, state: SuggestionState): void {
    this.db.raw.prepare('UPDATE vocabulary_suggestions SET state = ?, updated_at = ? WHERE id = ?').run(state, Date.now(), id)
  }
}

interface SuggestionRow {
  id: number
  type: string
  term: string
  heard: string
  kind: string
  evidence: string
  state: string
  created_at: number
  updated_at: number
}

function toSuggestion(r: SuggestionRow): VocabularySuggestion {
  let evidence: SuggestionEvidence[] = []
  try {
    const parsed = JSON.parse(r.evidence) as unknown
    if (Array.isArray(parsed)) evidence = parsed as SuggestionEvidence[]
  } catch {
    // Unreadable evidence costs the quotes, not the suggestion.
  }
  return {
    id: r.id,
    type: r.type === 'heard' ? 'heard' : 'new',
    term: r.term,
    heard: r.heard,
    kind: (VOCABULARY_KINDS as readonly string[]).includes(r.kind) ? (r.kind as VocabularyKind) : 'term',
    evidence,
    meetings: new Set(evidence.map((e) => e.meetingId)).size,
    state: (['candidate', 'suggested', 'accepted', 'rejected'].includes(r.state) ? r.state : 'candidate') as SuggestionState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/**
 * Has it earned a place in front of you? A mishearing of an entry you already
 * have, yes - it is tied to a word you chose. A new word only when it has come
 * up in two meetings, or something outside the transcript backs it: one heard
 * once, by a recogniser, is how "Ajay" would have become a name.
 */
function earned(input: SuggestionInput, evidence: readonly SuggestionEvidence[]): boolean {
  return input.type === 'heard' || input.corroborated === true || new Set(evidence.map((e) => e.meetingId)).size >= 2
}
