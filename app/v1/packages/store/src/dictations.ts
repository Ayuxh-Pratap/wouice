import { rows, row, type Db } from './db.js'
import type { AppliedRule, CaptureDiagnostics, DictationRecord, Page } from './types.js'

/**
 * Reading and writing dictations.
 *
 * The listing exists in paginated form because the previous one did not: it
 * held the last 2000 events in memory and showed the last twenty, so everything
 * before that was on disk and unreachable. Counting and paging are the whole
 * reason this is a database.
 */

interface Row {
  id: number
  at: number
  audio_ms: number
  asr_ms: number
  llm_ms: number
  total_ms: number
  chunks: number
  asr_model: string
  llm_model: string
  language: string
  raw_chars: number
  final_chars: number
  corrections: number
  degraded: string | null
  raw: string
  corrected: string
  sent_system: string
  sent_user: string
  received: string
  applied: string
  capture: string | null
  audio_path: string | null
  inserted: number
  delivery: string
  target_exe: string
  delivery_note: string
}

/** Never let a malformed JSON column take the whole listing down with it. */
function parse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function toRecord(r: Row): DictationRecord {
  return {
    id: r.id,
    at: r.at,
    audioMs: r.audio_ms,
    asrMs: r.asr_ms,
    llmMs: r.llm_ms,
    totalMs: r.total_ms,
    chunks: r.chunks,
    asrModel: r.asr_model,
    llmModel: r.llm_model,
    language: r.language,
    rawChars: r.raw_chars,
    finalChars: r.final_chars,
    corrections: r.corrections,
    degraded: r.degraded,
    raw: r.raw,
    corrected: r.corrected,
    sentSystem: r.sent_system,
    sentUser: r.sent_user,
    received: r.received,
    applied: parse<AppliedRule[]>(r.applied, []),
    capture: parse<CaptureDiagnostics | null>(r.capture, null),
    audioPath: r.audio_path,
    inserted: r.inserted === 1,
    delivery: r.delivery,
    targetExe: r.target_exe,
    deliveryNote: r.delivery_note,
  }
}

const COLUMNS = `
  id, at, audio_ms, asr_ms, llm_ms, total_ms, chunks, asr_model, llm_model,
  language, raw_chars, final_chars, corrections, degraded, raw, corrected,
  sent_system, sent_user, received, applied, capture, audio_path,
  inserted, delivery, target_exe, delivery_note
`

const INSERT = `
  INSERT INTO dictations (
    at, audio_ms, asr_ms, llm_ms, total_ms, chunks, asr_model, llm_model,
    language, raw_chars, final_chars, corrections, degraded, raw, corrected,
    sent_system, sent_user, received, applied, capture, audio_path,
    inserted, delivery, target_exe, delivery_note
  ) VALUES (
    :at, :audio_ms, :asr_ms, :llm_ms, :total_ms, :chunks, :asr_model, :llm_model,
    :language, :raw_chars, :final_chars, :corrections, :degraded, :raw, :corrected,
    :sent_system, :sent_user, :received, :applied, :capture, :audio_path,
    :inserted, :delivery, :target_exe, :delivery_note
  )
`

function bind(d: DictationRecord): Record<string, string | number | null> {
  return {
    at: d.at,
    audio_ms: Math.round(d.audioMs),
    asr_ms: Math.round(d.asrMs),
    llm_ms: Math.round(d.llmMs),
    total_ms: Math.round(d.totalMs),
    chunks: d.chunks,
    asr_model: d.asrModel,
    llm_model: d.llmModel,
    language: d.language,
    raw_chars: d.rawChars,
    final_chars: d.finalChars,
    corrections: d.corrections,
    degraded: d.degraded,
    raw: d.raw,
    corrected: d.corrected,
    sent_system: d.sentSystem,
    sent_user: d.sentUser,
    received: d.received,
    applied: JSON.stringify(d.applied),
    capture: d.capture ? JSON.stringify(d.capture) : null,
    audio_path: d.audioPath,
    inserted: d.inserted ? 1 : 0,
    delivery: d.delivery,
    target_exe: d.targetExe,
    delivery_note: d.deliveryNote,
  }
}

export class Dictations {
  constructor(private readonly db: Db) {}

