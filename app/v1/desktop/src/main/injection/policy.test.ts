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
  targetElevated: false,
  selfElevated: false,
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
    expect(d.reason).toMatch(/in front/i)
  })

  it('does not blame the hotkey, which may not have been what started it', () => {
    // A dictation can be started by clicking the pet. Telling someone they
    // pressed a key they did not press sends them looking in the wrong place.
    expect(decideDelivery(ctx({ captured: null })).reason).not.toMatch(/hotkey/i)
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
    const d = decideDelivery(ctx({ captured: target({ exe: '' }) }))
    expect(d.method).toBe('copy')
    expect(d.reason).toMatch(/identify/i)
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

describe('elevated windows', () => {
  // V6c measured this: SendInput reported all four events accepted and not one
  // character reached an elevated window. Nothing afterwards can detect it, so
  // refusing beforehand is the only defence.
  it('refuses an elevated target when we are not elevated', () => {
    const d = decideDelivery(ctx({ targetElevated: true }))
    expect(d.method).toBe('copy')
    expect(d.reason).toMatch(/administrator/i)
  })

  it('refuses when elevation could not be determined', () => {
    // Being wrong costs a transcript; being cautious costs a clipboard paste.
    const d = decideDelivery(ctx({ targetElevated: null }))
    expect(d.method).toBe('copy')
    expect(d.reason).toMatch(/could not check/i)
  })

  it('allows an elevated target when we are elevated too', () => {
    expect(decideDelivery(ctx({ targetElevated: true, selfElevated: true })).method).toBe('paste')
  })

  it('allows a normal target from an elevated app: input flows downward', () => {
    expect(decideDelivery(ctx({ targetElevated: false, selfElevated: true })).method).toBe('paste')
  })

  it('does not let the typing fallback slip past the elevation check', () => {
    // Typing is just as blocked as pasting; the clipboard case must not reorder
    // the rules and end up sending keystrokes that go nowhere.
    const d = decideDelivery(ctx({ targetElevated: true, clipboardHasNonText: true, textLength: 10 }))
    expect(d.method).toBe('copy')
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

  it('stays below the measured boundary, with margin', () => {
    // V6d: exact on 5/5 up to 320 chars, 3/5 at 400, 0/5 at 500.
    expect(TYPE_SAFE_MAX_CHARS).toBeLessThan(320)
    // And not so timid that it never types anything worth typing.
    expect(TYPE_SAFE_MAX_CHARS).toBeGreaterThanOrEqual(120)
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
