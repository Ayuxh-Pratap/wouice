import { inflateRawSync, unzipSync } from 'node:zlib'
import { isMine } from '../meeting/notes.js'
import type { PageMessage } from './meet-payload.js'
import {
  decodeCaptionV1,
  decodeCaptionV2,
  decodeCollection,
  decodeSyncResponse,
  type CaptionUpdate,
  type MeetUser,
} from './meet-protocol.js'

/**
 * From what Meet's page forwards, to lines with names on them.
 *
 * CAPTIONS ARE REVISED, NOT APPENDED. Meet sends the same caption again and
 * again as the speaker goes on - "I will", "I will send", "I will send it on
 * Monday" - each a higher version under one id, correcting earlier words as it
 * goes, until it marks the caption final. A caption is kept at that final
 * version. Keeping it earlier, two seconds after it stopped changing, kept
 * Meet's first guesses: in the first full call 172 revisions arrived after the
 * line was kept, and "चलो देखते हैं क्या होता है" was stored as "एक सेकंड". A
 * caption Meet never finalises is kept after ten quiet seconds.
 *
 * THEN JOINED INTO TURNS. Meet also cuts a new caption every few seconds while
 * one person keeps talking, and its own caption panel joins them back into one
 * block per speaker. Stored as they came, a third of the lines were one to
 * three words ("की", "हूं") and the English was translated three words at a
 * time. See `TurnBuilder`.
 *
 * NAMES FROM MEET'S OWN LIST. A caption carries a device id, not a person; the
 * participant list maps one to the other. It is kept for the whole call, so a
 * line said by someone who has since left still has their name.
 */

/** One finished caption, or a turn of them: a line of the transcript. */
export interface CaptionLine {
  deviceId: string
  /** The speaker's name as Meet shows it, or null if the list never named them. */
  speaker: string | null
  text: string
  /** When the caption first appeared, and when it last changed. */
  startedAt: number
  endedAt: number
  language: string | null
  /** The Meet captions it was made from, as `device:caption`: how a correction Meet sends later finds it. */
  keys?: string[]
  /**
   * Words Meet showed and then replaced with something new under the same
   * caption: in none of its later captions, nor in its own panel. A line of
   * their own, marked, rather than lost. See `CaptionAssembler`.
   */
  dropped?: boolean
}

/** Meet rewrote a caption after its line was stored: `from` becomes `to` in the line that began at `startedAt`. */
export interface CaptionRevision {
  startedAt: number
  speaker: string | null
  from: string
  to: string
}

/**
 * A line as the store keeps it, timed from the start of the meeting.
 *
 * Yours when the name Meet gives the speaker is yours - the same rule that
 * decides whether a task is yours - so "You" in the transcript and "Yours" on
 * the tasks agree. Everyone else keeps their own name.
 */
export function captionSegment(line: CaptionLine, meetingStartedAt: number, myName: string) {
  return {
    channel: line.speaker && isMine(line.speaker, myName) ? ('me' as const) : ('them' as const),
    startMs: Math.max(0, line.startedAt - meetingStartedAt),
    endMs: Math.max(0, line.endedAt - meetingStartedAt),
    text: line.text,
    echo: false,
    speaker: line.speaker,
    ...(line.dropped ? { dropped: true } : {}),
  }
}

/** Who a device was, for the run folder. */
export interface Person {
  deviceId: string
  name: string | null
  status: number
  isSelf: boolean
  screenShareOf: string | null
}

export class Roster {
  private readonly present = new Map<string, MeetUser>()
  /** Everyone ever listed, including those who have left. */
  private readonly seen = new Map<string, MeetUser>()
  private readonly names = new Map<string, string>()
  private listed = false

  /**
   * @param complete true for Meet's full list, which is the only thing that
   *   says who has left; single-person changes arrive one at a time.
   */
  update(users: readonly MeetUser[], complete: boolean): void {
    if (complete) this.present.clear()
    for (const user of users) {
      this.present.set(user.deviceId, user)
      this.seen.set(user.deviceId, user)
      // The full name, as Meet's own captions label people: "Ayush Pratap
      // Singh", where the shown name is "Ayush Pratap". It is also the one
      // that tells two Rahuls apart across meetings.
      const name = user.fullName || user.displayName
      if (name) this.names.set(user.deviceId, name)
    }
    if (complete || users.length > 0) this.listed = true
  }

