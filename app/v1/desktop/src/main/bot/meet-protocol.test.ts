import { deflateSync, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  decodeCaptionV1,
  decodeCaptionV2,
  decodeCollection,
  decodeSyncResponse,
} from './meet-protocol.js'
import { bytes, int, str, u8, userEntry as user } from './meet-fixtures.js'

/**
 * Meet's messages, built by hand in the shapes Attendee recorded from live
 * traffic, and read back. A field number wrong here is a meeting with no
 * captions; this is where that shows up.
 */

describe('captions', () => {
  it('reads the v2 format Meet switched to in September 2026', () => {
    const caption = [...int(2, 1), ...str(3, 'हाँ, मैं कल भेज दूँगा'), ...str(4, 'hi-IN'), ...str(6, 'dev-rahul'), ...int(9, 1)]
    const event = [...int(1, 424242424242n), ...int(2, 7), ...bytes(3, caption)]
    expect(decodeCaptionV2(u8([...bytes(1, event), ...bytes(6, int(1, 1_789_000_000_000))]))).toEqual({
      deviceId: 'dev-rahul',
      captionId: '424242424242',
      version: 7,
      text: 'हाँ, मैं कल भेज दूँगा',
      isFinal: true,
      language: 'hi-IN',
    })
  })

  it('reads an interim v2 caption as not final', () => {
    const event = [...int(1, 5), ...int(2, 1), ...bytes(3, [...str(3, 'I will'), ...str(6, 'd1')])]
    expect(decodeCaptionV2(u8(bytes(1, event)))).toMatchObject({ isFinal: false, text: 'I will', version: 1 })
  })

  it('still reads v1', () => {
    const caption = [...str(1, 'dev-1'), ...int(2, 99), ...int(3, 3), ...int(4, 1), ...str(6, 'ship it friday'), ...int(8, 1)]
    expect(decodeCaptionV1(u8(bytes(1, caption)))).toEqual({
      deviceId: 'dev-1',
      captionId: '99',
      version: 3,
      text: 'ship it friday',
      isFinal: true,
      language: null,
    })
  })

  it('returns nothing for a message that is not a caption, rather than guessing', () => {
    expect(decodeCaptionV2(u8([]))).toBeNull()
    expect(decodeCaptionV2(u8([0xff, 0xff]))).toBeNull()
    expect(decodeCaptionV1(u8(bytes(1, str(6, 'no device'))))).toBeNull()
  })
})

