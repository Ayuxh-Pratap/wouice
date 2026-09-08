/**
 * Deciding how to deliver text to another application.
 *
 * Pure. Takes what was captured, what is in front now, and what the clipboard
 * holds; returns a decision. No Win32, no clipboard, no I/O - so every rule
 * below is testable, and the rules are the part that has to be right.
 *
 * WHY PASTE AND NOT TYPING. Spike V6b measured both against Chrome, Windows
 * Terminal and VS Code with a 585-character transcript. Pasting was exact in
 * every target in 8-16 ms. Typing the same string lost 122 characters in Chrome
 * and all 585 in VS Code - and `SendInput` reported every event accepted in
 * both cases, so nothing in the return value reveals the loss. Pacing the
 * events did not fix it: the configuration that was exact on five consecutive
 * runs failed on the sixth under different load. A silent truncation is the
 * worst possible failure for dictation, so typing is the fallback and not the
 * default.
 */

export interface Target {
  /** Window handle as a string; the identity that matters. */
  hwnd: string
  pid: number
  /** Base name, lowercase, e.g. "code.exe". Empty when it could not be read. */
  exe: string
  title: string
}

export interface PasteCombo {
  /** Virtual key code of the non-modifier key. */
  key: number
  /** Virtual key codes held around it. */
  modifiers: number[]
  label: string
}

export const VK_CONTROL = 0x11
export const VK_SHIFT = 0x10
export const VK_INSERT = 0x2d
export const VK_V = 0x56

export const CTRL_V: PasteCombo = { key: VK_V, modifiers: [VK_CONTROL], label: 'Ctrl+V' }
const CTRL_SHIFT_V: PasteCombo = {
  key: VK_V,
  modifiers: [VK_CONTROL, VK_SHIFT],
  label: 'Ctrl+Shift+V',
}
const SHIFT_INSERT: PasteCombo = {
  key: VK_INSERT,
  modifiers: [VK_SHIFT],
  label: 'Shift+Insert',
}

/**
 * Terminals that do not take Ctrl+V.
 *
 * Deliberately short. The spec assumed terminals in general need Ctrl+Shift+V
 * and built a policy around it; V6b measured **Windows Terminal accepting plain
 * Ctrl+V**, so the default is right for the terminal that ships with Windows.
 * These are the ones where Ctrl+V means something else entirely, and dictating
 * into them with the wrong combination produces silence with no error.
 */
const KNOWN_PASTE_KEYS: Record<string, PasteCombo> = {
  // Git Bash and Cygwin: Ctrl+V is "literal next" in the readline sense.
  'mintty.exe': CTRL_SHIFT_V,
  'conemu64.exe': CTRL_SHIFT_V,
  'conemu.exe': CTRL_SHIFT_V,
  // PuTTY pastes on middle-click or Shift+Insert; Ctrl+V does nothing.
  'putty.exe': SHIFT_INSERT,
  'kitty.exe': SHIFT_INSERT,
}

/**
 * Which key combination pastes in this application.
 *
 * User overrides win, always: this table cannot know about every terminal, and
 * someone who has found the right combination for theirs should not have to
 * wait for it to be added here.
 */
export function pasteComboFor(exe: string, overrides: Record<string, string> = {}): PasteCombo {
  const key = exe.toLowerCase()
  const override = overrides[key]
  if (override) {
    const parsed = parseCombo(override)
    if (parsed) return parsed
  }
  return KNOWN_PASTE_KEYS[key] ?? CTRL_V
}

/** Accepts "Ctrl+V", "Ctrl+Shift+V", "Shift+Insert". Anything else is ignored. */
export function parseCombo(text: string): PasteCombo | null {
  const parts = text
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length < 2) return null

  const modifiers: number[] = []
  let key: number | null = null
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') modifiers.push(VK_CONTROL)
    else if (part === 'shift') modifiers.push(VK_SHIFT)
    else if (part === 'v') key = VK_V
    else if (part === 'insert' || part === 'ins') key = VK_INSERT
    else return null
  }
  if (key === null || modifiers.length === 0) return null

  const label = parts
    .map((p) => (p === 'ctrl' || p === 'control' ? 'Ctrl' : p[0]!.toUpperCase() + p.slice(1)))
    .join('+')
  return { key, modifiers, label }
}

