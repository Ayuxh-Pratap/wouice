import { useCallback, useEffect, useState } from 'react'
import type { CalibrationLabel, CalibrationReport } from '../../shared/ipc.js'
import type { Settings } from '../../shared/settings.js'
import { LevelScale } from './LevelScale.js'
import { DONE_WORDS, PROMPTS, ago, languageNotes, pretty, verdictFor } from './prompts.js'
import { MAX_RECORD_MS, MIN_RECORD_MS, useRecorder, type Recording } from './recorder.js'

/**
 * Teaching Wouice your voice, as a thing a person does rather than a thing a
 * person configures.
 *
 * WHY IT EXISTS. The speech gate cannot be a constant. Shipped as one it was
 * 0.004 x 2.5, which on the machine it was written on sat above the median
 * speech frame: seventy percent of continuous speech was filed as silence and
 * chunking silently never fired. Any other microphone, gain setting or quieter
 * voice lands somewhere equally arbitrary, so the number is measured from the
 * person who is going to use it.
 *
 * WHY IT LOOKS LIKE THIS. The measurement is arithmetic; the experience must not
 * be. Nobody should be shown "separation 31.4x, threshold 0.00213" and asked to
 * decide. So the flow is three prompts, one at a time, each finished before the
 * next appears, and it ends on a plain sentence about what changed. The numbers
 * are still there - they are the whole point - behind a developer-mode
 * disclosure, where they belong.
 */

type Screen = 'intro' | 'record' | 'analysing' | 'result'

function Ring({ progress, active }: { progress: number; active: boolean }): React.JSX.Element {
  const r = 34
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 80 80" className="absolute inset-0 size-full -rotate-90">
      <circle cx={40} cy={40} r={r} fill="none" stroke="#262626" strokeWidth={3} />
      {active && (
        <circle
          cx={40}
          cy={40}
          r={r}
          fill="none"
          stroke="#e5e5e5"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(1, progress))}
          className="transition-[stroke-dashoffset] duration-200"
        />
      )}
    </svg>
  )
}

function Meter({ level }: { level: number }): React.JSX.Element {
  return (
    <div className="flex h-8 items-center justify-center gap-[3px]">
      {Array.from({ length: 32 }, (_, i) => {
        // A fixed shape modulated by level, so it reads as a voice rather than
        // a random flicker.
        const falloff = 1 - Math.abs(i - 15.5) / 15.5
        const h = 3 + level * 26 * (0.3 + falloff * 0.7)
        return (
          <span
            key={i}
            className="w-[3px] rounded-full bg-neutral-400 transition-[height] duration-75"
            style={{ height: `${h}px` }}
          />
        )
      })}
    </div>
  )
}

function Steps({ done, current }: { done: number; current: number }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2">
      {PROMPTS.map((p, i) => (
        <span key={p.label} className="flex items-center gap-2">
          <span
            className={[
              'flex size-6 items-center justify-center rounded-full text-[11px] font-medium transition',
              i < done
                ? 'bg-emerald-500/20 text-emerald-300'
                : i === current
                  ? 'bg-white/15 text-neutral-100 ring-1 ring-white/25'
                  : 'bg-neutral-800 text-neutral-600',
            ].join(' ')}
          >
            {i < done ? '✓' : i + 1}
          </span>
          {i < PROMPTS.length - 1 && (
            <span className={`h-px w-6 ${i < done ? 'bg-emerald-500/40' : 'bg-neutral-800'}`} />
          )}
        </span>
      ))}
    </div>
  )
}

function SignalBars({ bars, ok }: { bars: number; ok: boolean }): React.JSX.Element {
  return (
    <div className="flex items-end gap-1" aria-label={`signal ${bars} of 4`}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`w-2 rounded-sm transition ${
            i < bars ? (ok ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-neutral-800'
          }`}
          style={{ height: `${8 + i * 5}px` }}
        />
      ))}
    </div>
  )
}

