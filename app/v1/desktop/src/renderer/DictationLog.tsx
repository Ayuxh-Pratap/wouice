import { useState } from 'react'
import type { DictationMetric } from '../shared/ipc.js'
import { formatMs } from './charts/primitives.js'

/**
 * Developer mode: every stage of the text for one dictation.
 *
 * When output is wrong the only question worth asking is WHICH stage got it
 * wrong. Whisper misheard, the dictionary rewrote something it should not have,
 * or the LLM took liberties: those need completely different fixes, and without
 * seeing all four you are guessing. This makes the pipeline legible instead.
 */

const STAGE_HINT: Record<string, string> = {
  raw: 'Straight out of Whisper, chunks joined',
  corrected: 'After the deterministic dictionary pass',
  system: 'The instruction the model was given',
  user: 'The text sent alongside it',
  received: 'Exactly what came back, before the plausibility check',
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
}

/**
 * Explain the chunk count in words.
 *
 * "chunks 0" on a 38-second dictation is ambiguous on its own: it could mean
 * the speaker never left a long enough pause, or that chunking is broken again.
 * Those need opposite responses, so say which it was.
 */
function explainChunks(d: DictationMetric): string | null {
  const c = d.capture
  if (!c) return null
  if (d.chunks > 0) return `${d.chunks} chunk(s) transcribed while you were still talking`
  if (c.speechMs < c.chunkAfterMs) {
    return `No chunks: ${ms(c.speechMs)} of speech, and chunking starts at ${ms(c.chunkAfterMs)}`
  }
  if (c.longestPauseMs < c.chunkPauseMs) {
    return `No chunks: enough speech (${ms(c.speechMs)}) but your longest pause was ${ms(
      c.longestPauseMs
    )}, under the ${ms(c.chunkPauseMs)} needed to cut without splitting a word`
  }
  return `No chunks, unexpectedly: speech ${ms(c.speechMs)} and longest pause ${ms(c.longestPauseMs)} both clear the thresholds`
}

function Stage({
  name,
  label,
  text,
  changed,
}: {
  name: string
  label: string
  text: string
  changed: boolean
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-2">
      <div>
        <div className="flex items-center gap-1.5">
          <span
            className={`size-1.5 shrink-0 rounded-full ${changed ? 'bg-amber-400' : 'bg-neutral-700'}`}
            title={changed ? 'this stage changed the text' : 'unchanged by this stage'}
          />
          <span className="text-[11px] font-medium text-neutral-300">{label}</span>
        </div>
        <div className="mt-0.5 pl-3 text-[10px] leading-tight text-neutral-600">
          {STAGE_HINT[name]}
        </div>
      </div>
      <p className="min-w-0 rounded-md bg-neutral-950/60 px-2.5 py-1.5 text-[12px] leading-relaxed break-words text-neutral-300">
        {text || <span className="text-neutral-600">(empty)</span>}
      </p>
    </div>
  )
}

