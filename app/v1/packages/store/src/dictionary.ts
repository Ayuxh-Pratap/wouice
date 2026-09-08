import { rows, row, type Db } from './db.js'
import type { DictionaryRecord } from './types.js'

/**
 * The user's own dictionary.
 *
 * The seed list ships in code and covers vocabulary any developer hits in week
 * one. This is the other half: colleagues, clients, project names, and the
 * words a particular voice reliably defeats. It has to be editable, so it has
 * to be data - and it grows without bound, so it belongs in the database rather
 * than in a settings file.
 *
 * Validation lives in `validateEntry`, which is pure and tested, because the
 * rules are the interesting part: a correction that is less specific than the
 * word it replaces breaks more than it fixes.
 */

interface Row {
  id: number
  kind: string
  hear: string
  write: string | null
  enabled: number
  hits: number
  created_at: number
}

function toRecord(r: Row): DictionaryRecord {
  return {
    id: r.id,
    kind: r.kind === 'term' ? 'term' : 'correction',
    hear: r.hear,
    write: r.write ?? '',
    enabled: r.enabled === 1,
    hits: r.hits,
    createdAt: r.created_at,
  }
}

const COLUMNS = 'id, kind, hear, write, enabled, hits, created_at'

export class Dictionary {
  constructor(private readonly db: Db) {}

  /**
   * Newest first: a rule just added should be visible without scrolling.
   *
   * Tie-broken by id, because two rules added in the same millisecond - which
   * happens the moment anyone pastes a list in - would otherwise come back in
   * whatever order SQLite felt like.
   */
  all(): DictionaryRecord[] {
    return rows<Row>(
      this.db.raw
        .prepare(`SELECT ${COLUMNS} FROM dictionary ORDER BY created_at DESC, id DESC`)
        .all()
    ).map(toRecord)
  }

  /** Only what the pipeline should actually apply. */
  active(): DictionaryRecord[] {
    return rows<Row>(
      this.db.raw
        .prepare(
          `SELECT ${COLUMNS} FROM dictionary WHERE enabled = 1 ORDER BY length(hear) DESC, id ASC`
        )
        .all()
    ).map(toRecord)
  }

  /**
   * Add one. Returns its id, or null when an identical trigger already exists.
   *
   * Silently ignoring the duplicate rather than overwriting: someone re-adding a
   * rule they forgot about should not lose the replacement they chose the first
   * time.
   */
  add(entry: Omit<DictionaryRecord, 'id' | 'hits' | 'createdAt'>): number | null {
    const info = this.db.raw
      .prepare(
        `INSERT OR IGNORE INTO dictionary (kind, hear, write, enabled, hits, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(
        entry.kind,
        entry.hear,
        entry.kind === 'correction' ? entry.write : null,
        entry.enabled ? 1 : 0,
        Date.now()
      )
    return info.changes > 0 ? Number(info.lastInsertRowid) : null
  }

  update(id: number, patch: Partial<Pick<DictionaryRecord, 'hear' | 'write' | 'enabled'>>): void {
    const current = this.byId(id)
    if (!current) return
    this.db.raw
      .prepare('UPDATE dictionary SET hear = ?, write = ?, enabled = ? WHERE id = ?')
      .run(
        patch.hear ?? current.hear,
        current.kind === 'correction' ? (patch.write ?? current.write) : null,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        id
      )
  }

  remove(id: number): void {
    this.db.raw.prepare('DELETE FROM dictionary WHERE id = ?').run(id)
  }

  byId(id: number): DictionaryRecord | null {
    const found = row<Row>(
      this.db.raw.prepare(`SELECT ${COLUMNS} FROM dictionary WHERE id = ?`).get(id)
    )
    return found ? toRecord(found) : null
  }

  count(): number {
    return Number(
      row<{ n: number }>(this.db.raw.prepare('SELECT COUNT(*) AS n FROM dictionary').get())?.n ?? 0
    )
  }

  /**
   * Record that these rules fired.
   *
   * A rule that has never fired in months of dictation is either wrong or no
   * longer needed, and that is only visible if the hits are counted.
   */
  recordHits(triggers: { hear: string; count: number }[]): void {
    if (triggers.length === 0) return
    // Case-insensitive: `applied.from` is the text as the recogniser produced
    // it, which is rarely capitalised the way the rule was written.
    const stmt = this.db.raw.prepare(
      'UPDATE dictionary SET hits = hits + ? WHERE lower(hear) = lower(?)'
    )
    for (const t of triggers) {
      try {
        stmt.run(t.count, t.hear)
      } catch {
        // Counting is bookkeeping; never let it interrupt a dictation.
      }
    }
  }
}

export interface EntryProblem {
  ok: false
  reason: string
}
export type EntryCheck = { ok: true } | EntryProblem

/**
 * Is this entry safe to add?
 *
 * The rule the seed dictionary documents by omission: **a correction must be
 * more specific than the word it replaces.** "cloud" -> "Claude" breaks "cloud
 * storage" and "Cloudflare"; "jason" -> "JSON" breaks everyone named Jason. The
 * fix in both cases is either a longer trigger or a `term`, which biases the
 * recogniser without ever rewriting anything.
 *
 * Pure, so every rule below can be argued with in a test rather than discovered
 * in a transcript.
 */
export function validateEntry(entry: {
  kind: 'term' | 'correction'
  hear: string
  write: string
}): EntryCheck {
  const hear = entry.hear.trim()
  const write = entry.write.trim()

  if (hear.length === 0) return { ok: false, reason: 'Enter the word as it is heard.' }
  if (hear.length > 120) return { ok: false, reason: 'That is too long to match reliably.' }

  if (entry.kind === 'term') {
    return { ok: true }
  }

  if (write.length === 0) return { ok: false, reason: 'Enter what it should be written as.' }
  if (write.length > 200) return { ok: false, reason: 'That replacement is too long.' }
  if (hear.toLowerCase() === write.toLowerCase() && hear === write) {
    return { ok: false, reason: 'That rewrites the word to itself.' }
  }

  // A single short word is almost always part of longer words and phrases, and
  // rewriting it everywhere does more damage than the mishearing it fixes.
  const words = hear.split(/\s+/).filter(Boolean)
  if (words.length === 1 && hear.length <= 4) {
    return {
      ok: false,
      reason: `"${hear}" is short enough to appear inside other words. Use a longer phrase, or add it as a term instead.`,
    }
  }

  return { ok: true }
}
