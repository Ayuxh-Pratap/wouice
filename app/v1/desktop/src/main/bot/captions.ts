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
}

export class CaptionAssembler {
  private readonly pending = new Map<string, Pending>()
  /** Captions already kept, by `device:caption`: the text kept, and at which version. */
  private readonly done = new Map<string, { text: string; version: number }>()
  /** Captions whose words Meet changed after they were kept. Counted, not stored. */
  lateRevisions = 0
  /** How captions were kept: at Meet's final version, or without one. */
  keptFinal = 0
  keptQuiet = 0

  constructor(private readonly quietMs = 10_000) {}

  update(caption: CaptionUpdate, now: number): void {
    const key = `${caption.deviceId}:${caption.captionId}`
    const kept = this.done.get(key)
    if (kept) {
      if (caption.version <= kept.version) return
      kept.version = caption.version
      if (caption.text.trim() !== kept.text.trim()) this.lateRevisions++
      return
    }
    const current = this.pending.get(key)
    if (current && caption.version < current.version) return
    this.pending.set(key, {
      deviceId: caption.deviceId,
      version: caption.version,
      text: caption.text,
      firstAt: current?.firstAt ?? now,
      lastAt: current && current.text === caption.text ? current.lastAt : now,
      isFinal: caption.isFinal,
      language: caption.language ?? current?.language ?? null,
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

  /** When this speaker's oldest caption still in progress began; null when none is. */
  openSince(deviceId: string): number | null {
    let since: number | null = null
    for (const p of this.pending.values()) {
      if (p.deviceId === deviceId && (since === null || p.firstAt < since)) since = p.firstAt
    }
    return since
  }

  private release(ready: (p: Pending) => boolean, nameOf: (deviceId: string) => string | null): CaptionLine[] {
    const lines: CaptionLine[] = []
    for (const [key, p] of this.pending) {
      if (!ready(p)) continue
      this.pending.delete(key)
      this.done.set(key, { text: p.text, version: p.version })
      if (p.isFinal) this.keptFinal++
      else this.keptQuiet++
      const text = p.text.trim()
      if (!text) continue
      lines.push({
        deviceId: p.deviceId,
        speaker: nameOf(p.deviceId),
        text,
        startedAt: p.firstAt,
        endedAt: p.lastAt,
        language: p.language,
      })
    }
    return lines.sort((a, b) => a.startedAt - b.startedAt)
  }
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

  private joins(line: CaptionLine): boolean {
    return line.deviceId === this.open[0]!.deviceId && line.startedAt - lastEnd(this.open) < this.joinGapMs
  }

  private close(): CaptionLine {
    // In the order they were said, which is not always the order Meet finalised them.
    const pieces = this.open.sort((a, b) => a.startedAt - b.startedAt)
    this.open = []
    return {
      deviceId: pieces[0]!.deviceId,
      speaker: pieces.find((p) => p.speaker)?.speaker ?? null,
      text: pieces.map((p) => p.text).join(' '),
      startedAt: pieces[0]!.startedAt,
      endedAt: lastEnd(pieces),
      language: pieces.find((p) => p.language)?.language ?? null,
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
    return [...this.turns.add(kept), ...this.turns.due(now, (d) => this.captions.openSince(d))]
  }

  /** Everything, at the end of the call. */
  flush(): CaptionLine[] {
    return [...this.turns.add(this.captions.flush((d) => this.roster.nameOf(d))), ...this.turns.flush()]
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
