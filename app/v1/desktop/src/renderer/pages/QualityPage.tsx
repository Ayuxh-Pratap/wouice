import { useCallback, useEffect, useState } from 'react'
import type { RatingSheet } from '../../shared/ipc.js'

/**
 * TEMPORARY. DELETE THIS SCREEN WHEN A4 IS MET.
 *
 * This is quality-assurance scaffolding, not a feature. It exists to close one
 * acceptance criterion and has no place in the product afterwards - not hidden
 * behind developer mode, not kept "in case": gone. What goes with it is the
 * route and its `RouteId`, the `quality` icon, the three IPC channels and their
 * handlers, the `RatingSheet` type, `Ratings` and its tests,
 * `Dictations.nextUnrated`, and the preview stub.
 *
 * Migration 5 stays. Migrations are append-only - a machine that has run one
 * will not run it again - so the `ratings` table remains and simply stops
 * being read.
 *
 * Acceptance criterion A4, made answerable.
 *
 * WHY A SCREEN AND NOT A SCRIPT. A4 asks for twenty Hinglish samples with at
 * least seventeen rated "would ship this text as-is". Every other criterion in
 * the spec can be measured by a machine; this one asks whether the output was
 * good enough for the person who said it, and there is no benchmark for that.
 * Until there was somewhere to record the answer, A4 was not merely unmet - it
 * was unmeasurable, and Phase 1 could not honestly be called done or not done.
 *
 * ONE AT A TIME, OLDEST FIRST. A grid of twenty rows with checkboxes invites
 * skimming, and skimming is exactly what makes the resulting number worthless.
 * One dictation, one question, one keystroke. Oldest first so the queue does
 * not reshuffle under you every time you dictate something mid-sitting.
 *
 * THE RAW TEXT IS SHOWN TOO. A "no" without knowing whether Whisper misheard
 * you or the cleanup mangled it is a number with no next action attached. The
 * two stages sit side by side so the verdict comes with a diagnosis.
 */

