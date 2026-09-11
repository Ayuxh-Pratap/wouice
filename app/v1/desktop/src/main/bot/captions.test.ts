import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CaptionAssembler, MeetFeed, Roster, captionSegment } from './captions.js'
import { base64, bytes, collectionEvent, int, pageMessage, u8, userEntry } from './meet-fixtures.js'
import type { CaptionUpdate, MeetUser } from './meet-protocol.js'

/**
 * Captions to lines, and the room to names: the rules that decide what the
 * transcript says and whose it is.
 */

const cap = (over: Partial<CaptionUpdate>): CaptionUpdate => ({
  deviceId: 'd-rahul',
  captionId: '1',
  version: 1,
  text: '',
  isFinal: false,
  language: 'hi-IN',
  ...over,
})

const person = (over: Partial<MeetUser>): MeetUser => ({
  deviceId: 'd-rahul',
  fullName: 'Rahul Dhir',
  displayName: '',
  status: 1,
  isSelf: false,
  isHost: false,
  screenShareOf: null,
  ...over,
})

const names = (deviceId: string): string | null => ({ 'd-rahul': 'Rahul Dhir' } as Record<string, string>)[deviceId] ?? null

describe('assembling captions', () => {
  it('keeps the newest version of a caption, and makes it a line once final', () => {
    const a = new CaptionAssembler()
    a.update(cap({ version: 1, text: 'I will' }), 1_000)
    a.update(cap({ version: 2, text: 'I will send' }), 1_400)
    expect(a.take(1_500, names)).toEqual([])
    a.update(cap({ version: 3, text: 'I will send it on Monday', isFinal: true }), 2_000)
    expect(a.take(2_000, names)).toEqual([
      { deviceId: 'd-rahul', speaker: 'Rahul Dhir', text: 'I will send it on Monday', startedAt: 1_000, endedAt: 2_000, language: 'hi-IN' },
    ])
  })

  it('ignores a version older than the one it has', () => {
    const a = new CaptionAssembler()
    a.update(cap({ version: 5, text: 'the whole sentence' }), 1_000)
    a.update(cap({ version: 4, text: 'the whole' }), 1_100)
    expect(a.flush(names)[0]!.text).toBe('the whole sentence')
  })

  it('settles a caption Meet never marks final, two seconds after it stops changing', () => {
    const a = new CaptionAssembler()
    a.update(cap({ text: 'ship it' }), 1_000)
    expect(a.take(2_900, names)).toEqual([])
    expect(a.take(3_000, names)).toHaveLength(1)
  })

  it('stores a line once, and counts Meet correcting it afterwards instead', () => {
    const a = new CaptionAssembler()
    a.update(cap({ text: 'ship it friday', isFinal: true }), 1_000)
    expect(a.take(1_000, names)).toHaveLength(1)
    a.update(cap({ version: 9, text: 'ship it Friday', isFinal: true }), 1_500)
    a.update(cap({ version: 9, text: 'ship it Friday', isFinal: true }), 1_600)
    expect(a.take(1_600, names)).toEqual([])
    expect(a.lateRevisions).toBe(1)
  })

  it('keeps what a speaker says after a pause, as a line of only the new words', () => {
    // The pause settles the caption; the same caption then grows.
    const a = new CaptionAssembler()
    a.update(cap({ version: 1, text: 'I will send the invoice' }), 1_000)
    expect(a.take(3_000, names).map((l) => l.text)).toEqual(['I will send the invoice'])
    a.update(cap({ version: 2, text: 'I will send the invoice on Monday' }), 4_000)
    a.update(cap({ version: 3, text: 'I will send the invoice on Monday, after the call', isFinal: true }), 4_500)
    expect(a.take(4_500, names)).toMatchObject([{ text: 'on Monday, after the call', startedAt: 4_000 }])
  })

  it('goes by word count when Meet also corrected the words it had kept', () => {
    const a = new CaptionAssembler()
    a.update(cap({ version: 1, text: 'kal tak ho jayega', isFinal: true }), 1_000)
    a.take(1_000, names)
    a.update(cap({ version: 2, text: 'Kal tak ho jaayega aur test bhi', isFinal: true }), 2_000)
    expect(a.take(2_000, names).map((l) => l.text)).toEqual(['aur test bhi'])
  })

  it('keeps two people talking at once apart, and in order', () => {
    const a = new CaptionAssembler()
    a.update(cap({ deviceId: 'd-you', captionId: '7', text: 'and me' }), 1_200)
    a.update(cap({ text: 'first', isFinal: true }), 1_000)
    const lines = a.flush(names)
    expect(lines.map((l) => [l.speaker, l.text])).toEqual([
      ['Rahul Dhir', 'first'],
      [null, 'and me'],
    ])
  })

  it('drops a caption that ended up empty', () => {
    const a = new CaptionAssembler()
    a.update(cap({ text: '   ', isFinal: true }), 1_000)
    expect(a.take(1_000, names)).toEqual([])
  })
})

