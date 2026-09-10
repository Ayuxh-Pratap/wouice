import { rows, row, type Db } from './db.js'
import { LIVE_SOURCE, TASK_AREAS, TASK_KINDS } from './types.js'
import type {
  MeetingDiagnostics,
  TaskArea,
  TaskEvidence,
  TaskKind,
  TaskStatus,
  MeetingRecord,
  SegmentInput,
  SegmentRecord,
  TaskInput,
  TaskRecord,
  TaskState,
  VersionDiagnostics,
  VersionRecord,
} from './types.js'

/**
 * Reading and writing meetings and their transcripts.
 *
 * A MEETING ROW IS CREATED WHEN RECORDING STARTS, not when it finishes. An hour
 * of audio that never reached a clean stop is exactly the case worth being able
 * to see, and a table that only learns about meetings once they end cannot
 * describe one. `ended_at` being null is what "this never finished" means, and
 * it matches the same statement on disk - a directory of checkpoints with no
 * `audio.wav`.
 *
 * SEGMENTS ARRIVE DURING THE MEETING, in the order they close. They are written
 * as they come rather than in one batch at the end, so a crash costs the tail
 * rather than the transcript.
 *
 * A MEETING HAS VERSIONS. The transcript written live is one; each careful pass
 * made afterwards is another, and becomes the main one. A version owns its
 * transcript, its summary and its tasks, so nothing built from one transcript
 * is ever shown with another. Reads default to the main version.
 */

interface MeetingRow {
  id: number
  started_at: number
  ended_at: number | null
  title: string | null
  attendees: string
  dir: string
  audio_path: string | null
  duration_ms: number
  scratch_md: string
  notes_md: string | null
  diarized: number
  named: number
  diagnostics: string
  kind: string
  main_version_id: number | null
}

/** A meeting row with what the list shows from its main version. */
type MeetingWithMain = MeetingRow & { main_notes: string | null; segments: number }

interface VersionRow {
  id: number
  meeting_id: number
  source: string
  created_at: number
  notes_md: string | null
  diagnostics: string
  segments: number
  main: number
}

interface SegmentRow {
  id: number
  meeting_id: number
  channel: string
  start_ms: number
  end_ms: number
  text: string
  text_en: string | null
  echo: number
}

/** The main version's summary and line count, joined onto a meeting row. */
const WITH_MAIN = `
  SELECT m.*, v.notes_md AS main_notes,
         (SELECT COUNT(*) FROM segments s WHERE s.version_id = m.main_version_id) AS segments
  FROM meetings m LEFT JOIN meeting_versions v ON v.id = m.main_version_id`

function toMeeting(r: MeetingWithMain, versions: VersionRecord[]): MeetingRecord {
  let attendees: string[] = []
  try {
    const parsed: unknown = JSON.parse(r.attendees)
    if (Array.isArray(parsed)) attendees = parsed.filter((n): n is string => typeof n === 'string')
  } catch {
    // A hand-edited row should not make the meeting unreadable.
  }
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    title: r.title,
    attendees,
    dir: r.dir,
    audioPath: r.audio_path,
    durationMs: r.duration_ms,
    scratchMd: r.scratch_md,
    notesMd: r.main_notes,
    kind: r.kind ?? 'mixed',
    diagnostics: readJson<MeetingDiagnostics>(r.diagnostics),
    segments: r.segments,
    mainVersionId: r.main_version_id,
    versions,
  }
}

function toVersion(r: VersionRow): VersionRecord {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    source: r.source,
    createdAt: r.created_at,
    notesMd: r.notes_md,
    diagnostics: readJson<VersionDiagnostics>(r.diagnostics),
    segments: r.segments,
    main: r.main === 1,
  }
}

function readJson<T extends object>(raw: string | null): T {
  if (!raw) return {} as T
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as T)
      : ({} as T)
  } catch {
    return {} as T
  }
}

function toSegment(r: SegmentRow): SegmentRecord {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    channel: r.channel === 'them' ? 'them' : 'me',
    startMs: r.start_ms,
    endMs: r.end_ms,
    text: r.text,
    textEn: r.text_en,
    echo: r.echo === 1,
  }
}