function Intro({
  onStart,
  redo,
  changedFrom,
}: {
  onStart(): void
  redo: boolean
  changedFrom: string | null
}): React.JSX.Element {
  return (
    <div className="px-8 py-10 text-center">
      <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-white/5 text-2xl ring-1 ring-white/10">
        🎙️
      </div>
      <h2 className="text-[19px] font-semibold text-neutral-50">
        {redo ? 'Let’s tune this again' : 'Let’s tune Wouice to your voice'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-neutral-400">
        Three short sentences, about a minute. Wouice learns how your voice sounds against your
        room, so it knows the moment you start talking and the moment you stop.
      </p>

      {changedFrom && (
        <p className="mx-auto mt-4 max-w-md rounded-lg bg-amber-500/10 px-3 py-2 text-left text-[12px] leading-relaxed text-amber-200 ring-1 ring-inset ring-amber-500/20">
          Your microphone changed since last time — this was set up on{' '}
          <span className="text-amber-100">{changedFrom}</span>. Different microphones hear you at
          different levels, which is why it is worth doing again.
        </p>
      )}

      <div className="mx-auto mt-6 max-w-md space-y-2 text-left">
        {[
          ['🪑', 'Sit where you normally sit. Do not lean into the microphone.'],
          ['🔊', 'Speak at your normal volume, the way you would to a colleague.'],
          ['⏸️', 'Leave small pauses between phrases. The gaps are half the point.'],
        ].map(([icon, text]) => (
          <div key={text} className="flex items-start gap-3 rounded-lg bg-neutral-950/50 px-3 py-2">
            <span className="text-[13px]">{icon}</span>
            <span className="text-[12px] leading-relaxed text-neutral-400">{text}</span>
          </div>
        ))}
      </div>

      <button
        onClick={onStart}
        className="mt-7 rounded-lg bg-neutral-100 px-6 py-2.5 text-[13px] font-semibold text-neutral-900 transition hover:bg-white"
      >
        Start
      </button>
    </div>
  )
}

function Record({
  index,
  recorder,
  justFinished,
  onDone,
}: {
  index: number
  recorder: ReturnType<typeof useRecorder>
  justFinished: string | null
  onDone(r: Recording): void
}): React.JSX.Element {
  const prompt = PROMPTS[index]!
  const enough = recorder.elapsedMs >= MIN_RECORD_MS
  const progress = recorder.elapsedMs / MIN_RECORD_MS

  return (
    <div className="px-8 py-8">
      <Steps done={index} current={index} />

      <div className="mt-7 text-center">
        <h2 className="text-[17px] font-semibold text-neutral-50">{prompt.title}</h2>
        <p className="mx-auto mt-1.5 max-w-md text-[12px] leading-relaxed text-neutral-500">
          {prompt.ask}
        </p>
      </div>

      <blockquote className="mx-auto mt-5 max-w-lg rounded-xl bg-neutral-950/60 px-5 py-4 text-center ring-1 ring-white/5">
        <p className="text-[15px] leading-relaxed text-neutral-200">{prompt.example}</p>
        {prompt.romanised && (
          <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-500">{prompt.romanised}</p>
        )}
      </blockquote>

      <div className="mt-7 flex flex-col items-center">
        {recorder.active ? (
          <>
            <Meter level={recorder.level} />
            <button
              onClick={() => {
                const r = recorder.stop()
                if (r) onDone(r)
              }}
              disabled={!enough}
              className="relative mt-4 flex size-20 items-center justify-center rounded-full transition disabled:cursor-default"
            >
              <Ring progress={progress} active />
              <span
                className={[
                  'flex size-14 items-center justify-center rounded-full text-[12px] font-semibold transition',
                  enough
                    ? 'bg-neutral-100 text-neutral-900 hover:bg-white'
                    : 'bg-red-500/20 text-red-300',
                ].join(' ')}
              >
                {enough ? 'Done' : <span className="size-3 animate-pulse rounded-full bg-red-500" />}
              </span>
            </button>
            <p className="mt-3 h-4 text-[11px] text-neutral-500">
              {enough ? 'Press when you have finished the sentence' : 'Listening…'}
            </p>
          </>
        ) : justFinished ? (
          <div className="flex h-[8.25rem] flex-col items-center justify-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-emerald-500/15 text-2xl text-emerald-300">
              ✓
            </span>
            <p className="mt-3 text-[13px] font-medium text-emerald-300">{justFinished}</p>
          </div>
        ) : (
          <>
            <div className="h-8" />
            <button
              onClick={() => void recorder.start()}
              className="relative mt-4 flex size-20 items-center justify-center rounded-full"
            >
              <Ring progress={0} active={false} />
              <span className="flex size-14 items-center justify-center rounded-full bg-red-500 text-neutral-50 transition hover:bg-red-400">
                <span className="size-4 rounded-full bg-white/90" />
              </span>
            </button>
            <p className="mt-3 h-4 text-[11px] text-neutral-500">Press to start recording</p>
          </>
        )}
      </div>

      {recorder.error && (
        <p className="mx-auto mt-4 max-w-md rounded-lg bg-red-500/10 px-3 py-2 text-center text-[12px] text-red-300 ring-1 ring-inset ring-red-500/20">
          {recorder.error}
        </p>
      )}
    </div>
  )
}

function Analysing(): React.JSX.Element {
  return (
    <div className="flex min-h-[22rem] flex-col items-center justify-center px-8 py-10 text-center">
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-2 animate-bounce rounded-full bg-neutral-500"
            style={{ animationDelay: `${i * 140}ms` }}
          />
        ))}
      </div>
      <h2 className="mt-5 text-[15px] font-medium text-neutral-200">
        Listening back to what you said
      </h2>
      <p className="mt-1.5 max-w-sm text-[12px] leading-relaxed text-neutral-500">
        Working out where your voice sits against your room, and checking how well each sentence
        was understood.
      </p>
    </div>
  )
}

