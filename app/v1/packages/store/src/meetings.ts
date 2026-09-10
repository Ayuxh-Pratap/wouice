import { rows, row, type Db } from './db.js'
import { TASK_AREAS, TASK_KINDS } from './types.js'
import type {
  MeetingDiagnostics,
  TaskArea,
  TaskKind,
  MeetingRecord,
  SegmentInput,
  SegmentRecord,
  TaskInput,
  TaskRecord,
  TaskState,
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

function toMeeting(r: MeetingRow, segments = 0): MeetingRecord {
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
    notesMd: r.notes_md,
    kind: r.kind ?? 'mixed',
    diagnostics: readDiagnostics(r.diagnostics),
    segments,
  }
}

function readDiagnostics(raw: string | null): MeetingDiagnostics {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as MeetingDiagnostics)
      : {}
  } catch {
    return {}
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
}

function toTask(r: TaskRow): TaskRecord {
  const state: TaskState =
    r.state === 'done' ? 'done' : r.state === 'dropped' ? 'dropped' : 'open'
  return {
    id: r.id,
    meetingId: r.meeting_id,
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
  }
}

export class Meetings {
  constructor(private readonly db: Db) {}

  /**
   * Record that a meeting has begun.
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

    const result = this.db.raw
      .prepare('INSERT INTO meetings (started_at, dir, kind) VALUES (?, ?, ?)')
      .run(startedAt, dir, kind)
    return Number(result.lastInsertRowid)
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

  /** Append transcript segments. Written as they close, not batched at the end. */
  addSegments(meetingId: number, segments: readonly SegmentInput[]): void {
    if (segments.length === 0) return
    const insert = this.db.raw.prepare(
      `INSERT INTO segments (meeting_id, channel, start_ms, end_ms, text, echo)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    // One transaction: twenty separate commits during a meeting is twenty
    // fsyncs on the path that has to keep up with live audio.
    this.db.raw.exec('BEGIN')
    try {
      for (const s of segments) {
        insert.run(meetingId, s.channel, s.startMs, s.endMs, s.text, s.echo ? 1 : 0)
      }
      this.db.raw.exec('COMMIT')
    } catch (err) {
      this.db.raw.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Swap in a completely new transcript for one meeting.
   *
   * Used by the careful re-transcription pass, and only ever with segments in
   * hand: the delete and the insert are one transaction, so a failure halfway
   * leaves the previous transcript rather than an empty meeting.
   *
   * The English renderings go with the old rows, because they were renderings
   * OF those rows. Keeping them would attach an English sentence to a line that
   * now says something different, which is worse than having none.
   */
  replaceSegments(meetingId: number, segments: readonly SegmentInput[]): void {
    this.db.raw.exec('BEGIN')
    try {
      this.db.raw.prepare('DELETE FROM segments WHERE meeting_id = ?').run(meetingId)
      const insert = this.db.raw.prepare(
        `INSERT INTO segments (meeting_id, channel, start_ms, end_ms, text, echo)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (const s of segments) {
        insert.run(meetingId, s.channel, s.startMs, s.endMs, s.text, s.echo ? 1 : 0)
      }
      this.db.raw.exec('COMMIT')
    } catch (err) {
      this.db.raw.exec('ROLLBACK')
      throw err
    }
  }

  setScratch(id: number, markdown: string): void {
    this.db.raw.prepare('UPDATE meetings SET scratch_md = ? WHERE id = ?').run(markdown, id)
  }

  setNotes(id: number, markdown: string): void {
    this.db.raw.prepare('UPDATE meetings SET notes_md = ? WHERE id = ?').run(markdown, id)
  }

  /**
   * Merge into this meeting's diagnostics.
   *
   * Merged rather than replaced, because the facts arrive at different times:
   * the channels and the drift when recording stops, the notes run whenever
   * somebody asks for it, possibly days later.
   */
  setDiagnostics(id: number, patch: MeetingDiagnostics): void {
    const current = this.byId(id)?.diagnostics ?? {}
    const merged = { ...current, ...patch }
    this.db.raw
      .prepare('UPDATE meetings SET diagnostics = ? WHERE id = ?')
      .run(JSON.stringify(merged), id)
  }

  /** Append one notes run to the record, keeping the last few. */
  recordNotesRun(id: number, run: NonNullable<MeetingDiagnostics['notes']>[number]): void {
    const previous = this.byId(id)?.diagnostics.notes ?? []
    this.setDiagnostics(id, { notes: [...previous, run].slice(-5) })
  }

  setKind(id: number, kind: string): void {
    this.db.raw.prepare('UPDATE meetings SET kind = ? WHERE id = ?').run(kind, id)
  }

  /**
   * Attach English renderings to lines already stored.
   *
   * Keyed on the segment id, so a rendering can only ever land on the line it
   * was made from. Anything the renderer could not produce is simply left null
   * and the raw line stands on its own.
   */
  setEnglish(pairs: readonly { id: number; textEn: string }[]): void {
    if (pairs.length === 0) return
    const update = this.db.raw.prepare('UPDATE segments SET text_en = ? WHERE id = ?')
    this.db.raw.exec('BEGIN')
    try {
      for (const pair of pairs) update.run(pair.textEn, pair.id)
      this.db.raw.exec('COMMIT')
    } catch (err) {
      this.db.raw.exec('ROLLBACK')
      throw err
    }
  }

