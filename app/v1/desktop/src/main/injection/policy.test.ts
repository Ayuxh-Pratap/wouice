import { describe, expect, it } from 'vitest'
import {
  CTRL_V,
  TYPE_SAFE_MAX_CHARS,
  decideDelivery,
  parseCombo,
  pasteComboFor,
  sameTarget,
  withCombo,
  type DeliveryContext,
  type Target,
} from './policy.js'

const target = (patch: Partial<Target> = {}): Target => ({
  hwnd: '1000',
  pid: 42,
  exe: 'notepad.exe',
  title: 'Untitled - Notepad',
  ...patch,
})

const ctx = (patch: Partial<DeliveryContext> = {}): DeliveryContext => ({
  captured: target(),
  current: target(),
  textLength: 50,
  clipboardHasNonText: false,
  enabled: true,
  ...patch,
})

describe('the happy path', () => {
  it('pastes into the window you were in, and puts the clipboard back', () => {
    const d = decideDelivery(ctx())
    expect(d.method).toBe('paste')
    expect(d.restoreClipboard).toBe(true)
    expect(d.combo).toEqual(CTRL_V)
  })
})

describe('it refuses rather than guessing', () => {
  it('copies when insertion is switched off', () => {
    expect(decideDelivery(ctx({ enabled: false })).method).toBe('copy')
  })

  it('copies when no window was captured at key-down', () => {
    const d = decideDelivery(ctx({ captured: null }))
    expect(d.method).toBe('copy')
    expect(d.reason).toMatch(/captured/i)
  })

  it('copies when focus moved during transcription', () => {
    // The bug this exists for: a slow transcription plus an alt-tab, and the
    // text lands in whatever the user switched to.
    const d = decideDelivery(ctx({ current: target({ hwnd: '2000', pid: 99, exe: 'chrome.exe' }) }))
    expect(d.method).toBe('copy')
    expect(d.reason).toMatch(/chrome\.exe/)
  })

  it('copies when nothing is in the foreground at all', () => {
    expect(decideDelivery(ctx({ current: null })).method).toBe('copy')
  })

  it('copies when the target executable could not be read', () => {
    // OpenProcess being refused usually means a higher integrity level, where
    // Windows drops our input silently. Better to decline out loud.
    const d = decideDelivery(ctx({ captured: target({ exe: '' }) }))
    expect(d.method).toBe('copy')
    expect(d.reason).toMatch(/elevated/i)
  })

  it('copies an empty transcript rather than sending a bare keystroke', () => {
    expect(decideDelivery(ctx({ textLength: 0 })).method).toBe('copy')
  })

  it('never reports restoreClipboard on a refusal', () => {
    for (const patch of [{ enabled: false }, { captured: null }, { current: null }]) {
      expect(decideDelivery(ctx(patch)).restoreClipboard).toBe(false)
    }
  })
})

describe('when the clipboard holds something we cannot put back', () => {
  it('types short text, so an image survives', () => {
    const d = decideDelivery(ctx({ clipboardHasNonText: true, textLength: 40 }))
    expect(d.method).toBe('type')
    expect(d.restoreClipboard).toBe(false)
  })

  it('types right up to the safe limit', () => {
    const d = decideDelivery(ctx({ clipboardHasNonText: true, textLength: TYPE_SAFE_MAX_CHARS }))
    expect(d.method).toBe('type')
  })

  it('pastes past the limit, because a truncated transcript is worse than a lost image', () => {
    // V6b: typing 585 characters lost 122 in Chrome and all of them in VS Code,
    // with SendInput reporting success both times.
    const d = decideDelivery(ctx({ clipboardHasNonText: true, textLength: TYPE_SAFE_MAX_CHARS + 1 }))
    expect(d.method).toBe('paste')
    expect(d.restoreClipboard).toBe(false)
    expect(d.reason).toMatch(/clipboard was replaced/i)
  })

  it('stays well below the shortest measured failure', () => {
    // Typing was exact at 21 chars and broken at 585; the boundary is unmeasured.
    expect(TYPE_SAFE_MAX_CHARS).toBeLessThan(585)
  })

  it('still refuses when focus moved, before considering the clipboard', () => {
    const d = decideDelivery(
      ctx({ clipboardHasNonText: true, textLength: 10, current: target({ hwnd: '999' }) })
    )
    expect(d.method).toBe('copy')
  })
})

describe('target identity', () => {
  it('matches on the handle', () => {
    expect(sameTarget(target(), target())).toBe(true)
  })

  it('ignores a title that changed while you were speaking', () => {
    // Editors mark the buffer dirty, browsers follow redirects. Matching on the
    // title would refuse perfectly valid insertions.
    expect(sameTarget(target(), target({ title: '● Untitled - Notepad' }))).toBe(true)
  })

  it('treats two windows of the same app as different targets', () => {
    expect(sameTarget(target(), target({ hwnd: '2000' }))).toBe(false)
  })

  it('rejects a recycled handle belonging to a different process', () => {
    expect(sameTarget(target(), target({ pid: 43 }))).toBe(false)
  })

  it('is false when either side is missing', () => {
    expect(sameTarget(null, target())).toBe(false)
    expect(sameTarget(target(), null)).toBe(false)
  })
})

describe('paste keys', () => {
  it('defaults to Ctrl+V', () => {
    expect(pasteComboFor('notepad.exe').label).toBe('Ctrl+V')
  })

  it('uses Ctrl+V for Windows Terminal, which was measured to accept it', () => {
    // The spec assumed terminals need Ctrl+Shift+V and built a policy on it.
    expect(pasteComboFor('windowsterminal.exe').label).toBe('Ctrl+V')
  })

  it('knows the terminals where Ctrl+V means something else', () => {
    expect(pasteComboFor('mintty.exe').label).toBe('Ctrl+Shift+V')
    expect(pasteComboFor('putty.exe').label).toBe('Shift+Insert')
  })

  it('is case-insensitive about the executable', () => {
    expect(pasteComboFor('MinTTY.EXE').label).toBe('Ctrl+Shift+V')
  })

  it('lets a user override win over the built-in table', () => {
    expect(pasteComboFor('mintty.exe', { 'mintty.exe': 'Ctrl+V' }).label).toBe('Ctrl+V')
  })

  it('ignores an unparseable override rather than sending nonsense', () => {
    expect(pasteComboFor('notepad.exe', { 'notepad.exe': 'Meta+Banana' }).label).toBe('Ctrl+V')
  })

  it('parses the combinations people actually write', () => {
    expect(parseCombo('Ctrl+V')?.label).toBe('Ctrl+V')
    expect(parseCombo('ctrl+shift+v')?.label).toBe('Ctrl+Shift+V')
    expect(parseCombo('Shift+Insert')?.label).toBe('Shift+Insert')
  })

  it('rejects a combination with no modifier, which would just type a letter', () => {
    expect(parseCombo('V')).toBeNull()
  })

  it('rejects an empty or malformed override', () => {
    for (const bad of ['', '+', 'Ctrl+', 'Ctrl', 'Ctrl+Shift']) expect(parseCombo(bad)).toBeNull()
  })
})

describe('withCombo', () => {
  it('resolves the paste key for the target application', () => {
    const d = withCombo(decideDelivery(ctx()), 'mintty.exe', {})
    expect(d.combo?.label).toBe('Ctrl+Shift+V')
  })

  it('leaves a typed or copied delivery untouched', () => {
    const typed = decideDelivery(ctx({ clipboardHasNonText: true, textLength: 10 }))
    expect(withCombo(typed, 'mintty.exe', {})).toEqual(typed)
  })
})