function Result({
  report,
  developerMode,
  onFinish,
  onRetry,
  saving,
}: {
  report: CalibrationReport
  developerMode: boolean
  onFinish(): void
  onRetry(): void
  saving: boolean
}): React.JSX.Element {
  const [showDetail, setShowDetail] = useState(false)
  const v = verdictFor(report.quality, report.observed.separation)
  const notes = languageNotes(report.transcripts)
  const heard = report.transcripts.filter((t) => t.text)

  return (
    <div className="px-8 py-8">
      <div className="text-center">
        <div
          className={[
            'mx-auto flex size-14 items-center justify-center rounded-2xl text-2xl',
            v.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300',
          ].join(' ')}
        >
          {v.ok ? '✓' : '!'}
        </div>
        <h2 className="mt-4 text-[19px] font-semibold text-neutral-50">
          {v.ok ? 'You’re calibrated' : 'Not quite there'}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-neutral-400">
          {v.headline}
        </p>
      </div>

      <div className="mx-auto mt-5 flex max-w-md items-center gap-3 rounded-xl bg-neutral-950/50 px-4 py-3">
        <SignalBars bars={v.bars} ok={v.ok} />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-neutral-200">{v.grade}</p>
          <p className="text-[11px] text-neutral-500">
            How well your voice separates from your room
          </p>
        </div>
      </div>

      {v.advice && (
        <p className="mx-auto mt-2.5 max-w-md rounded-xl bg-neutral-950/50 px-4 py-3 text-[12px] leading-relaxed text-neutral-400">
          {v.advice}
        </p>
      )}

      {v.ok && (
        <p className="mx-auto mt-2.5 max-w-md rounded-xl bg-emerald-500/5 px-4 py-3 text-[12px] leading-relaxed text-emerald-200/80 ring-1 ring-inset ring-emerald-500/15">
          Wouice will now stop listening as soon as you stop talking, and can split long dictations
          at your natural pauses.
        </p>
      )}

      {heard.length > 0 && (
        <div className="mx-auto mt-5 max-w-md">
          <p className="mb-2 text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
            What it heard
          </p>
          <div className="space-y-2">
            {heard.map((t) => (
              <div key={t.label} className="rounded-xl bg-neutral-950/50 px-4 py-3">
                <p className="text-[12px] leading-relaxed break-words text-neutral-300">{t.text}</p>
                <p className="mt-1 text-[10px] text-neutral-600">
                  {LABEL_NAME[t.label]} · understood as {pretty(t.language)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {notes.map((n) => (
        <p
          key={n}
          className="mx-auto mt-2.5 max-w-md rounded-xl bg-neutral-950/50 px-4 py-3 text-[12px] leading-relaxed text-neutral-400"
        >
          {n}
        </p>
      ))}

      <div className="mt-7 flex items-center justify-center gap-2">
        {v.ok ? (
          <>
            <button
              onClick={onFinish}
              disabled={saving}
              className="rounded-lg bg-neutral-100 px-6 py-2.5 text-[13px] font-semibold text-neutral-900 transition hover:bg-white disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Finish'}
            </button>
            <button
              onClick={onRetry}
              className="rounded-lg px-4 py-2.5 text-[13px] text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-200"
            >
              Record again
            </button>
          </>
        ) : (
          <button
            onClick={onRetry}
            className="rounded-lg bg-neutral-100 px-6 py-2.5 text-[13px] font-semibold text-neutral-900 transition hover:bg-white"
          >
            Try again
          </button>
        )}
      </div>

      {/*
        The arithmetic, for the person maintaining this. Everything above is
        deliberately free of it; a threshold in the wrong place is still a
        number, and diagnosing one needs the number.
      */}
      {developerMode && (
        <div className="mx-auto mt-6 max-w-md border-t border-white/5 pt-4">
          <button
            onClick={() => setShowDetail((s) => !s)}
            className="text-[11px] text-neutral-600 hover:text-neutral-400"
          >
            {showDetail ? 'Hide' : 'Show'} technical detail
          </button>
          {showDetail && (
            <div className="mt-3 rounded-xl bg-neutral-950/50 p-3">
              <LevelScale
                silenceLevel={report.observed.silenceLevel}
                speechLevel={report.observed.speechLevel}
                threshold={report.threshold}
                previousThreshold={report.previousThreshold}
              />
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-neutral-600">
                separation {report.observed.separation.toFixed(1)}x · frames{' '}
                {report.observed.frames} · speech {Math.round(report.observed.speechRatio * 100)}% ·
                floor {report.minNoiseFloor.toFixed(5)} · factor {report.speechFactor} · device{' '}
                {report.device || 'unnamed'}
              </p>
              <p className="mt-1 text-[10px] text-neutral-600">{report.reason}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const LABEL_NAME: Record<CalibrationLabel, string> = {
  english: 'English',
  hindi: 'Hindi',
  mixed: 'Mixed',
}

export function Calibration({ settings }: { settings: Settings | null }): React.JSX.Element {
  const [screen, setScreen] = useState<Screen | null>(null)
  const [index, setIndex] = useState(0)
  const [takes, setTakes] = useState<Partial<Record<CalibrationLabel, Recording>>>({})
  const [report, setReport] = useState<CalibrationReport | null>(null)
  const [justFinished, setJustFinished] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [currentDevice, setCurrentDevice] = useState('')
  const recorder = useRecorder()
  const saved = settings?.calibration ?? null

  const close = useCallback((): void => {
    if (recorder.active) recorder.stop()
    setScreen(null)
  }, [recorder])

  const open = (): void => {
    setTakes({})
    setReport(null)
    setIndex(0)
    setJustFinished(null)
    setScreen('intro')
  }

  // The page behind must not scroll while the dialog is up: that was the second
  // scrollbar. Restored on close, including when the component unmounts first.
  useEffect(() => {
    if (!screen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [screen])

  // Escape closes, as it does in every other dialog on the machine.
  useEffect(() => {
    if (!screen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen, close])

  // Labels only exist once microphone permission has been granted, so before
  // that this stays empty and the "device changed" note simply does not appear.
  // No warning beats a wrong one.
  useEffect(() => {
    void navigator.mediaDevices
      .enumerateDevices()
      .then((d) => setCurrentDevice(d.find((x) => x.kind === 'audioinput')?.label ?? ''))
      .catch(() => setCurrentDevice(''))
  }, [screen])

  const analyse = useCallback(
    async (all: Partial<Record<CalibrationLabel, Recording>>): Promise<void> => {
      setScreen('analysing')
      const inputs = PROMPTS.filter((p) => all[p.label]).map((p) => ({
        label: p.label,
        pcm: all[p.label]!.pcm,
        durationMs: all[p.label]!.durationMs,
      }))
      try {
        setReport(await window.wouice.calibrate(inputs, recorder.device || currentDevice))
        setScreen('result')
      } catch {
        // A failure here is almost always the recogniser still loading. Send
        // them back to the recording screen rather than to a dead end.
        setScreen('record')
      }
    },
    [recorder.device, currentDevice]
  )

  const finishTake = (r: Recording): void => {
    const label = PROMPTS[index]!.label
    const all = { ...takes, [label]: r }
    setTakes(all)
    setJustFinished(DONE_WORDS[index] ?? 'Got it.')
    // A beat on the tick before moving on: without it, three recordings feel
    // like one button pressed three times.
    setTimeout(() => {
      setJustFinished(null)
      if (index + 1 < PROMPTS.length) setIndex(index + 1)
      else void analyse(all)
    }, 900)
  }

  // Hard cap, so a forgotten recording cannot grow without bound.
  const { active, elapsedMs, stop } = recorder
  useEffect(() => {
    if (!active || elapsedMs < MAX_RECORD_MS) return
    const r = stop()
    if (r) finishTake(r)
    // finishTake is rebuilt every render, but the guard above means this only
    // runs on the single tick that crosses the cap, so it cannot loop.
  }, [active, elapsedMs, stop])

  const deviceChanged =
    saved !== null && currentDevice !== '' && saved.device !== '' && saved.device !== currentDevice

  return (
    <>
      {/*
        Compact once it is done. Calibration is a setup step, not a feature: it
        earns the whole width of the page exactly once, and after that it is a
        status light. Leaving the full card up would mean permanently spending
        the top of the dashboard on something already finished.
      */}
      {!saved ? (
        <button
          onClick={open}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-neutral-100 px-3.5 py-2 text-[12px] font-semibold text-neutral-900 transition hover:bg-white"
        >
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-neutral-900/40" />
            <span className="relative inline-flex size-2 rounded-full bg-neutral-900" />
          </span>
          Tune your voice
        </button>
      ) : deviceChanged ? (
        <button
          onClick={open}
          title={`Set up on ${saved.device}, but your input is now ${currentDevice}.`}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-1.5 text-[11px] font-medium text-amber-200 ring-1 ring-inset ring-amber-500/25 transition hover:bg-amber-500/15"
        >
          <span className="size-1.5 rounded-full bg-amber-400" />
          Microphone changed
        </button>
      ) : (
        <button
          onClick={open}
          title={`Calibrated ${ago(saved.at)}${saved.device ? ` on ${saved.device}` : ''}. Click to do it again.`}
          className="group flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
        >
          <span className="size-1.5 rounded-full bg-emerald-400" />
          Calibrated
          <span className="text-neutral-600 group-hover:text-neutral-500">{ago(saved.at)}</span>
        </button>
      )}

      {screen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/85 p-6 backdrop-blur-sm"
          onClick={(e) => {
            // Only a click on the backdrop itself, never one that started inside.
            if (e.target === e.currentTarget && screen !== 'analysing') close()
          }}
        >
          {/*
            The dialog owns its own scrolling. Letting the backdrop scroll gave
            two scrollbars - the page behind kept its own - and the close button
            scrolled away with the content.
          */}
          <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-neutral-900 shadow-2xl shadow-black/60 ring-1 ring-white/10">
            <div className="flex shrink-0 justify-end px-3 pt-3">
              <button
                onClick={close}
                disabled={screen === 'analysing'}
                className="rounded-md px-2 py-0.5 text-[16px] leading-none text-neutral-600 hover:text-neutral-300 disabled:opacity-30"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {screen === 'intro' && (
                <Intro
                  redo={saved !== null}
                  changedFrom={deviceChanged ? (saved?.device ?? null) : null}
                  onStart={() => setScreen('record')}
                />
              )}
              {screen === 'record' && (
                <Record
                  index={index}
                  recorder={recorder}
                  justFinished={justFinished}
                  onDone={finishTake}
                />
              )}
              {screen === 'analysing' && <Analysing />}
              {screen === 'result' && report && (
                <Result
                  report={report}
                  developerMode={settings?.developerMode ?? false}
                  saving={saving}
                  onRetry={open}
                  onFinish={() => {
                    setSaving(true)
                    void window.wouice
                      .calibrateApply(report)
                      .then(() => setScreen(null))
                      .finally(() => setSaving(false))
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
