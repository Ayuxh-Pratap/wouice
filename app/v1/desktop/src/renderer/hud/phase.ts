import type { HudPhase } from '../../shared/ipc.js'
import type { Pose } from './sprite.js'

/**
 * What the pet is doing, as data.
 *
 * Separated from the drawing because the rules are worth stating once and
 * testing: which phases open the capsule, which keep the waveform live, which
 * hold long enough to be read. Scattering those through JSX is how a pet ends
 * up cheerful during an error.
 */

export type Tone = 'idle' | 'waking' | 'listening' | 'thinking' | 'inserted' | 'copied' | 'error' | 'paused'

export interface Look {
  tone: Tone
  /**
   * What fills the readout: the waveform, or a word.
   *
   * Waking, listening and thinking are all the waveform - flat and breathing,
   * moving, then frozen with a light travelling through it. Carrying one object
   * across the three of them is what makes a dictation read as a single act
   * rather than as three indicators taking turns.
   */
  content: 'wave' | 'word'
  /**
   * Which of the three animations to play.
   *
   * Waking, listening and thinking all share one pose on purpose. They are one
   * continuous act from the pet's side, and cutting between animations partway
   * through would pull the eye at exactly the moment somebody is trying to
   * talk.
   */
  pose: Pose
  /** The word beside the pet. Empty when the pet alone says enough. */
  label: string
  /** Is the capsule out at all? */
  open: boolean
  /** Is the microphone feeding the waveform right now? */
  live: boolean
  /** Show the frozen shape of what was just heard, dimmed. */
  frozen: boolean
  /** Something is happening that has no progress to report. */
  working: boolean
}

const LOOKS: Record<HudPhase, Look> = {
  idle: { tone: 'idle', pose: 'idle', content: 'word', label: '', open: false, live: false, frozen: false, working: false },
  // The waveform is up before a word is heard, flat and breathing, so waking
  // into listening is one continuous thing.
  arming: { tone: 'waking', pose: 'waiting', content: 'wave', label: 'Waking', open: true, live: false, frozen: false, working: true },
  listening: {
    tone: 'listening',
    pose: 'waiting',
    content: 'wave',
    label: 'Listening',
    open: true,
    live: true,
    frozen: false,
    working: false,
  },
  // The waveform stays, dimmed. It is the audio being worked on, so it belongs
  // on screen for exactly as long as the work takes.
  thinking: {
    tone: 'thinking',
    pose: 'waiting',
    content: 'wave',
    label: 'Thinking',
    open: true,
    live: false,
    frozen: true,
    working: true,
  },
  inserted: {
    tone: 'inserted',
    pose: 'waving',
    content: 'word',
    // "Done" beside a character who has just waved says everything "Inserted
    // 2182 chars" said, in a bubble a quarter the size.
    label: 'Done',
    open: true,
    live: false,
    frozen: false,
    working: false,
  },
  copied: { tone: 'copied', pose: 'waving', content: 'word', label: 'Copied', open: true, live: false, frozen: false, working: false },
  // Not a wave. An error is not something to be cheerful about.
  error: { tone: 'error', pose: 'idle', content: 'word', label: 'Error', open: true, live: false, frozen: false, working: false },
  // Not an error either: dictation is away on purpose, for a meeting's
  // write-up, and says when it is back. See 08-after-call-models.md.
  paused: { tone: 'paused', pose: 'idle', content: 'word', label: 'Paused', open: true, live: false, frozen: false, working: false },
}

export function lookOf(phase: HudPhase): Look {
  return LOOKS[phase] ?? LOOKS.idle
}

/**
 * Split the status into a headline and the reason.
 *
 * Main composes messages like "Copied · that window runs as administrator, and
 * Windows blocks input from apps that do not". The old pill gave that 7.5rem
 * and truncated it, which threw away the only sentence explaining where the
 * text went. Splitting lets the headline stay bold and short while the reason
 * gets the width and the wrapping it needs.
 */
export function splitMessage(message: string | undefined, fallback: string): {
  title: string
  detail: string | null
} {
  if (!message) return { title: fallback, detail: null }
  const at = message.indexOf(' · ')
  if (at === -1) return { title: message, detail: null }
  return { title: message.slice(0, at), detail: message.slice(at + 3) }
}

/**
 * What to actually draw, once you know whether there is a pet.
 *
 * ONE READOUT EITHER WAY. With the character, everything happens in her bubble;
 * without her, everything happens in the pill. An earlier version had the pet
 * use two different shapes in two different places depending on the phase, so a
 * dictation finished by moving the readout - and a state that preferred the
 * shape that needed a pet drew nothing at all when there was none.
 */
export type Presentation = 'none' | 'thought' | 'pill'

export function presentation(look: Look, hasPet: boolean): Presentation {
  if (!look.open) return 'none'
  return hasPet ? 'thought' : 'pill'
}

/**
 * Split an outcome's detail into the size and the reason.
 *
 * Main sends "Inserted · 2182 chars" for an ordinary dictation and
 * "Copied · that window runs as administrator, and ..." when something went
 * wrong. They are different KINDS of thing and belong in different places: the
 * size is a small figure at the end of the line, next to where the clock was a
 * moment earlier, and the reason is a sentence that needs room to wrap.
 *
 * An earlier version simply threw the size away to keep the bubble to one word.
 * That lost the one number worth reporting - how much text just landed - which
 * is exactly what somebody glances at to check the whole thing worked.
 */
export interface Outcome {
  /** "2182 chars", or null when the message carried a reason instead. */
  size: string | null
  /** Why insertion did not happen. Null on an ordinary success. */
  reason: string | null
}

export function outcomeParts(detail: string | null): Outcome {
  if (!detail) return { size: null, reason: null }
  const text = detail.trim()
  return /^[\d,]+ chars$/.test(text) ? { size: text, reason: null } : { size: null, reason: text }
}

/**
 * How long a finished phase stays on screen.
 *
 * An error earns longer than a success: "Inserted" is confirming something the
 * person can already see happen in front of them, while an error is the only
 * place the reason is ever shown.
 */
export function holdMs(phase: HudPhase): number {
  // A pause carries its reason and when dictation is back, so it earns the same time.
  return phase === 'error' || phase === 'paused' ? 4_000 : 1_400
}
