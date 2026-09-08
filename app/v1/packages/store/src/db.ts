import { DatabaseSync } from 'node:sqlite'
import { LATEST_VERSION, MIGRATIONS } from './migrations.js'

/**
 * Open the local database and bring it up to date.
 *
 * `node:sqlite`, not `better-sqlite3`. SQLite 3.53.4 with FTS5 is compiled into
 * Electron 44 already, so there is no native module to rebuild against Electron's
 * ABI, nothing for a Windows toolchain to fail at, and nothing extra to ship.
 * The whole reason the first version of this used a JSONL file was to avoid that
 * rebuild; the reason it can stop is that the rebuild is no longer needed.
 *
 * Synchronous by design. Every query here runs on the main process against a
 * local file, and the volume is a few thousand rows - the cost of a statement is
 * microseconds. An async wrapper would add a scheduling boundary to every read
 * and buy nothing. The one place this must never appear is the dictation path
 * itself, where writes happen after the text has already been delivered.
 */
export interface OpenOptions {
  /** File path, or ':memory:' in tests. */
  file: string
  /** Called once per migration applied. Wired to the log in production. */
  onMigrate?(id: number, name: string): void
}

export interface Db {
  readonly raw: DatabaseSync
  readonly file: string
  readonly version: number
  close(): void
}

export function openDb({ file, onMigrate }: OpenOptions): Db {
  const raw = new DatabaseSync(file)

  // WAL lets a read run while a write is in flight, which is what keeps the
  // metrics view from blocking behind a dictation being recorded. Not available
  // for an in-memory database, so tests fall back to the default journal.
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL')
  // NORMAL rather than FULL: one fsync per checkpoint instead of one per commit.
  // The worst case is losing the last few telemetry rows to a power cut, which
  // is an acceptable trade for not fsyncing on the dictation path.
  raw.exec('PRAGMA synchronous = NORMAL')
  raw.exec('PRAGMA foreign_keys = ON')

  migrate(raw, onMigrate)

  return {
    raw,
    file,
    get version() {
      return currentVersion(raw)
    },
    close() {
      raw.close()
    },
  }
}

function currentVersion(raw: DatabaseSync): number {
  const row = raw.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

/**
 * Apply every migration newer than the file's recorded version.
 *
 * Each one runs inside its own transaction together with its version bump, so
 * the database is never left describing a version it does not actually have. A
 * failure aborts the whole upgrade rather than continuing past it: running
 * migration 3 on a schema where 2 failed is how a recoverable error becomes a
 * corrupt file.
 */
export function migrate(raw: DatabaseSync, onMigrate?: (id: number, name: string) => void): void {
  const from = currentVersion(raw)
  if (from >= LATEST_VERSION) return

  for (const m of MIGRATIONS) {
    if (m.id <= from) continue
    raw.exec('BEGIN IMMEDIATE')
    try {
      raw.exec(m.sql)
      // Not a bound parameter: PRAGMA does not accept one. The value is a
      // literal from this file, never user input.
      raw.exec(`PRAGMA user_version = ${m.id}`)
      raw.exec('COMMIT')
    } catch (err) {
      raw.exec('ROLLBACK')
      throw new Error(`migration ${m.id} (${m.name}) failed: ${String(err)}`)
    }
    onMigrate?.(m.id, m.name)
  }
}

/**
 * The boundary between SQLite's untyped rows and this package's row types.
 *
 * `node:sqlite` returns `Record<string, SQLOutputValue>`: it cannot know the
 * shape of a query it did not write. Naming that assertion in one place, rather
 * than scattering casts through the repositories, keeps it honest - it is safe
 * only because the migrations and the row types live side by side in this
 * package and change together. Anything crossing out of here is a real type.
 */
export function rows<T>(result: unknown[]): T[] {
  return result as T[]
}

export function row<T>(result: unknown): T | undefined {
  return (result ?? undefined) as T | undefined
}
