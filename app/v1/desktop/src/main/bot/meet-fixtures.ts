import { deflateSync } from 'node:zlib'

/**
 * Meet's messages, built by hand, for tests.
 *
 * The shapes are the ones Attendee recorded from live traffic (see
 * `meet-protocol.ts`). One encoder, so the tests of the decoder, the feed and
 * the bot's run all send Meet the same bytes.
 */

export function varint(n: number | bigint): number[] {
  let value = BigInt(n)
  const out: number[] = []
  do {
    let byte = Number(value & 0x7fn)
    value >>= 7n
    if (value > 0n) byte |= 0x80
    out.push(byte)
  } while (value > 0n)
  return out
}

export const int = (no: number, n: number | bigint): number[] => [...varint((no << 3) | 0), ...varint(n)]
export const bytes = (no: number, payload: number[]): number[] => [
  ...varint((no << 3) | 2),
  ...varint(payload.length),
  ...payload,
]
export const str = (no: number, s: string): number[] => bytes(no, [...Buffer.from(s, 'utf8')])
export const u8 = (parts: number[]): Uint8Array => Uint8Array.from(parts)
export const base64 = (parts: number[] | Uint8Array): string => Buffer.from(Uint8Array.from(parts)).toString('base64')

/** One caption update in the v2 format. */
export function captionV2(c: {
  deviceId: string
  captionId: number | bigint
  version: number
  text: string
  isFinal?: boolean
  language?: string
}): number[] {
  const caption = [
    ...int(2, c.isFinal ? 1 : 0),
    ...str(3, c.text),
    ...(c.language ? str(4, c.language) : []),
    ...str(6, c.deviceId),
  ]
  return bytes(1, [...int(1, c.captionId), ...int(2, c.version), ...bytes(3, caption)])
}

/** One participant, present unless told otherwise. */
export const userEntry = (deviceId: string, fullName: string, extra: number[] = [], status = 1): number[] => [
  ...str(1, deviceId),
  ...str(2, fullName),
  ...int(4, status),
  ...extra,
]

/** A collections-channel event carrying participants, before it is deflated. */
export const collectionEvent = (users: number[][]): number[] =>
  bytes(1, bytes(2, bytes(13, bytes(1, users.flatMap((u) => bytes(2, u))))))

/** What the page hook forwards, as the JSON the binding receives. */
export const pageMessage = {
  caption: (c: Parameters<typeof captionV2>[0]): string =>
    JSON.stringify({ type: 'dc', label: 'captions_v2', b64: base64(captionV2(c)) }),
  people: (users: number[][]): string =>
    JSON.stringify({ type: 'dc', label: 'collections', b64: base64(deflateSync(u8(collectionEvent(users)))) }),
  channel: (label: string): string => JSON.stringify({ type: 'channel', label }),
  heartbeat: (): string => JSON.stringify({ type: 'heartbeat' }),
}