  /**
   * Insert one. Returns its id, or null if a row with that timestamp exists.
   *
   * `at` is unique so re-importing an old log cannot duplicate history. A clash
   * from two dictations finishing in the same millisecond is not realistic -
   * they are seconds apart by construction - and losing one telemetry row would
   * be preferable to duplicating the whole log anyway.
   */
  insert(d: DictationRecord): number | null {
    const stmt = this.db.raw.prepare(
      INSERT.replace('INSERT INTO', 'INSERT OR IGNORE INTO')
    )
    const info = stmt.run(bind(d))
    return info.changes > 0 ? Number(info.lastInsertRowid) : null
  }

  /** Bulk insert in one transaction, for the import path. */
  insertMany(records: DictationRecord[]): number {
    const stmt = this.db.raw.prepare(INSERT.replace('INSERT INTO', 'INSERT OR IGNORE INTO'))
    let inserted = 0
    this.db.raw.exec('BEGIN IMMEDIATE')
    try {
      for (const d of records) inserted += stmt.run(bind(d)).changes > 0 ? 1 : 0
      this.db.raw.exec('COMMIT')
    } catch (err) {
      this.db.raw.exec('ROLLBACK')
      throw err
    }
    return inserted
  }

  count(): number {
    return Number(row<{ n: number }>(
      this.db.raw.prepare('SELECT COUNT(*) AS n FROM dictations').get()
    )?.n ?? 0)
  }

  byId(id: number): DictationRecord | null {
    const found = row<Row>(this.db.raw.prepare(`SELECT ${COLUMNS} FROM dictations WHERE id = ?`).get(id))
    return found ? toRecord(found) : null
  }

  byAt(at: number): DictationRecord | null {
    const found = row<Row>(this.db.raw.prepare(`SELECT ${COLUMNS} FROM dictations WHERE at = ?`).get(at))
    return found ? toRecord(found) : null
  }

  /**
   * One page, newest first, with the total so the UI can render "page 3 of 14".
   *
   * The count is a second query rather than a window function because SQLite has
   * to scan for it either way, and keeping them separate means the page query
   * stays a plain index scan of exactly `limit` rows.
   */
  page(offset: number, limit: number, query?: string): Page<DictationRecord> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    const safeOffset = Math.max(0, Math.floor(offset))
    const match = query ? toMatchQuery(query) : null

    if (match === null) {
      const found = rows<Row>(
        this.db.raw
          .prepare(`SELECT ${COLUMNS} FROM dictations ORDER BY at DESC LIMIT ? OFFSET ?`)
          .all(safeLimit, safeOffset)
      )
      return { rows: found.map(toRecord), total: this.count(), offset: safeOffset, limit: safeLimit }
    }

    // A search that tokenises to nothing (all punctuation, say) must return
    // nothing rather than quietly falling back to the unfiltered listing, which
    // would look like the filter silently failed.
    if (match === '') return { rows: [], total: 0, offset: safeOffset, limit: safeLimit }

    const found = rows<Row>(
      this.db.raw
        .prepare(
          `SELECT ${COLUMNS.split(',')
            .map((c) => `d.${c.trim()}`)
            .join(', ')}
           FROM dictations_fts f
           JOIN dictations d ON d.id = f.rowid
           WHERE dictations_fts MATCH ?
           ORDER BY d.at DESC
           LIMIT ? OFFSET ?`
        )
        .all(match, safeLimit, safeOffset)
    )

    const total = row<{ n: number }>(
      this.db.raw
        .prepare('SELECT COUNT(*) AS n FROM dictations_fts WHERE dictations_fts MATCH ?')
        .get(match)
    )

