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
 * Monday" - each a higher version under one id. Storing every update would
 * put the sentence in the transcript eight times. So each caption is kept
 * under `device:caption` and replaced by newer versions, and becomes a line
 * once Meet marks it final, or once it has not changed for two seconds. The
 * rule is Attendee's `closed_caption_manager`. A caption that grows again after
 * it settled - the speaker paused, then went on - adds a line with only the new
 * words, so a pause never costs the end of a sentence.
 *
 * NAMES FROM MEET'S OWN LIST. A caption carries a device id, not a person; the
 * participant list maps one to the other. It is kept for the whole call, so a
 * line said by someone who has since left still has their name.
 */

/** One finished caption: a line of the transcript. */
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

export class Roster {
  private readonly present = new Map<string, MeetUser>()
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
}

interface Pending {
  deviceId: string
  version: number
  text: string
  firstAt: number
  lastAt: number
  isFinal: boolean
  language: string | null
  /** What of this caption an earlier line already kept. Empty for a new caption. */
  kept: string
}

export class CaptionAssembler {
  private readonly pending = new Map<string, Pending>()
  /** Captions already made into lines: the text kept, and at which version. */
  private readonly done = new Map<string, { text: string; version: number }>()
  /** Captions Meet changed after they were kept, without adding to them. Logged, not stored. */
  lateRevisions = 0

  constructor(
    private readonly settleMs = 2_000,
    private readonly minAgeMs = 1_000
  ) {}

  update(caption: CaptionUpdate, now: number): void {
    const key = `${caption.deviceId}:${caption.captionId}`
    const kept = this.done.get(key)
    if (kept) {
      if (caption.version <= kept.version) return
      kept.version = caption.version
      if (!remainder(kept.text, caption.text)) {
        this.lateRevisions++
        return
      }
      // The speaker went on after a pause long enough to settle the caption.
      // The new words become a line of their own rather than being lost.
      this.done.delete(key)
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
      kept: current?.kept ?? kept?.text ?? '',
    })
  }

  /** Captions that are finished: final, or settled. Oldest first. */
  take(now: number, nameOf: (deviceId: string) => string | null): CaptionLine[] {
    return this.release(
      (p) => p.isFinal || (now - p.lastAt >= this.settleMs && now - p.firstAt >= this.minAgeMs),
      nameOf
    )
  }

  /** Everything still open, at the end of the call. */
  flush(nameOf: (deviceId: string) => string | null): CaptionLine[] {
    return this.release(() => true, nameOf)
  }

  private release(ready: (p: Pending) => boolean, nameOf: (deviceId: string) => string | null): CaptionLine[] {
    const lines: CaptionLine[] = []
    for (const [key, p] of this.pending) {
      if (!ready(p)) continue
      this.pending.delete(key)
      this.done.set(key, { text: p.text, version: p.version })
      const text = p.kept ? remainder(p.kept, p.text) : p.text.trim()
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
 */
export class MeetFeed {
  readonly roster = new Roster()
  readonly captions = new CaptionAssembler()
  /** Every data channel label seen: the first sign Meet has renamed one. */
  readonly channels = new Set<string>()
  /** Per channel label (and `sync`, `page`, `page-error`). */
  readonly stats = new Map<string, ChannelStats>()
  readonly samples: MessageSample[] = []
  lastHeartbeat: number | null = null
  captionMessages = 0
  /** Messages that could not be read at all. */
  unreadable = 0

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

/** The words `after` adds to `before`: what was said since part of a caption was kept. */
function remainder(before: string, after: string): string {
  if (after.startsWith(before)) return after.slice(before.length).trim()
  // Meet corrects earlier words as it goes, so go by how many there were.
  const was = before.split(/\s+/).filter(Boolean).length
  return after.split(/\s+/).filter(Boolean).slice(was).join(' ')
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