/**
 * Is the window in front still the one we captured when the hotkey was pressed?
 *
 * By handle, not by process or title. A title changes while you dictate - an
 * editor marks the buffer dirty, a browser follows a redirect - and matching on
 * it would refuse valid insertions. Two windows of the same application are
 * different handles and must be treated as different targets.
 */
export function sameTarget(captured: Target | null, current: Target | null): boolean {
  if (!captured || !current) return false
  return captured.hwnd === current.hwnd && captured.pid === current.pid
}

/**
 * How long a transcript may be before typing stops being trusted.
 *
 * PROVISIONAL. V6b measured typing exact at 21 characters in all three targets
 * and broken at 585 in two of them; the boundary between was not bisected. Until
 * V6d does that, this sits far below the shortest known failure rather than
 * anywhere near it - a wrong guess here is a silently truncated sentence.
 */
export const TYPE_SAFE_MAX_CHARS = 120

export type DeliveryMethod = 'paste' | 'type' | 'copy'

export interface Delivery {
  method: DeliveryMethod
  /** Filled in for 'paste'. */
  combo?: PasteCombo
  /**
   * Whether the previous clipboard contents can be put back afterwards.
   * False when the clipboard holds something Electron cannot rewrite.
   */
  restoreClipboard: boolean
  /** Plain-English explanation, recorded and shown when it is not a plain paste. */
  reason: string
}

export interface DeliveryContext {
  /** The foreground window when the hotkey was pressed. */
  captured: Target | null
  /** The foreground window now, at the moment of delivery. */
  current: Target | null
  textLength: number
  /** The clipboard holds something that is not plain text, e.g. an image or files. */
  clipboardHasNonText: boolean
  /** The user's setting. Off means copy and let them paste. */
  enabled: boolean
}

/**
 * Decide how this transcript reaches the cursor.
 *
 * The ordering is the safety argument. Refusals come first, so no amount of
 * later reasoning can talk the decision into typing somewhere it should not.
 */
export function decideDelivery(ctx: DeliveryContext): Delivery {
  const copy = (reason: string): Delivery => ({ method: 'copy', restoreClipboard: false, reason })

  if (!ctx.enabled) return copy('insertion is turned off')
  if (!ctx.captured) return copy('no window was captured when you pressed the hotkey')

  // An unreadable executable means OpenProcess was refused, which usually means
  // the target runs at a higher integrity level than we do. Windows will drop
  // our input there anyway, and it does so silently, so decline out loud.
  if (!ctx.captured.exe) return copy('could not identify the window, so it may be elevated')

  if (!ctx.current) return copy('no window is in the foreground')
  if (!sameTarget(ctx.captured, ctx.current)) {
    return copy(`focus moved to ${ctx.current.exe || 'another window'}`)
  }
  if (ctx.textLength === 0) return copy('nothing to insert')

  // Something on the clipboard that we cannot put back. Typing avoids touching
  // it at all, which is worth doing while the text is short enough to type
  // reliably - and beyond that length, delivering the transcript matters more
  // than preserving an image, so say so rather than truncating.
  if (ctx.clipboardHasNonText) {
    if (ctx.textLength <= TYPE_SAFE_MAX_CHARS) {
      return { method: 'type', restoreClipboard: false, reason: 'typed to keep your clipboard' }
    }
    return {
      method: 'paste',
      combo: CTRL_V,
      restoreClipboard: false,
      reason: 'too long to type safely, so your clipboard was replaced',
    }
  }

  return { method: 'paste', combo: CTRL_V, restoreClipboard: true, reason: '' }
}

/** Fill in the paste key for the target, once the method is known. */
export function withCombo(
  delivery: Delivery,
  exe: string,
  overrides: Record<string, string>
): Delivery {
  if (delivery.method !== 'paste') return delivery
  return { ...delivery, combo: pasteComboFor(exe, overrides) }
}
