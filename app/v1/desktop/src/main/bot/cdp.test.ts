import { afterEach, describe, expect, it, vi } from 'vitest'
import { CdpConnection, CdpError } from './cdp.js'

/**
 * The DevTools pipe, minus Chrome: NUL-terminated JSON in both directions.
 */

function connection(): { cdp: CdpConnection; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const cdp = new CdpConnection((frame) => {
    const text = frame.toString('utf8')
    expect(text.endsWith('\0')).toBe(true)
    sent.push(JSON.parse(text.slice(0, -1)) as Record<string, unknown>)
  })
  return { cdp, sent }
}

const reply = (message: object): Buffer => Buffer.from(JSON.stringify(message) + '\0')

afterEach(() => {
  vi.useRealTimers()
})

describe('the DevTools pipe', () => {
  it('numbers each command and resolves it with its own answer', async () => {
    const { cdp, sent } = connection()
    const first = cdp.send('Browser.getVersion')
    const second = cdp.send('Storage.getCookies', {}, 'session-1')
    expect(sent).toEqual([
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Storage.getCookies', params: {}, sessionId: 'session-1' },
    ])
    cdp.receive(reply({ id: 2, result: { cookies: [] } }))
    cdp.receive(reply({ id: 1, result: { product: 'Chrome/153' } }))
    expect(await first).toEqual({ product: 'Chrome/153' })
    expect(await second).toEqual({ cookies: [] })
  })

  it('reassembles a message split across chunks, and several in one chunk', async () => {
    const { cdp } = connection()
    const a = cdp.send('A')
    const b = cdp.send('B')
    const both = Buffer.concat([reply({ id: 1, result: { v: 'a' } }), reply({ id: 2, result: { v: 'b' } })])
    cdp.receive(both.subarray(0, 7))
    cdp.receive(both.subarray(7))
    expect(await a).toEqual({ v: 'a' })
    expect(await b).toEqual({ v: 'b' })
  })

  it('keeps a character whole when its bytes land in two chunks', async () => {
    const { cdp } = connection()
    const pending = cdp.send('Runtime.evaluate')
    const bytes = reply({ id: 1, result: { value: 'हिंदी' } })
    // Split inside the first Devanagari character's three bytes.
    const cut = bytes.indexOf(Buffer.from('ह')) + 1
    cdp.receive(bytes.subarray(0, cut))
    cdp.receive(bytes.subarray(cut))
    expect(await pending).toEqual({ value: 'हिंदी' })
  })

  it('fails a command Chrome refused, with its reason', async () => {
    const { cdp } = connection()
    const pending = cdp.send('Nope.nothing')
    cdp.receive(reply({ id: 1, error: { code: -32601, message: "'Nope.nothing' wasn't found" } }))
    await expect(pending).rejects.toThrow("'Nope.nothing' wasn't found")
  })

  it('gives up on a command that never gets an answer', async () => {
    vi.useFakeTimers()
    const { cdp } = connection()
    const pending = cdp.send('Page.navigate', {}, undefined, 2_000)
    vi.advanceTimersByTime(2_001)
    await expect(pending).rejects.toBeInstanceOf(CdpError)
  })

  it('fails everything waiting when Chrome goes away, and anything sent after', async () => {
    const { cdp } = connection()
    const pending = cdp.send('Browser.getVersion')
    cdp.close('Chrome exited with code 1')
    await expect(pending).rejects.toThrow('Chrome exited with code 1')
    await expect(cdp.send('Browser.close')).rejects.toThrow('Chrome exited with code 1')
  })

  it('ignores events and noise', () => {
    const { cdp } = connection()
    expect(() => cdp.receive(reply({ method: 'Target.targetCreated', params: {} }))).not.toThrow()
    expect(() => cdp.receive(Buffer.from('not json\0'))).not.toThrow()
  })
})
