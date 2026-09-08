import type { Look } from './phase.js'
import { heights, tail, type Waveform } from './waveform.js'

/**
 * The character's bubble. EVERY state she has, in one place.
 *
 * An earlier version put listening and thinking here and a separate pill beside
 * her for the outcome, so a dictation ended by swapping one shape for another
 * in a different position on screen. There is one bubble now, it stays where it
 * is, and only what is inside it changes.
 *
 * THE WAVEFORM IS THE THREAD. It appears the moment she wakes - flat, and
 * breathing, because nothing has been heard yet; it moves while she listens; it
 * freezes and a light travels through it while she thinks. One object carried
 * through the whole of a dictation rather than three unrelated indicators, and
 * then a word when it is done.
 *
 * IT MIRRORS. The corner it sits in follows the side the pet is parked on: the
 * stage only extends inward from the character, so a bubble hung off the
 * outward corner would be clipped by the edge of the window.
 *
 * IT SITS CLEAR OF HER HEAD. Hung off the top corner it landed in her hair,
 * which reads as a mistake rather than as a thought. The stage was made taller
 * to give it somewhere to go.
 */

/** Deliberately few. Enough to see movement, not enough to read as a chart. */
const BARS = 9
const BAR_H = 12

export function ThoughtBubble({
  look,
  wave,
  reason,
  side,
}: {
  look: Look
  wave: Waveform
  /** Why insertion did not happen. The only thing that widens the bubble. */
  reason: string | null
  /** Which side of the stage the pet is on. The bubble hangs the other way. */
  side: 'left' | 'right'
}): React.JSX.Element {
  const bars = heights(tail(wave, BARS), BAR_H, 2)

  return (
    <div
      className={[
        'pointer-events-none absolute top-0 z-10 flex items-center',
        // Up and out from the shoulder, into the stage rather than off it.
        side === 'right' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2',
        '-translate-y-[1.35rem]',
        look.open ? 'capsule-open' : 'capsule-shut',
        side === 'right' ? 'origin-bottom-right' : 'origin-bottom-left',
      ].join(' ')}
    >
      {/* Same surface and hairline as the panel in the main window, so the
          thought reads as part of the app rather than as a generic tooltip. */}
      <div className="lift relative flex max-w-[12rem] items-center rounded-full bg-neutral-900/95 px-2 py-1.5 ring-1 ring-white/[0.08] backdrop-blur-xl">
        {look.content === 'wave' ? (
          <div className="relative overflow-hidden" style={{ height: BAR_H }}>
            <div
              className={[
                'flex h-full items-center gap-[2px] transition-opacity duration-300',
                look.frozen ? 'opacity-45' : 'opacity-100',
                // Waking: nothing has been heard yet, so the flat line breathes
                // rather than sitting there looking like a dead microphone.
                look.tone === 'waking' ? 'wave-wake' : '',
              ].join(' ')}
            >
              {bars.map((h, i) => (
                <span
                  key={i}
                  className={`w-[2px] rounded-full ${
                    look.tone === 'listening' ? 'bg-red-400/90' : 'bg-neutral-400/80'
                  }`}
                  style={{ height: h, transition: 'height 70ms linear' }}
                />
              ))}
            </div>

            {/* The wait, travelling through the audio it is waiting on. */}
            {look.working && look.frozen && (
              <span className="wave-scan pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-amber-200/50 to-transparent" />
            )}
          </div>
        ) : (
          <div className="min-w-0">
            {/* The phase's own short label, NOT the headline main sent. Main
                says "Inserted" because the pill has room for it; beside a
                character who has just waved, "Done" says the same thing and
                keeps the bubble the size of a thought. */}
            <span className="block truncate text-[10px] leading-tight font-medium text-neutral-200">
              {look.label}
            </span>
            {/* The one sentence this overlay ever shows that somebody needs, and
                the only thing allowed to make the bubble bigger. */}
            {reason && (
              <span className="mt-0.5 line-clamp-2 block text-[9px] leading-snug text-neutral-500">
                {reason}
              </span>
            )}
          </div>
        )}

        {/*
          Two shrinking circles toward the character, which is the whole of what
          makes a rounded rectangle read as a thought rather than a label.
        */}
        <span
          className={`absolute -bottom-[5px] size-[5px] rounded-full bg-neutral-900/95 ring-1 ring-white/[0.08] ${
            side === 'right' ? 'right-3' : 'left-3'
          }`}
        />
        <span
          className={`absolute -bottom-[11px] size-[3px] rounded-full bg-neutral-900/90 ring-1 ring-white/[0.08] ${
            side === 'right' ? 'right-1.5' : 'left-1.5'
          }`}
        />
      </div>
    </div>
  )
}