  nameOf(deviceId: string): string | null {
    return this.names.get(deviceId) ?? null
  }

  /**
   * Other people in the call now - not the bot, not a screen share. Null until
   * Meet has said anything about who is here, which is not the same as nobody.
   */
  others(): number | null {
    if (!this.listed) return null
    let count = 0
    for (const user of this.present.values()) {
      if (user.status === 1 && !user.isSelf && !user.screenShareOf) count++
    }
    return count
  }

  /** Everyone Meet listed during the call, as last seen. */
  people(): Person[] {
    return [...this.seen.values()].map((u) => ({
      deviceId: u.deviceId,
      name: this.nameOf(u.deviceId),
      status: u.status,
      isSelf: u.isSelf,
      screenShareOf: u.screenShareOf,
    }))
  }
}

interface Pending {
  deviceId: string
  version: number
  text: string
  firstAt: number
  lastAt: number
  isFinal: boolean
  language: string | null
  /** Words Meet replaced with something new under the same caption, held to be kept. See `replaced`. */
  dropped?: boolean
}

/** A caption already kept: its words and version, and whose and when - for telling words Meet moved from words it dropped. */
interface Kept {
  text: string
  version: number
  deviceId: string
  at: number
  dropped: boolean
}

export class CaptionAssembler {
  private readonly pending = new Map<string, Pending>()
  /** Captions already kept, by `device:caption`: the text kept, and at which version. */
  private readonly done = new Map<string, Kept>()
  /** Corrections to captions already kept, not yet handed on. See `MeetFeed.revisions`. */
  private revised: { key: string; from: string; to: string }[] = []
  /** A caption id Meet reused for new words: its later versions belong to the new caption. */
  private readonly reused = new Map<string, string>()
  /** Captions whose words Meet changed after they were kept. */
  lateRevisions = 0
  /** Of those, the ones that were new words under an old id, kept as captions of their own. */
  newUnderOldId = 0
  /** How captions were kept: at Meet's final version, or without one. */
  keptFinal = 0
  keptQuiet = 0
  /**
   * Words Meet showed and then replaced with something new before they were
   * kept: those kept as lines of their own, and those that turned up in a
   * neighbouring caption - moved, not lost - and so were not kept twice.
   */
  droppedKept = 0
  droppedMoved = 0
  /** Versions older than one already held or kept, with other words in them: ignored. */
  staleIgnored = 0

  constructor(private readonly quietMs = 10_000) {}

  update(caption: CaptionUpdate, now: number): void {
    const id = `${caption.deviceId}:${caption.captionId}`
    let key = this.reused.get(id) ?? id
    const kept = this.done.get(key)
    if (kept) {
      if (caption.version <= kept.version) {
        if (caption.text.trim() !== kept.text) this.staleIgnored++
        return
      }
      kept.version = caption.version
      const text = caption.text.trim()
      if (text === kept.text) return
      this.lateRevisions++
      if (kept.text && sameCaption(kept.text, text)) {
        this.revised.push({ key, from: kept.text, to: text })
        kept.text = text
        return
      }
      // Different words under an id Meet already used: a caption of its own,
      // not a correction. Replayed, meeting 18 had "तो मतलब 12000 प्लस 6000
      // प्लस" overwritten by the next thing said, "मतलब देखो अगर आप उसको बहुत".
      this.newUnderOldId++
      key = `${id}#${caption.version}`
      this.reused.set(id, key)
    }
    const current = this.pending.get(key)
    if (current && caption.version < current.version) {
      if (caption.text !== current.text) this.staleIgnored++
      return
    }
    // Something new under a caption that still showed these words: said under
    // a reused id, and the old words in none of Meet's later captions. Meeting
    // 20 lost "बस इस चीज के अलावा इसमें कुछ भी" to "बाकी" this way, and 131
    // words more. Held, so they can turn up in a neighbour - moved, not lost -
    // and then kept as a line of their own. See `replaced`.
    const fresh = current !== undefined && replaced(current, caption.text, now)
    if (fresh) this.pending.set(`${key}~${current.version}`, { ...current, dropped: true, isFinal: false, lastAt: now })
    const before = fresh ? undefined : current
    this.pending.set(key, {
      deviceId: caption.deviceId,
      version: caption.version,
      text: caption.text,
      firstAt: before?.firstAt ?? now,
      lastAt: before && before.text === caption.text ? before.lastAt : now,
      isFinal: caption.isFinal,
      language: caption.language ?? before?.language ?? null,
    })
  }

