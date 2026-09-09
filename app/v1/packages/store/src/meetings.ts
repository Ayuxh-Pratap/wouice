import { rows, row, type Db } from './db.js'
import type { MeetingRecord, SegmentInput, SegmentRecord } from './types.js'

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
}

interface SegmentRow {
  id: number
  meeting_id: number
  channel: string
  start_ms: number
  end_ms: number
  text: string
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
    segments,
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
    echo: r.echo === 1,
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
  start(dir: string, startedAt: number): number {
    const existing = row<{ id: number }>(
      this.db.raw.prepare('SELECT id FROM meetings WHERE dir = ?').get(dir)
    )
    if (existing) return existing.id

    const result = this.db.raw
      .prepare('INSERT INTO meetings (started_at, dir) VALUES (?, ?)')
      .run(startedAt, dir)
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

  setScratch(id: number, markdown: string): void {
    this.db.raw.prepare('UPDATE meetings SET scratch_md = ? WHERE id = ?').run(markdown, id)
  }

  setNotes(id: number, markdown: string): void {
    this.db.raw.prepare('UPDATE meetings SET notes_md = ? WHERE id = ?').run(markdown, id)
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

  /** Removes the row and its segments. The audio on disk is the caller's. */
  remove(id: number): void {
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
