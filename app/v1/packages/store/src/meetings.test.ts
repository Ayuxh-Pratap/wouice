import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDb, type Db } from './db.js'
import { Meetings } from './meetings.js'
import { MIGRATIONS } from './migrations.js'
import type { SegmentInput } from './types.js'

/**
 * Meetings and their transcripts.
 *
 * The cases that matter are the ones a naive schema gets wrong: a meeting that
 * never ended, a recovery pass that must not create a second row for audio that
 * already has one, a transcript that has to read as a conversation rather than
 * as two separate monologues - and a better transcript that must never cost you
 * the one you had.
 */

let db: Db
let meetings: Meetings

beforeEach(() => {
  db = openDb({ file: ':memory:' })
  meetings = new Meetings(db)
})

const said = (
  channel: 'me' | 'them',
  startMs: number,
  text: string,
  echo = false
): SegmentInput => ({ channel, startMs, endMs: startMs + 1_000, text, echo })

const mainOf = (id: number): number => meetings.byId(id)!.mainVersionId!

describe('a checked summary', () => {
  it('is kept on its version, as data, and cleared with it', () => {
    const id = meetings.start('/sessions/bot', 1_000)
    const versionId = meetings.appendToVersion(id, 'meet-captions', [said('them', 5_000, 'costing about 21000')])
    expect(meetings.version(versionId)?.summary).toBeNull()
    const summary = {
      gist: [{ text: 'A call on the assistant.', points: [0] }],
      points: [{ text: 'Costing is about 21,000', mark: null, segmentIds: [1], quote: 'costing about 21000', atMs: 5_000 }],
    }
    meetings.setVersionSummary(versionId, summary)
    expect(meetings.version(versionId)?.summary).toEqual(summary)
    meetings.setVersionSummary(versionId, null)
    expect(meetings.version(versionId)?.summary).toBeNull()
  })
})

describe('a correction to a stored line', () => {
  it('changes the words in the line that began then, and nowhere else', () => {
    // Meeting 18: Meet's first guess "प्लस" was stored, and Meet rewrote it after.
    const id = meetings.start('/sessions/bot', 1_000)
    meetings.appendToVersion(id, 'meet-captions', [said('them', 5_000, 'तो मतलब प्लस और'), said('them', 9_000, 'प्लस')])
    expect(meetings.reviseLine(id, 'meet-captions', 5_000, 'प्लस', 'ऑप्टिमाइज वाली लाइन हटा दो')).toBe(true)
    expect(meetings.reviseLine(id, 'meet-captions', 7_000, 'प्लस', 'anything')).toBe(false)
    expect(meetings.reviseLine(id, 'meet-captions', 9_000, 'not there', 'anything')).toBe(false)
    const version = meetings.versions(id).find((v) => v.source === 'meet-captions')!
    expect(meetings.segments(id, version.id).map((s) => s.text)).toEqual(['तो मतलब ऑप्टिमाइज वाली लाइन हटा दो और', 'प्लस'])
  })
})

describe('the life of a meeting', () => {
  it('exists from the moment recording starts, not when it ends', () => {
    // An hour that never reached a clean stop is exactly the case worth being
    // able to see, and a table that only learns about meetings when they end
    // cannot describe one.
    const id = meetings.start('/sessions/a', 1_000)
    const record = meetings.byId(id)
    expect(record?.endedAt).toBeNull()
    expect(record?.durationMs).toBe(0)
  })

  it('closes out with its audio once merged', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.finish(id, { endedAt: 5_000, audioPath: '/sessions/a/audio.wav', durationMs: 4_000 })

    const record = meetings.byId(id)
    expect(record?.endedAt).toBe(5_000)
    expect(record?.audioPath).toBe('/sessions/a/audio.wav')
    expect(record?.durationMs).toBe(4_000)
  })

  it('does not create a second row for a directory it already knows', () => {
    // Recovery at startup re-announces a session that was already recorded.
    const first = meetings.start('/sessions/a', 1_000)
    const again = meetings.start('/sessions/a', 9_999)
    expect(again).toBe(first)
    expect(meetings.list()).toHaveLength(1)
    expect(meetings.versions(first)).toHaveLength(1)
  })

  it('lists newest first', () => {
    meetings.start('/sessions/old', 1_000)
    meetings.start('/sessions/new', 9_000)
    expect(meetings.list().map((m) => m.dir)).toEqual(['/sessions/new', '/sessions/old'])
  })

  it('takes its scratch notes and its generated notes separately', () => {
    // What you typed during the call and what the model wrote after it are
    // different things, and the first is an input to the second.
    const id = meetings.start('/sessions/a', 1_000)
    meetings.setScratch(id, 'priya = decision maker')
    meetings.setVersionNotes(mainOf(id), '## Decisions\n- ship on Friday')

    const record = meetings.byId(id)
    expect(record?.scratchMd).toBe('priya = decision maker')
    expect(record?.notesMd).toContain('Decisions')
  })

  it('has no notes until something writes them', () => {
    const id = meetings.start('/sessions/a', 1_000)
    expect(meetings.byId(id)?.notesMd).toBeNull()
    expect(meetings.byId(id)?.scratchMd).toBe('')
  })
})

