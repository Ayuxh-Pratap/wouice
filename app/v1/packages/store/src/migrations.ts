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
  {
    id: 3,
    name: 'how each dictation was delivered',
    sql: `
      -- Additive, with defaults, so every row written before injection existed
      -- reads as "copied to the clipboard" - which is exactly what happened.
      ALTER TABLE dictations ADD COLUMN inserted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dictations ADD COLUMN delivery TEXT NOT NULL DEFAULT 'copy';
      ALTER TABLE dictations ADD COLUMN target_exe TEXT NOT NULL DEFAULT '';
      -- Why it was not inserted, when it was not. Empty on a clean paste.
      ALTER TABLE dictations ADD COLUMN delivery_note TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: 4,
    name: 'user dictionary entries',
    sql: `
      -- The seed dictionary ships in code and never changes. This is the half
      -- that belongs to the person using the app: their colleagues, clients,
      -- projects, and the words their accent reliably defeats. It lives in the
      -- database rather than in settings.json because it grows without bound
      -- and because it is data, not preference.
      CREATE TABLE dictionary (
        id         INTEGER PRIMARY KEY,
        -- 'term' biases the recogniser; 'correction' rewrites afterwards.
        kind       TEXT    NOT NULL,
        hear       TEXT    NOT NULL,
        write      TEXT,
        enabled    INTEGER NOT NULL DEFAULT 1,
        -- How often the rule actually fired, so a dead rule is visible.
        hits       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      -- One rule per trigger per kind. Two corrections for the same phrase
      -- would fire in an order nobody chose.
      CREATE UNIQUE INDEX dictionary_unique ON dictionary (kind, hear);
    `,
  },
  {
    id: 5,
    name: 'your verdict on each dictation',
    sql: `
      -- A4 in the spec: twenty Hinglish samples, at least seventeen rated
      -- "would ship this text as-is". It is the one acceptance criterion no
      -- benchmark can answer, because it asks whether the output was good
      -- enough for the person who said it - and that judgement only exists if
      -- somewhere records it.
      --
      -- Keyed on the dictation's timestamp rather than its row id, which is
      -- what every other reference in this app already uses, and made the
      -- primary key so that changing your mind updates the verdict instead of
      -- appending a second one.
      CREATE TABLE ratings (
        dictation_at INTEGER PRIMARY KEY
                     REFERENCES dictations (at) ON DELETE CASCADE,
        -- 1 = would have shipped this text as it came out.
        ship         INTEGER NOT NULL,
        -- Optional, and the valuable half of a "no": what was wrong with it.
        note         TEXT    NOT NULL DEFAULT '',
        at           INTEGER NOT NULL
      );
    `,
  },
  {
    id: 6,
    name: 'meetings, their transcript, and the tasks that came out of them',
    sql: `
      -- Phase 2. The speaker columns are here from the start and stay null
      -- until diarization exists, per spec 7.5: designing the schema now and
      -- building the feature later costs nothing, and the reverse costs a
      -- migration.
      CREATE TABLE meetings (
        id          INTEGER PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        title       TEXT,
        -- JSON array of names, typed at the start. Feeds both the cluster-count
        -- prior for diarization and the naming prompt.
        attendees   TEXT    NOT NULL DEFAULT '[]',
        -- <session>/audio.wav. The directory is the source of truth for the
        -- audio; this is the pointer to it.
        dir         TEXT    NOT NULL UNIQUE,
        audio_path  TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        -- What you typed DURING the call. Folded into the notes prompt after
        -- it, because it is the one signal telling the model what you thought
        -- mattered - which no summariser can infer from a transcript.
        scratch_md  TEXT    NOT NULL DEFAULT '',
        notes_md    TEXT,
        diarized    INTEGER NOT NULL DEFAULT 0,
        named       INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE segments (
        id           INTEGER PRIMARY KEY,
        meeting_id   INTEGER NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
        -- 'me' is the microphone, 'them' the system channel. Separation comes
        -- from capture topology, not from a model, so this cannot mislabel.
        channel      TEXT    NOT NULL CHECK (channel IN ('me','them')),
        -- Milliseconds from the start of audio.wav, so a segment and the sound
        -- it came from are the same moment.
        start_ms     INTEGER NOT NULL,
        end_ms       INTEGER NOT NULL,
        text         TEXT    NOT NULL,
        -- The far side arriving back through your microphone. Flagged, never
        -- deleted: a wrongly dropped line cannot be recovered.
        echo         INTEGER NOT NULL DEFAULT 0,
        cluster_id   TEXT,
        speaker_id   INTEGER REFERENCES speakers (id),
        speaker_conf REAL
      );

      CREATE INDEX segments_by_meeting ON segments (meeting_id, start_ms);

      CREATE TABLE speakers (
        id           INTEGER PRIMARY KEY,
        name         TEXT    NOT NULL UNIQUE,
        embedding    BLOB,
        sample_count INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE tasks (
        id         INTEGER PRIMARY KEY,
        meeting_id INTEGER NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
        text       TEXT    NOT NULL,
        -- Null when nobody was named. A guessed owner is worse than none: the
        -- wrong name quietly moves work to somebody who never agreed to it.
        owner      TEXT,
        due        TEXT,
        -- What was actually said to produce this. The column easiest to leave
        -- out and the one that decides whether tasks are usable at all: a task
        -- you cannot trace back is one you have to take on faith, and the first
        -- wrong one teaches you to distrust every other.
        segment_id INTEGER REFERENCES segments (id) ON DELETE SET NULL,
        state      TEXT    NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','done','dropped')),
        created_at INTEGER NOT NULL
      );

      CREATE INDEX tasks_by_meeting ON tasks (meeting_id, state);

      -- External content, as with dictations: the text lives in "segments" and
      -- is not duplicated here.
      CREATE VIRTUAL TABLE segments_fts USING fts5 (
        text, content='segments', content_rowid='id'
      );

      CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
        INSERT INTO segments_fts (rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
        INSERT INTO segments_fts (segments_fts, rowid, text)
        VALUES ('delete', old.id, old.text);
      END;

      CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
        INSERT INTO segments_fts (segments_fts, rowid, text)
        VALUES ('delete', old.id, old.text);
        INSERT INTO segments_fts (rowid, text) VALUES (new.id, new.text);
      END;
    `,
  },
  {
    id: 7,
    name: 'what happened while a meeting was recorded',
    sql: `
      -- One JSON blob per meeting: which models ran, how many transcription
      -- chunks were sent and how many failed, what each channel did, how far
      -- the two clocks drifted apart, and what the notes run made of it.
      --
      -- WHY THIS IS STORED RATHER THAN LOGGED. A meeting is an hour long and
      -- happens once. When the transcript comes out wrong the question is
      -- always "which step failed", and a console line that scrolled past
      -- during the call cannot answer it. This still can, a week later.
      ALTER TABLE meetings ADD COLUMN diagnostics TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    id: 8,
    name: 'the english rendering alongside what was actually said',
    sql: `
      -- BOTH, not one. The raw transcript is what was said and is the thing a
      -- disagreement about a meeting gets settled against; the English
      -- rendering is what makes it readable and is what the notes are built
      -- from. Replacing the first with the second would quietly make the
      -- record un-checkable, so they live side by side and the reader chooses.
      ALTER TABLE segments ADD COLUMN text_en TEXT;

      -- Which kind of meeting this was: it decides the recognition language
      -- and whether an English rendering is wanted at all.
      ALTER TABLE meetings ADD COLUMN kind TEXT NOT NULL DEFAULT 'mixed';

      -- Search has to cover both columns, or searching in English finds
      -- nothing in a Hindi meeting and vice versa. FTS5 cannot gain a column,
      -- so the index is rebuilt; the text itself lives in "segments" and is
      -- not duplicated here.
      DROP TRIGGER IF EXISTS segments_ai;
      DROP TRIGGER IF EXISTS segments_ad;
      DROP TRIGGER IF EXISTS segments_au;
      DROP TABLE IF EXISTS segments_fts;

      CREATE VIRTUAL TABLE segments_fts USING fts5 (
        text, text_en, content='segments', content_rowid='id'
      );

      INSERT INTO segments_fts (rowid, text, text_en)
        SELECT id, text, text_en FROM segments;

      CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
        INSERT INTO segments_fts (rowid, text, text_en)
        VALUES (new.id, new.text, new.text_en);
      END;

      CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
        INSERT INTO segments_fts (segments_fts, rowid, text, text_en)
        VALUES ('delete', old.id, old.text, old.text_en);
      END;

      CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
        INSERT INTO segments_fts (segments_fts, rowid, text, text_en)
        VALUES ('delete', old.id, old.text, old.text_en);
        INSERT INTO segments_fts (rowid, text, text_en)
        VALUES (new.id, new.text, new.text_en);
      END;
    `,
  },
  {
    id: 9,
    name: 'what a task is about, and whose it is',
    sql: `
      -- A long meeting produces tasks for everybody in it. What one person
      -- actually wants to see is their own, and the ones in their area of the
      -- work: a frontend engineer does not open a meeting to read the
      -- finance follow-ups. These are what the task list filters on.
      ALTER TABLE tasks ADD COLUMN area TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'other';
      ALTER TABLE tasks ADD COLUMN mine INTEGER NOT NULL DEFAULT 0;

      -- Where it came from: a line of the transcript, or what the person typed
      -- during the call. A task from the notes has no segment to point at, so
      -- it carries the words it came from instead.
      ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'transcript';
      ALTER TABLE tasks ADD COLUMN note_quote TEXT;

      -- Why the model decided this was a real commitment. Kept, because a task
      -- list you cannot question is one you stop trusting.
      ALTER TABLE tasks ADD COLUMN reason TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: 10,
    name: 'a meeting keeps every transcript made of it',
    sql: `
      -- One row per transcript of a meeting: the one written live during the
      -- call, and one per careful pass made afterwards, keyed by where it came
      -- from. Before this the careful pass overwrote the live transcript, and
      -- with it the summary and tasks you had already read and acted on - a
      -- better transcript that cost you the record of what you had seen.
      CREATE TABLE meeting_versions (
        id          INTEGER PRIMARY KEY,
        meeting_id  INTEGER NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
        -- 'live' for the transcript written during the call, otherwise the
        -- model or service that produced it. One per source: running the same
        -- source again replaces its own version, never another.
        source      TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        -- Everything built FROM a transcript belongs to it. A summary shown
        -- above a transcript it was not written from is the confusion this
        -- table exists to remove.
        notes_md    TEXT,
        diagnostics TEXT    NOT NULL DEFAULT '{}',
        UNIQUE (meeting_id, source)
      );

      -- The version the app reads by default: the one tasks are ticked on and
      -- search looks through.
      ALTER TABLE meetings ADD COLUMN main_version_id INTEGER
        REFERENCES meeting_versions (id) ON DELETE SET NULL;
      ALTER TABLE segments ADD COLUMN version_id INTEGER
        REFERENCES meeting_versions (id) ON DELETE CASCADE;
      ALTER TABLE tasks ADD COLUMN version_id INTEGER
        REFERENCES meeting_versions (id) ON DELETE CASCADE;
      -- The source of the version a task was carried over from, when a newer
      -- version did not produce it but you had already ticked or dropped it.
      ALTER TABLE tasks ADD COLUMN carried_from TEXT;

      -- Every existing meeting becomes one version holding what it has now.
      -- A meeting the careful pass already rewrote is labelled by the model
      -- that did it, because that is what its transcript is.
      INSERT INTO meeting_versions (meeting_id, source, created_at, notes_md, diagnostics)
        SELECT id,
               COALESCE(json_extract(diagnostics, '$.repass.model'), 'live'),
               started_at,
               notes_md,
               json_object(
                 'english', json_extract(diagnostics, '$.english'),
                 'notes', json_extract(diagnostics, '$.notes'),
                 'transcription', json_extract(diagnostics, '$.repass')
               )
        FROM meetings;

      UPDATE meetings SET main_version_id =
        (SELECT v.id FROM meeting_versions v WHERE v.meeting_id = meetings.id);
      UPDATE segments SET version_id =
        (SELECT m.main_version_id FROM meetings m WHERE m.id = segments.meeting_id);
      UPDATE tasks SET version_id =
        (SELECT m.main_version_id FROM meetings m WHERE m.id = tasks.meeting_id);

      CREATE INDEX segments_by_version ON segments (version_id, start_ms);
      CREATE INDEX tasks_by_version ON tasks (version_id);
    `,
  },
  {
    id: 11,
    name: 'a task has a title, a story and the lines it came from',
    sql: `
      -- A task used to be one line of text pointing at one line of transcript,
      -- found by asking "who promised what". Real work is described over
      -- minutes of a meeting and by several people - a feature is asked for,
      -- argued, narrowed, agreed - and a single line cannot hold it. So a task
      -- is now a one-line title (the existing text column), a description that
      -- tells the story, and every line it came from.
      ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';
      -- JSON array of {"segmentId": n, "quote": "..."}. Empty for a task from
      -- before this existed, which still has its one segment_id.
      ALTER TABLE tasks ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]';
      -- Where the meeting landed on it: 'agreed' or 'proposed'. Empty for a
      -- task from before this existed.
      ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT '';
    `,
  },
]

/** The version a fully migrated database reports. */
export const LATEST_VERSION = MIGRATIONS.reduce((n, m) => Math.max(n, m.id), 0)
