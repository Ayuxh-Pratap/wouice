import type { SidecarId } from './models.js'
import {
  DEFAULT_CHARACTER,
  DEFAULT_PET_SIZE,
  DEFAULT_PLACEMENT,
  type CharacterId,
  type PetPlacement,
  type PetSize,
} from './pet.js'

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
  /**
   * Absolute floor, so a silent room cannot make the gate infinitely sensitive.
   *
   * CALIBRATED FROM A REAL RECORDING, not chosen. Measuring 60 seconds of
   * natural speech on this machine's microphone gave:
   *
   *   true silence   p5  0.00032   p25 0.00091
   *   speech         p50 0.00436   p90 0.01778
   *
   * The original 0.004 x 2.5 = 0.010 sat ABOVE the median speech frame, so 70%
   * of a continuous 60-second dictation was classified as silence, speechMs
   * never reached the 20s chunking threshold, and chunking never fired.
   *
   * 0.0015 x 2.0 = 0.003 lands in the gap between the two distributions. The
   * adaptive floor still raises it in a noisy room; this is only the minimum.
   */
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
  speechFactor: 2.0,
  minNoiseFloor: 0.0015,
}

/**
 * What a calibration run concluded, kept alongside the levels it produced.
 *
 * The levels alone cannot say whether they were measured or shipped, and that
 * distinction matters: a threshold tuned on a headset is wrong for the laptop's
 * built-in microphone. Recording the device it was measured on is what lets the
 * app notice the input has changed and say so, instead of quietly misbehaving.
 */
export interface CalibrationRecord {
  at: number
  device: string
  quality: 'good' | 'weak'
  silenceLevel: number
  speechLevel: number
  separation: number
  languages: { label: string; detected: string }[]
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
  /** Null until the user calibrates; the levels above are then shipped defaults. */
  calibration: CalibrationRecord | null
  injection: InjectionConfig
  audio: AudioConfig
  appearance: AppearanceConfig
  pet: PetConfig
  meetings: MeetingConfig
}

export interface MeetingConfig {
  /**
   * Notice when a meeting application takes the microphone, and offer to record.
   *
   * It OFFERS. Starting a recording on the app's own judgement has to be right
   * every single time on a machine that records calls, and being wrong in the
   * cheap direction costs one dismissed prompt.
   */
  autoDetect: boolean
  /**
   * The language spoken in your meetings.
   *
   * WHY THIS IS A SETTING AT ALL. Detection runs per 25-second request, and on
   * real conversation it thrashes: one recorded meeting came back as Icelandic,
   * Japanese, Spanish and English in turn. The same 25 seconds that produced
   * "What are the things that are going on?" under auto produced the sentence
   * that was actually spoken under 'hi'.
   *
   * 'auto' now detects ONCE and pins the answer for the rest of the meeting,
   * which fixes the thrashing but not a wrong first guess. Naming the language
   * is strictly better when you know it, and on Hindi it is not a small
   * difference - it is the difference between a transcript and noise.
   */
  language: 'auto' | 'hi' | 'en'
}

/**
 * The thing on the desktop.
 *
 * WHY IT IS A CHOICE. A character parked on top of everything is either a
 * companion or an obstruction depending on the screen it is on and the person
 * looking at it, and there is no answer that is right for both. Off puts the
 * overlay back to how it behaved before: invisible until you press the hotkey,
 * bottom-centre while it works, gone again afterwards.
 *
 * The hotkey is unaffected either way. Clicking the pet is an additional way
 * in, never the only one.
 */
export interface PetConfig {
  enabled: boolean
  /** Where it is parked. See `PetPlacement` - fractions, not pixels. */
  placement: PetPlacement
  /** Which character. The artwork and frame data live in the renderer. */
  character: CharacterId
  /**
   * How big to draw her.
   *
   * The sheets disagree about how much of a cell the character fills, so no one
   * size suits all of them - and how big is comfortable also depends on the
   * monitor she is sitting on.
   */
  size: PetSize
}

/**
 * How large the interface is drawn.
 *
 * A multiplier on the main window, not a theme and not a font size. It exists
 * because screen size and reading distance are not the same thing: the same
 * 1040x720 window is comfortable on a 14-inch laptop and unreadable on a
 * 32-inch monitor two feet further back, and Windows' own display scaling is
 * all-or-nothing across every application on the machine.
 */
export interface AppearanceConfig {
  /** 1 is 100%. Clamped to `ZOOM_RANGE` on the way in, from any source. */
  zoom: number
}

/**
 * The offered scales.
 *
 * Shown as whole percentages and never as a decimal: 1.25 is a number about the
 * implementation, 125% is a number about the screen.
 */
export const ZOOM_STEPS = [0.9, 1, 1.1, 1.25, 1.5, 1.75] as const

export const ZOOM_RANGE = { min: 0.8, max: 2 } as const

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, zoom))
}

export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}

