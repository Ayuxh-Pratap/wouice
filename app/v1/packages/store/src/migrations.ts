/**
 * Schema migrations, forward-only, applied in order.
 *
 * WHY THIS MATTERS MORE THAN THE SCHEMA ITSELF. This database lives on the
 * user's machine and holds the only copy of their dictation history. There is
 * no ops team, no staging environment and no way to reach in and fix a bad
 * upgrade. A release that corrupts it destroys data nobody can recover, so the
 * rules are strict:
 *
 *   - Migrations are append-only. Never edit one that has shipped: a machine
 *     that already ran it will not run it again, so an edit means two users on
 *     the same version have different schemas.
 *   - Each runs inside a transaction with the version bump, so a crash halfway
 *     leaves the previous version intact rather than a half-migrated database.
 *   - Additive by preference. Dropping a column to tidy up throws away data
 *     that an older build might still be the only reader of.
 *
 * `PRAGMA user_version` is the version marker: it is stored in the file header,
 * costs nothing to read, and needs no table of its own.
 */

export interface Migration {
  /** Monotonic. Becomes `user_version` once applied. */
  id: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'dictations, telemetry and calibration history',
    sql: `
      CREATE TABLE dictations (
        id           INTEGER PRIMARY KEY,
        at           INTEGER NOT NULL,
        audio_ms     INTEGER NOT NULL,
        asr_ms       INTEGER NOT NULL,
        llm_ms       INTEGER NOT NULL,
        total_ms     INTEGER NOT NULL,
        chunks       INTEGER NOT NULL,
        asr_model    TEXT    NOT NULL,
        llm_model    TEXT    NOT NULL,
        language     TEXT    NOT NULL,
        raw_chars    INTEGER NOT NULL,
        final_chars  INTEGER NOT NULL,
        corrections  INTEGER NOT NULL,
        degraded     TEXT,
        raw          TEXT    NOT NULL DEFAULT '',
        corrected    TEXT    NOT NULL DEFAULT '',
        sent_system  TEXT    NOT NULL DEFAULT '',
        sent_user    TEXT    NOT NULL DEFAULT '',
        received     TEXT    NOT NULL DEFAULT '',
        applied      TEXT    NOT NULL DEFAULT '[]',
        capture      TEXT,
        audio_path   TEXT
      );

      -- Every listing is newest-first and paginated; without this the count of
      -- rows scanned grows with the whole history on every page turn.
      CREATE INDEX dictations_at ON dictations (at DESC);

      -- Deduplicates the one-time import from metrics.jsonl, which can be run
      -- more than once if a previous attempt was interrupted.
      CREATE UNIQUE INDEX dictations_at_unique ON dictations (at);

      CREATE TABLE resource_samples (
        id             INTEGER PRIMARY KEY,
        at             INTEGER NOT NULL,
        vram_used_mib  INTEGER NOT NULL,
        vram_total_mib INTEGER NOT NULL,
        rss_mib        INTEGER NOT NULL
      );
      CREATE INDEX resource_samples_at ON resource_samples (at DESC);

      CREATE TABLE calibrations (
        id              INTEGER PRIMARY KEY,
        at              INTEGER NOT NULL,
        device          TEXT    NOT NULL,
        quality         TEXT    NOT NULL,
        silence_level   REAL    NOT NULL,
        speech_level    REAL    NOT NULL,
        separation      REAL    NOT NULL,
        threshold       REAL    NOT NULL,
        min_noise_floor REAL    NOT NULL,
        speech_factor   REAL    NOT NULL,
        applied         INTEGER NOT NULL,
        samples         TEXT    NOT NULL DEFAULT '[]'
      );
      CREATE INDEX calibrations_at ON calibrations (at DESC);
    `,
  },
  {
    id: 2,
    name: 'full-text search over dictation text',
    sql: `
      -- External-content FTS: the index stores no copy of the text, it points
      -- back at 'dictations'. Half the disk, and the two can never disagree.
      CREATE VIRTUAL TABLE dictations_fts USING fts5(
        received, raw, corrected,
        content='dictations',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      -- External content means FTS is not maintained automatically. These are
      -- the triggers the SQLite manual specifies; without them search silently
      -- returns stale rows, which is worse than search not existing.
      CREATE TRIGGER dictations_ai AFTER INSERT ON dictations BEGIN
        INSERT INTO dictations_fts (rowid, received, raw, corrected)
        VALUES (new.id, new.received, new.raw, new.corrected);
      END;

      CREATE TRIGGER dictations_ad AFTER DELETE ON dictations BEGIN
        INSERT INTO dictations_fts (dictations_fts, rowid, received, raw, corrected)
        VALUES ('delete', old.id, old.received, old.raw, old.corrected);
      END;

      CREATE TRIGGER dictations_au AFTER UPDATE ON dictations BEGIN
        INSERT INTO dictations_fts (dictations_fts, rowid, received, raw, corrected)
        VALUES ('delete', old.id, old.received, old.raw, old.corrected);
        INSERT INTO dictations_fts (rowid, received, raw, corrected)
        VALUES (new.id, new.received, new.raw, new.corrected);
      END;

      -- Rows imported before this migration existed are not covered by the
      -- triggers above, so build the index over whatever is already there.
      INSERT INTO dictations_fts (dictations_fts) VALUES ('rebuild');
    `,
  },
]

/** The version a fully migrated database reports. */
export const LATEST_VERSION = MIGRATIONS.reduce((n, m) => Math.max(n, m.id), 0)