describe('captions, as Meet actually sent them', () => {
  // Real messages off `captions_v2`, saved by the bot in two calls on 2026-09-11.
  const real = (b64: string): Uint8Array => Uint8Array.from(Buffer.from(b64, 'base64'))

  it('reads a caption from one level deeper than Attendee documents', () => {
    const message = 'CkgKPggBEAEaOBoFWW8geT8iBWVuLVVTKgVlbi1VUzIfc3BhY2VzL3VtWEtDc1FzczFJQi9kZXZpY2VzLzI5MUgBMgYIt5OR1QY='
    expect(decodeCaptionV2(real(message))).toEqual({
      deviceId: 'spaces/umXKCsQss1IB/devices/291',
      captionId: '1',
      version: 1,
      text: 'Yo y?',
      isFinal: false,
      language: 'en-US',
    })
  })

  it('reads the version Meet marks final', () => {
    const message = 'Ck4KRAgBEAYaPhABGglZbyB5byB5bz8iBWVuLVVTKgVlbi1VUzIfc3BhY2VzL3VtWEtDc1FzczFJQi9kZXZpY2VzLzI5MUgBMgYIt5OR1QY='
    expect(decodeCaptionV2(real(message))).toMatchObject({ version: 6, text: 'Yo yo yo?', isFinal: true })
  })

  it('reads Hindi captions', () => {
    const message = 'Ck8KRQgBEAEaPxoM4KSy4KWH4KSf4KSwIgVoaS1JTioFaGktSU4yH3NwYWNlcy91bVhLQ3NRc3MxSUIvZGV2aWNlcy8yOTJIATIGCMSVkdUG'
    expect(decodeCaptionV2(real(message))).toMatchObject({
      text: 'लेटर',
      language: 'hi-IN',
      deviceId: 'spaces/umXKCsQss1IB/devices/292',
    })
  })

  it('reads a long caption Meet sent gzipped, which was the final version of the sentence', () => {
    const message =
      'EowBH4sIAAAAAAAAAOPqYeRgFOCWamUUYJQKeLBk04Ol7Q+WzH+wZIPCgyVLHixtUniwZO2DpQ0KD5YsA0tNU4AoUniwZN2DpR0PluBS0fRgSZMSa0amrqefFoQyki8uSExOLdYvzY3wdi4OLC429HTST0ktywQJGlkaeTAasXEcnzrxKhsAxF3xXZcAAAA='
    expect(decodeCaptionV2(real(message))).toEqual({
      deviceId: 'spaces/umXKCsQss1IB/devices/292',
      captionId: '1',
      version: 11,
      text: 'लेटर तू भी देख ले मैं भी देख लूं',
      isFinal: true,
      language: 'hi-IN',
    })
  })

  it('knows the other events on the channel are not captions, and not failures either', () => {
    expect(decodeCaptionV2(real('ChQKBBABIgASBAgBIgAyBgisk5HVBg=='))).toBe('other')
    expect(decodeCaptionV2(real('CgYSBAgCGgA='))).toBe('other')
  })
})

describe('participants', () => {
  it('reads who joined off the collections channel, once inflated', () => {
    // {13: {1: {2: user, 2: user}}}: the users sit straight under field 2.
    const users = bytes(1, [...bytes(2, user('d-ayush', 'Ayush Pratap Singh', int(34, 1))), ...bytes(2, user('d-bot', 'Ayush Wouice Bot', str(7, 'uuid')))])
    const outputs = bytes(3, bytes(2, [...int(2, 1), ...str(4, '123456'), ...str(6, 'd-ayush'), ...bytes(10, int(1, 0))]))
    const event = u8(bytes(1, bytes(2, [...outputs, ...bytes(13, users)])))
    // Through zlib and back, the way Meet sends it and the feed reads it.
    const { users: found, outputs: streams } = decodeCollection(Uint8Array.from(inflateSync(deflateSync(event))))
    expect(found).toEqual([
      { deviceId: 'd-ayush', fullName: 'Ayush Pratap Singh', displayName: '', status: 1, isSelf: false, isHost: true, screenShareOf: null },
      { deviceId: 'd-bot', fullName: 'Ayush Wouice Bot', displayName: '', status: 1, isSelf: true, isHost: false, screenShareOf: null },
    ])
    expect(streams).toEqual([{ deviceId: 'd-ayush', streamId: '123456', kind: 'audio', disabled: false }])
  })

  it('reads the full list Meet fetches, which is base64 text', () => {
    const list = bytes(2, bytes(2, [...bytes(1, int(1, 3)), ...bytes(2, user('d-1', 'Rahul Dhir', str(29, 'Rahul'))), ...bytes(2, user('d-2', 'Rahul (Presentation)', str(21, 'd-1')))]))
    const body = Buffer.from(u8(list)).toString('base64')
    expect(decodeSyncResponse(body)).toEqual([
      { deviceId: 'd-1', fullName: 'Rahul Dhir', displayName: 'Rahul', status: 1, isSelf: false, isHost: false, screenShareOf: null },
      { deviceId: 'd-2', fullName: 'Rahul (Presentation)', displayName: '', status: 1, isSelf: false, isHost: false, screenShareOf: 'd-1' },
    ])
  })

  it('reads nothing out of nothing', () => {
    expect(decodeSyncResponse('')).toEqual([])
    expect(decodeCollection(u8([]))).toEqual({ users: [], outputs: [] })
  })
})
