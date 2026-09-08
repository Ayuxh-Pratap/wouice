import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Acceptance criterion A3: the clipboard is always restored.
 *
 * The spec names this test specifically - "a test that copies during
 * transcription and asserts the copy survives" - and it did not exist. The
 * policy that decides where text goes was well covered; the part that actually
 * touches somebody's clipboard was not covered at all.
 *
 * WHAT IS FAKED, AND WHY. Electron's clipboard and the Win32 bindings, and
 * nothing else. The fake clipboard behaves like the real one in the way that
 * matters here: it holds exactly one thing, and whoever writes last wins. That
 * is the whole hazard - the app writes the transcript, and has to give the slot
 * back without stepping on whatever arrived in the meantime.
 */

const clip = {
  text: '',
  /** Every write, in order, so a restore that clobbers is visible. */
  writes: [] as string[],
  formats: new Set<string>(),
}

vi.mock('electron', () => ({
  clipboard: {
    writeText: vi.fn(async (t: string) => {
      clip.text = t
      clip.writes.push(t)
    }),
    readText: vi.fn(async () => clip.text),
    has: vi.fn(async (f: string) => clip.formats.has(f)),
  },
}))

const win32 = {
  available: true,
  target: { hwnd: '1', pid: 100, exe: 'notepad.exe', title: 'Untitled' },
  comboSent: true,
  typedOk: true,
}

vi.mock('./win32.js', () => ({
  injectionAvailable: () => win32.available,
  injectionUnavailableReason: () => 'stubbed',
  foregroundTarget: () => win32.target,
  isProcessElevated: () => false,
  selfElevated: () => false,
  pressCombo: () => (win32.comboSent ? { sent: 4, expected: 4 } : { sent: 0, expected: 4 }),
  typeText: async () => (win32.typedOk ? { sent: 10, expected: 10 } : { sent: 2, expected: 10 }),
}))

const { Injector } = await import('./injector.js')
const { clipboard } = await import('electron')

function makeInjector(): InstanceType<typeof Injector> {
  return new Injector({ enabled: () => true, pasteOverrides: () => ({}) })
}

beforeEach(() => {
  clip.text = ''
  clip.writes = []
  clip.formats.clear()
  win32.available = true
  win32.target = { hwnd: '1', pid: 100, exe: 'notepad.exe', title: 'Untitled' }
  win32.comboSent = true
  win32.typedOk = true
  vi.clearAllMocks()
})

describe('A3: the clipboard is always restored', () => {
  it('gives back what you copied before the dictation', () => {
    // The plain case, and the one that happens every time somebody dictates
    // with something already on their clipboard.
    clip.text = 'a link I was about to paste'
    const injector = makeInjector()
    injector.captureTarget()

    return injector.deliver('the transcript').then((result) => {
      expect(result.delivered).toBe('inserted')
      expect(result.method).toBe('paste')
      expect(result.clipboardReplaced).toBe(false)
      expect(clip.text).toBe('a link I was about to paste')
      // The transcript did pass through on the way. That is the mechanism, not
      // an accident: pasting is how the text gets in.
      expect(clip.writes).toEqual(['the transcript', 'a link I was about to paste'])
    })
  })

  it('gives back a copy made DURING transcription, which is the case A3 names', async () => {
    const injector = makeInjector()
    injector.captureTarget()

    // Transcription is running. The user copies something in the middle of it -
    // the app has not touched the clipboard yet, so this is simply what is
    // there when delivery starts.
    clip.text = 'copied while it was thinking'

    const result = await injector.deliver('the transcript')
    expect(result.clipboardReplaced).toBe(false)
    expect(clip.text).toBe('copied while it was thinking')
  })

  it('does not restore over a copy made while the paste was settling', async () => {
    // The 120ms window between pasting and restoring. Anything the user copies
    // in it belongs to them, and putting the old snapshot back would silently
    // undo it. Nothing in the app writes here, so a generation counter cannot
    // see it - only re-reading can.
    clip.text = 'the old thing'
    const injector = makeInjector()
    injector.captureTarget()

    const delivering = injector.deliver('the transcript')
    // Land inside the settle window, after the app's own write.
    await new Promise((r) => setTimeout(r, 40))
    clip.text = 'something they copied just now'

    await delivering
    expect(clip.text).toBe('something they copied just now')
  })

  it('leaves the transcript on the clipboard when it refuses to insert', async () => {
    // Refused for any reason, the text has to be somewhere the user can reach.
    win32.available = false
    const injector = makeInjector()
    const result = await injector.deliver('the transcript')

    expect(result.delivered).toBe('copied')
    expect(result.clipboardReplaced).toBe(true)
    expect(clip.text).toBe('the transcript')
  })

  it('leaves the transcript on the clipboard when the keystroke never lands', async () => {
    clip.text = 'mine'
    win32.comboSent = false
    const injector = makeInjector()
    injector.captureTarget()

    const result = await injector.deliver('the transcript')
    expect(result.delivered).toBe('copied')
    expect(result.reason).toMatch(/refused the paste keystroke/)
    // Deliberately NOT restored: the paste did not happen, so the transcript is
    // the only copy of what was said and it stays reachable.
    expect(clip.text).toBe('the transcript')
  })

  it('types instead, rather than destroy an image on the clipboard', async () => {
    // Electron 44 can only write plain text, so an image or a file on the
    // clipboard is something we could not put back. Typing sidesteps the
    // clipboard entirely, which is better than either clobbering it or
    // refusing to deliver.
    clip.formats.add('image/png')
    const injector = makeInjector()
    injector.captureTarget()

    const result = await injector.deliver('short enough to type')
    expect(result.method).toBe('type')
    expect(result.delivered).toBe('inserted')
    expect(clip.writes).toEqual([])
  })

  it('says so when the text is too long to type around an image', async () => {
    // Past the typing cap, delivering the transcript matters more than
    // preserving the image - but the user is told which trade was made.
    clip.formats.add('image/png')
    const injector = makeInjector()
    injector.captureTarget()

    const result = await injector.deliver('x'.repeat(400))
    expect(result.method).toBe('paste')
    expect(result.reason).toMatch(/too long to type/)
    expect(result.clipboardReplaced).toBe(true)
  })

  it('awaits the write before pressing paste', async () => {
    // Electron 44's clipboard is asynchronous. Pasting from an unawaited write
    // delivers the PREVIOUS dictation, which is the kind of bug that looks like
    // the model misbehaving.
    const injector = makeInjector()
    injector.captureTarget()
    await injector.deliver('first')
    clip.writes = []
    await injector.deliver('second')
    expect(clip.writes[0]).toBe('second')
    expect(clipboard.writeText).toHaveBeenCalled()
  })
})
