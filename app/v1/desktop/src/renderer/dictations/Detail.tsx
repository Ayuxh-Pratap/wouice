import { useState } from 'react'
import type { DictationRecord } from '../../shared/ipc.js'
import { formatMs } from '../charts/primitives.js'
import { describeDelivery, explainChunks, finalText, hasStages, stagesOf, type Stage } from './stages.js'

/**
 * One dictation, opened up.
 *
 * LEADS WITH THE TEXT. The previous version opened straight into five
 * near-identical grey paragraphs of pipeline stages, and the thing almost
 * everybody wants - what did I actually say - was the fourth of them, findable
 * only if you knew that "4 · Got back" meant "the answer". The text comes
 * first now, at a size you can read, with the one button anybody wants next to
 * it. The pipeline is still all here, one disclosure further down.
 *
 * IT IS A CARD, NOT A HOLE. The first version tinted the opened region darker
 * than the table around it, which landed it on almost exactly the colour of the
 * page behind the table - so the row appeared to open a hole straight through
 * to the background, and the two surfaces read as one. It is a raised card
 * sitting in a recessed gutter now: lighter than the rows above it, ringed, and
 * unambiguously in front of everything else on the page.
 *
 * NOTHING OVERFLOWS. The facts wrap, the button has a fixed place in the header
 * rather than floating to the end of whichever line it lands on, and every
 * block that can hold a path or an executable name breaks words rather than
 * pushing the table wider than the window.
 */

function Chip({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-[10px] tracking-wide text-neutral-600 uppercase">{label}</span>
      <span className="truncate font-mono text-[11px] text-neutral-300 tabular-nums">{value}</span>
    </div>
  )
}

function Note({
  tone = 'plain',
  children,
}: {
  tone?: 'plain' | 'warn'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p
      className={[
        'rounded-lg px-3 py-2 text-[11px] leading-relaxed break-words',
        tone === 'warn'
          ? 'bg-amber-500/10 text-amber-200 ring-1 ring-amber-500/20'
          : 'bg-white/[0.03] text-neutral-400 ring-1 ring-white/[0.06]',
      ].join(' ')}
    >
      {children}
    </p>
  )
}

/**
 * One stage of the pipeline.
 *
 * A stage that changed nothing collapses to a single line saying so. Five
 * blocks of the same sentence repeated is not five pieces of information, and
 * hiding the repeats is what makes the one that did change visible without
 * having to compare paragraphs by eye.
 */
