import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { DictationRecord } from '../shared/ipc.js'
import { formatMs } from './charts/primitives.js'

/**
 * The dictation history, as a table you can page through.
 *
 * The previous version showed the last twenty rows of an in-memory buffer, so
 * everything older existed on disk and could not be reached from the app at
 * all. This asks the database for one page at a time and is told the real
 * total, which is the difference between "here are the recent ones" and "here
 * is your history".
 *
 * Paging happens in SQL rather than by slicing a loaded array, so the cost of
 * opening page 40 is the same as opening page 1.
 */

const PAGE_SIZES = [20, 50, 100]

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
function explainChunks(d: DictationRecord): string | null {
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
  return `No chunks, unexpectedly: speech ${ms(c.speechMs)} and longest pause ${ms(
    c.longestPauseMs
  )} both clear the thresholds`
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

function Detail({ d }: { d: DictationRecord }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const hasText = Boolean(d.raw || d.received)

  return (
    <td colSpan={6} className="bg-neutral-950/40 px-3 pb-3">
      <div className="flex items-center justify-between pt-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-neutral-500">
          <span>audio {(d.audioMs / 1000).toFixed(1)}s</span>
          <span>asr {formatMs(d.asrMs)}</span>
          <span>llm {d.llmMs ? formatMs(d.llmMs) : 'none'}</span>
          <span>chunks {d.chunks}</span>
          <span>lang {d.language}</span>
          <span>{d.asrModel}</span>
          <span>{d.llmModel}</span>
        </div>
        <button
          onClick={() => {
            void window.wouice.copyDiagnostic(d.at).then((ok) => setCopied(ok))
            setTimeout(() => setCopied(false), 1_800)
          }}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200"
        >
          {copied ? 'Copied to clipboard' : 'Copy diagnostic'}
        </button>
      </div>

      {d.capture && (
        <p className="mt-2 rounded-md bg-neutral-900 px-2.5 py-1.5 text-[11px] leading-relaxed text-neutral-400">
          Stopped by <span className="text-neutral-200">{d.capture.stoppedBy}</span> after{' '}
          {ms(d.capture.speechMs)} of speech and {ms(d.capture.silenceMs)} of silence. Longest pause{' '}
          {ms(d.capture.longestPauseMs)}, silence window {ms(d.capture.windowMs)}.
          <br />
          {explainChunks(d)}
        </p>
      )}

      {d.degraded && (
        <p className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
          Fell back: <span className="font-mono">{d.degraded}</span>. The text you got is the stage
          before the language model.
        </p>
      )}

      {hasText ? (
        <div className="mt-1 divide-y divide-white/5">
          <Stage name="raw" label="1 · Heard" text={d.raw} changed />
          <Stage
            name="corrected"
            label="2 · Dictionary"
            text={d.corrected}
            changed={d.corrected !== d.raw}
          />
          <Stage name="system" label="3a · Instruction" text={d.sentSystem} changed={false} />
          <Stage
            name="user"
            label="3b · Text sent"
            text={d.sentUser}
            changed={d.sentUser !== d.corrected}
          />
          <Stage
            name="received"
            label="4 · Got back"
            text={d.received}
            changed={d.received !== d.sentUser}
          />
          {d.applied.length > 0 && (
            <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-2">
              <span className="pl-3 text-[11px] font-medium text-neutral-300">Rules fired</span>
              <div className="flex flex-wrap gap-1.5">
                {d.applied.map((a, i) => (
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
          Imported from a build that predates stage capture, so no text was kept.
        </p>
      )}
    </td>
  )
}

export function DictationTable({
  refreshKey,
  developerMode,
}: {
  /** Bumped when a new dictation lands, so the current page reloads. */
  refreshKey: number
  developerMode: boolean
}): React.JSX.Element {
  const [rows, setRows] = useState<DictationRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(20)
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [openAt, setOpenAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  // Debounced: typing a word should not fire a query per keystroke.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setApplied(search.trim())
      setPage(0)
    }, 250)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [search])

  const load = useCallback((): void => {
    setLoading(true)
    void window.wouice
      .getDictationPage(page * size, size, applied || undefined)
      .then((p) => {
        setRows(p.rows)
        setTotal(p.total)
      })
      .finally(() => setLoading(false))
  }, [page, size, applied])

  useEffect(load, [load, refreshKey])

  const pages = Math.max(1, Math.ceil(total / size))
  // A filter that shrinks the result set can strand you on a page past the end.
  useEffect(() => {
    if (page > 0 && page >= pages) setPage(pages - 1)
  }, [page, pages])

  const firstIndex = total - page * size

  return (
    <section className="rounded-xl bg-neutral-900 ring-1 ring-white/10">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h3 className="text-[13px] font-semibold text-neutral-100">Dictations</h3>
          <p className="text-[11px] text-neutral-500">
            {total === 0
              ? 'Nothing yet.'
              : applied
                ? `${total} matching "${applied}"`
                : `${total} in total. Click a row for every stage of the text.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search transcripts"
            className="w-44 rounded-md bg-neutral-950 px-2.5 py-1 text-[12px] text-neutral-200 ring-1 ring-white/10 outline-none placeholder:text-neutral-600 focus:ring-white/25"
          />
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
            With audio
          </button>
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] border-collapse text-left">
          <thead>
            <tr className="border-y border-white/5 text-[10px] tracking-wide text-neutral-500 uppercase">
              <th className="w-12 px-3 py-1.5 font-medium">#</th>
              <th className="w-32 px-3 py-1.5 font-medium">When</th>
              <th className="px-3 py-1.5 font-medium">Text</th>
              <th className="w-16 px-3 py-1.5 text-right font-medium">Audio</th>
              <th className="w-16 px-3 py-1.5 text-right font-medium">Took</th>
              <th className="w-8 px-3 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[12px] text-neutral-600">
                  {loading
                    ? 'Loading…'
                    : applied
                      ? `Nothing matches "${applied}".`
                      : 'Press the hotkey and say something.'}
                </td>
              </tr>
            )}
            {rows.map((d, i) => {
              const open = openAt === d.at
              return (
                <Fragment key={d.at}>
                  <tr
                    onClick={() => setOpenAt(open ? null : d.at)}
                    className="cursor-pointer border-t border-white/5 align-top hover:bg-white/5"
                  >
                    <td className="px-3 py-2 font-mono text-[10px] text-neutral-600">
                      {firstIndex - i}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] whitespace-nowrap text-neutral-500">
                      {new Date(d.at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="max-w-0 px-3 py-2">
                      <span className="block truncate text-[12px] text-neutral-300">
                        {d.received || d.corrected || d.raw || '(no text)'}
                      </span>
                      {d.degraded && (
                        <span className="mt-0.5 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                          degraded
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[10px] tabular-nums text-neutral-500">
                      {(d.audioMs / 1000).toFixed(1)}s
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[10px] tabular-nums text-neutral-400">
                      {formatMs(d.asrMs + d.llmMs)}
                    </td>
                    <td className="px-3 py-2 text-neutral-600">
                      <span className={`inline-block transition ${open ? 'rotate-90' : ''}`}>›</span>
                    </td>
                  </tr>
                  {open && developerMode && (
                    <tr className="border-t border-white/5">
                      <Detail d={d} />
                    </tr>
                  )}
                  {open && !developerMode && (
                    <tr className="border-t border-white/5">
                      <td colSpan={6} className="bg-neutral-950/40 px-3 py-3">
                        <p className="text-[12px] leading-relaxed text-neutral-300">{d.received}</p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 px-4 py-2.5">
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <span>Rows</span>
          {PAGE_SIZES.map((n) => (
            <button
              key={n}
              onClick={() => {
                setSize(n)
                setPage(0)
              }}
              className={`rounded px-1.5 py-0.5 tabular-nums ${
                size === n ? 'bg-white/10 text-neutral-200' : 'hover:bg-white/5'
              }`}
            >
              {n}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPage(0)}
            disabled={page === 0}
            className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            First
          </button>
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            Previous
          </button>
          <span className="px-2 font-mono text-[11px] tabular-nums text-neutral-500">
            {page + 1} / {pages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            Next
          </button>
          <button
            onClick={() => setPage(pages - 1)}
            disabled={page >= pages - 1}
            className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            Last
          </button>
        </div>
      </footer>
    </section>
  )
}
