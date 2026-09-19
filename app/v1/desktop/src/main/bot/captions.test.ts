import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  CaptionAssembler,
  MeetFeed,
  Roster,
  TurnBuilder,
  captionSegment,
  replayCaptions,
  unsavedTail,
  type CaptionLine,
} from './captions.js'
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
      {
        deviceId: 'd-rahul',
        speaker: 'Rahul Dhir',
        text: 'I will send it on Monday',
        startedAt: 1_000,
        endedAt: 2_000,
        language: 'hi-IN',
        keys: ['d-rahul:1'],
      },
    ])
  })

  it('ignores a version older than the one it has', () => {
    const a = new CaptionAssembler()
    a.update(cap({ version: 5, text: 'the whole sentence' }), 1_000)
    a.update(cap({ version: 4, text: 'the whole' }), 1_100)
    expect(a.flush(names)[0]!.text).toBe('the whole sentence')
  })

  it('keeps a caption Meet never marks final once it has been quiet for ten seconds', () => {
    const a = new CaptionAssembler()
    a.update(cap({ text: 'ship it' }), 1_000)
    expect(a.take(10_900, names)).toEqual([])
    expect(a.take(11_000, names)).toHaveLength(1)
    expect(a.keptQuiet).toBe(1)
  })

  it("waits for Meet's final version rather than keeping its first guess", () => {
    // The real case: kept after two quiet seconds, this was stored as "एक सेकंड".
    const a = new CaptionAssembler()
    a.update(cap({ version: 1, text: 'एक सेकंड' }), 1_000)
    expect(a.take(4_000, names)).toEqual([])
    a.update(cap({ version: 5, text: 'चलो देखते हैं क्या होता है', isFinal: true }), 5_000)
    expect(a.take(5_000, names)).toMatchObject([{ text: 'चलो देखते हैं क्या होता है', startedAt: 1_000 }])
    expect(a.keptFinal).toBe(1)
  })

  it('stores a line once, and hands on a correction Meet makes to it afterwards', () => {
    const a = new CaptionAssembler()
    a.update(cap({ text: 'ship it friday', isFinal: true }), 1_000)
    expect(a.take(1_000, names)).toHaveLength(1)
    a.update(cap({ version: 9, text: 'ship it Friday', isFinal: true }), 1_500)
    a.update(cap({ version: 9, text: 'ship it Friday', isFinal: true }), 1_600)
    expect(a.take(1_600, names)).toEqual([])
    expect(a.lateRevisions).toBe(1)
    expect(a.takeRevisions()).toEqual([{ key: 'd-rahul:1', from: 'ship it friday', to: 'ship it Friday' }])
    expect(a.takeRevisions()).toEqual([])
  })

  it('keeps new words Meet sends under a caption id it already used as a caption of their own', () => {
    // Replayed, meeting 18 had this line overwritten by the next thing said.
    const a = new CaptionAssembler()
    a.update(cap({ text: 'तो मतलब 12000 प्लस 6000 प्लस', isFinal: true }), 1_000)
    expect(a.take(1_000, names)).toHaveLength(1)
    a.update(cap({ version: 7, text: 'मतलब देखो अगर आप उसको बहुत', isFinal: true }), 9_000)
    expect(a.takeRevisions()).toEqual([])
    expect(a.take(9_000, names).map((l) => [l.text, l.startedAt])).toEqual([['मतलब देखो अगर आप उसको बहुत', 9_000]])
    expect(a.newUnderOldId).toBe(1)
    // And the new caption's own later versions correct it, not the first one.
    a.update(cap({ version: 8, text: 'मतलब देखो अगर आप उसको बहुत बताओगे', isFinal: true }), 9_500)
    expect(a.takeRevisions()).toEqual([
      { key: 'd-rahul:1#7', from: 'मतलब देखो अगर आप उसको बहुत', to: 'मतलब देखो अगर आप उसको बहुत बताओगे' },
    ])
  })

  it('keeps words Meet replaced with something new before they were kept, as a line of their own', () => {
    // Meeting 20: on screen for seven seconds, then the caption was reused for "बाकी".
    const a = new CaptionAssembler()
    a.update(cap({ text: 'बस इस चीज के अलावा इसमें कुछ भी' }), 1_000)
    a.update(cap({ version: 2, text: 'बाकी' }), 8_000)
    expect(a.take(20_000, names).map((l) => [l.text, l.startedAt, l.endedAt, l.dropped])).toEqual([
      ['बस इस चीज के अलावा इसमें कुछ भी', 1_000, 8_000, true],
      ['बाकी', 8_000, 8_000, undefined],
    ])
    expect(a.droppedKept).toBe(1)
  })

  it('keeps words Meet wiped with an empty version', () => {
    const a = new CaptionAssembler()
    a.update(cap({ text: 'कमी नहीं लगी मुझे' }), 1_000)
    a.update(cap({ version: 2, text: '' }), 5_000)
    expect(a.take(20_000, names).map((l) => [l.text, l.dropped])).toEqual([['कमी नहीं लगी मुझे', true]])
  })

  it('does not keep twice words Meet only moved to the caption before', () => {
    const a = new CaptionAssembler()
    a.update(cap({ captionId: '2', text: 'यही वाली चीज आनी चाहिए' }), 1_000)
    a.update(cap({ captionId: '1', version: 3, text: 'बनाना तो यही वाली चीज' }), 2_500)
    a.update(cap({ captionId: '2', version: 2, text: 'आनी चाहिए' }), 2_600)
    expect(a.take(20_000, names).map((l) => l.text)).toEqual(['बनाना तो यही वाली चीज', 'आनी चाहिए'])
    expect(a.droppedMoved).toBe(1)
    expect(a.droppedKept).toBe(0)
  })

  it("does not keep Meet's first guess when it hears the same thing again, nor a flicker", () => {
    const a = new CaptionAssembler()
    // Corrected to as many words or more: the same speech, heard again.
    a.update(cap({ text: 'एक सेकंड' }), 1_000)
    a.update(cap({ version: 2, text: 'चलो देखते हैं क्या होता है' }), 5_000)
    // On screen for half a second.
    a.update(cap({ captionId: '2', text: 'तो पहले वाला' }), 6_000)
    a.update(cap({ captionId: '2', version: 2, text: 'तीसरा' }), 6_500)
    expect(a.take(30_000, names).map((l) => l.text)).toEqual(['चलो देखते हैं क्या होता है', 'तीसरा'])
    expect(a.droppedKept).toBe(0)
  })

  it('stores words Meet dropped as a line of their own, never inside a turn', () => {
    const feed = new MeetFeed()
    feed.captions.update(cap({ text: 'बस इस चीज के अलावा इसमें कुछ भी' }), 1_000)
    feed.captions.update(cap({ version: 2, text: 'बाकी', isFinal: true }), 8_000)
    feed.captions.update(cap({ captionId: '2', text: 'तो ठीक है', isFinal: true }), 9_000)
    const lines = [...feed.take(20_000), ...feed.flush()]
    expect(lines.map((l) => [l.text, l.dropped ?? false])).toEqual([
      ['बस इस चीज के अलावा इसमें कुछ भी', true],
      ['बाकी तो ठीक है', false],
    ])
  })

  it('replays a caption log into the lines it would have stored, and finds those not stored yet', () => {
    const log = [
      { ...cap({ text: 'ship it' }), at: 1_000 },
      { ...cap({ version: 2, text: 'ship it friday', isFinal: true }), at: 1_500 },
      { ...cap({ captionId: '2', text: 'and the registry too', isFinal: true }), at: 30_000 },
    ]
    const lines = replayCaptions(log)
    expect(lines.map((l) => [l.text, l.startedAt])).toEqual([
      ['ship it friday', 1_000],
      ['and the registry too', 30_000],
    ])
    // Wouice closed after storing the first: the rest, named from what was stored.
    expect(unsavedTail(lines, [{ startMs: 0, speaker: 'Rahul Dhir' }], 1_000)).toMatchObject([
      { text: 'and the registry too', speaker: 'Rahul Dhir' },
    ])
  })

  it('makes a correction in the open turn, or hands it back once the line is stored', () => {
    // Meeting 18: Meet's first guess "प्लस", then new words under the same id, then those corrected.
    const feed = new MeetFeed()
    feed.captions.update(cap({ text: 'प्लस', isFinal: true }), 1_000)
    expect(feed.take(1_000)).toEqual([])
    feed.captions.update(cap({ version: 2, text: 'ऑप्टिमाइज वाली लाइन हटा दो', isFinal: true }), 2_000)
    expect(feed.revisions()).toEqual([])
    expect(feed.take(20_000).map((l) => l.text)).toEqual(['प्लस ऑप्टिमाइज वाली लाइन हटा दो'])
    feed.captions.update(cap({ version: 3, text: 'ऑप्टिमाइज वाली लाइन हटा दो भाई', isFinal: true }), 21_000)
    expect(feed.revisions()).toEqual([
      { startedAt: 1_000, speaker: null, from: 'ऑप्टिमाइज वाली लाइन हटा दो', to: 'ऑप्टिमाइज वाली लाइन हटा दो भाई' },
    ])
  })

  it('corrects the words of the open turn itself when Meet revises them', () => {
    const feed = new MeetFeed()
    feed.captions.update(cap({ text: 'ship it friday', isFinal: true }), 1_000)
    feed.take(1_000)
    feed.captions.update(cap({ version: 2, text: 'ship it Friday', isFinal: true }), 1_500)
    expect(feed.revisions()).toEqual([])
    expect(feed.take(20_000).map((l) => l.text)).toEqual(['ship it Friday'])
  })

  it('knows which speakers still have a caption in progress, and since when', () => {
    const a = new CaptionAssembler()
    a.update(cap({ captionId: '1', text: 'कल तक' }), 1_000)
    a.update(cap({ captionId: '2', text: 'हो' }), 1_400)
    expect(a.openSince('d-rahul')).toBe(1_000)
    expect(a.openSince('d-you')).toBeNull()
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

describe('joining captions into turns', () => {
  const piece = (deviceId: string, text: string, startedAt: number, endedAt: number): CaptionLine => ({
    deviceId,
    speaker: deviceId === 'd-rahul' ? 'Rahul Dhir' : null,
    text,
    startedAt,
    endedAt,
    language: 'hi-IN',
  })

  it("joins one speaker's captions that follow each other, as Meet's panel does", () => {
    const t = new TurnBuilder()
    expect(t.add([piece('d-rahul', 'भाई होगा तो वही तरीका', 0, 900), piece('d-rahul', 'जो मैंने', 1_200, 1_800)])).toEqual([])
    expect(t.flush()).toEqual([piece('d-rahul', 'भाई होगा तो वही तरीका जो मैंने', 0, 1_800)])
  })

  it('starts a new turn when someone else speaks, or after a long pause', () => {
    const t = new TurnBuilder()
    const done = t.add([piece('d-rahul', 'आएगा', 0, 500), piece('d-you', 'बताओ', 600, 900), piece('d-you', 'ठीक है', 16_000, 16_300)])
    expect(done.map((l) => l.text)).toEqual(['आएगा', 'बताओ'])
    expect(t.flush().map((l) => l.text)).toEqual(['ठीक है'])
  })

  it('closes a long turn at sixty words, so a monologue is still pieces a task can cite', () => {
    const t = new TurnBuilder()
    const ten = (at: number): CaptionLine => piece('d-rahul', 'एक दो तीन चार पांच छह सात आठ नौ दस', at, at + 500)
    const done = t.add([0, 600, 1_200, 1_800, 2_400, 3_000, 3_600].map(ten))
    expect(done).toHaveLength(1)
    expect(done[0]!.text.split(' ')).toHaveLength(60)
    expect(t.flush()[0]!.text.split(' ')).toHaveLength(10)
  })

  it('holds the turn open while its speaker has a caption in progress that began inside the gap', () => {
    const t = new TurnBuilder()
    t.add([piece('d-rahul', 'कल तक', 0, 800)])
    // The gap has not passed.
    expect(t.due(5_000, () => null)).toEqual([])
    // It has, but their next caption began inside it.
    expect(t.due(13_000, () => 1_000)).toEqual([])
    expect(t.due(13_000, () => null).map((l) => l.text)).toEqual(['कल तक'])
  })

  it('puts the pieces in the order they were said, whatever order Meet finished them in', () => {
    const t = new TurnBuilder()
    t.add([piece('d-rahul', 'हो जाएगा', 900, 1_400), piece('d-rahul', 'कल तक', 0, 800)])
    expect(t.flush()[0]!.text).toBe('कल तक हो जाएगा')
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

  it('stores turns, not the pieces Meet cut them into, and logs every update', () => {
    const feed = new MeetFeed()
    feed.receive(pageMessage.caption({ deviceId: 'd-rahul', captionId: 1, version: 1, text: 'कल तक', isFinal: true }), 1_000)
    feed.receive(pageMessage.caption({ deviceId: 'd-rahul', captionId: 2, version: 1, text: 'हो जाएगा', isFinal: true }), 1_300)
    expect(feed.take(1_300)).toEqual([])
    expect(feed.take(14_000).map((l) => l.text)).toEqual(['कल तक हो जाएगा'])
    expect(feed.drainLog().map((u) => [u.captionId, u.at])).toEqual([
      ['1', 1_000],
      ['2', 1_300],
    ])
    expect(feed.drainLog()).toEqual([])
  })

  it('remembers who each device was, including people who have left', () => {
    const feed = new MeetFeed()
    feed.receive(pageMessage.people([userEntry('d-rahul', 'Rahul Dhir'), userEntry('d-priya', 'Priya', [], 6)]), 1_000)
    expect(feed.roster.people().map((p) => [p.deviceId, p.name, p.status])).toEqual([
      ['d-rahul', 'Rahul Dhir', 1],
      ['d-priya', 'Priya', 6],
    ])
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