describe('the transcript', () => {
  it('reads as a conversation, both channels in time order', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [
      said('me', 0, 'can you take the api'),
      said('them', 2_000, 'yes I can'),
      said('me', 4_000, 'thanks'),
    ])
    expect(meetings.segments(id).map((s) => s.channel)).toEqual(['me', 'them', 'me'])
    expect(meetings.byId(id)?.segments).toBe(3)
  })

  it('keeps echo flagged rather than dropping it', () => {
    // A wrongly dropped line cannot be recovered; a wrongly kept one is untidy.
    // Filtering here would also mean nobody could check whether the flag is
    // right.
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'we need SSO before rollout', true)])
    expect(meetings.segments(id)[0]!.echo).toBe(true)
  })

  it('appends across several writes, as segments close during the call', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'first')])
    meetings.addSegments(id, [said('me', 2_000, 'second')])
    expect(meetings.segments(id).map((s) => s.text)).toEqual(['first', 'second'])
  })

  it('writes nothing for an empty batch', () => {
    const id = meetings.start('/sessions/a', 1_000)
    expect(() => meetings.addSegments(id, [])).not.toThrow()
    expect(meetings.segments(id)).toEqual([])
  })
})

describe('versions', () => {
  it('starts with the live transcript as the main version', () => {
    const id = meetings.start('/sessions/a', 1_000)
    const [live] = meetings.versions(id)
    expect(live).toMatchObject({ source: 'live', main: true, segments: 0 })
    expect(meetings.byId(id)?.mainVersionId).toBe(live!.id)
  })

  it('adds an improved version beside the live one, never over it', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('them', 0, 'ki itne saari failiyar')])
    const live = mainOf(id)
    meetings.setVersionNotes(live, 'first summary')

    const improved = meetings.createVersion(id, 'large-v3', [
      said('them', 0, 'कि इतनी सारी फ़ाइलें'),
      said('me', 3_000, 'हाँ'),
    ])

    expect(mainOf(id)).toBe(improved)
    expect(meetings.segments(id).map((s) => s.text)).toEqual(['कि इतनी सारी फ़ाइलें', 'हाँ'])
    // The first pass is still there, exactly as it was.
    expect(meetings.segments(id, live).map((s) => s.text)).toEqual(['ki itne saari failiyar'])
    expect(meetings.version(live)?.notesMd).toBe('first summary')
    // The improved version has no summary until one is written from IT.
    expect(meetings.byId(id)?.notesMd).toBeNull()
    expect(meetings.byId(id)?.segments).toBe(2)
  })

  it('refuses to replace the live transcript', () => {
    const id = meetings.start('/sessions/a', 1_000)
    expect(() => meetings.createVersion(id, 'live', [said('me', 0, 'x')])).toThrow()
  })

  it('replaces a source in place, clearing what was built from the old lines', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'live line')])
    const first = meetings.createVersion(id, 'large-v3', [said('me', 0, 'I will send the report')])
    meetings.setVersionNotes(first, 'improved summary')
    meetings.setVersionDiagnostics(first, { transcription: { at: 1, model: 'large-v3', segments: 1, ms: 5 } })
    const line = meetings.segments(id, first)[0]!
    meetings.replaceTasks(first, [
      { text: 'send the report', owner: 'You', due: null, segmentId: line.id },
    ])
    meetings.setTaskState(meetings.tasksFor(id, first)[0]!.id, 'done')

    const again = meetings.createVersion(id, 'large-v3', [said('me', 0, 'I will send the full report')])

    expect(again).toBe(first)
    expect(meetings.versions(id)).toHaveLength(2)
    expect(meetings.segments(id, again).map((s) => s.text)).toEqual(['I will send the full report'])
    expect(meetings.version(again)?.notesMd).toBeNull()
    expect(meetings.version(again)?.diagnostics.transcription).toBeUndefined()
    // What you ticked survives until a new summary replaces it, still showing
    // the words it came from.
    const [kept] = meetings.tasksFor(id, again)
    expect(kept).toMatchObject({ state: 'done', quote: 'I will send the report' })
  })

  it('can go back to the first pass as the main version', () => {
    // For when the careful pass came out worse than the first.
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'okay, so I am recording this for testing')])
    const live = mainOf(id)
    const improved = meetings.createVersion(id, 'large-v3', [said('me', 0, 'अगर आपको इसे पर')])

    expect(meetings.setMain(id, live)).toBe(true)
    expect(mainOf(id)).toBe(live)
    expect(meetings.segments(id).map((s) => s.text)).toEqual(['okay, so I am recording this for testing'])
    expect(meetings.search('testing')).toHaveLength(1)

    // Only its own versions.
    const other = meetings.start('/sessions/b', 2_000)
    expect(meetings.setMain(other, improved)).toBe(false)
    expect(mainOf(other)).not.toBe(improved)
  })

  it('keeps each version’s diagnostics to itself', () => {
    const id = meetings.start('/sessions/a', 1_000)
    const live = mainOf(id)
    const improved = meetings.createVersion(id, 'large-v3', [said('me', 0, 'x')])
    meetings.recordNotesRun(improved, { at: 5, ok: true, chunks: 1, gaps: 0, tasks: 0, ms: 1 })
    expect(meetings.version(improved)?.diagnostics.notes).toHaveLength(1)
    expect(meetings.version(live)?.diagnostics.notes).toBeUndefined()
  })
})

