import { clipboard } from 'electron'
import { decideDelivery, withCombo, type Delivery, type Target } from './policy.js'
import {
  foregroundTarget,
  injectionAvailable,
  isProcessElevated,
  pressCombo,
  selfElevated,
  typeText,
} from './win32.js'

/**
 * Putting the transcript where the cursor is.
 *
 * The decisions live in `policy.ts` and the Win32 calls in `win32.ts`; this is
 * the part that touches the clipboard and the clock, which is exactly the part
 * that cannot be unit tested and therefore should contain as little judgement
 * as possible.
 */

/** Formats that mean the clipboard holds something we cannot write back. */
const NON_TEXT_FORMATS = ['image/png', 'image/jpeg', 'text/html', 'text/rtf', 'CF_HDROP', 'FileNameW']

/** How long to let the target consume the paste before restoring the clipboard. */
const PASTE_SETTLE_MS = 120

export interface InjectionResult {
  delivered: 'inserted' | 'copied'
  method: Delivery['method']
  /** Empty when it was a plain paste into the expected window. */
  reason: string
  /** The application the text went to, when it went anywhere. */
  targetExe: string
  /** True when the user's clipboard could not be put back. */
  clipboardReplaced: boolean
  ms: number
}

export interface InjectorDeps {
  enabled(): boolean
  /** exe (lowercase) -> combination, e.g. { 'mintty.exe': 'Ctrl+Shift+V' }. */
  pasteOverrides(): Record<string, string>
}

export class Injector {
  /**
   * The window that was in front when the hotkey was pressed.
   *
   * Captured at key-down and not at paste time, which is the whole point: a
   * transcription takes seconds, and an alt-tab in the middle of one would
   * otherwise deliver your text into whatever you switched to.
   */
  private captured: Target | null = null

  /**
   * Bumped on every clipboard write we make.
   *
   * The restore only runs if the generation it started with is still current.
   * Without it, a second dictation - or the user copying something during the
   * settle window - gets clobbered by a restore that belongs to an older paste.
   */
  private generation = 0

  constructor(private readonly deps: InjectorDeps) {}

  /** Call when a dictation starts. Cheap: about 0.03 ms. */
  captureTarget(): Target | null {
    this.captured = injectionAvailable() ? foregroundTarget() : null
    return this.captured
  }

  get capturedTarget(): Target | null {
    return this.captured
  }

  /**
   * Deliver the text, and always leave it on the clipboard if anything is off.
   *
   * Never throws. A dictation that has already been spoken must not be lost to
   * a failure in the delivery mechanism, so every path here ends with the text
   * either inserted or sitting on the clipboard ready to paste by hand.
   */
  async deliver(text: string): Promise<InjectionResult> {
    const started = performance.now()
    const done = (r: Omit<InjectionResult, 'ms'>): InjectionResult => ({
      ...r,
      ms: performance.now() - started,
    })

    if (!injectionAvailable()) {
      await this.copyOnly(text)
      return done({
        delivered: 'copied',
        method: 'copy',
        reason: 'native input is unavailable on this machine',
        targetExe: '',
        clipboardReplaced: true,
      })
    }

    const current = foregroundTarget()
    const clipboardHasNonText = await this.holdsNonText()

    let delivery = decideDelivery({
      captured: this.captured,
      current,
      textLength: text.length,
      clipboardHasNonText,
      enabled: this.deps.enabled(),
      // Asked about the CAPTURED window, which is the one the text is destined
      // for, not whatever happens to be in front at this instant.
      targetElevated: this.captured ? isProcessElevated(this.captured.pid) : null,
      selfElevated: selfElevated(),
    })
    delivery = withCombo(delivery, this.captured?.exe ?? '', this.deps.pasteOverrides())

    if (delivery.method === 'copy') {
      await this.copyOnly(text)
      return done({
        delivered: 'copied',
        method: 'copy',
        reason: delivery.reason,
        targetExe: '',
        clipboardReplaced: true,
      })
    }

    if (delivery.method === 'type') {
      const sent = await typeText(text)
      // Even on the typing path the text goes to the clipboard afterwards, so a
      // target that silently swallowed it still leaves the user something to
      // paste. It is their clipboard either way at that point.
      if (sent.sent !== sent.expected) {
        await this.copyOnly(text)
        return done({
          delivered: 'copied',
          method: 'copy',
          reason: 'the window refused synthetic keystrokes',
          targetExe: this.captured?.exe ?? '',
          clipboardReplaced: true,
        })
      }
      return done({
        delivered: 'inserted',
        method: 'type',
        reason: delivery.reason,
        targetExe: this.captured?.exe ?? '',
        clipboardReplaced: false,
      })
    }

    // Paste. The write is AWAITED: Electron 44's clipboard is asynchronous, and
    // pasting from an unawaited write is a race that delivers the PREVIOUS
    // dictation.
    const snapshot = delivery.restoreClipboard ? await this.readTextSafely() : null
    const generation = ++this.generation
    await clipboard.writeText(text)

    const sent = pressCombo(delivery.combo ?? { key: 0x56, modifiers: [0x11], label: 'Ctrl+V' })
    if (sent.sent !== sent.expected) {
      // The keystroke never left. Leave the text on the clipboard and say so.
      return done({
        delivered: 'copied',
        method: 'copy',
        reason: 'the window refused the paste keystroke',
        targetExe: this.captured?.exe ?? '',
        clipboardReplaced: true,
      })
    }

    if (snapshot !== null) {
      await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS))
      // Only if nothing else has written since: a newer dictation owns the
      // clipboard now, and restoring over it would undo their work.
      if (generation === this.generation) {
        try {
          await clipboard.writeText(snapshot)
        } catch {
          // Their clipboard now holds the transcript. Not a reason to fail.
        }
      }
    }

    return done({
      delivered: 'inserted',
      method: 'paste',
      reason: delivery.reason,
      targetExe: this.captured?.exe ?? '',
      clipboardReplaced: snapshot === null,
    })
  }

  private async copyOnly(text: string): Promise<void> {
    this.generation++
    try {
      await clipboard.writeText(text)
    } catch {
      // Nothing left to fall back to; the transcript is still in the history.
    }
  }

  private async readTextSafely(): Promise<string> {
    try {
      return await clipboard.readText()
    } catch {
      return ''
    }
  }

  /**
   * Does the clipboard hold something we could not put back?
   *
   * Electron 44 can only write plain text: `writeHTML`, `writeImage` and
   * `writeBuffer` are gone, and `write()` now wants a `ClipboardItem[]`. So the
   * question is not "what is on the clipboard" but "would using it destroy
   * something", and `has()` answers that in under a millisecond.
   */
  private async holdsNonText(): Promise<boolean> {
    for (const format of NON_TEXT_FORMATS) {
      try {
        if (await clipboard.has(format)) return true
      } catch {
        // An unknown format name is not a reason to refuse to deliver text.
      }
    }
    return false
  }
}