interface TaskRow {
  id: number
  meeting_id: number
  version_id: number | null
  text: string
  owner: string | null
  due: string | null
  segment_id: number | null
  state: string
  created_at: number
  quote: string | null
  quote_at: number | null
  area: string
  kind: string
  mine: number
  source: string
  note_quote: string | null
  reason: string
  carried_from: string | null
  description: string
  evidence: string
  status: string
}

/** The lines a task cites, as stored: before the when and the words are joined in. */
function readEvidence(raw: string | null): { segmentId: number; quote: string }[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e): e is { segmentId: number; quote?: unknown } =>
          typeof e === 'object' && e !== null && Number.isInteger((e as { segmentId?: unknown }).segmentId)
      )
      .map((e) => ({ segmentId: e.segmentId, quote: typeof e.quote === 'string' ? e.quote : '' }))
  } catch {
    return []
  }
}

function toTask(r: TaskRow): TaskRecord {
  const state: TaskState =
    r.state === 'done' ? 'done' : r.state === 'dropped' ? 'dropped' : 'open'
  return {
    id: r.id,
    meetingId: r.meeting_id,
    versionId: r.version_id,
    text: r.text,
    owner: r.owner,
    due: r.due,
    segmentId: r.segment_id,
    state,
    createdAt: r.created_at,
    // A task from your notes has no segment; the words it came from stand in.
    quote: r.quote ?? r.note_quote,
    quoteAtMs: r.quote_at,
    area: (TASK_AREAS as readonly string[]).includes(r.area) ? (r.area as TaskArea) : 'other',
    kind: (TASK_KINDS as readonly string[]).includes(r.kind) ? (r.kind as TaskKind) : 'other',
    mine: r.mine === 1,
    source: r.source === 'notes' ? 'notes' : 'transcript',
    noteQuote: r.note_quote,
    reason: r.reason,
    carriedFrom: r.carried_from,
    description: r.description ?? '',
    // A task from before evidence existed still has its one line.
    evidence: (() => {
      const cited = readEvidence(r.evidence)
      if (cited.length > 0) return cited.map((e) => ({ ...e, atMs: null, line: null }))
      return r.segment_id !== null
        ? [{ segmentId: r.segment_id, quote: '', atMs: r.quote_at, line: r.quote }]
        : []
    })(),
    status: r.status === 'agreed' || r.status === 'proposed' ? (r.status as TaskStatus) : '',
  }
}

const INSERT_SEGMENT = `INSERT INTO segments (meeting_id, version_id, channel, start_ms, end_ms, text, echo)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`

/** A version id, or the meeting's main version when none is given. */
const VERSION_OR_MAIN = 'COALESCE(?, (SELECT main_version_id FROM meetings WHERE id = ?))'

export class Meetings {
  constructor(private readonly db: Db) {}