describe('search', () => {
  it('finds a phrase across meetings', () => {
    const one = meetings.start('/sessions/one', 1_000)
    const two = meetings.start('/sessions/two', 2_000)
    meetings.addSegments(one, [said('them', 0, 'they need SSO before rollout')])
    meetings.addSegments(two, [said('me', 0, 'the pricing question is open')])

    expect(meetings.search('SSO').map((s) => s.meetingId)).toEqual([one])
    expect(meetings.search('pricing').map((s) => s.meetingId)).toEqual([two])
  })

  it('looks only through the main version, so nothing is found twice', () => {
    const id = meetings.start('/sessions/one', 1_000)
    meetings.addSegments(id, [said('them', 0, 'the rollout slips a week')])
    meetings.createVersion(id, 'large-v3', [said('them', 0, 'the rollout slips by a week')])
    const hits = meetings.search('rollout')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.text).toBe('the rollout slips by a week')
  })

  it('matches a partial word, because you type as you think', () => {
    const id = meetings.start('/sessions/one', 1_000)
    meetings.addSegments(id, [said('me', 0, 'the deployment pipeline is slow')])
    expect(meetings.search('deploy')).toHaveLength(1)
  })

  it('treats punctuation as a search, not a syntax error', () => {
    // FTS5 rejects a bare apostrophe or quote outright.
    const id = meetings.start('/sessions/one', 1_000)
    meetings.addSegments(id, [said('me', 0, "we can't ship it")])
    expect(() => meetings.search("can't")).not.toThrow()
    expect(meetings.search('"')).toEqual([])
    expect(meetings.search('   ')).toEqual([])
  })

  it('stops finding text that was deleted', () => {
    const id = meetings.start('/sessions/one', 1_000)
    meetings.addSegments(id, [said('me', 0, 'a memorable phrase')])
    meetings.createVersion(id, 'large-v3', [said('me', 0, 'a memorable phrase indeed')])
    expect(meetings.search('memorable')).toHaveLength(1)
    meetings.remove(id)
    expect(meetings.search('memorable')).toEqual([])
    expect(meetings.byId(id)).toBeNull()
    expect(meetings.versions(id)).toEqual([])
  })
})

