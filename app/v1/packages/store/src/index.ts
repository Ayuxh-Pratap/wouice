import path from 'node:path'
import { mkdirSync, statSync } from 'node:fs'
import { openDb, rows, row, type Db } from './db.js'
import { Dictations } from './dictations.js'
import { Calibrations, Resources } from './resources.js'
import { Dictionary } from './dictionary.js'
import { Ratings } from './ratings.js'
import { Meetings } from './meetings.js'

export { openDb, migrate, type Db } from './db.js'
export { Dictations, toMatchQuery } from './dictations.js'
export { Calibrations, Resources } from './resources.js'
export { Dictionary, validateEntry, type EntryCheck } from './dictionary.js'
export { Ratings, A4_SAMPLE_TARGET, A4_SHIP_TARGET } from './ratings.js'
export { Meetings } from './meetings.js'
export { LIVE_SOURCE, MEET_CAPTIONS_SOURCE, TASK_AREAS, TASK_KINDS } from './types.js'
export { importJsonl, type ImportResult } from './import.js'
export { MIGRATIONS, LATEST_VERSION, type Migration } from './migrations.js'
export type {
  AppliedRule,
  CalibrationRecord,
  CaptureDiagnostics,
  DictationRecord,
  DictionaryRecord,
  Page,
  MeetingChannel,
  MeetingDiagnostics,
  MeetingRecord,
  RatingProgress,
  RatingRecord,
  ResourceRecord,
  SegmentInput,
  SegmentRecord,
  TaskArea,
  TaskInput,
  TaskKind,
  TaskEvidence,
  TaskRecord,
  TaskState,
  TaskStatus,
  VersionDiagnostics,
  VersionRecord,
} from './types.js'

/**
 * Everything the app stores, behind one object.
 *
 * One database file, opened once, holding dictations, telemetry and calibration
 * history together. They are here together because they answer questions about
 * each other: "was the transcription bad before or after I recalibrated?" needs
 * all three, and three separate files could not answer it.
 */
export interface Store {
  readonly db: Db
  readonly dictations: Dictations
  readonly resources: Resources
  readonly calibrations: Calibrations
  readonly dictionary: Dictionary
  readonly ratings: Ratings
  readonly meetings: Meetings
  readonly file: string
  /** What is actually in the database right now. */
  stats(): StoreStats
  close(): void
}

/**
 * A look inside the file, for the diagnostics panel.
 *
 * Not a debugging convenience: a local-first app's database is the user's own
 * data with no server to inspect it from, and "how much of my voice is sitting
 * on this disk, and where" is a fair question to be able to answer without
 * installing a SQLite browser.
 */
export interface StoreStats {
  file: string
  /** Schema version, so a failed migration is visible rather than inferred. */
  version: number
  bytes: number
  tables: { name: string; rows: number }[]
}

export interface OpenStoreOptions {
  /** The app's userData directory. The database is created inside it. */
  dir: string
  onMigrate?(id: number, name: string): void
}

/**
 * Opening is side-effect-free beyond creating and migrating the file, so it is
 * safe to call before an app knows whether it is the instance that will keep
 * running. Absorbing the old JSONL log is NOT safe there - it renames the
 * original - so `importJsonl` is called separately, once the app has won the
 * single-instance lock.
 */
export function openStore(options: OpenStoreOptions): Store {
  mkdirSync(options.dir, { recursive: true })
  const file = path.join(options.dir, 'wouice.db')
  const db = openDb({ file, onMigrate: options.onMigrate })

  return {
    db,
    file,
    dictations: new Dictations(db),
    resources: new Resources(db),
    calibrations: new Calibrations(db),
    dictionary: new Dictionary(db),
    ratings: new Ratings(db),
    meetings: new Meetings(db),
    stats: () => stats(db, file),
    close: () => {
      // Fold the WAL back into the main file on the way out, so a database that
      // is not running is a single self-contained file. Anyone pointing a
      // SQLite browser at it then sees everything, rather than whatever had
      // been checkpointed by chance.
      try {
        db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // Nothing to checkpoint, or not in WAL mode. Closing still matters.
      }
      db.close()
    },
  }
}

export function stats(db: Db, file: string): StoreStats {
  // Real tables only: sqlite_* is SQLite's own bookkeeping, and an external
  // content FTS index reports the row count of the table it points at, so
  // listing both would show the same number twice under different names.
  const names = rows<{ name: string }>(
    db.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
         ORDER BY name`
      )
      .all()
  )

  // The WAL counts. In write-ahead mode the main file stays small until a
  // checkpoint - a database holding 350 KB of dictations reports 4 KB - so
  // measuring only the .db would understate it by two orders of magnitude.
  let bytes = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      bytes += statSync(file + suffix).size
    } catch {
      // ':memory:', or that companion file does not exist yet.
    }
  }

  return {
    file,
    version: db.version,
    bytes,
    tables: names.map((t) => ({
      name: t.name,
      // The table name comes from sqlite_master, not from a caller, so it
      // cannot be anything a parameter would have protected against.
      rows: Number(
        row<{ n: number }>(db.raw.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get())?.n ?? 0
      ),
    })),
  }
}
