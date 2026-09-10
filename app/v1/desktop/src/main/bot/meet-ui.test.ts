import { describe, expect, it } from 'vitest'
import { JOIN_LABELS, meetUrl, readPage, snapshotScript, type PageSnapshot } from './meet-ui.js'

/**
 * Reading Meet's page, minus Meet: what each state of the page means.
 */

const snap = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  text: '',
  nameInput: false,
  joinButton: null,
  leaveButton: false,
  continueWithoutDevices: false,
  micOn: false,
  cameraOn: false,
  dialogOk: false,
  participants: 0,
  url: 'https://meet.google.com/abc-defg-hij',
  ...over,
})

describe('what the page means', () => {
  it('is in the meeting while the leave button is there, whatever the page says', () => {
    // Someone typing an end-of-call sentence into the chat must not end the bot's meeting.
    expect(
      readPage(snap({ leaveButton: true, text: 'The call ended because everyone left (chat)' }))
    ).toEqual({ kind: 'in-meeting' })
  })

  it('knows each way of not getting in', () => {
    expect(readPage(snap({ text: 'Check your meeting code' }))).toEqual({ kind: 'failed', reason: 'not-found' })
    expect(readPage(snap({ text: 'You can’t join this video call' }))).toEqual({ kind: 'failed', reason: 'blocked' })
    expect(readPage(snap({ text: 'Someone in the call denied your request to join' }))).toEqual({
      kind: 'failed',
      reason: 'denied',
    })
    expect(readPage(snap({ text: 'No one responded to your request to join the call' }))).toEqual({
      kind: 'failed',
      reason: 'denied',
    })
  })

  it('reads curly and straight apostrophes alike', () => {
    expect(readPage(snap({ text: 'The meeting code you entered doesn’t work' })).kind).toBe('failed')
    expect(readPage(snap({ text: "You've been removed from the meeting" })).kind).toBe('removed')
    expect(readPage(snap({ text: 'You’ve been removed from the meeting' })).kind).toBe('removed')
  })

  it('treats the guest name box as not signed in, never as a way in', () => {
    expect(readPage(snap({ nameInput: true, joinButton: 'Ask to join' }))).toEqual({
      kind: 'failed',
      reason: 'login-required',
    })
    expect(readPage(snap({ text: 'Sign in. Use your Google Account' }))).toEqual({
      kind: 'failed',
      reason: 'login-required',
    })
  })

  it('knows the end of a call from being removed from one', () => {
    expect(readPage(snap({ text: 'Your host ended the meeting for everyone' }))).toEqual({ kind: 'ended' })
    expect(readPage(snap({ text: 'Someone has removed you from the meeting' }))).toEqual({ kind: 'removed' })
    expect(readPage(snap({ text: 'You left the meeting' }))).toEqual({ kind: 'self-left' })
  })

  it('walks the lobby: devices, the button, waiting to be let in, waiting for the host', () => {
    expect(readPage(snap({ continueWithoutDevices: true })).kind).toBe('continue-without-devices')
    expect(readPage(snap({ joinButton: 'Join now' }))).toEqual({ kind: 'ready', join: 'Join now' })
    expect(readPage(snap({ text: 'Asking to be let in…' })).kind).toBe('asking')
    expect(readPage(snap({ text: 'Waiting for the host to join' })).kind).toBe('waiting-for-host')
    expect(readPage(snap())).toEqual({ kind: 'loading' })
  })
})

describe('Meet links', () => {
  it('accepts what people paste, and opens one form of it', () => {
    const want = 'https://meet.google.com/abc-defg-hij?hl=en'
    expect(meetUrl('https://meet.google.com/abc-defg-hij')).toBe(want)
    expect(meetUrl('  meet.google.com/ABC-DEFG-HIJ?authuser=1 ')).toBe(want)
    expect(meetUrl('abc-defg-hij')).toBe(want)
  })

  it('refuses anything else', () => {
    expect(meetUrl('https://zoom.us/j/123')).toBeNull()
    expect(meetUrl('https://meet.google.com/')).toBeNull()
    expect(meetUrl('https://evil.example/meet.google.com/abc-defg-hij')).toBeNull()
    expect(meetUrl('')).toBeNull()
  })
})

describe('the script run inside the page', () => {
  /** Just enough of a DOM for the script to read. */
  function page(html: {
    buttons?: { text: string; spans?: string[] }[]
    selectors?: string[]
    participants?: string[]
    body?: string
  }) {
    const buttons = (html.buttons ?? []).map((b) => ({
      textContent: b.text,
      querySelectorAll: () => (b.spans ?? []).map((s) => ({ textContent: s })),
    }))
    const document = {
      body: { innerText: html.body ?? '' },
      querySelector: (selector: string) => ((html.selectors ?? []).includes(selector) ? {} : null),
      querySelectorAll: (selector: string) => {
        if (selector === 'button') return buttons
        if (selector === '[data-participant-id]') {
          return (html.participants ?? []).map((id) => ({ getAttribute: () => id }))
        }
        return []
      },
    }
    const run = new Function('document', 'location', `return ${snapshotScript(JOIN_LABELS)}`)
    return run(document, { href: 'https://meet.google.com/abc-defg-hij' }) as PageSnapshot
  }

  it('finds the join button by its words, even when they sit in a span beside an icon', () => {
    expect(page({ buttons: [{ text: 'videocamAsk to join', spans: ['Ask to join'] }] }).joinButton).toBe(
      'Ask to join'
    )
    expect(page({ buttons: [{ text: 'Join now' }] }).joinButton).toBe('Join now')
    expect(page({ buttons: [{ text: 'Present now' }] }).joinButton).toBeNull()
  })

  it('reports the leave button, the controls, and each participant once', () => {
    const found = page({
      selectors: ['[aria-label^="Leave call"]', '[aria-label^="Turn off microphone"]'],
      participants: ['a', 'b', 'b'],
      body: 'hello',
    })
    expect(found).toMatchObject({ leaveButton: true, micOn: true, cameraOn: false, participants: 2, text: 'hello' })
  })
})
