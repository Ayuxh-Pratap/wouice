import type { HudPhase } from '../../shared/ipc.js'

/**
 * What the pet is doing, as data.
 *
 * Separated from the drawing because the rules are worth stating once and
 * testing: which phases open the capsule, which keep the waveform live, which
 * hold long enough to be read. Scattering those through JSX is how a pet ends
 * up cheerful during an error.
 */

export type Tone = 'idle' | 'waking' | 'listening' | 'thinking' | 'inserted' | 'copied' | 'error'

export interface Look {
  tone: Tone
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
  idle: { tone: 'idle', label: '', open: false, live: false, frozen: false, working: false },
  arming: { tone: 'waking', label: 'Waking', open: true, live: false, frozen: false, working: true },
  listening: {
    tone: 'listening',
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
    label: 'Thinking',
    open: true,
    live: false,
    frozen: true,
    working: true,
  },
  inserted: {
    tone: 'inserted',
    label: 'Inserted',
    open: true,
    live: false,
    frozen: false,
    working: false,
  },
  copied: { tone: 'copied', label: 'Copied', open: true, live: false, frozen: false, working: false },
  error: { tone: 'error', label: 'Error', open: true, live: false, frozen: false, working: false },
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
 * How long a finished phase stays on screen.
 *
 * An error earns longer than a success: "Inserted" is confirming something the
 * person can already see happen in front of them, while an error is the only
 * place the reason is ever shown.
 */
export function holdMs(phase: HudPhase): number {
  return phase === 'error' ? 4_000 : 1_400
}