/**
 * The next scale up or down, for the keyboard shortcuts.
 *
 * Steps through the offered list rather than multiplying by a constant, so a
 * press always lands on a value the settings screen can show as selected. A
 * hand-edited zoom sitting between two steps moves to the nearest one in the
 * requested direction, rather than being snapped in place - which would look
 * like the key press did nothing.
 */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const steps: readonly number[] = ZOOM_STEPS
  const last = steps[steps.length - 1]!
  if (direction === 1) return steps.find((s) => s > zoom + 1e-6) ?? last
  return [...steps].reverse().find((s) => s < zoom - 1e-6) ?? steps[0]!
}

/**
 * Which microphone to record from.
 *
 * `null` means the Windows default, and is not the same as naming whichever
 * device happens to be default today: someone who plugs in a headset expects
 * the app to follow, and someone who picked a device expects it to stay picked.
 * The label is stored alongside so the settings screen can say what was chosen
 * even when that device is currently unplugged.
 */
export interface AudioConfig {
  deviceId: string | null
  deviceLabel: string
}

/**
 * Putting the text at the cursor instead of only on the clipboard.
 *
 * `pasteOverrides` exists because the paste key is not universal. Spike V6b
 * measured Windows Terminal accepting plain Ctrl+V, so the default is right for
 * the terminal that ships with Windows - but Git Bash reads Ctrl+V as "quote the
 * next character" and PuTTY ignores it entirely, and dictating into either with
 * the wrong combination produces silence and no error at all. The built-in table
 * cannot know every emulator, so someone who has found the right combination for
 * theirs can say so here.
 */
export interface InjectionConfig {
  enabled: boolean
  /** Lowercase executable name -> combination, e.g. { 'mintty.exe': 'Ctrl+Shift+V' }. */
  pasteOverrides: Record<string, string>
}

export const DEFAULT_MEETINGS: MeetingConfig = { autoDetect: true, language: 'auto' }

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
  // Measured, not assumed. The 2x2 matrix over nine Hinglish recordings put
  // turbo + qwen3-4b fastest end to end AND best on language: p50 2230 ms with
  // 9 of 9 samples rendered into English. large-v3 costs 2.5x the recognition
  // time for 5% more transcript, and gemma3-4b returns a third of Hindi-heavy
  // samples untranslated - silently, and reproducibly on the same inputs.
  models: {
    whisper: 'turbo',
    llama: 'qwen3-4b',
  },
  silence: DEFAULT_SILENCE,
  // No timeout here any more. It was 4000 ms, a constant, and it killed any
  // dictation over about 120 words - the work scales with what was said, so the
  // allowance is computed per dictation in `cleanupBudget` instead.
  cleanup: { enabled: true },
  developerMode: true,
  retainAudio: true,
  calibration: null,
  injection: { enabled: true, pasteOverrides: {} },
  audio: { deviceId: null, deviceLabel: '' },
  appearance: { zoom: 1 },
  pet: {
    enabled: true,
    placement: DEFAULT_PLACEMENT,
    character: DEFAULT_CHARACTER,
    size: DEFAULT_PET_SIZE,
  },
  meetings: DEFAULT_MEETINGS,
}

/**
 * How long a pause has to be before the recording stops.
 *
 * Offered as three named choices rather than two millisecond fields. The
 * underlying pair is adaptive - a short window early, a longer one once you are
 * clearly mid-thought - and asking someone to set both correctly is asking them
 * to understand a mechanism they have no reason to care about.
 *
 * Derived FROM the config rather than stored beside it. A stored preset and the
 * numbers it refers to are two copies of one fact, and they drift the moment
 * anyone edits the file by hand.
 */
export type PausePreset = 'quick' | 'normal' | 'relaxed' | 'custom'

export const PAUSE_PRESETS: Record<Exclude<PausePreset, 'custom'>, Pick<SilenceConfig, 'shortWindowMs' | 'longWindowMs'>> = {
  // Cuts in fast. Good for short commands, impatient if you think mid-sentence.
  quick: { shortWindowMs: 1_200, longWindowMs: 2_000 },
  normal: { shortWindowMs: 1_800, longWindowMs: 3_000 },
  // Waits. For dictating prose where the pauses are part of the thinking.
  relaxed: { shortWindowMs: 2_600, longWindowMs: 4_200 },
}

export const PAUSE_LABELS: Record<PausePreset, string> = {
  quick: 'Quick',
  normal: 'Normal',
  relaxed: 'Relaxed',
  custom: 'Custom',
}

export function pausePresetOf(silence: SilenceConfig): PausePreset {
  for (const [name, windows] of Object.entries(PAUSE_PRESETS)) {
    if (
      silence.shortWindowMs === windows.shortWindowMs &&
      silence.longWindowMs === windows.longWindowMs
    ) {
      return name as PausePreset
    }
  }
  return 'custom'
}

/** Apply a preset, leaving every other silence field alone. */
export function applyPausePreset(silence: SilenceConfig, preset: PausePreset): SilenceConfig {
  if (preset === 'custom') return silence
  return { ...silence, ...PAUSE_PRESETS[preset] }
}