function Row({ d, index }: { d: DictationMetric; index: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const s = d.stages
  const when = new Date(d.at).toLocaleTimeString()
  const total = d.asrMs + d.llmMs

  return (
    <div className="border-t border-white/5 first:border-t-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-white/5"
      >
        <span className="w-6 shrink-0 font-mono text-[10px] text-neutral-600">#{index}</span>
        <span className="w-16 shrink-0 font-mono text-[10px] text-neutral-500">{when}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-300">
          {s?.received || s?.corrected || '(no text)'}
        </span>
        {d.degraded && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
            degraded
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-neutral-500">
          {formatMs(total)}
        </span>
        <span className={`shrink-0 text-neutral-600 transition ${open ? 'rotate-90' : ''}`}>›</span>
      </button>

      {open && (
        <div className="bg-neutral-950/40 px-3 pb-3">
          <div className="flex items-center justify-end pt-2">
            <button
              onClick={() => {
                void window.wouice.copyDiagnostic(d.at).then((ok) => setCopied(ok))
                setTimeout(() => setCopied(false), 1_800)
              }}
              className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200"
            >
              {copied ? 'Copied to clipboard' : 'Copy diagnostic'}
            </button>
          </div>
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 pt-2 font-mono text-[10px] text-neutral-500">
            <span>audio {(d.audioMs / 1000).toFixed(1)}s</span>
            <span>asr {formatMs(d.asrMs)}</span>
            <span>llm {d.llmMs ? formatMs(d.llmMs) : 'none'}</span>
            <span>chunks {d.chunks}</span>
            <span>lang {d.language}</span>
            <span>{d.asrModel}</span>
            <span>{d.llmModel}</span>
          </div>

          {d.capture && (
            <p className="mb-2 rounded-md bg-neutral-900 px-2.5 py-1.5 text-[11px] leading-relaxed text-neutral-400">
              Stopped by <span className="text-neutral-200">{d.capture.stoppedBy}</span> after{' '}
              {ms(d.capture.speechMs)} of speech and {ms(d.capture.silenceMs)} of silence. Longest
              pause {ms(d.capture.longestPauseMs)}, silence window {ms(d.capture.windowMs)}.
              <br />
              {explainChunks(d)}
            </p>
          )}

          {d.degraded && (
            <p className="mb-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
              Fell back: <span className="font-mono">{d.degraded}</span>. The text you got is the
              stage before the language model.
            </p>
          )}

          {s ? (
            <div className="divide-y divide-white/5">
              <Stage name="raw" label="1 · Heard" text={s.raw} changed />
              <Stage
                name="corrected"
                label="2 · Dictionary"
                text={s.corrected}
                changed={s.corrected !== s.raw}
              />
              <Stage
                name="system"
                label="3a · Instruction"
                text={s.sent.system}
                changed={false}
              />
              <Stage
                name="user"
                label="3b · Text sent"
                text={s.sent.user}
                changed={s.sent.user !== s.corrected}
              />
              <Stage
                name="received"
                label="4 · Got back"
                text={s.received}
                changed={s.received !== s.sent.user}
              />
              {s.applied.length > 0 && (
                <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-2">
                  <span className="pl-3 text-[11px] font-medium text-neutral-300">Rules fired</span>
                  <div className="flex flex-wrap gap-1.5">
                    {s.applied.map((a, i) => (
                      <span
                        key={i}
                        className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
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
              Recorded before developer mode existed, so no stage text was kept.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function DictationLog({
  dictations,
  limit = 20,
}: {
  dictations: DictationMetric[]
  limit?: number
}): React.JSX.Element {
  const recent = dictations.slice(-limit).reverse()

  return (
    <section className="rounded-xl bg-neutral-900 ring-1 ring-white/10">
      <header className="flex items-baseline justify-between px-4 py-3">
        <div>
          <h3 className="text-[13px] font-semibold text-neutral-100">Dictations</h3>
          <p className="text-[11px] text-neutral-500">
            Click any row for every stage of the text, from what Whisper heard to what came back.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-neutral-600">{dictations.length} total</span>
          <button
            onClick={() => void window.wouice.exportDiagnostics(false)}
            className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200"
          >
            Export
          </button>
          <button
            onClick={() => void window.wouice.exportDiagnostics(true)}
            className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200"
            title="Markdown plus the retained WAV files, so the exact audio can be replayed"
          >
            Export with audio
          </button>
        </div>
      </header>
      {recent.length === 0 ? (
        <p className="px-4 pb-6 text-center text-[12px] text-neutral-600">
          Nothing yet. Press the hotkey and say something.
        </p>
      ) : (
        <div className="max-h-[26rem] overflow-y-auto">
          {recent.map((d, i) => (
            <Row key={d.at} d={d} index={dictations.length - i} />
          ))}
        </div>
      )}
    </section>
  )
}
