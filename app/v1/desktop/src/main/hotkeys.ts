import { globalShortcut } from 'electron'

/**
 * Global hotkey registration, with fallback.
 *
 * `globalShortcut` is used rather than a low-level keyboard hook because it
 * SUPPRESSES the keypress: nothing leaks through to the app underneath, which
 * also neutralises the AltGr concern on international layouts. The cost is that
 * it only fires on press with no key-up, which is why the design is
 * toggle-plus-silence-detection rather than push-to-talk (decision A8b).
 *
 * WHY FALLBACK EXISTS. Spike V1 found that the spec's chosen default
 * `Control+Alt+Space` AND its documented fallback `Control+Shift+Space` were
 * both already taken on the target machine, most likely by the Windows keyboard
 * layout switcher (a Hindi layout is installed) and PowerToys. Registration
 * fails silently at the OS level, so an app that assumes success just does
 * nothing forever and looks broken.
 *
 * So: try the configured accelerator, then walk a candidate list, and report
 * exactly what was landed on.
 */

/** Tried in order when the configured accelerator is unavailable. */
export const FALLBACK_CHAIN: Record<string, string[]> = {
  dictate: ['Control+Alt+D', 'Control+Alt+J', 'Alt+Shift+W', 'Control+Alt+Enter', 'F13'],
  meeting: ['Control+Alt+M', 'Control+Alt+K', 'F14'],
  companion: ['Control+Alt+C', 'Control+Alt+L', 'F15'],
}

export interface HotkeyBinding {
  name: string
  accelerator: string
  handler: () => void
}

export interface HotkeyResult {
  name: string
  /** What is actually registered, which may differ from what was requested. */
  accelerator: string | null
  requested: string
  /** True when we had to fall back, so the UI can say so. */
  substituted: boolean
  /** Everything tried and rejected, for diagnostics. */
  rejected: string[]
}

function tryRegister(accelerator: string, handler: () => void): boolean {
  try {
    // isRegistered is the honest check: register() can return true while the OS
    // quietly declines to deliver events.
    return globalShortcut.register(accelerator, handler) && globalShortcut.isRegistered(accelerator)
  } catch {
    return false
  }
}

/** Which of these accelerators can currently be claimed. Used by diagnostics. */
export function probe(candidates: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const acc of candidates) {
    const ok = tryRegister(acc, () => {})
    out[acc] = ok
    if (ok) globalShortcut.unregister(acc)
  }
  return out
}

export class HotkeyManager {
  private results: HotkeyResult[] = []

  register(bindings: HotkeyBinding[]): HotkeyResult[] {
    this.unregisterAll()
    this.results = bindings.map((b) => this.registerOne(b))
    return this.results
  }

  private registerOne(b: HotkeyBinding): HotkeyResult {
    const rejected: string[] = []
    const candidates = [b.accelerator, ...(FALLBACK_CHAIN[b.name] ?? [])]

    for (const acc of candidates) {
      if (!acc || rejected.includes(acc)) continue
      if (tryRegister(acc, b.handler)) {
        return {
          name: b.name,
          accelerator: acc,
          requested: b.accelerator,
          substituted: acc !== b.accelerator,
          rejected,
        }
      }
      rejected.push(acc)
    }

    return { name: b.name, accelerator: null, requested: b.accelerator, substituted: false, rejected }
  }

  status(): HotkeyResult[] {
    return this.results
  }

  /** name -> whether it is live right now. */
  liveStatus(): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    for (const r of this.results) {
      out[r.name] = r.accelerator !== null && globalShortcut.isRegistered(r.accelerator)
    }
    return out
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll()
    this.results = []
  }
}
