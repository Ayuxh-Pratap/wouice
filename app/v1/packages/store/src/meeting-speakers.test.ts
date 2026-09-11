import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from './db.js'
import { Meetings } from './meetings.js'
import { MEET_CAPTIONS_SOURCE, type SegmentInput } from './types.js'

/**
 * Lines with names on them, and a transcript that grows while the meeting
 * happens: what the meeting bot stores from Meet's captions.
 */

let meetings: Meetings

beforeEach(() => {
  meetings = new Meetings(openDb({ file: ':memory:' }))
})

const line = (startMs: number, text: string, speaker: string | null, channel: 'me' | 'them' = 'them'): SegmentInput => ({
  channel,
  startMs,
  endMs: startMs + 1_000,
  text,
  echo: false,
  speaker,
})

describe('speakers', () => {
  it('keeps the name of whoever said each line', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [line(0, 'I will check the branch', 'Rahul Dhir'), line(2_000, 'thanks', null, 'me')])
    expect(meetings.segments(id).map((s) => [s.speaker, s.text])).toEqual([
      ['Rahul Dhir', 'I will check the branch'],
      [null, 'thanks'],
    ])
  })

  it('is one person across meetings, however often the name comes up', () => {
    const one = meetings.start('/sessions/one', 1_000)
    const two = meetings.start('/sessions/two', 2_000)
    meetings.addSegments(one, [line(0, 'a', 'Priya'), line(1_000, 'b', 'Priya')])
    meetings.addSegments(two, [line(0, 'c', ' Priya ')])
    const all = [...meetings.segments(one), ...meetings.segments(two)]
    expect(new Set(all.map((s) => s.speaker))).toEqual(new Set(['Priya']))
  })

  it('finds a line by search with its speaker', () => {
    const id = meetings.start('/sessions/a', 1_000)
    meetings.addSegments(id, [line(0, 'the leaderboard shows old data', 'Rahul Dhir')])
    expect(meetings.search('leaderboard')[0]!.speaker).toBe('Rahul Dhir')
  })
})

describe('a transcript that grows during the call', () => {
  it('is made on the first lines, grows with the next, and leaves the live one alone', () => {
    const id = meetings.start('/sessions/bot', 1_000)
    const first = meetings.appendToVersion(id, MEET_CAPTIONS_SOURCE, [line(0, 'hello', 'Rahul Dhir')])
    const again = meetings.appendToVersion(id, MEET_CAPTIONS_SOURCE, [line(5_000, 'shall we start', 'Priya')])
    expect(again).toBe(first)
    expect(meetings.segments(id, first).map((s) => s.text)).toEqual(['hello', 'shall we start'])
    // Not the main version until somebody says so.
    expect(meetings.byId(id)?.mainVersionId).not.toBe(first)
    expect(meetings.setMain(id, first)).toBe(true)
    expect(meetings.byId(id)?.segments).toBe(2)
  })

  it('can be made before any line arrives', () => {
    const id = meetings.start('/sessions/bot', 1_000)
    const versionId = meetings.appendToVersion(id, MEET_CAPTIONS_SOURCE, [])
    expect(meetings.versions(id).find((v) => v.id === versionId)).toMatchObject({ source: 'meet-captions', segments: 0 })
  })

  it('refuses to write into the live transcript', () => {
    const id = meetings.start('/sessions/bot', 1_000)
    expect(() => meetings.appendToVersion(id, 'live', [line(0, 'x', null)])).toThrow()
  })
})