  setTitle(id: number, title: string): void {
    this.db.raw.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(title, id)
  }

  /** Newest first, with each meeting's segment count. */
  list(limit = 50, offset = 0): MeetingRecord[] {
    const found = rows<MeetingRow & { segments: number }>(
      this.db.raw
        .prepare(
          `SELECT m.*, (SELECT COUNT(*) FROM segments s WHERE s.meeting_id = m.id) AS segments
           FROM meetings m ORDER BY m.started_at DESC LIMIT ? OFFSET ?`
        )
        .all(limit, offset)
    )
    return found.map((r) => toMeeting(r, r.segments))
  }

  byId(id: number): MeetingRecord | null {
    const found = row<MeetingRow & { segments: number }>(
      this.db.raw
        .prepare(
          `SELECT m.*, (SELECT COUNT(*) FROM segments s WHERE s.meeting_id = m.id) AS segments
           FROM meetings m WHERE m.id = ?`
        )
        .get(id)
    )
    return found ? toMeeting(found, found.segments) : null
  }

  byDir(dir: string): MeetingRecord | null {
    const found = row<MeetingRow>(
      this.db.raw.prepare('SELECT * FROM meetings WHERE dir = ?').get(dir)
    )
    return found ? toMeeting(found) : null
  }

  /**
   * One meeting's transcript, in the order it was said.
   *
   * Both channels interleaved by time, because that is the conversation. Echo
   * segments are included and flagged; filtering them here would mean the
   * reader could never check whether the flag was right.
   */
  segments(meetingId: number): SegmentRecord[] {
    return rows<SegmentRow>(
      this.db.raw
        .prepare('SELECT * FROM segments WHERE meeting_id = ? ORDER BY start_ms, id')
        .all(meetingId)
    ).map(toSegment)
  }

  /** Full-text search across every meeting. */
  search(query: string, limit = 100): SegmentRecord[] {
    const trimmed = query.trim()
    if (!trimmed) return []
    try {
      return rows<SegmentRow>(
        this.db.raw
          .prepare(
            `SELECT s.* FROM segments_fts f JOIN segments s ON s.id = f.rowid
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
   * Replace this meeting's tasks.
   *
   * Replace rather than append, because the only thing that writes them is a
   * notes run, and running it twice should not double the list. Tasks you have
   * already marked done survive: their state is matched back by text, so a
   * regenerate does not silently reopen work you finished.
   */
  replaceTasks(meetingId: number, tasks: readonly TaskInput[], at = Date.now()): void {
    const previous = new Map(
      this.tasksFor(meetingId).map((t) => [t.text.toLowerCase(), t.state] as const)
    )

    this.db.raw.exec('BEGIN')
    try {
      this.db.raw.prepare('DELETE FROM tasks WHERE meeting_id = ?').run(meetingId)
      const insert = this.db.raw.prepare(
        `INSERT INTO tasks (meeting_id, text, owner, due, segment_id, state, created_at,
                            area, kind, mine, source, note_quote, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const task of tasks) {
        insert.run(
          meetingId,
          task.text,
          task.owner,
          task.due,
          task.segmentId,
          previous.get(task.text.toLowerCase()) ?? 'open',
          at,
          task.area ?? 'other',
          task.kind ?? 'other',
          task.mine ? 1 : 0,
          task.source ?? 'transcript',
          task.noteQuote ?? null,
          task.reason ?? ''
        )
      }
      this.db.raw.exec('COMMIT')
    } catch (err) {
      this.db.raw.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * One meeting's tasks, each carrying the line it came from.
   *
   * The quote is joined here rather than looked up on demand, because a task
   * shown without its evidence is a task you cannot check - and one nobody
   * checks is one nobody trusts.
   */
  tasksFor(meetingId: number): TaskRecord[] {
    return rows<TaskRow>(
      this.db.raw
        .prepare(
          `SELECT t.*, s.text AS quote, s.start_ms AS quote_at
           FROM tasks t LEFT JOIN segments s ON s.id = t.segment_id
           WHERE t.meeting_id = ? ORDER BY t.id`
        )
        .all(meetingId)
    ).map(toTask)
  }

  /** Everything still open, newest meeting first. */
  openTasks(limit = 200): TaskRecord[] {
    return rows<TaskRow>(
      this.db.raw
        .prepare(
          `SELECT t.*, s.text AS quote, s.start_ms AS quote_at
           FROM tasks t
           LEFT JOIN segments s ON s.id = t.segment_id
           JOIN meetings m ON m.id = t.meeting_id
           WHERE t.state = 'open' ORDER BY m.started_at DESC, t.id LIMIT ?`
        )
        .all(limit)
    ).map(toTask)
  }

  setTaskState(id: number, state: TaskState): void {
    this.db.raw.prepare('UPDATE tasks SET state = ? WHERE id = ?').run(state, id)
  }

  /** Removes the row and its segments. The audio on disk is the caller's. */
  remove(id: number): void {
    this.db.raw.prepare('DELETE FROM tasks WHERE meeting_id = ?').run(id)
    this.db.raw.prepare('DELETE FROM segments WHERE meeting_id = ?').run(id)
    this.db.raw.prepare('DELETE FROM meetings WHERE id = ?').run(id)
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
