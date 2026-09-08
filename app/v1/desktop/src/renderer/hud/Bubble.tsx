import type { Look } from './phase.js'
import { heights, tail, type Waveform } from './waveform.js'

/**
 * The whole overlay, when the character is switched off.
 *
 * IT IS THE APP'S OWN SURFACE. Same `neutral-900` panel, same
 * `ring-white/[0.08]` hairline, same `lift-panel` shadow as the content panel
 * in the main window - so the thing that appears over your editor is
 * recognisably a piece of Wouice rather than a generic toast. The one addition
 * is a blur behind it, because unlike the panel this floats over whatever you
 * were looking at.
 *
 * ONLY THE PET-OFF CASE USES THIS. With her on screen everything happens in her
 * thought bubble, including the outcome; a second shape beside her, in a
 * different place, meant a dictation ended by moving the readout.
 *
 * THE WAVEFORM IS THE THREAD, exactly as it is in her bubble. It is up from the
 * moment of waking - flat and breathing, because nothing has been heard yet -
 * then it moves, then it freezes with a light travelling through it. There used
 * to be a hairline sweeping along the bottom edge for waking and thinking,
 * which was a second moving thing, a strip of chrome that existed for two
 * states, and a different idea from the waveform sitting beside it.
 *
 * NOTHING IN IT MOVES SIDEWAYS. Every slot is either fixed or the single one
 * that flexes, so a part appearing cannot shove the parts next to it. The clock
 * arrives about a second into thinking, and while it shared its space with the
 * waveform the whole trace jumped left at that moment.
 *
 * IT IS ALWAYS ONE LINE. A refusal used to wrap underneath and make the box
 * taller - the most visible movement of the lot, for the rarest event. The
 * reason is appended and truncated instead, with the full text on the element's
 * tooltip; the dictations table keeps all of it, which is where anybody
 * actually investigating a refusal will be.
 */

/**
 * The state dot's colour, as a VALUE rather than a utility class.
 *
 * It was a lookup of Tailwind class names, and the class on the element changed
 * correctly while the painted colour did not - it stayed on whichever tone had
 * been set first, so a finished dictation showed a red dot and a listening one
 * showed green. A freshly created element with the same class painted
 * correctly, so the class was arriving and something about swapping it on this
 * element was not taking.
 *
 * Rather than keep hunting it, the colour is set directly. This is data-driven
 * colour with seven possible values, which is what an inline style is for; the
 * Pet's aura next door already works this way for the same reason.
 */
const DOT: Record<Look['tone'], string> = {
  idle: '#525252',
  waking: '#fbbf24',
  listening: '#ef4444',
  thinking: '#fbbf24',
  inserted: '#34d399',
  copied: '#38bdf8',
  error: '#ef4444',
}

const TITLE: Record<Look['tone'], string> = {
  idle: 'text-neutral-400',
  waking: 'text-neutral-300',
  listening: 'text-neutral-100',
  thinking: 'text-neutral-200',
  inserted: 'text-emerald-200',
  copied: 'text-sky-200',
  error: 'text-red-300',
}

/** Few, because the pill is narrow. Enough to see a pause in. */
const WAVE_BARS = 12
const WAVE_H = 16

/**
 * The right-hand slot, always present at a fixed width.
 *
 * It carries the clock while something is happening and the size once it has
 * finished, so the pill has weight at both ends and reads as one continuous
 * thing. Hanging the size off the end of the title instead left the whole right
 * half of the box empty on the one state that has no clock, which looked like
 * the pill had been cut short.
 *
 * Wide enough for "1234 chars", which is longer than any clock it will show.
 */
const META_W = '3.5rem'

/**
 * The clock's own slot, beside the word rather than at the far end.
 *
 * Fixed, so a running number that gains or loses a digit does not nudge the
 * waveform, and so the gap between the state and the count is the same in every
 * one of them.
 */
const CLOCK_W = '2.2rem'