function StageRow({ stage }: { stage: Stage }): React.JSX.Element {
  const [open, setOpen] = useState(!stage.bulky && stage.changed)
  const empty = stage.text.length === 0

  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${
              stage.changed ? 'bg-amber-400' : 'bg-neutral-700'
            }`}
          />
          <span className="truncate text-[11px] font-medium text-neutral-300">{stage.label}</span>
        </div>
        <div className="mt-0.5 pl-3 text-[10px] leading-tight text-neutral-600">
          {/* Spelled out rather than left to the dot's tooltip: this panel is
              read with the eyes, and a hover hint is not an explanation. The
              instruction is not a step that could have changed anything, so it
              says what it is instead of reporting that it changed nothing. */}
          {stage.bulky ? stage.hint : stage.changed ? 'changed the text' : 'left it as it was'}
        </div>
      </div>

      {open || empty ? (
        <p className="min-w-0 rounded-lg bg-black/30 px-3 py-2 text-[12px] leading-relaxed break-words text-neutral-300 ring-1 ring-white/[0.05]">
          {empty ? <span className="text-neutral-600">(empty)</span> : stage.text}
        </p>
      ) : (
        <button
          onClick={() => setOpen(true)}
          title={stage.hint}
          className="min-w-0 rounded-lg bg-black/20 px-3 py-2 text-left text-[11px] text-neutral-600 ring-1 ring-white/[0.04] transition hover:bg-black/30 hover:text-neutral-400"
        >
          {stage.bulky ? 'Show the instruction' : 'Identical to the stage above · show'}
        </button>
      )}
    </div>
  )
}

function CopyButton({ at }: { at: number }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        void window.wouice.copyDiagnostic(at).then((ok) => setCopied(ok))
        setTimeout(() => setCopied(false), 1_800)
      }}
      className="shrink-0 rounded-md px-2.5 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-200"
    >
      {copied ? 'Copied' : 'Copy diagnostic'}
    </button>
  )
}

export function Detail({
  d,
  developerMode,
}: {
  d: DictationRecord
  developerMode: boolean
}): React.JSX.Element {
  const [pipeline, setPipeline] = useState(false)
  const text = finalText(d)

  return (
    <td colSpan={7} className="bg-black/20 p-3">
      <div className="lift min-w-0 rounded-xl bg-white/[0.05] px-4 py-3.5 ring-1 ring-white/[0.09]">
        {/* The text and the one button anybody wants, on one line. The button
            has a fixed corner rather than being pushed to the end of a wrapping
            row, where it ends up somewhere different on every dictation. */}
        <div className="flex items-start justify-between gap-4">
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed break-words text-neutral-100">
            {text || <span className="text-neutral-600">(no text was kept for this one)</span>}
          </p>
          <CopyButton at={d.at} />
        </div>

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          <Chip label="audio" value={`${(d.audioMs / 1000).toFixed(1)}s`} />
          <Chip label="took" value={formatMs(d.asrMs + d.llmMs)} />
          <Chip label="language" value={d.language} />
          {developerMode && (
            <>
              <Chip label="asr" value={formatMs(d.asrMs)} />
              <Chip label="cleanup" value={d.llmMs ? formatMs(d.llmMs) : 'skipped'} />
              <Chip label="chunks" value={d.chunks} />
              <Chip label="models" value={`${d.asrModel} + ${d.llmModel}`} />
            </>
          )}
        </div>

      <div className="mt-3 space-y-2">
        <Note>{describeDelivery(d)}</Note>

        {d.degraded && (
          <Note tone="warn">
            Fell back: <span className="font-mono">{d.degraded}</span>. The text above is the stage
            before the language model, not its answer.
          </Note>
        )}

        {developerMode && d.capture && (
          <Note>
            Stopped by <span className="text-neutral-200">{d.capture.stoppedBy}</span> after{' '}
            {(d.capture.speechMs / 1000).toFixed(1)}s of speech and{' '}
            {(d.capture.silenceMs / 1000).toFixed(1)}s of silence.
            <br />
            {explainChunks(d)}
          </Note>
        )}
      </div>

      {developerMode && (
        <div className="mt-3">
          <button
            onClick={() => setPipeline((v) => !v)}
            className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] text-neutral-500 transition hover:text-neutral-300"
          >
            <span className={`inline-block transition ${pipeline ? 'rotate-90' : ''}`}>›</span>
            {pipeline ? 'Hide the pipeline' : 'Show every stage of the text'}
          </button>

          {pipeline &&
            (hasStages(d) ? (
              <div className="mt-1 divide-y divide-white/5">
                {stagesOf(d).map((s) => (
                  <StageRow key={s.name} stage={s} />
                ))}
                {d.applied.length > 0 && (
                  <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 py-2">
                    <span className="pl-3 text-[11px] font-medium text-neutral-300">Rules fired</span>
                    <div className="flex flex-wrap gap-1.5">
                      {d.applied.map((a, i) => (
                        <span
                          key={i}
                          className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
                        >
                          {a.from} → {a.to}
                          {a.count > 1 && <span className="text-neutral-600"> ×{a.count}</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="py-3 text-[11px] text-neutral-600">
                Imported from a build that predates stage capture, so no text was kept.
              </p>
            ))}
        </div>
      )}
      </div>
    </td>
  )
}