    return {
      rows: found.map(toRecord),
      total: Number(total?.n ?? 0),
      offset: safeOffset,
      limit: safeLimit,
    }
  }

  /**
   * Remove specific dictations, and say which audio files they were holding.
   *
   * RETURNS THE PATHS rather than deleting the files itself. This class owns a
   * database and nothing else; the WAV files live under the app's userData and
   * are the recording store's business. Returning them is what lets the caller
   * clean up without this one growing a dependency on the filesystem.
   *
   * The FTS index looks after itself: migration 3 installed an AFTER DELETE
   * trigger that removes the matching row, so a search cannot go on matching
   * text that is no longer here.
   */
  deleteAt(ats: number[]): { deleted: number; audioPaths: string[] } {
    if (ats.length === 0) return { deleted: 0, audioPaths: [] }

    // One statement per row inside a transaction, rather than an IN list built
    // by string concatenation. The values come from the renderer.
    const find = this.db.raw.prepare('SELECT audio_path FROM dictations WHERE at = ?')
    const remove = this.db.raw.prepare('DELETE FROM dictations WHERE at = ?')
    const audioPaths: string[] = []
    let deleted = 0

    this.db.raw.exec('BEGIN IMMEDIATE')
    try {
      for (const at of ats) {
        const found = row<{ audio_path: string | null }>(find.get(at))
        if (found?.audio_path) audioPaths.push(found.audio_path)
        deleted += remove.run(at).changes > 0 ? 1 : 0
      }
      this.db.raw.exec('COMMIT')
    } catch (err) {
      this.db.raw.exec('ROLLBACK')
      throw err
    }

    return { deleted, audioPaths }
  }

  /**
   * Remove every dictation. Starting over, deliberately.
   *
   * DELETE rather than DROP and recreate, so the FTS triggers fire and the
   * schema version is untouched: a reset must leave a database the next launch
   * recognises, not one it tries to migrate again.
   *
   * The file does not shrink on its own - SQLite keeps the freed pages for
   * reuse - so this vacuums afterwards. Someone clearing their history is
   * usually asking for the disk space back too, and a storage panel still
   * reporting 1.8 MB after "delete everything" reads as a failure.
   */
  deleteAll(): { deleted: number; audioPaths: string[] } {
    const audioPaths = rows<{ audio_path: string }>(
      this.db.raw.prepare('SELECT audio_path FROM dictations WHERE audio_path IS NOT NULL').all()
    ).map((r) => r.audio_path)

    const deleted = this.db.raw.prepare('DELETE FROM dictations').run().changes
    try {
      this.db.raw.exec('VACUUM')
    } catch {
      // VACUUM cannot run inside a transaction or with an open statement. The
      // rows are gone either way, which is the part that was asked for.
    }
    return { deleted: Number(deleted), audioPaths }
  }

  /** Newest first, for the charts. Bounded: the charts show tens, not thousands. */
  recent(limit = 60): DictationRecord[] {
    return rows<Row>(
      this.db.raw
        .prepare(`SELECT ${COLUMNS} FROM dictations ORDER BY at DESC LIMIT ?`)
        .all(Math.max(1, Math.min(1_000, limit)))
    ).map(toRecord)
  }

  /** Mean ASR time per model, computed in SQL rather than by loading everything. */
  meanAsrByModel(): { model: string; meanMs: number; n: number }[] {
    return rows<{ model: string; mean_ms: number; n: number }>(
      this.db.raw
        .prepare(
          `SELECT asr_model AS model, AVG(asr_ms) AS mean_ms, COUNT(*) AS n
           FROM dictations GROUP BY asr_model ORDER BY mean_ms ASC`
        )
        .all()
    ).map((r) => ({ model: r.model, meanMs: Number(r.mean_ms), n: Number(r.n) }))
  }

  /**
   * Headline numbers over the WHOLE history, not the visible page.
   *
   * Percentiles come from SQLite rather than from JavaScript over a loaded
   * array, because the point of moving to a database was to stop the summary
   * silently describing only the last two thousand rows.
   */
  summary(): { count: number; p50Ms: number; p95Ms: number; degraded: number; chars: number } {
    const base = row<{ n: number; degraded: number | null; chars: number }>(
      this.db.raw
        .prepare(
          `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN degraded IS NOT NULL THEN 1 ELSE 0 END) AS degraded,
                  COALESCE(SUM(final_chars), 0) AS chars
           FROM dictations`
        )
        .get()
    )

    const n = Number(base?.n ?? 0)
    const at = (p: number): number => {
      if (n === 0) return 0
      const offset = Math.min(n - 1, Math.floor((p / 100) * n))
      const found = row<{ v: number }>(
        this.db.raw
          .prepare('SELECT (asr_ms + llm_ms) AS v FROM dictations ORDER BY v ASC LIMIT 1 OFFSET ?')
          .get(offset)
      )
      return Number(found?.v ?? 0)
    }

    return {
      count: n,
      p50Ms: at(50),
      p95Ms: at(95),
      degraded: Number(base?.degraded ?? 0),
      chars: Number(base?.chars ?? 0),
    }
  }
}

/**
 * Turn what someone typed into a safe FTS5 MATCH expression.
 *
 * FTS5 has its own query language: bare input containing `"`, `*`, `NEAR` or an
 * unbalanced quote is either a syntax error or a query that means something the
 * user did not ask for. So the input is treated as words, never as syntax. Each
 * token is quoted as a literal, they are ANDed, and the last one gets a prefix
 * `*` so results narrow while typing rather than appearing only on the space.
 *
 * Returns '' when nothing survives tokenising, which the caller reads as "no
 * matches" rather than "no filter".
 */
export function toMatchQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (tokens.length === 0) return ''
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' AND ')
}