  /** Captions that are finished: final, or quiet for too long to be anything else. Oldest first. */
  take(now: number, nameOf: (deviceId: string) => string | null): CaptionLine[] {
    return this.release((p) => p.isFinal || now - p.lastAt >= this.quietMs, nameOf)
  }

  /** Everything still open, at the end of the call. */
  flush(nameOf: (deviceId: string) => string | null): CaptionLine[] {
    return this.release(() => true, nameOf)
  }

  /** Corrections Meet made to kept captions since the last call. */
  takeRevisions(): { key: string; from: string; to: string }[] {
    const out = this.revised
    this.revised = []
    return out
  }

  /** When this speaker's oldest caption still in progress began; null when none is. */
  openSince(deviceId: string): number | null {
    let since: number | null = null
    for (const p of this.pending.values()) {
      if (!p.dropped && p.deviceId === deviceId && (since === null || p.firstAt < since)) since = p.firstAt
    }
    return since
  }

  private release(ready: (p: Pending) => boolean, nameOf: (deviceId: string) => string | null): CaptionLine[] {
    const lines: CaptionLine[] = []
    for (const [key, p] of this.pending) {
      if (!ready(p)) continue
      this.pending.delete(key)
      const text = p.text.trim()
      this.done.set(key, { text, version: p.version, deviceId: p.deviceId, at: p.firstAt, dropped: p.dropped === true })
      if (p.dropped) {
        if (this.movedOn(p)) {
          this.droppedMoved++
          continue
        }
        this.droppedKept++
      } else if (p.isFinal) this.keptFinal++
      else this.keptQuiet++
      if (!text) continue
      lines.push({
        deviceId: p.deviceId,
        speaker: nameOf(p.deviceId),
        text,
        startedAt: p.firstAt,
        endedAt: p.lastAt,
        language: p.language,
        keys: [key],
        ...(p.dropped ? { dropped: true } : {}),
      })
    }
    return lines.sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * Did words Meet replaced turn up in the same speaker's captions around
   * them? Meet also moves words between captions as it re-cuts a sentence -
   * "यही वाली चीज आनी चाहिए" became "आनी चाहिए", its first words now in the
   * caption before - and those are not lost, so not kept twice.
   */
  private movedOn(p: Pending): boolean {
    const around = (at: number): boolean => at >= p.firstAt - NEAR_MS && at <= p.lastAt + NEAR_MS
    const near: string[] = []
    for (const q of this.pending.values()) {
      if (!q.dropped && q.deviceId === p.deviceId && around(q.firstAt)) near.push(q.text)
    }
    for (const k of this.done.values()) {
      if (!k.dropped && k.deviceId === p.deviceId && around(k.at)) near.push(k.text)
    }
    return sameCaption(p.text, near.join(' '))
  }
}

/**
 * Is the new text a correction of the kept one, or new words? A correction
 * keeps at least half of the words it corrects: "ship it friday" and "ship it
 * Friday", or a long line with a word changed. New words under an old id share
 * a word or two by chance.
 */
function sameCaption(kept: string, next: string): boolean {
  const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean)
  const left = new Map<string, number>()
  for (const w of words(next)) left.set(w, (left.get(w) ?? 0) + 1)
  const before = words(kept)
  let still = 0
  for (const w of before) {
    const n = left.get(w) ?? 0
    if (n > 0) {
      still++
      left.set(w, n - 1)
    }
  }
  return still * 2 >= before.length
}

/** Words on screen this long unchanged have been read by the people in the call. */
const HELD_MS = 1_000
/** How far around words Meet replaced they are looked for, moved. */
const NEAR_MS = 15_000

/**
 * Words replaced before they were kept: something new said under the same
 * caption id, not Meet correcting what it heard. Only words held on screen for
 * a second, two of them at least; not replaced by a correction, which keeps
 * half their words; and not by as many words or more - the same speech heard
 * again comes back as long ("एक सेकंड" corrected to "चलो देखते हैं क्या होता
 * है"), where a new thing said starts short: "बाकी", "यह", "तो", or nothing.
 */
function replaced(held: Pending, next: string, now: number): boolean {
  const count = (s: string): number => s.split(/\s+/).filter(Boolean).length
  const words = count(held.text)
  if (words < 2 || now - held.lastAt < HELD_MS) return false
  if (next.trim() && sameCaption(held.text, next)) return false
  return count(next) * 2 <= words
}