  private tx<T>(work: () => T): T {
    this.db.raw.exec('BEGIN')
    try {
      const result = work()
      this.db.raw.exec('COMMIT')
      return result
    } catch (err) {
      this.db.raw.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Record that a meeting has begun, with the version its live transcript goes into.
   *
   * Keyed on the session directory, which is unique and already exists by the
   * time this is called. Re-starting into the same directory returns the same
   * row rather than a duplicate, so a recovery pass cannot create a second
   * meeting for audio that already has one.
   */
  start(dir: string, startedAt: number, kind = 'mixed'): number {
    const existing = row<{ id: number }>(
      this.db.raw.prepare('SELECT id FROM meetings WHERE dir = ?').get(dir)
    )
    if (existing) return existing.id

    return this.tx(() => {
      const id = Number(
        this.db.raw
          .prepare('INSERT INTO meetings (started_at, dir, kind) VALUES (?, ?, ?)')
          .run(startedAt, dir, kind).lastInsertRowid
      )
      this.liveVersionId(id, startedAt)
      return id
    })
  }

  /** Close it out once the audio is merged. */
  finish(
    id: number,
    detail: { endedAt: number; audioPath: string | null; durationMs: number }
  ): void {
    this.db.raw
      .prepare('UPDATE meetings SET ended_at = ?, audio_path = ?, duration_ms = ? WHERE id = ?')
      .run(detail.endedAt, detail.audioPath, detail.durationMs, id)
  }

  /**
   * The version the live transcript is written into.
   *
   * Made on demand, so a meeting that somehow has none still records rather
   * than losing its lines. It becomes the main version only if there is none.
   */
  private liveVersionId(meetingId: number, at = Date.now()): number {
    const found = row<{ id: number }>(
      this.db.raw
        .prepare('SELECT id FROM meeting_versions WHERE meeting_id = ? AND source = ?')
        .get(meetingId, LIVE_SOURCE)
    )
    if (found) return found.id
    const id = Number(
      this.db.raw
        .prepare('INSERT INTO meeting_versions (meeting_id, source, created_at) VALUES (?, ?, ?)')
        .run(meetingId, LIVE_SOURCE, at).lastInsertRowid
    )
    this.db.raw
      .prepare('UPDATE meetings SET main_version_id = COALESCE(main_version_id, ?) WHERE id = ?')
      .run(id, meetingId)
    return id
  }

  /** Append live transcript segments. Written as they close, not batched at the end. */
  addSegments(meetingId: number, segments: readonly SegmentInput[]): void {
    if (segments.length === 0) return
    // One transaction: twenty separate commits during a meeting is twenty
    // fsyncs on the path that has to keep up with live audio.
    this.tx(() => {
      const versionId = this.liveVersionId(meetingId)
      const insert = this.db.raw.prepare(INSERT_SEGMENT)
      for (const s of segments) {
        insert.run(meetingId, versionId, s.channel, s.startMs, s.endMs, s.text, s.echo ? 1 : 0)
      }
    })
  }

  /**
   * A new transcript of a meeting, from a source other than the live one. It
   * becomes the main version.
   *
   * The live transcript is never touched, so a careful pass can only ever add.
   * Running the same source again replaces that source's own transcript in
   * place: its summary and English are cleared, because they were written from
   * the lines being replaced, but its tasks stay until a new summary replaces
   * them - they carry whatever you ticked, and the words they were taken from
   * are copied onto them before those lines go.
   *
   * Called only with segments in hand, in one transaction: a failure leaves
   * everything as it was.
   */
  createVersion(
    meetingId: number,
    source: string,
    segments: readonly SegmentInput[],
    at = Date.now()
  ): number {
    if (source === LIVE_SOURCE) {
      throw new Error('the live transcript is written by the recording, not replaced')
    }
    return this.tx(() => {
      const existing = row<{ id: number }>(
        this.db.raw
          .prepare('SELECT id FROM meeting_versions WHERE meeting_id = ? AND source = ?')
          .get(meetingId, source)
      )
      let versionId: number
      if (existing) {
        versionId = existing.id
        this.db.raw
          .prepare(
            `UPDATE tasks SET note_quote = COALESCE(note_quote,
               (SELECT s.text FROM segments s WHERE s.id = tasks.segment_id))
             WHERE version_id = ?`
          )
          .run(versionId)
        this.db.raw.prepare('DELETE FROM segments WHERE version_id = ?').run(versionId)
        this.db.raw
          .prepare(
            `UPDATE meeting_versions SET created_at = ?, notes_md = NULL, diagnostics = '{}'
             WHERE id = ?`
          )
          .run(at, versionId)
      } else {
        versionId = Number(
          this.db.raw
            .prepare('INSERT INTO meeting_versions (meeting_id, source, created_at) VALUES (?, ?, ?)')
            .run(meetingId, source, at).lastInsertRowid
        )
      }

      const insert = this.db.raw.prepare(INSERT_SEGMENT)
      for (const s of segments) {
        insert.run(meetingId, versionId, s.channel, s.startMs, s.endMs, s.text, s.echo ? 1 : 0)
      }
      this.db.raw
        .prepare('UPDATE meetings SET main_version_id = ? WHERE id = ?')
        .run(versionId, meetingId)
      return versionId
    })
  }

  /** Every version of a meeting, oldest first. */
  versions(meetingId: number): VersionRecord[] {
    return rows<VersionRow>(
      this.db.raw
        .prepare(
          `SELECT v.*,
                  (SELECT COUNT(*) FROM segments s WHERE s.version_id = v.id) AS segments,
                  (v.id = m.main_version_id) AS main
           FROM meeting_versions v JOIN meetings m ON m.id = v.meeting_id
           WHERE v.meeting_id = ? ORDER BY v.created_at, v.id`
        )
        .all(meetingId)
    ).map(toVersion)
  }

  version(versionId: number): VersionRecord | null {
    const found = row<VersionRow>(
      this.db.raw
        .prepare(
          `SELECT v.*,
                  (SELECT COUNT(*) FROM segments s WHERE s.version_id = v.id) AS segments,
                  (v.id = m.main_version_id) AS main
           FROM meeting_versions v JOIN meetings m ON m.id = v.meeting_id
           WHERE v.id = ?`
        )
        .get(versionId)
    )
    return found ? toVersion(found) : null
  }

  /**
   * Make another of this meeting's versions the main one: the one its tasks
   * are ticked on and search looks through.
   *
   * For when the careful pass came out worse than the first. On a meeting that
   * was mostly English, it turned English speech into Hindi-script nonsense,
   * and the first pass was the transcript worth working from.
   *
   * @returns false when that version does not belong to this meeting.
   */
  setMain(meetingId: number, versionId: number): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE meetings SET main_version_id = ?
         WHERE id = ? AND EXISTS
           (SELECT 1 FROM meeting_versions v WHERE v.id = ? AND v.meeting_id = ?)`
      )
      .run(versionId, meetingId, versionId, meetingId)
    return Number(result.changes) > 0
  }

  setScratch(id: number, markdown: string): void {
    this.db.raw.prepare('UPDATE meetings SET scratch_md = ? WHERE id = ?').run(markdown, id)
  }

  /** The summary written from one version's transcript. */
  setVersionNotes(versionId: number, markdown: string): void {
    this.db.raw
      .prepare('UPDATE meeting_versions SET notes_md = ? WHERE id = ?')
      .run(markdown, versionId)
  }

  /**
   * Merge into this meeting's diagnostics: what happened while it was recorded.
   *
   * Merged rather than replaced, because the facts arrive at different times.
   * What happened to a particular transcript afterwards is on its version.
   */
  setDiagnostics(id: number, patch: MeetingDiagnostics): void {
    const current = this.byId(id)?.diagnostics ?? {}
    this.db.raw
      .prepare('UPDATE meetings SET diagnostics = ? WHERE id = ?')
      .run(JSON.stringify({ ...current, ...patch }), id)
  }

  /** Merge into one version's diagnostics: how it was transcribed, rendered, summarised. */
  setVersionDiagnostics(versionId: number, patch: VersionDiagnostics): void {
    const current = this.version(versionId)?.diagnostics ?? {}
    this.db.raw
      .prepare('UPDATE meeting_versions SET diagnostics = ? WHERE id = ?')
      .run(JSON.stringify({ ...current, ...patch }), versionId)
  }

  /** Append one notes run to a version's record, keeping the last few. */
  recordNotesRun(versionId: number, run: NonNullable<MeetingDiagnostics['notes']>[number]): void {
    const previous = this.version(versionId)?.diagnostics.notes ?? []
    this.setVersionDiagnostics(versionId, { notes: [...previous, run].slice(-5) })
  }

  setKind(id: number, kind: string): void {
    this.db.raw.prepare('UPDATE meetings SET kind = ? WHERE id = ?').run(kind, id)
  }

  /**
   * Attach English renderings to lines already stored.
   *
   * Keyed on the segment id, so a rendering can only ever land on the line it
   * was made from - and so on the version that line belongs to. Anything the
   * renderer could not produce is simply left null and the raw line stands on
   * its own.
   */
  setEnglish(pairs: readonly { id: number; textEn: string }[]): void {
    if (pairs.length === 0) return
    this.tx(() => {
      const update = this.db.raw.prepare('UPDATE segments SET text_en = ? WHERE id = ?')
      for (const pair of pairs) update.run(pair.textEn, pair.id)
    })
  }

  setTitle(id: number, title: string): void {
    this.db.raw.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(title, id)
  }

  /** Newest first, each with its main version's line count and summary. */
  list(limit = 50, offset = 0): MeetingRecord[] {
    return rows<MeetingWithMain>(
      this.db.raw
        .prepare(`${WITH_MAIN} ORDER BY m.started_at DESC LIMIT ? OFFSET ?`)
        .all(limit, offset)
    ).map((r) => toMeeting(r, this.versions(r.id)))
  }

  byId(id: number): MeetingRecord | null {
    const found = row<MeetingWithMain>(this.db.raw.prepare(`${WITH_MAIN} WHERE m.id = ?`).get(id))
    return found ? toMeeting(found, this.versions(found.id)) : null
  }

  byDir(dir: string): MeetingRecord | null {
    const found = row<MeetingWithMain>(this.db.raw.prepare(`${WITH_MAIN} WHERE m.dir = ?`).get(dir))
    return found ? toMeeting(found, this.versions(found.id)) : null
  }

  /**
   * One version's transcript - the main one unless told otherwise - in the
   * order it was said.
   *
   * Both channels interleaved by time, because that is the conversation. Echo
   * segments are included and flagged; filtering them here would mean the
   * reader could never check whether the flag was right.
   */
  segments(meetingId: number, versionId?: number): SegmentRecord[] {
    return rows<SegmentRow>(
      this.db.raw
        .prepare(
          `SELECT * FROM segments WHERE meeting_id = ? AND version_id = ${VERSION_OR_MAIN}
           ORDER BY start_ms, id`
        )
        .all(meetingId, versionId ?? null, meetingId)
    ).map(toSegment)
  }

  /**
   * Full-text search across every meeting's main version.
   *
   * Only the main one: every line exists once per version, and a search that
   * found everything twice would be wrong in the most visible way possible.
   */
  search(query: string, limit = 100): SegmentRecord[] {
    const trimmed = query.trim()
    if (!trimmed) return []
    try {
      return rows<SegmentRow>(
        this.db.raw
          .prepare(
            `SELECT s.* FROM segments_fts f
             JOIN segments s ON s.id = f.rowid
             JOIN meetings m ON m.id = s.meeting_id AND s.version_id = m.main_version_id
             WHERE segments_fts MATCH ? ORDER BY rank LIMIT ?`
          )
          .all(toMatch(trimmed), limit)
      ).map(toSegment)
    } catch {
      // FTS5 rejects some punctuation outright. An unparseable query is no
      // matches, not an error the person has to understand.
      return []
    }
  }

  /* ------------------------------------------------------------ tasks ---- */

  /**
   * Replace one version's tasks.
   *
   * Replace rather than append, because the only thing that writes them is a
   * notes run, and running it twice should not double the list. A task given a
   * state keeps it - that is a state carried over from another version. One
   * without keeps whatever the same wording had in this version, so writing the
   * summary again does not silently reopen work you finished.
   */
  replaceTasks(versionId: number, tasks: readonly TaskInput[], at = Date.now()): void {
    const owner = row<{ meeting_id: number }>(
      this.db.raw.prepare('SELECT meeting_id FROM meeting_versions WHERE id = ?').get(versionId)
    )
    if (!owner) throw new Error(`there is no version ${versionId}`)
    const previous = new Map(
      this.tasksFor(owner.meeting_id, versionId).map((t) => [t.text.toLowerCase(), t.state] as const)
    )

    this.tx(() => {
      this.db.raw.prepare('DELETE FROM tasks WHERE version_id = ?').run(versionId)
      const insert = this.db.raw.prepare(
        `INSERT INTO tasks (meeting_id, version_id, text, owner, due, segment_id, state, created_at,
                            area, kind, mine, source, note_quote, reason, carried_from,
                            description, evidence, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const task of tasks) {
        insert.run(
          owner.meeting_id,
          versionId,
          task.text,
          task.owner,
          task.due,
          task.segmentId,
          task.state ?? previous.get(task.text.toLowerCase()) ?? 'open',
          at,
          task.area ?? 'other',
          task.kind ?? 'other',
          task.mine ? 1 : 0,
          task.source ?? 'transcript',
          task.noteQuote ?? null,
          task.reason ?? '',
          task.carriedFrom ?? null,
          task.description ?? '',
          JSON.stringify(
            (task.evidence ?? []).map((e) => ({ segmentId: e.segmentId, quote: e.quote }))
          ),
          task.status ?? ''
        )
      }
    })
  }

  /**
   * One version's tasks - the main one unless told otherwise - each carrying
   * the line it came from.
   *
   * The quote is joined here rather than looked up on demand, because a task
   * shown without its evidence is a task you cannot check - and one nobody
   * checks is one nobody trusts.
   */
  tasksFor(meetingId: number, versionId?: number): TaskRecord[] {
    const tasks = rows<TaskRow>(
      this.db.raw
        .prepare(
          `SELECT t.*, s.text AS quote, s.start_ms AS quote_at
           FROM tasks t LEFT JOIN segments s ON s.id = t.segment_id
           WHERE t.meeting_id = ? AND t.version_id = ${VERSION_OR_MAIN} ORDER BY t.id`
        )
        .all(meetingId, versionId ?? null, meetingId)
    ).map(toTask)
    return this.withEvidence(tasks)
  }

  /**
   * Fill in when each cited line was said, and what it says.
   *
   * One query for every line every task cites, rather than a join per task: an
   * hour's tasks cite a hundred lines between them. The line is given in
   * English where there is one, because that is what the task was found in.
   */
  private withEvidence(tasks: TaskRecord[]): TaskRecord[] {
    const ids = [
      ...new Set(tasks.flatMap((t) => t.evidence.filter((e) => e.line === null).map((e) => e.segmentId))),
    ]
    if (ids.length === 0) return tasks
    const found = new Map(
      rows<{ id: number; start_ms: number; line: string }>(
        this.db.raw
          .prepare(
            `SELECT id, start_ms, COALESCE(text_en, text) AS line FROM segments
             WHERE id IN (${ids.map(() => '?').join(', ')})`
          )
          .all(...ids)
      ).map((s) => [s.id, s] as const)
    )
    for (const task of tasks) {
      task.evidence = task.evidence.map((e): TaskEvidence => {
        if (e.line !== null) return e
        const s = found.get(e.segmentId)
        return s ? { ...e, atMs: s.start_ms, line: s.line } : e
      })
    }
    return tasks
  }

  /** Every version's tasks, for carrying what you ticked from one to the next. */
  allTasks(meetingId: number): TaskRecord[] {
    return this.withEvidence(
      rows<TaskRow>(
        this.db.raw
          .prepare(
            `SELECT t.*, s.text AS quote, s.start_ms AS quote_at
             FROM tasks t LEFT JOIN segments s ON s.id = t.segment_id
             WHERE t.meeting_id = ? ORDER BY t.id`
          )
          .all(meetingId)
      ).map(toTask)
    )
  }

  /** Everything still open on each meeting's main version, newest meeting first. */
  openTasks(limit = 200): TaskRecord[] {
    const tasks = rows<TaskRow>(
      this.db.raw
        .prepare(
          `SELECT t.*, s.text AS quote, s.start_ms AS quote_at
           FROM tasks t
           LEFT JOIN segments s ON s.id = t.segment_id
           JOIN meetings m ON m.id = t.meeting_id AND t.version_id = m.main_version_id
           WHERE t.state = 'open' ORDER BY m.started_at DESC, t.id LIMIT ?`
        )
        .all(limit)
    ).map(toTask)
    return this.withEvidence(tasks)
  }

  setTaskState(id: number, state: TaskState): void {
    this.db.raw.prepare('UPDATE tasks SET state = ? WHERE id = ?').run(state, id)
  }

  /** Removes the row, every version and everything in them. The audio on disk is the caller's. */
  remove(id: number): void {
    this.tx(() => {
      this.db.raw.prepare('DELETE FROM tasks WHERE meeting_id = ?').run(id)
      this.db.raw.prepare('DELETE FROM segments WHERE meeting_id = ?').run(id)
      this.db.raw.prepare('UPDATE meetings SET main_version_id = NULL WHERE id = ?').run(id)
      this.db.raw.prepare('DELETE FROM meeting_versions WHERE meeting_id = ?').run(id)
      this.db.raw.prepare('DELETE FROM meetings WHERE id = ?').run(id)
    })
  }
}

/**
 * A typed search string FTS5 will accept.
 *
 * Everything that is not a letter or digit becomes a space, and each remaining
 * word gets a prefix `*` so typing half a word finds it. Without this, an
 * apostrophe or a hyphen is a syntax error rather than a search.
 */
function toMatch(query: string): string {
  const words = query
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return words.map((w) => `"${w}"*`).join(' ')
}