describe('tasks', () => {
  it('carries the line each one came from', () => {
    // A task shown without its evidence is a task nobody can check, and one
    // nobody checks is one nobody trusts.
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'I will send the SSO timeline on Monday')])
    const segment = meetings.segments(id)[0]!

    meetings.replaceTasks(mainOf(id), [
      { text: 'send the SSO timeline', owner: 'You', due: '2026-09-14', segmentId: segment.id },
    ])

    const [task] = meetings.tasksFor(id)
    expect(task!.quote).toBe('I will send the SSO timeline on Monday')
    expect(task!.quoteAtMs).toBe(0)
    expect(task!.state).toBe('open')
    expect(task!.versionId).toBe(mainOf(id))
  })

  it('replaces rather than appends, so regenerating does not double the list', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'a commitment')])
    const segment = meetings.segments(id)[0]!

    const task = { text: 'do the thing', owner: null, due: null, segmentId: segment.id }
    meetings.replaceTasks(mainOf(id), [task])
    meetings.replaceTasks(mainOf(id), [task])
    expect(meetings.tasksFor(id)).toHaveLength(1)
  })

  it('does not reopen work you already finished', () => {
    // Regenerating notes is a routine thing to do. Silently un-ticking a task
    // you completed would make the list untrustworthy.
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'a commitment')])
    const segment = meetings.segments(id)[0]!
    const task = { text: 'do the thing', owner: null, due: null, segmentId: segment.id }

    meetings.replaceTasks(mainOf(id), [task])
    meetings.setTaskState(meetings.tasksFor(id)[0]!.id, 'done')
    meetings.replaceTasks(mainOf(id), [task])

    expect(meetings.tasksFor(id)[0]!.state).toBe('done')
  })

  it('takes a state and its origin when one is carried from another version', () => {
    const id = meetings.start('/sessions/a', 1_000)
    const improved = meetings.createVersion(id, 'large-v3', [said('me', 0, 'x')])
    meetings.replaceTasks(improved, [
      { text: 'ship it', owner: null, due: null, segmentId: null, state: 'dropped', carriedFrom: 'live' },
    ])
    expect(meetings.tasksFor(id)[0]).toMatchObject({ state: 'dropped', carriedFrom: 'live' })
  })

  it('keeps each version’s tasks apart', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'a commitment')])
    const live = mainOf(id)
    meetings.replaceTasks(live, [{ text: 'first pass task', owner: null, due: null, segmentId: null }])
    const improved = meetings.createVersion(id, 'large-v3', [said('me', 0, 'a better commitment')])
    meetings.replaceTasks(improved, [{ text: 'improved task', owner: null, due: null, segmentId: null }])

    expect(meetings.tasksFor(id).map((t) => t.text)).toEqual(['improved task'])
    expect(meetings.tasksFor(id, live).map((t) => t.text)).toEqual(['first pass task'])
    expect(meetings.allTasks(id)).toHaveLength(2)
  })

  it('keeps a task’s story and every line it came from, with when each was said', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [
      said('them', 7_000, 'We still have not fixed the capitalization in the carousel'),
      said('them', 9_000, 'Yeah, we are doing it right now'),
    ])
    const [first, second] = meetings.segments(id)
    meetings.replaceTasks(mainOf(id), [
      {
        text: 'Fix capitalization in the carousel',
        description: 'Raised on several calls; the team is fixing it now.',
        owner: null,
        due: null,
        segmentId: first!.id,
        evidence: [
          { segmentId: first!.id, quote: 'fixed the capitalization' },
          { segmentId: second!.id, quote: '' },
        ],
        status: 'agreed',
        kind: 'bug',
      },
    ])

    const [task] = meetings.tasksFor(id)
    expect(task).toMatchObject({
      description: 'Raised on several calls; the team is fixing it now.',
      status: 'agreed',
      kind: 'bug',
    })
    expect(task!.evidence).toEqual([
      {
        segmentId: first!.id,
        quote: 'fixed the capitalization',
        atMs: 7_000,
        line: 'We still have not fixed the capitalization in the carousel',
      },
      { segmentId: second!.id, quote: '', atMs: 9_000, line: 'Yeah, we are doing it right now' },
    ])
  })

  it('gives a task from before evidence existed its one line', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 3_000, 'I will send the report')])
    const segment = meetings.segments(id)[0]!
    meetings.replaceTasks(mainOf(id), [
      { text: 'send the report', owner: 'You', due: null, segmentId: segment.id },
    ])
    expect(meetings.tasksFor(id)[0]!.evidence).toEqual([
      { segmentId: segment.id, quote: '', atMs: 3_000, line: 'I will send the report' },
    ])
  })

  it('lists what is still open on main versions, newest meeting first', () => {
    const older = meetings.start('/sessions/older', 1_000)
    const newer = meetings.start('/sessions/newer', 9_000)
    for (const id of [older, newer]) {
      meetings.addSegments(id, [said('me', 0, 'a commitment')])
      const segment = meetings.segments(id)[0]!
      meetings.replaceTasks(mainOf(id), [
        { text: `task for ${id}`, owner: null, due: null, segmentId: segment.id },
      ])
    }
    expect(meetings.openTasks().map((t) => t.meetingId)).toEqual([newer, older])

    meetings.setTaskState(meetings.tasksFor(newer)[0]!.id, 'done')
    expect(meetings.openTasks().map((t) => t.meetingId)).toEqual([older])

    // A first pass that has been improved on no longer lists its tasks.
    meetings.createVersion(older, 'large-v3', [said('me', 0, 'x')])
    expect(meetings.openTasks()).toEqual([])
  })

  it('goes when its meeting goes', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'a commitment')])
    const segment = meetings.segments(id)[0]!
    meetings.replaceTasks(mainOf(id), [
      { text: 'do the thing', owner: null, due: null, segmentId: segment.id },
    ])
    meetings.remove(id)
    expect(meetings.openTasks()).toEqual([])
  })
})