/**
 * One speaker's captions this close together are one turn. Meet's panel keeps
 * a speaker's block going through pauses; on the first full call, twelve
 * seconds gave turns of the same median length as the panel's, nine words.
 */
const JOIN_GAP_MS = 12_000
/** A turn closes at this many words: a monologue still splits into pieces a task can cite. */
const TURN_WORDS = 60

/**
 * One speaker's consecutive captions, joined into a turn.
 *
 * As Meet's own caption panel shows them: a turn goes on while the same person
 * speaks, and ends when someone else does or they stop for a while. In the
 * first full call the median gap between one person's consecutive captions was
 * 0.3 s - pieces of one sentence, not sentences. Joined this way its 223 lines
 * became 69 turns, against the 52 Meet's panel showed; the difference is mostly
 * two people talking over each other.
 */
export class TurnBuilder {
  private open: CaptionLine[] = []

  constructor(
    private readonly joinGapMs = JOIN_GAP_MS,
    private readonly maxWords = TURN_WORDS
  ) {}

  /** Kept captions in, oldest first; finished turns out. */
  add(lines: readonly CaptionLine[]): CaptionLine[] {
    const done: CaptionLine[] = []
    for (const line of lines) {
      if (this.open.length > 0 && !this.joins(line)) done.push(this.close())
      this.open.push(line)
      if (countWords(this.open) >= this.maxWords) done.push(this.close())
    }
    return done
  }

  /**
   * The open turn, once nothing more can join it: the gap has passed since its
   * last words, and its speaker has no caption in progress that began inside
   * that gap.
   */
  due(now: number, openSince: (deviceId: string) => number | null): CaptionLine[] {
    if (this.open.length === 0) return []
    const end = lastEnd(this.open)
    if (now - end < this.joinGapMs) return []
    const next = openSince(this.open[0]!.deviceId)
    if (next !== null && next - end < this.joinGapMs) return []
    return [this.close()]
  }

  /** The open turn, at the end of the call. */
  flush(): CaptionLine[] {
    return this.open.length > 0 ? [this.close()] : []
  }

  /** A correction to a caption still in the open turn: made here, before the turn is stored. */
  revise(key: string, to: string): boolean {
    const piece = this.open.find((p) => p.keys?.includes(key))
    if (!piece) return false
    piece.text = to
    return true
  }

  private joins(line: CaptionLine): boolean {
    return line.deviceId === this.open[0]!.deviceId && line.startedAt - lastEnd(this.open) < this.joinGapMs
  }

  private close(): CaptionLine {
    // In the order they were said, which is not always the order Meet finalised them.
    const pieces = this.open.sort((a, b) => a.startedAt - b.startedAt)
    this.open = []
    const keys = pieces.flatMap((p) => p.keys ?? [])
    return {
      deviceId: pieces[0]!.deviceId,
      speaker: pieces.find((p) => p.speaker)?.speaker ?? null,
      text: pieces
        .map((p) => p.text)
        .filter(Boolean)
        .join(' '),
      startedAt: pieces[0]!.startedAt,
      endedAt: lastEnd(pieces),
      language: pieces.find((p) => p.language)?.language ?? null,
      ...(keys.length > 0 ? { keys } : {}),
    }
  }
}

function lastEnd(lines: readonly CaptionLine[]): number {
  return Math.max(...lines.map((l) => l.endedAt))
}

function countWords(lines: readonly CaptionLine[]): number {
  return lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0)
}

/** What arrived under one label, and how much of it could be read. */
export interface ChannelStats {
  messages: number
  unreadable: number
}

/** One message as the page sent it, kept for reading by hand when nothing decodes. */
export interface MessageSample {
  label: string
  at: number
  b64?: string
  text?: string
  /** Why it could not be read. Absent when it could. */
  problem?: string
}

/** One caption update as it arrived, for replaying a call through new rules. */
export type LoggedCaption = CaptionUpdate & { at: number }

/** Raw messages kept per label: enough to see Meet's format, not a copy of the call. */
const SAMPLES_PER_LABEL = 25

