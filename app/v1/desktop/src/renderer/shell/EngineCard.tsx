import { useEffect, useState, type CSSProperties } from 'react'
import type { EngineMode, EngineView } from '../../shared/ipc.js'
import { backAt, gib, leftLabel, useEngine } from './engine.js'
import { hashForMeeting } from './routes.js'

/**
 * The status card at the bottom of the rail: can you dictate, and if not, why
 * not and until when.
 *
 * WHY IT IS ALWAYS THERE. After a call, dictation goes away for a few minutes
 * while larger models write the meeting up (08-after-call-models.md). That is
 * only acceptable if it is never a surprise: the card says what is running,
 * how far through it is, and when dictation is back - from every page.
 *
 * ONE COLOUR FOR ONE ANSWER. Green: dictation is ready. Amber: dictation is
 * paused for a meeting's write-up, from the pause to the restore, whatever the
 * step - the step is named underneath and moves on without the card changing
 * colour. Red: dictation cannot run. Blue only while the app starts its models.
 * A first version gave every step its own colour, and a card that stayed blue
 * read as nothing happening at all.
 *
 * THE LOOK is a tile lit from below: dark at the top, the state's colour at
 * the bottom, and a border of that same colour that reads as a lit edge at
 * the top and melts into the ground at the bottom. No glow outside it; a soft
 * light drifts inside it. It lives in index.css (`.engine-card`), driven by
 * one `--tint` set here.
 */

/** The state's colour, as the RGB triplet `.engine-card` lights itself with. */
const TINT: Record<EngineMode, string> = {
  ready: '34 197 94',
  busy: '56 189 248',
  working: '245 158 11',
  problem: '239 68 68',
}

/** The step line: a lighter shade of the same colour. */
const STEP: Record<EngineMode, string> = {
  ready: 'text-emerald-200',
  busy: 'text-sky-200',
  working: 'text-amber-200',
  problem: 'text-rose-200',
}

/** Stop the write-up - on a second click, because one alone would throw away a step in progress. */
function ResumeButton(): React.JSX.Element {
  const [sure, setSure] = useState(false)
  useEffect(() => {
    if (!sure) return
    const t = setTimeout(() => setSure(false), 3_000)
    return () => clearTimeout(t)
  }, [sure])
  return (
    <button
      onClick={() => (sure ? void window.wouice.resumeDictation() : setSure(true))}
      title="Stop the meeting write-up and bring dictation back now. Steps already finished are kept."
      className="shrink-0 rounded-md bg-white/[0.08] px-2 py-0.5 text-[10.5px] font-medium text-neutral-100 ring-1 ring-white/15 transition hover:bg-white/[0.14]"
    >
      {sure ? 'Stop it?' : 'Resume now'}
    </button>
  )
}

/** How much of the GPU is taken, when nothing is running. */
function Memory({ view }: { view: EngineView }): React.JSX.Element | null {
  if (!view.vram) return null
  const share = Math.min(1, view.vram.usedMiB / view.vram.totalMiB)
  return (
    <div
      className="mt-2 flex items-center gap-2"
      title={`${view.vram.usedMiB} of ${view.vram.totalMiB} MiB of GPU memory in use${
        view.tempC !== null ? ` · ${view.tempC} °C` : ''
      }`}
    >
      <span className="text-[9px] font-medium tracking-wider text-white/50 uppercase">GPU</span>
      <div className="engine-meter flex-1">
        <span style={{ width: `${share * 100}%` }} />
      </div>
      <span className="font-mono text-[9.5px] text-white/75 tabular-nums">
        {gib(view.vram.usedMiB)}/{gib(view.vram.totalMiB)} GB
      </span>
    </div>
  )
}

export function EngineCard({ collapsed }: { collapsed: boolean }): React.JSX.Element | null {
  const view = useEngine()
  if (!view) return null
  const tint = { '--tint': TINT[view.mode] } as CSSProperties
  const moving = view.mode === 'working' || view.mode === 'busy'
  const left = view.dictationPaused ? leftLabel(view.backInSec) : null
  const at = view.dictationPaused ? backAt(view.backInSec) : null
  const tip = [
    view.title + (view.percent !== null ? ` · ${view.percent}%` : ''),
    view.step,
    view.detail,
    at ? `Dictation back at about ${at}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  // Collapsed, the card is its colour: one glowing dot, the words in its tooltip.
  if (collapsed) {
    return (
      <div title={tip} className="mx-auto mb-1 grid size-9 place-items-center" style={tint}>
        <span className={`engine-dot ${moving ? 'animate-pulse' : ''}`} />
      </div>
    )
  }

  return (
    <section aria-live="polite" className={`engine-card mx-2.5 mb-2 ${moving ? 'engine-live' : ''}`} style={tint}>
      <span aria-hidden="true" className={`engine-sheen ${moving ? '' : 'engine-sheen-slow'}`} />
      <div className="relative">
        <div className="flex items-center gap-2">
          <span className={`engine-dot ${moving ? 'animate-pulse' : ''}`} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-tight text-white/95">
            {view.title}
          </span>
          {view.percent !== null && (
            <span className="text-[14px] leading-none font-semibold text-white tabular-nums">
              {view.percent}
              <span className="text-[10px] text-white/55">%</span>
            </span>
          )}
        </div>

        {view.step && (
          <p className={`mt-1.5 truncate text-[11.5px] font-medium ${STEP[view.mode]}`}>
            {/* The meeting being written up is one click away. */}
            {view.meetingId !== null ? (
              <a href={hashForMeeting(view.meetingId)} className="hover:underline">
                {view.step}
              </a>
            ) : (
              view.step
            )}
          </p>
        )}
        <p className="mt-0.5 truncate text-[10.5px] text-white/60" title={view.detail}>
          {view.detail}
        </p>

        {view.percent !== null ? (
          <div className="engine-bar mt-2">
            <span style={{ width: `${Math.max(4, view.percent)}%` }} />
          </div>
        ) : (
          <Memory view={view} />
        )}

        {view.dictationPaused ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span
              className="min-w-0 truncate text-[10.5px] text-white/80 tabular-nums"
              title={at ? `Dictation back at about ${at}` : undefined}
            >
              {left ?? 'Working…'}
            </span>
            <ResumeButton />
          </div>
        ) : view.mode === 'problem' ? (
          <div className="mt-2 flex justify-end">
            <button
              onClick={() => void window.wouice.restartModels()}
              className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[10.5px] font-medium text-neutral-100 ring-1 ring-white/15 transition hover:bg-white/[0.14]"
            >
              Restart models
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