describe('upgrading a database from before versions', () => {
  it('turns each meeting into one version holding what it had', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec('PRAGMA foreign_keys = ON')
    for (const m of MIGRATIONS.filter((m) => m.id <= 9)) raw.exec(m.sql)
    raw.exec('PRAGMA user_version = 9')

    raw
      .prepare(`INSERT INTO meetings (id, started_at, dir, notes_md, diagnostics) VALUES (1, 100, '/a', 'old summary', ?)`)
      .run(JSON.stringify({ asrModel: 'turbo', english: { at: 5, rendered: 1, missed: 0, failedBatches: 0, ms: 1 } }))
    raw
      .prepare(`INSERT INTO meetings (id, started_at, dir, diagnostics) VALUES (2, 200, '/b', ?)`)
      .run(JSON.stringify({ repass: { at: 9, model: 'large-v3', segments: 1, ms: 2 } }))
    raw.exec(`INSERT INTO segments (id, meeting_id, channel, start_ms, end_ms, text) VALUES (1, 1, 'me', 0, 1, 'hello')`)
    raw.exec(`INSERT INTO tasks (meeting_id, text, segment_id, state, created_at) VALUES (1, 'say hi', 1, 'done', 1)`)

    migrate(raw)
    const upgraded = new Meetings({ raw, file: ':memory:', version: 10, close: () => raw.close() })

    const first = upgraded.byId(1)!
    expect(first.versions).toHaveLength(1)
    expect(first.versions[0]).toMatchObject({ source: 'live', main: true, notesMd: 'old summary', segments: 1 })
    expect(first.versions[0]!.diagnostics.english).toMatchObject({ rendered: 1 })
    expect(first.notesMd).toBe('old summary')
    expect(upgraded.segments(1).map((s) => s.text)).toEqual(['hello'])
    expect(upgraded.tasksFor(1)[0]).toMatchObject({ text: 'say hi', state: 'done' })
    // One the careful pass had already rewritten is labelled by what made it.
    expect(upgraded.byId(2)!.versions[0]).toMatchObject({ source: 'large-v3' })
  })
})