/**
 * Everything the page forwards, taken in: captions, participants, heartbeats,
 * and the names of the channels Meet opened.
 *
 * COUNTED, AND SAMPLED RAW. When Meet changes a format, every message fails
 * the same way and the call keeps nothing. The counts say which channel it
 * was; the first messages of each, kept as they arrived, are what the decoder
 * is then fixed against. The first live call failed like this with no bytes to
 * look at, which is why they are kept now.
 *
 * EVERY CAPTION UPDATE, LOGGED. Decoded, as they came: a call can be replayed
 * through changed rules and scored again, instead of waiting for another call.
 */
export class MeetFeed {
  readonly roster = new Roster()
  readonly captions = new CaptionAssembler()
  readonly turns = new TurnBuilder()
  /** Every data channel label seen: the first sign Meet has renamed one. */
  readonly channels = new Set<string>()
  /** Per channel label (and `sync`, `page`, `page-error`). */
  readonly stats = new Map<string, ChannelStats>()
  readonly samples: MessageSample[] = []
  lastHeartbeat: number | null = null
  captionMessages = 0
  /** Messages that could not be read at all. */
  unreadable = 0
  /**
   * The language the latest caption came in, and when: what Meet is actually
   * captioning in, whatever its menus said.
   */
  lastLanguage: string | null = null
  lastLanguageAt: number | null = null
  private logged: LoggedCaption[] = []

  receive(raw: string, now: number): void {
    let message: PageMessage
    try {
      message = JSON.parse(raw) as PageMessage
    } catch {
      this.read('page', now, { text: raw.slice(0, 500) }, () => {
        throw new Error('not JSON')
      })
      return
    }
    switch (message.type) {
      case 'heartbeat':
        this.lastHeartbeat = now
        return
      case 'channel':
        this.channels.add(message.label)
        return
      case 'sync':
        this.read('sync', now, { text: message.text }, () => {
          // Most syncs say only what changed, which is usually nothing about
          // people: in the first real calls, 37 of 43 had no list in them.
          // When there is a list, it is the whole room.
          const users = decodeSyncResponse(message.text)
          if (users.length > 0) this.roster.update(users, true)
        })
        return
      case 'dc':
        this.channel(message, now)
        return
      case 'error':
        this.read('page-error', now, { text: message.message }, () => undefined)
        return
      default:
        return
    }
  }

  /** Turns that are finished: what gets stored. */
  take(now: number): CaptionLine[] {
    const kept = this.captions.take(now, (d) => this.roster.nameOf(d))
    return this.stored([...this.joined(kept), ...this.turns.due(now, (d) => this.captions.openSince(d))])
  }

  /** Everything, at the end of the call. */
  flush(): CaptionLine[] {
    return this.stored([...this.joined(this.captions.flush((d) => this.roster.nameOf(d))), ...this.turns.flush()])
  }

  /** Kept captions into turns - but words Meet dropped stay a line of their own, shown for what they are. */
  private joined(kept: CaptionLine[]): CaptionLine[] {
    return [...this.turns.add(kept.filter((l) => !l.dropped)), ...kept.filter((l) => l.dropped)]
  }

  /**
   * Corrections Meet made to captions after they were kept. One whose turn is
   * still open is made there; one whose line is already stored comes back
   * here, for the store to make. Counted and dropped, meeting 18 kept Meet's
   * first guess "प्लस" for a line Meet then wrote as "ऑप्टिमाइज वाली लाइन हटा दो".
   */
  revisions(): CaptionRevision[] {
    const out: CaptionRevision[] = []
    for (const r of this.captions.takeRevisions()) {
      if (this.turns.revise(r.key, r.to)) continue
      const line = this.storedIn.get(r.key)
      if (line) out.push({ ...line, from: r.from, to: r.to })
    }
    return out
  }

  /** Which stored line each kept caption went into, so a later correction can find it. */
  private readonly storedIn = new Map<string, { startedAt: number; speaker: string | null }>()

  private stored(lines: CaptionLine[]): CaptionLine[] {
    for (const line of lines) {
      for (const key of line.keys ?? []) this.storedIn.set(key, { startedAt: line.startedAt, speaker: line.speaker })
    }
    return lines
  }

  /** The caption updates that arrived since the last call. */
  drainLog(): LoggedCaption[] {
    const logged = this.logged
    this.logged = []
    return logged
  }

  /** One line per label: how much came, and how much of it could not be read. */
  summary(): string {
    const labels = [...this.stats].map(([label, s]) => `${label} ${s.messages} (${s.unreadable} unreadable)`)
    return `received: ${labels.join(', ') || 'nothing'}; channels: ${[...this.channels].join(', ') || 'none'}`
  }

