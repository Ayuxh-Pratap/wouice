import type { SidecarId } from './models.js'

/**
 * Everything the user can change. Persisted as JSON in userData so it survives
 * restarts and can be edited by hand when something goes wrong.
 */
export interface Settings {
  hotkeys: {
    dictate: string
    /** Phase 2 and 3; registered but inert for now. */
    meeting: string
    companion: string
  }
  models: Record<SidecarId, string>
  /** Silence detection, see spec 6.3. Adaptive: short window, then long. */
  silence: {
    shortWindowMs: number
    longWindowMs: number
    adaptAfterMs: number
    minSpeechMs: number
    maxSessionMs: number
    chunkAfterMs: number
  }
  cleanup: {
    enabled: boolean
    timeoutMs: number
  }
}

export const DEFAULT_SETTINGS: Settings = {
  hotkeys: {
    // W for Wouice, and the Ctrl+Alt namespace keeps the three surfaces a family.
    // NOT Space: spike V1 measured Control+Alt+Space AND Control+Shift+Space as
    // already taken here (Windows layout switcher + PowerToys). NOT Ctrl+Shift+W
    // either: that is "close window" in every browser, so a reflex press while
    // the app is down would shut all your tabs.
    dictate: 'Control+Alt+W',
    meeting: 'Control+Alt+M',
    companion: 'Control+Alt+C',
  },
  models: {
    whisper: 'large-v3',
    llama: 'qwen3-4b',
  },
  silence: {
    // One value cannot serve a one-line prompt and a five-minute spec dictation.
    shortWindowMs: 1_800,
    longWindowMs: 3_000,
    adaptAfterMs: 15_000,
    minSpeechMs: 300,
    maxSessionMs: 300_000,
    chunkAfterMs: 20_000,
  },
  cleanup: {
    enabled: true,
    // A stalled model must never cost an utterance already spoken.
    timeoutMs: 4_000,
  },
}
