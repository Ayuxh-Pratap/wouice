import type { Look } from './phase.js'
import { BARS, heights, type Waveform } from './waveform.js'

/**
 * What the pet opens while it is working.
 *
 * IT IS AS WIDE AS WHAT IT HAS TO SAY. The old pill gave every phase the same
 * 340x76 rectangle, so "Starting" and a two-line explanation of why a paste was
 * refused got identical room - one mostly empty, the other truncated at fifteen
 * characters. This sizes itself, and the window around it never changes, so
 * there is nothing to jump.
 *
 * THE WAVEFORM STAYS THROUGH THINKING. Dimmed, frozen, but there: it is the
 * audio currently being transcribed, and showing it is the difference between
 * a wait that looks like work and a wait that looks like a hang.
 */

const TONE_TEXT: Record<Look['tone'], string> = {
  idle: 'text-neutral-400',
  waking: 'text-amber-200',
  listening: 'text-neutral-100',
  thinking: 'text-amber-200',
  inserted: 'text-emerald-200',
  copied: 'text-sky-200',
  error: 'text-red-300',
}

const WAVE_H = 30

export function Capsule({
  look,
  wave,
  title,
  detail,
  seconds,
  side,
}: {
  look: Look
  wave: Waveform
  title: string
  detail: string | null
  /** Elapsed time, already formatted. Null when there is nothing to count. */
  seconds: string | null
  side: 'left' | 'right'
}): React.JSX.Element {
  const bars = heights(wave, WAVE_H)
  const showWave = look.live || look.frozen

  return (
    <div
      className={[
        'pointer-events-none flex min-w-0 items-center gap-3 rounded-2xl px-4 py-2.5',
        'bg-neutral-900/90 ring-1 shadow-2xl ring-white/10 shadow-black/50 backdrop-blur-xl',
        // The capsule enters from the pet's side, so it reads as coming out of
        // the character rather than appearing beside it.
        side === 'left' ? 'origin-left' : 'origin-right',
        look.open ? 'capsule-open' : 'capsule-shut',
      ].join(' ')}
    >
      {showWave && (
        <div
          className={[
            'flex shrink-0 items-center gap-[2px] transition-opacity duration-300',
            look.frozen ? 'opacity-40' : 'opacity-100',
          ].join(' ')}
          style={{ height: WAVE_H }}
        >
          {bars.map((h, i) => (
            <span
              key={i}
              className={[
                'w-[2px] rounded-full',
                look.tone === 'listening' ? 'bg-red-400/80' : 'bg-neutral-300/70',
              ].join(' ')}
              style={{
                height: h,
                // Older bars fade out, so the eye lands on now rather than
                // reading the strip as one solid block.
                opacity: 0.35 + (i / BARS) * 0.65,
                transition: 'height 70ms linear',
              }}
            />
          ))}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className={`text-[12px] leading-tight font-medium ${TONE_TEXT[look.tone]}`}>
          {title}
        </div>
        {/* Wraps to two lines rather than truncating. The reason a paste was
            refused is the most useful sentence this overlay ever shows. */}
        {detail && (
          <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-neutral-500">
            {detail}
          </div>
        )}
      </div>

      {seconds && (
        <span className="shrink-0 font-mono text-[10px] text-neutral-500 tabular-nums">
          {seconds}
        </span>
      )}

      {/*
        An honest indeterminate track. There is no progress to report - the
        cleanup budget scales with what was said and finishing early is normal -
        so this says "still going" and claims nothing about how far along it is.
      */}
      {look.working && (
        <span className="pointer-events-none absolute inset-x-4 bottom-1 h-px overflow-hidden rounded-full bg-white/5">
          <span className="capsule-sweep block h-full w-1/3 rounded-full bg-amber-300/60" />
        </span>
      )}
    </div>
  )
}