function Bar({ value, target, tone }: { value: number; target: number; tone: string }): React.JSX.Element {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${tone}`}
        style={{ width: `${Math.min(100, (value / Math.max(1, target)) * 100)}%` }}
      />
    </div>
  )
}

function Scoreboard({ sheet }: { sheet: RatingSheet }): React.JSX.Element {
  const p = sheet.progress
  const shortfall = Math.max(0, p.sampleTarget - p.rated)

  return (
    <section className="lift rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-neutral-100">A4 · would you ship it</h3>
          <p className="mt-0.5 text-[11px] text-neutral-500">
            {p.shipTarget} of {p.sampleTarget} rated “would ship this text as-is”.
          </p>
        </div>
        <span
          className={[
            'rounded-full px-2.5 py-1 text-[11px] font-medium ring-1',
            p.met
              ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30'
              : 'bg-white/[0.04] text-neutral-400 ring-white/10',
          ].join(' ')}
        >
          {p.met ? 'Met' : shortfall > 0 ? `${shortfall} more to rate` : 'Not met'}
        </span>
      </div>

      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="flex items-baseline justify-between text-[11px]">
            <dt className="text-neutral-400">Rated</dt>
            <dd className="font-mono text-neutral-300 tabular-nums">
              {p.rated} / {p.sampleTarget}
            </dd>
          </div>
          <div className="mt-1.5">
            <Bar value={p.rated} target={p.sampleTarget} tone="bg-neutral-400" />
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between text-[11px]">
            <dt className="text-neutral-400">Would ship</dt>
            <dd className="font-mono text-neutral-300 tabular-nums">
              {p.shipped} / {p.shipTarget}
            </dd>
          </div>
          <div className="mt-1.5">
            <Bar
              value={p.shipped}
              target={p.shipTarget}
              tone={p.shipped >= p.shipTarget ? 'bg-emerald-400' : 'bg-amber-400'}
            />
          </div>
        </div>
      </dl>

      {/* A4 is about Hinglish, which is the hard case and the reason the bar was
          set at seventeen rather than twenty. Broken out so a pass built
          entirely on English dictations is visible as one. */}
      <p className="mt-3 border-t border-white/5 pt-2.5 text-[11px] text-neutral-500">
        Of those, {p.hinglishRated} were not English —{' '}
        <span className="text-neutral-300">{p.hinglishShipped} would ship</span>. A4 asks about
        Hinglish specifically, so a pass made up of English dictations is not the thing it
        wanted.
      </p>
    </section>
  )
}

function Stage({ label, text, muted }: { label: string; text: string; muted?: boolean }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[10px] tracking-wide text-neutral-600 uppercase">{label}</div>
      <p
        className={[
          'rounded-lg px-3 py-2.5 text-[13px] leading-relaxed break-words ring-1',
          muted
            ? 'bg-black/25 text-neutral-400 ring-white/[0.05]'
            : 'bg-white/[0.05] text-neutral-100 ring-white/[0.08]',
        ].join(' ')}
      >
        {text || <span className="text-neutral-600">(nothing)</span>}
      </p>
    </div>
  )
}

export function QualityPage(): React.JSX.Element {
  const [sheet, setSheet] = useState<RatingSheet | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback((): void => {
    void window.wouice.getRatingSheet().then(setSheet)
  }, [])

  useEffect(load, [load])

  const rate = useCallback(
    (ship: boolean): void => {
      const at = sheet?.next?.at
      if (at === undefined || busy) return
      setBusy(true)
      void window.wouice
        .rateDictation(at, ship, note.trim())
        .then((next) => {
          setSheet(next)
          setNote('')
        })
        .finally(() => setBusy(false))
    },
    [sheet, note, busy]
  )

  /**
   * Y and N, because this is twenty judgements in a row.
   *
   * Ignored while a text field has focus, or typing a note would rate the thing
   * you are writing about.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (e.key === 'y' || e.key === 'Y') rate(true)
      if (e.key === 'n' || e.key === 'N') rate(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rate])

  if (!sheet) return <p className="text-[12px] text-neutral-500">Loading…</p>

  const d = sheet.next

  return (
    <div className="space-y-4">
      <Scoreboard sheet={sheet} />

      {d ? (
        <section className="lift rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
          <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-neutral-100">
              Would you have shipped this?
            </h3>
            <span className="font-mono text-[11px] text-neutral-500 tabular-nums">
              {sheet.remaining} left
            </span>
          </header>

          <div className="space-y-3">
            <Stage label="What you got" text={d.received || d.corrected || d.raw} />
            {/* Only when they differ. Showing the same sentence twice teaches
                nothing and doubles what there is to read. */}
            {d.raw && d.raw !== (d.received || d.corrected) && (
              <Stage label="What it heard" text={d.raw} muted />
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[10px] text-neutral-600">
            <span>{new Date(d.at).toLocaleString()}</span>
            <span>{d.language}</span>
            <span>
              {d.asrModel} + {d.llmModel}
            </span>
            <span>{(d.audioMs / 1000).toFixed(1)}s audio</span>
            {d.degraded && <span className="text-amber-400/80">fell back: {d.degraded}</span>}
          </div>

          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What was wrong with it? (optional, and the useful half of a no)"
            className="mt-3 w-full rounded-md bg-black/25 px-3 py-2 text-[12px] text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-600 focus:ring-white/20"
          />

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => rate(true)}
              disabled={busy}
              className="rounded-lg bg-emerald-500/15 px-3.5 py-1.5 text-[12px] font-medium text-emerald-200 ring-1 ring-emerald-500/30 transition hover:bg-emerald-500/25 disabled:opacity-40"
            >
              Would ship
            </button>
            <button
              onClick={() => rate(false)}
              disabled={busy}
              className="rounded-lg bg-white/[0.04] px-3.5 py-1.5 text-[12px] font-medium text-neutral-300 ring-1 ring-white/10 transition hover:bg-white/[0.08] disabled:opacity-40"
            >
              Would not
            </button>
            <span className="ml-auto text-[10px] text-neutral-600">
              <kbd className="rounded bg-white/5 px-1.5 py-0.5 font-mono">Y</kbd> /{' '}
              <kbd className="rounded bg-white/5 px-1.5 py-0.5 font-mono">N</kbd>
            </span>
          </div>
        </section>
      ) : (
        <section className="lift rounded-xl bg-white/[0.035] px-4 py-8 text-center ring-1 ring-white/[0.08]">
          <p className="text-[13px] text-neutral-300">Everything has a verdict.</p>
          <p className="mt-1 text-[11px] text-neutral-500">
            {sheet.progress.rated < sheet.progress.sampleTarget
              ? `A4 needs ${sheet.progress.sampleTarget} rated and you have ${sheet.progress.rated}. Dictate some more.`
              : 'Nothing left to judge.'}
          </p>
        </section>
      )}

      {sheet.recent.length > 0 && (
        <section className="lift rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
          <h3 className="text-[13px] font-semibold text-neutral-100">Recent verdicts</h3>
          <p className="mt-0.5 text-[11px] text-neutral-500">
            Undo one to put it back in the queue.
          </p>
          <ul className="mt-2 divide-y divide-white/5">
            {sheet.recent.map(({ rating, text, language }) => (
              <li key={rating.dictationAt} className="flex items-center gap-3 py-2">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    rating.ship ? 'bg-emerald-400' : 'bg-neutral-600'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-neutral-300">{text}</p>
                  {rating.note && (
                    <p className="truncate text-[10px] text-neutral-600">{rating.note}</p>
                  )}
                </div>
                <span className="shrink-0 font-mono text-[10px] text-neutral-600">{language}</span>
                <button
                  onClick={() => void window.wouice.clearRating(rating.dictationAt).then(setSheet)}
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
