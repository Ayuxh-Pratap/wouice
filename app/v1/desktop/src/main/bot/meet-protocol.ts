import { unzipSync } from 'node:zlib'

/**
 * Google Meet's own data, decoded.
 *
 * Meet speaks protobuf on its WebRTC data channels, with no published schema.
 * The field numbers below are Attendee's (attendee-labs/attendee, Elastic
 * License 2.0), read off live traffic: they are facts about Meet, and when
 * Meet changes them this is the file that changes. The reader is our own.
 *
 * DECODED HERE, NOT IN THE PAGE. The script inside Meet only forwards raw
 * bytes. Every decision about what those bytes mean lives in Node, where it can
 * be tested against real and made-up messages - and a mistake shows up as a
 * failing test rather than as a meeting with no captions.
 *
 * Captions switched format on 2026-09-09 (Attendee PR #999): both are read.
 */

interface Field {
  no: number
  varint?: bigint
  bytes?: Uint8Array
}

/** Every field of one message, in order. Stops quietly at anything malformed. */
function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = []
  let at = 0
  const varint = (): bigint | null => {
    let value = 0n
    let shift = 0n
    while (at < bytes.length) {
      const byte = bytes[at++]!
      value |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value
      shift += 7n
      if (shift > 70n) return null
    }
    return null
  }
  while (at < bytes.length) {
    const tag = varint()
    if (tag === null) break
    const no = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      const value = varint()
      if (value === null) break
      out.push({ no, varint: value })
    } else if (wire === 2) {
      const length = varint()
      if (length === null || at + Number(length) > bytes.length) break
      out.push({ no, bytes: bytes.subarray(at, at + Number(length)) })
      at += Number(length)
    } else if (wire === 1) {
      at += 8
    } else if (wire === 5) {
      at += 4
    } else {
      // Groups (3, 4) are long deprecated and Meet does not use them.
      break
    }
  }
  return out
}

const utf8 = new TextDecoder('utf-8')

function message(bytes: Uint8Array | undefined, no: number): Uint8Array | undefined {
  return bytes ? fields(bytes).find((f) => f.no === no && f.bytes)?.bytes : undefined
}

function repeated(bytes: Uint8Array | undefined, no: number): Uint8Array[] {
  return bytes ? fields(bytes).flatMap((f) => (f.no === no && f.bytes ? [f.bytes] : [])) : []
}

function text(bytes: Uint8Array | undefined, no: number): string | undefined {
  const raw = message(bytes, no)
  return raw ? utf8.decode(raw) : undefined
}

/** A gzipped field, unpacked. Undefined when it is absent or not gzip. */
function gunzip(bytes: Uint8Array | undefined): Uint8Array | undefined {
  if (!bytes) return undefined
  try {
    return Uint8Array.from(unzipSync(bytes))
  } catch {
    return undefined
  }
}

function number(bytes: Uint8Array | undefined, no: number): bigint | undefined {
  return bytes ? fields(bytes).find((f) => f.no === no && f.varint !== undefined)?.varint : undefined
}

/* ------------------------------------------------------------ captions -- */

export interface CaptionUpdate {
  /** Whose words: the speaking device, named through the participant list. */
  deviceId: string
  /** One caption, revised many times as the speaker goes on. */
  captionId: string
  /** Higher is newer. */
  version: number
  text: string
  /** Meet will not revise it again. Only v2 says so reliably. */
  isFinal: boolean
  language: string | null
}

/** v1: `{1: {deviceId 1, captionId 2, version 3, isFinal 4, text 6}}`. */
export function decodeCaptionV1(bytes: Uint8Array): CaptionUpdate | null {
  const caption = message(bytes, 1)
  const deviceId = text(caption, 1)
  const captionId = number(caption, 2)
  if (!deviceId || captionId === undefined) return null
  return {
    deviceId,
    captionId: captionId.toString(),
    version: Number(number(caption, 3) ?? 0n),
    text: text(caption, 6) ?? '',
    isFinal: (number(caption, 4) ?? 0n) !== 0n,
    language: null,
  }
}

