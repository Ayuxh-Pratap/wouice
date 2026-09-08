import { rows, row, type Db } from './db.js'
import type { CalibrationRecord, ResourceRecord } from './types.js'

/**
 * Telemetry and calibration history.
 *
 * Resource samples are the one table that grows without a user doing anything -
 * one row every few seconds, forever - so it is also the one table that prunes
 * itself. Everything else here is written only when a person acts.
 */

/** About a fortnight at one sample every five seconds. */
const RESOURCE_KEEP = 250_000

export class Resources {
  constructor(private readonly db: Db) {}

  insert(r: ResourceRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO resource_samples (at, vram_used_mib, vram_total_mib, rss_mib)
         VALUES (?, ?, ?, ?)`
      )
      .run(r.at, Math.round(r.vramUsedMiB), Math.round(r.vramTotalMiB), Math.round(r.rssMiB))
  }

  /** Newest first from SQL, returned oldest first because a line chart reads left to right. */
  recent(limit = 120): ResourceRecord[] {
    return rows<{
      at: number
      vram_used_mib: number
      vram_total_mib: number
      rss_mib: number
    }>(
      this.db.raw
        .prepare(
          `SELECT at, vram_used_mib, vram_total_mib, rss_mib
           FROM resource_samples ORDER BY at DESC LIMIT ?`
        )
        .all(Math.max(1, Math.min(5_000, limit)))
    )
      .map((r) => ({
        at: r.at,
        vramUsedMiB: r.vram_used_mib,
        vramTotalMiB: r.vram_total_mib,
        rssMiB: r.rss_mib,
      }))
      .reverse()
  }

  count(): number {
    return Number(
      row<{ n: number }>(
        this.db.raw.prepare('SELECT COUNT(*) AS n FROM resource_samples').get()
      )?.n ?? 0
    )
  }

  /**
   * Drop the oldest samples once the table is past its cap.
   *
   * By id, not by timestamp: ids are monotonic even if the system clock moves,
   * and a clock that jumped backwards must not be able to delete new rows.
   */
  prune(keep = RESOURCE_KEEP): number {
    const info = this.db.raw
      .prepare(
        `DELETE FROM resource_samples
         WHERE id <= (SELECT MAX(id) FROM resource_samples) - ?`
      )
      .run(keep)
    return Number(info.changes)
  }
}

export class Calibrations {
  constructor(private readonly db: Db) {}

  insert(c: CalibrationRecord): number {
    const info = this.db.raw
      .prepare(
        `INSERT INTO calibrations (
           at, device, quality, silence_level, speech_level, separation,
           threshold, min_noise_floor, speech_factor, applied, samples
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        c.at,
        c.device,
        c.quality,
        c.silenceLevel,
        c.speechLevel,
        c.separation,
        c.threshold,
        c.minNoiseFloor,
        c.speechFactor,
        c.applied ? 1 : 0,
        JSON.stringify(c.samples)
      )
    return Number(info.lastInsertRowid)
  }

  /**
   * Every run, newest first - including the ones that were not accepted.
   *
   * A rejected calibration is evidence: three weak results in a row on the same
   * microphone says the room or the hardware is the problem, not the algorithm.
   * Keeping only the accepted ones would throw exactly that away.
   */
  recent(limit = 20): CalibrationRecord[] {
    const found = rows<{
      id: number
      at: number
      device: string
      quality: string
      silence_level: number
      speech_level: number
      separation: number
      threshold: number
      min_noise_floor: number
      speech_factor: number
      applied: number
      samples: string
    }>(
      this.db.raw
        .prepare(
          `SELECT id, at, device, quality, silence_level, speech_level, separation,
                  threshold, min_noise_floor, speech_factor, applied, samples
           FROM calibrations ORDER BY at DESC LIMIT ?`
        )
        .all(Math.max(1, Math.min(500, limit)))
    )

    return found.map((r) => {
      let samples: CalibrationRecord['samples'] = []
      try {
        samples = JSON.parse(r.samples) as CalibrationRecord['samples']
      } catch {
        samples = []
      }
      return {
        id: r.id,
        at: r.at,
        device: r.device,
        quality: r.quality as CalibrationRecord['quality'],
        silenceLevel: r.silence_level,
        speechLevel: r.speech_level,
        separation: r.separation,
        threshold: r.threshold,
        minNoiseFloor: r.min_noise_floor,
        speechFactor: r.speech_factor,
        applied: r.applied === 1,
        samples,
      }
    })
  }

  /**
   * Mark a run as accepted.
   *
   * Runs are written the moment they are analysed, not when they are accepted,
   * because a run the user looked at and walked away from is the one worth
   * having: it is the record of a microphone or a room that did not work.
   */
  markApplied(id: number): void {
    this.db.raw.prepare('UPDATE calibrations SET applied = 1 WHERE id = ?').run(id)
  }

  /** The one in force: the most recent run the user accepted. */
  latestApplied(): CalibrationRecord | null {
    return this.recent(50).find((c) => c.applied) ?? null
  }
}
