import { describe, expect, it } from 'vitest'
import { MEET_PAYLOAD, PAGE_BINDING, type PageMessage } from './meet-payload.js'

/**
 * The page hook, run against just enough of a browser: a peer connection that
 * opens data channels, and fetch.
 */

class FakeChannel extends EventTarget {
  constructor(readonly label: string) {
    super()
  }
}

class FakeConnection extends EventTarget {
  createDataChannel(label: string): FakeChannel {
    return new FakeChannel(label)
  }
  static generateCertificate(): string {
    return 'cert'
  }
}

function install() {
  const sent: PageMessage[] = []
  const window: Record<string, unknown> = {
    // A class of its own for each page, as every real page has: sharing one
    // across tests would hook the same prototype twice.
    RTCPeerConnection: class extends FakeConnection {},
    fetch: async () => ({ clone: () => ({ text: async () => 'c3luYw==' }) }),
    btoa: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
    setInterval: () => 0,
    [PAGE_BINDING]: (raw: string) => sent.push(JSON.parse(raw) as PageMessage),
  }
  new Function('window', MEET_PAYLOAD)(window)
  return { window, sent }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the page hook', () => {
  it('forwards caption messages from a channel the page opens, as base64', () => {
    const { window, sent } = install()
    const Connection = window.RTCPeerConnection as typeof FakeConnection
    const channel = new Connection().createDataChannel('captions_v2')
    channel.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from([1, 2, 3]).buffer }))
    expect(sent).toEqual([
      { type: 'channel', label: 'captions_v2' },
      { type: 'dc', label: 'captions_v2', b64: 'AQID' },
    ])
  })

  it('forwards participants from a channel the server opens', () => {
    const { window, sent } = install()
    const Connection = window.RTCPeerConnection as typeof FakeConnection
    const connection = new Connection()
    const channel = new FakeChannel('collections')
    connection.dispatchEvent(Object.assign(new Event('datachannel'), { channel }))
    channel.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from([9]).buffer }))
    expect(sent).toContainEqual({ type: 'dc', label: 'collections', b64: 'CQ==' })
  })

  it('names every channel, but forwards only the ones worth having', () => {
    const { window, sent } = install()
    const Connection = window.RTCPeerConnection as typeof FakeConnection
    const channel = new Connection().createDataChannel('media-director')
    channel.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from([1]).buffer }))
    expect(sent).toEqual([{ type: 'channel', label: 'media-director' }])
  })

  it("leaves Meet's connection working: still one, with its static methods", () => {
    const { window } = install()
    const Connection = window.RTCPeerConnection as typeof FakeConnection
    expect(new Connection()).toBeInstanceOf(Connection)
    expect(Connection.generateCertificate()).toBe('cert')
  })

  it('forwards the participant list Meet fetches, and nothing else it fetches', async () => {
    const { window, sent } = install()
    const fetch = window.fetch as (url: string) => Promise<unknown>
    await fetch('https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections')
    await fetch('https://meet.google.com/some/other/call')
    await settle()
    expect(sent).toEqual([{ type: 'sync', text: 'c3luYw==' }])
  })

  it('installs once, however many times the page runs it', () => {
    const { window, sent } = install()
    new Function('window', MEET_PAYLOAD)(window)
    const Connection = window.RTCPeerConnection as typeof FakeConnection
    new Connection().createDataChannel('captions')
    expect(sent.filter((m) => m.type === 'channel')).toHaveLength(1)
  })
})
