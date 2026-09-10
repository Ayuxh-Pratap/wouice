import type { TaskRecord } from '@wouice/store'
import { describe, expect, it } from 'vitest'
import { carryOver, sameTaskAcross, type NewTask } from './versions.js'

/**
 * What you did with tasks, carried from the first pass to the improved one.
 *
 * The rule under test: work you finished never reappears as open, and work you
 * acted on never silently disappears.
 */

const old = (over: Partial<TaskRecord>): TaskRecord => ({
  id: 1,
  meetingId: 10,
  versionId: 1,
  text: 'check the leader board page',
  owner: null,
  due: null,
  segmentId: 603,
  state: 'done',
  createdAt: 0,
  area: 'frontend',
  kind: 'bug',
  mine: false,
  source: 'transcript',
  noteQuote: null,
  reason: 'they said they would check it',
  quote: 'leader board on vote page users are seeing old data',
  quoteAtMs: 3_201_008,
  carriedFrom: null,
  ...over,
})

const fresh = (text: string, atMs: number | null): NewTask => ({
  text,
  owner: null,
  due: null,
  segmentId: 9_001,
  atMs,
})

const sourceOf = (versionId: number | null): string => (versionId === 1 ? 'live' : 'large-v3')

describe('matching a task across versions', () => {
  it('accepts a rewording said at the same moment', () => {
    // From a real meeting: the first pass and the careful pass worded the same
    // leaderboard check differently.
    expect(
      sameTaskAcross(
        { text: 'check the leader board page', atMs: 3_201_008 },
        { text: 'check the leaderboard page in Safari', atMs: 3_215_000 }
      )
    ).toBe(true)
  })

  it('refuses the same words an hour apart unless they are nearly identical', () => {
    expect(
      sameTaskAcross(
        { text: 'check the leader board page', atMs: 0 },
        { text: 'check the leader board', atMs: 3_600_000 }
      )
    ).toBe(true)
    expect(
      sameTaskAcross(
        { text: 'check the branch name', atMs: 0 },
        { text: 'check the leaderboard page', atMs: 3_600_000 }
      )
    ).toBe(false)
  })
})

describe('carrying what you did', () => {
  it('puts your tick on the matching new task', () => {
    const { tasks, carried } = carryOver(
      [old({})],
      [fresh('check the leaderboard page in Safari', 3_215_000)],
      sourceOf
    )
    expect(tasks[0]!.state).toBe('done')
    expect(carried).toEqual([])
  })

  it('keeps a task you acted on that the new version did not find, marked', () => {
    const { tasks, carried } = carryOver(
      [old({ text: 'ping Bprayib when the condition is met', state: 'dropped', quoteAtMs: 642_328 })],
      [fresh('check the leaderboard page', 3_215_000)],
      sourceOf
    )
    expect(tasks[0]!.state).toBeUndefined()
    expect(carried).toEqual([
      expect.objectContaining({
        text: 'ping Bprayib when the condition is met',
        state: 'dropped',
        carriedFrom: 'live',
        // Its words travel with it.
        noteQuote: 'leader board on vote page users are seeing old data',
      }),
    ])
  })

  it('leaves untouched tasks behind: the newer transcript decides those', () => {
    const { carried } = carryOver([old({ state: 'open' })], [], sourceOf)
    expect(carried).toEqual([])
  })

  it('carries a task once, however many versions it was ticked in', () => {
    const { carried } = carryOver(
      [old({ versionId: 2, state: 'done' }), old({ versionId: 1, state: 'dropped' })],
      [],
      sourceOf
    )
    expect(carried).toHaveLength(1)
    // The most recent state wins: the list is given newest first.
    expect(carried[0]).toMatchObject({ state: 'done', carriedFrom: 'large-v3' })
  })

  it('keeps the origin of a task that was already carried once', () => {
    const { carried } = carryOver([old({ versionId: 2, carriedFrom: 'live' })], [], sourceOf)
    expect(carried[0]!.carriedFrom).toBe('live')
  })
})
