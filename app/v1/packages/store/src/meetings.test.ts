import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './db.js'
import { Meetings } from './meetings.js'
import type { SegmentInput } from './types.js'

/**
 * Meetings and their transcripts.
 *
 * The cases that matter are the ones a naive schema gets wrong: a meeting that
 * never ended, a recovery pass that must not create a second row for audio that
 * already has one, and a transcript that has to read as a conversation rather
 * than as two separate monologues.
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
    meetings.setNotes(id, '## Decisions\n- ship on Friday')

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

describe('search', () => {
  it('finds a phrase across meetings', () => {
    const one = meetings.start('/sessions/one', 1_000)
    const two = meetings.start('/sessions/two', 2_000)
    meetings.addSegments(one, [said('them', 0, 'they need SSO before rollout')])
    meetings.addSegments(two, [said('me', 0, 'the pricing question is open')])

    expect(meetings.search('SSO').map((s) => s.meetingId)).toEqual([one])
    expect(meetings.search('pricing').map((s) => s.meetingId)).toEqual([two])
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
    expect(meetings.search('memorable')).toHaveLength(1)
    meetings.remove(id)
    expect(meetings.search('memorable')).toEqual([])
    expect(meetings.byId(id)).toBeNull()
  })
})

describe('tasks', () => {
  it('carries the line each one came from', () => {
    // A task shown without its evidence is a task nobody can check, and one
    // nobody checks is one nobody trusts.
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'I will send the SSO timeline on Monday')])
    const segment = meetings.segments(id)[0]!

    meetings.replaceTasks(id, [
      { text: 'send the SSO timeline', owner: 'You', due: '2026-09-14', segmentId: segment.id },
    ])

    const [task] = meetings.tasksFor(id)
    expect(task!.quote).toBe('I will send the SSO timeline on Monday')
    expect(task!.quoteAtMs).toBe(0)
    expect(task!.state).toBe('open')
  })

  it('replaces rather than appends, so regenerating does not double the list', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'a commitment')])
    const segment = meetings.segments(id)[0]!

    const task = { text: 'do the thing', owner: null, due: null, segmentId: segment.id }
    meetings.replaceTasks(id, [task])
    meetings.replaceTasks(id, [task])
    expect(meetings.tasksFor(id)).toHaveLength(1)
  })

  it('does not reopen work you already finished', () => {
    // Regenerating notes is a routine thing to do. Silently un-ticking a task
    // you completed would make the list untrustworthy.
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'a commitment')])
    const segment = meetings.segments(id)[0]!
    const task = { text: 'do the thing', owner: null, due: null, segmentId: segment.id }

    meetings.replaceTasks(id, [task])
    meetings.setTaskState(meetings.tasksFor(id)[0]!.id, 'done')
    meetings.replaceTasks(id, [task])

    expect(meetings.tasksFor(id)[0]!.state).toBe('done')
  })

  it('lists what is still open across meetings, newest first', () => {
    const older = meetings.start('/sessions/older', 1_000)
    const newer = meetings.start('/sessions/newer', 9_000)
    for (const id of [older, newer]) {
      meetings.addSegments(id, [said('me', 0, 'a commitment')])
      const segment = meetings.segments(id)[0]!
      meetings.replaceTasks(id, [
        { text: `task for ${id}`, owner: null, due: null, segmentId: segment.id },
      ])
    }
    expect(meetings.openTasks().map((t) => t.meetingId)).toEqual([newer, older])

    meetings.setTaskState(meetings.tasksFor(newer)[0]!.id, 'done')
    expect(meetings.openTasks().map((t) => t.meetingId)).toEqual([older])
  })

  it('goes when its meeting goes', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [said('me', 0, 'a commitment')])
    const segment = meetings.segments(id)[0]!
    meetings.replaceTasks(id, [
      { text: 'do the thing', owner: null, due: null, segmentId: segment.id },
    ])
    meetings.remove(id)
    expect(meetings.openTasks()).toEqual([])
  })
})