  private channel(message: Extract<PageMessage, { type: 'dc' }>, now: number): void {
    const { label } = message
    this.read(label, now, { b64: message.b64, text: message.text }, () => {
      if (!message.b64) throw new Error('text, not bytes')
      const bytes = Uint8Array.from(Buffer.from(message.b64, 'base64'))
      if (label === 'captions' || label === 'captions_v2') {
        const caption = label === 'captions' ? decodeCaptionV1(bytes) : decodeCaptionV2(bytes)
        if (!caption) throw new Error('not a caption')
        // Another kind of event on the caption channel: understood, and nothing to keep.
        if (caption === 'other') return
        this.captionMessages++
        this.captions.update(caption, now)
        this.logged.push({ ...caption, at: now })
        if (caption.language) {
          this.lastLanguage = caption.language
          this.lastLanguageAt = now
        }
      } else if (label === 'collections') {
        this.roster.update(decodeCollection(inflate(bytes)).users, false)
      }
    })
  }

  /** Count a message, keep the first few of its label raw, and count it unreadable if `work` throws. */
  private read(label: string, now: number, raw: { b64?: string; text?: string }, work: () => void): void {
    const stats = this.stats.get(label) ?? { messages: 0, unreadable: 0 }
    this.stats.set(label, stats)
    stats.messages++
    let problem: string | undefined
    try {
      work()
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err)
      stats.unreadable++
      this.unreadable++
    }
    if (stats.messages <= SAMPLES_PER_LABEL || (problem && stats.unreadable <= SAMPLES_PER_LABEL)) {
      this.samples.push({ label, at: now, ...raw, ...(problem ? { problem } : {}) })
    }
  }
}

/**
 * A call's caption log replayed through the same rules: the lines it would
 * have stored, with Meet's corrections made. How a meeting Wouice closed under
 * mid-call finds what it had not saved yet. Nameless: who was who came from
 * the participant list, which the log does not keep. See `unsavedTail`. The
 * feed is left with the replay's counts in it.
 */
export function replayCaptions(log: readonly LoggedCaption[], feed = new MeetFeed()): CaptionLine[] {
  const lines: CaptionLine[] = []
  const correct = (): void => {
    for (const r of feed.revisions()) {
      const line = lines.find((l) => l.startedAt === r.startedAt && l.text.includes(r.from))
      if (line) line.text = line.text.replace(r.from, r.to)
    }
  }
  for (const { at, ...update } of log) {
    // What was due by then goes first, as the bot looking every two seconds
    // had kept it: a caption quiet for ten seconds is a line before Meet
    // reuses its id, not words the reuse replaced.
    lines.push(...feed.take(at))
    feed.captions.update(update, at)
    lines.push(...feed.take(at))
    correct()
  }
  lines.push(...feed.flush())
  correct()
  return lines
}

/**
 * Of a replayed call, the lines not stored yet: those that began after the
 * last stored line. Names come from stored lines that began at the same
 * moment, device by device - the log knows devices, the store knows names.
 */
export function unsavedTail(
  replayed: readonly CaptionLine[],
  stored: readonly { startMs: number; speaker?: string | null }[],
  meetingStartedAt: number
): CaptionLine[] {
  const last = Math.max(-1, ...stored.map((s) => s.startMs))
  const names = new Map<string, string>()
  for (const line of replayed) {
    const same = stored.find((s) => s.speaker && s.startMs === Math.max(0, line.startedAt - meetingStartedAt))
    if (same?.speaker) names.set(line.deviceId, same.speaker)
  }
  return replayed
    .filter((l) => Math.max(0, l.startedAt - meetingStartedAt) > last)
    .map((l) => ({ ...l, speaker: l.speaker ?? names.get(l.deviceId) ?? null }))
}

/**
 * Meet compresses the collections channel. Attendee reads it with
 * `pako.inflate`, which takes zlib and gzip alike; `unzipSync` does the same,
 * and raw deflate is tried after it.
 */
function inflate(bytes: Uint8Array): Uint8Array {
  try {
    return Uint8Array.from(unzipSync(bytes))
  } catch {
    try {
      return Uint8Array.from(inflateRawSync(bytes))
    } catch {
      throw new Error('could not be inflated')
    }
  }
}