/**
 * v2, as Meet sent it in September 2026 - one level deeper than Attendee's
 * schema:
 *
 *   {1: {1: event, 6: {1: unix seconds}}}
 *   event = {captionId 1, version 2, 3: {isFinal 2, text 3, languageCode 4,
 *            translatedLanguageCode 5, deviceId 6}}
 *
 * A long caption comes gzipped instead, as `{2: gzip({1: event, 6: ...})}` -
 * often the final version of a sentence, so skipping these would keep every
 * long line cut short.
 *
 * Both depths are read: the event is whichever message has the caption id as
 * its field 1. The same channel carries other events with no caption in them;
 * those are `'other'`, which is not a failure. Null is bytes that are not this
 * format at all.
 */
export function decodeCaptionV2(bytes: Uint8Array): CaptionUpdate | 'other' | null {
  const outer = message(bytes, 1) ?? gunzip(message(bytes, 2))
  if (!outer) return null
  const event = number(outer, 1) !== undefined ? outer : message(outer, 1)
  const captionId = number(event, 1)
  const body = message(event, 3)
  const deviceId = text(body, 6)
  if (!body || !deviceId || captionId === undefined) return 'other'
  return {
    deviceId,
    captionId: captionId.toString(),
    version: Number(number(event, 2) ?? 0n),
    text: text(body, 3) ?? '',
    isFinal: (number(body, 2) ?? 0n) !== 0n,
    language: text(body, 4) ?? null,
  }
}

/* -------------------------------------------------------- participants -- */

export interface MeetUser {
  deviceId: string
  fullName: string
  displayName: string
  /** 1 in the meeting, 6 not in it, 7 removed - as far as anyone has seen. */
  status: number
  /** The account this browser is signed in as: the bot itself. */
  isSelf: boolean
  isHost: boolean
  /** Set when this "participant" is somebody's screen share. */
  screenShareOf: string | null
}

/** `{deviceId 1, fullName 2, status 4, isCurrentUser 7, parentDeviceId 21, displayName 29, isHost 34}`. */
function decodeUser(bytes: Uint8Array): MeetUser | null {
  const deviceId = text(bytes, 1)
  if (!deviceId) return null
  return {
    deviceId,
    fullName: text(bytes, 2) ?? '',
    displayName: text(bytes, 29) ?? '',
    status: Number(number(bytes, 4) ?? 0n),
    isSelf: message(bytes, 7) !== undefined,
    isHost: number(bytes, 34) !== undefined,
    screenShareOf: text(bytes, 21) ?? null,
  }
}

export interface DeviceOutput {
  deviceId: string
  /** The contributing-source id its audio arrives under. Stage B5 maps audio with it. */
  streamId: string
  kind: 'audio' | 'video' | 'other'
  disabled: boolean
}

/**
 * One message off the `collections` channel, already inflated.
 *
 * `{1: {2: {3: {2: [outputs]}, 13: {1: {2: [users]}}}}}`. A user here is one
 * person joining or changing - never the whole room, and never reliably a
 * leave: those arrive with the next full list, about a minute later.
 */
export function decodeCollection(bytes: Uint8Array): { users: MeetUser[]; outputs: DeviceOutput[] } {
  const wrapper = message(message(bytes, 1), 2)
  const outputs = repeated(message(wrapper, 3), 2).flatMap((raw) => {
    const deviceId = text(raw, 6)
    if (!deviceId) return []
    const type = Number(number(raw, 2) ?? 0n)
    return [
      {
        deviceId,
        streamId: text(raw, 4) ?? '',
        kind: type === 1 ? ('audio' as const) : type === 2 ? ('video' as const) : ('other' as const),
        disabled: (number(message(raw, 10), 1) ?? 0n) !== 0n,
      },
    ]
  })
  const users = repeated(message(message(wrapper, 13), 1), 2).flatMap((raw) => {
    const user = decodeUser(raw)
    return user ? [user] : []
  })
  return { users, outputs }
}

/**
 * The full participant list Meet fetches for itself - base64 text of
 * `{2: {2: {2: [users]}}}`. The one message that says who has LEFT.
 */
export function decodeSyncResponse(body: string): MeetUser[] {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(Buffer.from(body.trim(), 'base64'))
  } catch {
    return []
  }
  return repeated(message(message(bytes, 2), 2), 2).flatMap((raw) => {
    const user = decodeUser(raw)
    return user ? [user] : []
  })
}