describe('the room', () => {
  it('does not know who is here until Meet says', () => {
    expect(new Roster().others()).toBeNull()
  })

  it('counts other people: not the bot, not a screen share, not somebody who left', () => {
    const r = new Roster()
    r.update(
      [
        person({}),
        person({ deviceId: 'd-bot', fullName: 'Ayush Wouice Bot', isSelf: true }),
        person({ deviceId: 'd-share', fullName: 'Rahul (Presenting)', screenShareOf: 'd-rahul' }),
        person({ deviceId: 'd-gone', fullName: 'Priya', status: 6 }),
      ],
      true
    )
    expect(r.others()).toBe(1)
  })

  it('learns who left only from the full list, and remembers their name', () => {
    const r = new Roster()
    r.update([person({})], true)
    r.update([person({ deviceId: 'd-priya', fullName: 'Priya' })], false)
    expect(r.others()).toBe(2)
    r.update([person({ deviceId: 'd-priya', fullName: 'Priya' })], true)
    expect(r.others()).toBe(1)
    expect(r.nameOf('d-rahul')).toBe('Rahul Dhir')
  })

  it("names people as Meet's captions do: the full name, the shown one only when there is none", () => {
    const r = new Roster()
    r.update([person({ displayName: 'Rahul' }), person({ deviceId: 'd-x', fullName: '', displayName: 'Guest' })], true)
    expect(r.nameOf('d-rahul')).toBe('Rahul Dhir')
    expect(r.nameOf('d-x')).toBe('Guest')
  })
})

describe('lines for the store', () => {
  const line = {
    deviceId: 'd-ayush',
    speaker: 'Ayush Pratap Singh',
    text: 'I will send it on Monday',
    startedAt: 61_000,
    endedAt: 64_000,
    language: 'en-US',
  }

  it('is yours when Meet names you, timed from the start of the meeting', () => {
    expect(captionSegment(line, 1_000, 'Ayush Pratap Singh')).toEqual({
      channel: 'me',
      startMs: 60_000,
      endMs: 63_000,
      text: 'I will send it on Monday',
      echo: false,
      speaker: 'Ayush Pratap Singh',
    })
  })

  it('is theirs otherwise, with their name, or none when Meet never gave one', () => {
    expect(captionSegment({ ...line, speaker: 'Rahul Dhir' }, 1_000, 'Ayush Pratap Singh')).toMatchObject({
      channel: 'them',
      speaker: 'Rahul Dhir',
    })
    expect(captionSegment({ ...line, speaker: null }, 1_000, 'Ayush Pratap Singh')).toMatchObject({
      channel: 'them',
      speaker: null,
    })
  })
})

describe('the feed from the page', () => {
  it('turns forwarded bytes into named lines', () => {
    const feed = new MeetFeed()
    feed.receive(pageMessage.people([userEntry('d-rahul', 'Rahul Dhir')]), 900)
    feed.receive(
      pageMessage.caption({ deviceId: 'd-rahul', captionId: 11, version: 1, text: 'कल तक हो जाएगा', isFinal: true }),
      1_000
    )

    expect(feed.captions.take(1_000, (d) => feed.roster.nameOf(d))).toMatchObject([
      { speaker: 'Rahul Dhir', text: 'कल तक हो जाएगा' },
    ])
    expect(feed.roster.others()).toBe(1)
    expect(feed.captionMessages).toBe(1)
  })

  it('reads the participant channel whether Meet compresses it as zlib or gzip', () => {
    const feed = new MeetFeed()
    const gzipped = base64(gzipSync(u8(collectionEvent([userEntry('d-rahul', 'Rahul Dhir')]))))
    feed.receive(JSON.stringify({ type: 'dc', label: 'collections', b64: gzipped }), 900)
    expect(feed.roster.others()).toBe(1)
    expect(feed.unreadable).toBe(0)
  })

  it('counts each channel, and keeps its first messages raw, with why they could not be read', () => {
    const feed = new MeetFeed()
    for (let i = 0; i < 30; i++) {
      feed.receive(JSON.stringify({ type: 'dc', label: 'captions_v2', b64: base64([0xff]) }), i)
    }
    feed.receive(JSON.stringify({ type: 'dc', label: 'collections', b64: base64([1, 2, 3]) }), 40)
    expect(feed.stats.get('captions_v2')).toEqual({ messages: 30, unreadable: 30 })
    expect(feed.samples.filter((s) => s.label === 'captions_v2')).toHaveLength(25)
    expect(feed.samples[0]).toEqual({ label: 'captions_v2', at: 0, b64: '/w==', problem: 'not a caption' })
    expect(feed.samples.at(-1)).toMatchObject({ label: 'collections', problem: 'could not be inflated' })
    expect(feed.summary()).toMatch(/captions_v2 30 \(30 unreadable\), collections 1 \(1 unreadable\)/)
  })

  it('takes a sync that says nothing about people as the normal case it is', () => {
    const feed = new MeetFeed()
    const versionsOnly = base64(bytes(1, bytes(1, bytes(1, int(1, 42)))))
    feed.receive(JSON.stringify({ type: 'sync', text: versionsOnly }), 1_000)
    expect(feed.unreadable).toBe(0)
    expect(feed.roster.others()).toBeNull()
  })

  it('keeps heartbeats and channel names, and counts what it cannot read', () => {
    const feed = new MeetFeed()
    feed.receive(JSON.stringify({ type: 'heartbeat' }), 5_000)
    feed.receive(JSON.stringify({ type: 'channel', label: 'captions_v2' }), 5_000)
    feed.receive('not json', 5_000)
    feed.receive(JSON.stringify({ type: 'dc', label: 'captions_v2', b64: base64([0xff]) }), 5_000)
    expect(feed.lastHeartbeat).toBe(5_000)
    expect([...feed.channels]).toEqual(['captions_v2'])
    expect(feed.unreadable).toBe(2)
  })
})
