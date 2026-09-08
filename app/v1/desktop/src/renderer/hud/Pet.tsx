import { PET_SIZE } from '../../shared/pet.js'
import type { Tone } from './phase.js'

/**
 * The character.
 *
 * IT IS THE APP'S OWN MARK, not a mascot. The five-bar waveform glyph is
 * already the icon in the title bar and the rail, and making it the face means
 * one identity across the tray, the window and the desktop - and no question
 * about whose artwork it is when this ships to anyone else.
 *
 * STATE IS IN THE COLOUR AND THE POSTURE, NOT THE CHARM. A character read out
 * of the corner of the eye is worse at conveying state than a coloured dot, so
 * the bars carry it: still and dim when asleep, breathing when waking, moving
 * with the voice when listening, sweeping while thinking. Red still means
 * recording and nothing else in the app is red.
 *
 * ANIMATION IS COMPOSITOR-ONLY. This window sits on top of everything for the
 * whole session, and the machine it runs on is holding two model sidecars in
 * 6 GB of VRAM. Transform and opacity are the only properties animated here, so
 * the work stays off the main thread and off the GPU's memory.
 */

const RING: Record<Tone, string> = {
  idle: 'ring-white/10',
  waking: 'ring-amber-400/40',
  listening: 'ring-red-500/50',
  thinking: 'ring-amber-400/40',
  inserted: 'ring-emerald-400/50',
  copied: 'ring-sky-400/50',
  error: 'ring-red-600/60',
}

const GLOW: Record<Tone, string> = {
  idle: 'shadow-black/50',
  waking: 'shadow-amber-500/20',
  listening: 'shadow-red-600/25',
  thinking: 'shadow-amber-500/20',
  inserted: 'shadow-emerald-500/25',
  copied: 'shadow-sky-500/25',
  error: 'shadow-red-700/30',
}

const BAR: Record<Tone, string> = {
  idle: 'bg-neutral-500',
  waking: 'bg-amber-300',
  listening: 'bg-red-400',
  thinking: 'bg-amber-300',
  inserted: 'bg-emerald-300',
  copied: 'bg-sky-300',
  error: 'bg-red-400',
}

/** Resting heights, as a fraction of the tallest bar. The glyph's own shape. */
const SHAPE = [0.34, 0.62, 1, 0.62, 0.34]

export function Pet({
  tone,
  level,
  hovered,
  dragging,
}: {
  tone: Tone
  /** 0..1, live only while listening. */
  level: number
  hovered: boolean
  dragging: boolean
}): React.JSX.Element {
  const listening = tone === 'listening'

  return (
    <div
      className="relative shrink-0 select-none"
      style={{ width: PET_SIZE, height: PET_SIZE }}
      aria-hidden="true"
    >
      <div
        className={[
          'absolute inset-1.5 grid place-items-center rounded-[22px]',
          'bg-neutral-900/85 backdrop-blur-xl',
          'ring-1 shadow-xl transition-all duration-300',
          RING[tone],
          GLOW[tone],
          // Grows a little under the cursor and presses in while being moved,
          // so a click has some acknowledgement of its own on a window that
          // cannot show a cursor change.
          dragging ? 'scale-95' : hovered ? 'scale-[1.06]' : 'scale-100',
          tone === 'idle' && !hovered ? 'opacity-75' : 'opacity-100',
        ].join(' ')}
      >
        <div className="flex h-8 items-center gap-[3px]">
          {SHAPE.map((base, i) => {
            // While listening the middle bars answer to the voice more than the
            // outer ones, which reads as a voice rather than a level meter.
            const reach = listening ? 0.45 + base * 0.55 : 0
            const scale = base + level * reach * 0.9
            return (
              <span
                key={i}
                className={[
                  'w-[3px] origin-center rounded-full transition-transform duration-75',
                  BAR[tone],
                  tone === 'waking' || tone === 'thinking' ? 'pet-breathe' : '',
                ].join(' ')}
                style={{
                  height: 26,
                  transform: `scaleY(${Math.min(1.5, Math.max(0.12, scale))})`,
                  animationDelay: `${i * 90}ms`,
                }}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
