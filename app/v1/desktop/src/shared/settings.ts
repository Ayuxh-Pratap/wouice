import type { SidecarId } from './models.js'

/**
 * Silence detection and chunking parameters.
 *
 * Defined HERE, in shared, and imported by the policy rather than duplicated.
 * The first version declared a partial shape in settings and a fuller one in
 * the policy, bridged by an `as never` cast. At runtime `speechFactor` was then
 * undefined, the speech threshold became NaN, nothing was ever classified as
 * speech, and both auto-stop and chunking silently never fired. One type, one
 * place, no cast.
 */
export interface SilenceConfig {
  /** Silence needed to stop, while total speech is under `adaptAfterMs`. */
  shortWindowMs: number
  /** Silence needed to stop after that. */
  longWindowMs: number
  /** Still talking at this point means long-form, which has thinking pauses. */
  adaptAfterMs: number
  /** Ignore a cough: below this much speech, a pause does not end anything. */
  minSpeechMs: number
  /** Hard cap. Purely a "did I forget this was recording" guard. */
  maxSessionMs: number
  /** Flush a chunk at the first pause after this much speech accumulates. */
  chunkAfterMs: number
  /** A pause this long is a safe place to cut a chunk. Shorter than a stop. */
  chunkPauseMs: number
  /** Frames above (noiseFloor * this) count as speech. */
  speechFactor: number
  /** Absolute floor, so a silent room cannot make the gate infinitely sensitive. */
  minNoiseFloor: number
}

export const DEFAULT_SILENCE: SilenceConfig = {
  shortWindowMs: 1_800,
  longWindowMs: 3_000,
  adaptAfterMs: 15_000,
  minSpeechMs: 300,
  maxSessionMs: 300_000,
  chunkAfterMs: 20_000,
  chunkPauseMs: 600,
  speechFactor: 2.5,
  minNoiseFloor: 0.004,
}

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
  silence: SilenceConfig
  cleanup: {
    enabled: boolean
    timeoutMs: number
  }
  /**
   * Developer mode. ON by default, deliberately: this is a personal tool whose
   * whole value right now is being able to see why a transcription came out
   * wrong. It costs one collapsed panel of screen space.
   */
  developerMode: boolean
  /**
   * Keep the audio of the last ~20 dictations, so a bad transcription can be
   * reproduced rather than reasoned about. Bounded and pruned oldest-first,
   * because this is your voice accumulating on your own disk.
   */
  retainAudio: boolean
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
  silence: DEFAULT_SILENCE,
  cleanup: {
    enabled: true,
    // A stalled model must never cost an utterance already spoken.
    timeoutMs: 4_000,
  },
  developerMode: true,
  retainAudio: true,
}