export function Bubble({
  look,
  wave,
  title,
  size,
  reason,
  seconds,
  side,
}: {
  look: Look
  wave: Waveform
  title: string
  /** "22 chars" on a finished dictation. */
  size: string | null
  /** Why insertion did not happen. Appended to the title, never a second line. */
  reason: string | null
  seconds: string | null
  side: 'left' | 'right'
}): React.JSX.Element {
  const showWave = look.content === 'wave'
  const bars = heights(tail(wave, WAVE_BARS), WAVE_H, 2)
  // The reason goes on the title because it is a sentence; the size goes in the
  // slot on the right because it is a figure. They are never both present.
  const line = reason ? `${title} · ${reason}` : title
  const meta = seconds ?? size

  return (
    <div
      className={[
        'lift-panel pointer-events-none flex min-w-0 items-center gap-1.5',
        'rounded-xl bg-neutral-900/95 ring-1 ring-white/[0.08] backdrop-blur-xl',
        // Narrow on purpose. Everything in it is short, and it floats over
        // whatever somebody is working in. The HEIGHT is fixed rather than
        // grown from the contents: a waveform is taller than a line of text,
        // so sizing to content made the box shrink six pixels the moment a
        // dictation finished.
        'h-7 w-[11.75rem] px-2',
        side === 'left' ? 'origin-left' : 'origin-right',
        look.open ? 'capsule-open' : 'capsule-shut',
      ].join(' ')}
    >
      <span
        className={[
          'size-1.5 shrink-0 rounded-full',
          look.tone === 'listening' ? 'animate-pulse' : '',
        ].join(' ')}
        style={{ backgroundColor: DOT[look.tone] }}
      />

      {showWave ? (
        <>
          <span className={`shrink-0 text-[10px] leading-none font-medium ${TITLE[look.tone]}`}>
            {title}
          </span>

          {/* Beside the word, not across the box. The clock belongs to the
              state it is counting, and the waveform is the other end. */}
          <span
            className="shrink-0 text-left font-mono text-[9px] leading-none text-neutral-500 tabular-nums"
            style={{ width: CLOCK_W }}
          >
            {meta ?? ''}
          </span>

          <div
            className="relative ml-auto shrink-0 overflow-hidden"
            style={{ height: WAVE_H }}
          >
            <div
              className={[
                'flex h-full items-center justify-end gap-[2px] transition-opacity duration-300',
                look.frozen ? 'opacity-45' : 'opacity-100',
                // Waking: nothing heard yet, so the flat line breathes rather
                // than sitting there looking like a microphone that is off.
                look.tone === 'waking' ? 'wave-wake' : '',
              ].join(' ')}
            >
              {bars.map((h, i) => (
                <span
                  key={i}
                  className={`w-[2px] shrink-0 rounded-full ${
                    look.tone === 'listening' ? 'bg-red-400/85' : 'bg-neutral-400/80'
                  }`}
                  style={{ height: h, transition: 'height 70ms linear' }}
                />
              ))}
            </div>

            {/* The wait, travelling through the audio it is waiting on. Honest
                about knowing nothing: the cleanup budget scales with what was
                said, and finishing early is normal. */}
            {look.working && look.frozen && (
              <span className="wave-scan pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-amber-200/50 to-transparent" />
            )}
          </div>
        </>
      ) : (
        <>
          <span
            title={line}
            className={`min-w-0 flex-1 truncate text-[10px] leading-none font-medium ${TITLE[look.tone]}`}
          >
            {line}
          </span>

          {/* The size keeps the right-hand end, where the waveform was a moment
              ago, so the pill still has weight at both ends when it finishes. */}
          <span
            className="shrink-0 text-right font-mono text-[9px] leading-none text-neutral-500 tabular-nums"
            style={{ width: META_W }}
          >
            {meta ?? ''}
          </span>
        </>
      )}

    </div>
  )
}
