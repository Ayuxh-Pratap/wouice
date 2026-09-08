import { row, rows, type Db } from './db.js'
import type { RatingRecord, RatingProgress } from './types.js'

/**
 * Your verdict on what the app produced.
 *
 * WHY THIS EXISTS. Acceptance criterion A4 says twenty Hinglish samples with at
 * least seventeen rated "would ship this text as-is". Every other criterion can
 * be measured - latency, wrong-window insertions, clipboard survival - but this
 * one asks whether the text was good enough for the person who said it, and no
 * benchmark can answer that. Without somewhere to record the answer the
 * criterion is not merely unmet, it is unmeasurable, and Phase 1 cannot be
 * called done either way.
 *
 * ONE VERDICT PER DICTATION, and changing your mind replaces it. A rating sheet
 * you cannot correct is one misclick away from a wrong number, and the number
 * is the entire point.
 */

interface Row {
  dictation_at: number
  ship: number
  note: string
  at: number
}

function toRecord(r: Row): RatingRecord {
  return { dictationAt: r.dictation_at, ship: r.ship === 1, note: r.note, at: r.at }
}

/**
 * What A4 asks for: twenty samples, seventeen of which would have shipped.
 *
 * Stated here rather than in the UI so the pass mark and the arithmetic live
 * with the data they judge.
 */
export const A4_SAMPLE_TARGET = 20
export const A4_SHIP_TARGET = 17

export class Ratings {
  constructor(private readonly db: Db) {}

  /** Record a verdict, replacing any previous one for that dictation. */
  set(dictationAt: number, ship: boolean, note = '', now = Date.now()): void {
    this.db.raw
      .prepare(
        `INSERT INTO ratings (dictation_at, ship, note, at) VALUES (?, ?, ?, ?)
         ON CONFLICT (dictation_at) DO UPDATE SET ship = excluded.ship,
                                                 note = excluded.note,
                                                 at   = excluded.at`
      )
      .run(dictationAt, ship ? 1 : 0, note, now)
  }

  clear(dictationAt: number): void {
    this.db.raw.prepare('DELETE FROM ratings WHERE dictation_at = ?').run(dictationAt)
  }

  byDictation(dictationAt: number): RatingRecord | null {
    const found = row<Row>(
      this.db.raw.prepare('SELECT * FROM ratings WHERE dictation_at = ?').get(dictationAt)
    )
    return found ? toRecord(found) : null
  }

  /** Every verdict, newest first. Small by construction - A4 needs twenty. */
  all(limit = 200): RatingRecord[] {
    return rows<Row>(
      this.db.raw
        .prepare('SELECT * FROM ratings ORDER BY at DESC LIMIT ?')
        .all(Math.max(1, Math.min(1_000, limit)))
    ).map(toRecord)
  }

  /**
   * How far along A4 is.
   *
   * Counted in SQL rather than by loading the ratings and reducing, for the
   * same reason the dictation summary is: the answer must describe everything
   * that has been rated, not the page of it somebody happens to be looking at.
   */
  progress(): RatingProgress {
    const totals = row<{ rated: number; shipped: number }>(
      this.db.raw
        .prepare(
          `SELECT COUNT(*) AS rated,
                  COALESCE(SUM(ship), 0) AS shipped
           FROM ratings`
        )
        .get()
    )

    // The criterion is about Hinglish specifically, which is the hard case and
    // the reason the number was set at seventeen rather than twenty.
    const hinglish = row<{ rated: number; shipped: number }>(
      this.db.raw
        .prepare(
          `SELECT COUNT(*) AS rated,
                  COALESCE(SUM(r.ship), 0) AS shipped
           FROM ratings r
           JOIN dictations d ON d.at = r.dictation_at
           WHERE d.language != 'english'`
        )
        .get()
    )

    const rated = Number(totals?.rated ?? 0)
    const shipped = Number(totals?.shipped ?? 0)
    return {
      rated,
      shipped,
      hinglishRated: Number(hinglish?.rated ?? 0),
      hinglishShipped: Number(hinglish?.shipped ?? 0),
      sampleTarget: A4_SAMPLE_TARGET,
      shipTarget: A4_SHIP_TARGET,
      // Both halves have to hold: enough samples, and enough of them good.
      // Reporting a pass off three ratings would be worse than reporting none.
      met: rated >= A4_SAMPLE_TARGET && shipped >= A4_SHIP_TARGET,
    }
  }
}
