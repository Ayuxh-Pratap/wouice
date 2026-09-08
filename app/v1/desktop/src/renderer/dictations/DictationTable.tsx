import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { DictationRecord } from '../../shared/ipc.js'
import { formatMs } from '../charts/primitives.js'
import { ConfirmButton } from '../settings/Field.js'
import { Detail } from './Detail.js'
import { finalText } from './stages.js'

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
 *
 * ROWS CAN BE DELETED. This is a recording of somebody's own voice and the text
 * they dictated with it; being unable to remove any of it from inside the app
 * that collected it was the wrong default. Selection is per row with a
 * select-all for the visible page, and "delete everything" lives in Settings,
 * where a whole-history action belongs.
 */

const PAGE_SIZES = [20, 50, 100]

/**
 * A checkbox drawn rather than borrowed.
 *
 * The native control renders as a bright white square on this ground - the
 * loudest thing on a page whose brightest text is a mid grey - and no amount of
 * `accent-color` fixes the box itself. A button with `role="checkbox"` keeps
 * the semantics and the keyboard behaviour while looking like it belongs.
 *
 * `indeterminate` is a real third state here: "some of this page is selected"
 * has to be distinguishable from "none of it is", or the select-all in the
 * header lies about what pressing it will do.
 */
function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange(next: boolean): void
  label: string
}): React.JSX.Element {
  const on = checked || indeterminate

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      // Ticking a box must not also expand the row it sits in.
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={[
        'grid size-[15px] shrink-0 place-items-center rounded-[4px] transition',
        on
          ? 'bg-neutral-200 text-neutral-900 ring-1 ring-neutral-200'
          : 'bg-black/30 ring-1 ring-white/15 hover:ring-white/35',
      ].join(' ')}
    >
      {indeterminate ? (
        <span className="h-px w-2 rounded-full bg-current" />
      ) : (
        checked && (
          <svg viewBox="0 0 12 12" className="size-2.5" fill="none" aria-hidden="true">
            <path
              d="M2 6.2 4.6 8.8 10 3.4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )
      )}
    </button>
  )
}

export function DictationTable({
  developerMode,
  query = '',
}: {
  developerMode: boolean
  /** A term arriving from the sidebar search, via the hash. */
  query?: string
}): React.JSX.Element {
  const [rows, setRows] = useState<DictationRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(20)
  const [search, setSearch] = useState(query)
  const [applied, setApplied] = useState(query)
  const [openAt, setOpenAt] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)

  // A search from the rail arrives as a navigation, so adopt it when it changes
  // - but only then, or every keystroke typed here would be overwritten.
  useEffect(() => {
    setSearch(query)
    setApplied(query)
    setPage(0)
  }, [query])

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

  useEffect(load, [load])

  // Reload the page in view when a dictation lands, so the newest one appears
  // without anyone reaching for a refresh.
  useEffect(() => window.wouice.onMetric(load), [load])

  const pages = Math.max(1, Math.ceil(total / size))
  // A filter that shrinks the result set can strand you on a page past the end.
  useEffect(() => {
    if (page > 0 && page >= pages) setPage(pages - 1)
  }, [page, pages])

  const firstIndex = total - page * size
  const onPage = rows.filter((d) => selected.has(d.at)).length
  const allOnPage = rows.length > 0 && onPage === rows.length

  const toggle = (at: number, on: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(at)
      else next.delete(at)
      return next
    })
  }

  const toggleAllOnPage = (on: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const d of rows) {
        if (on) next.add(d.at)
        else next.delete(d.at)
      }
      return next
    })
  }

  const removeSelected = (): void => {
    const ats = [...selected]
    void window.wouice.deleteDictations(ats).then(() => {
      setSelected(new Set())
      // An open row that has just been deleted would otherwise stay expanded
      // over the row that slid up into its place.
      if (openAt !== null && ats.includes(openAt)) setOpenAt(null)
      load()
    })
  }

  return (
    <section className="lift rounded-xl bg-white/[0.035] ring-1 ring-white/[0.08]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        {/*
          The selection count REPLACES the summary rather than appearing beside
          it. While rows are selected, how many there are in total is not the
          question being asked.
        */}
        {selected.size > 0 ? (
          <div className="flex items-center gap-3">
            <p className="text-[12px] text-neutral-200">
              {selected.size} selected
              {selected.size > onPage && (
                <span className="text-neutral-500"> · across more than this page</span>
              )}
            </p>
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-md px-2 py-1 text-[11px] text-neutral-500 transition hover:text-neutral-300"
            >
              Clear
            </button>
          </div>
        ) : (
          <p className="text-[12px] text-neutral-400">
            {/* No heading here: the page it sits on is already called Dictations,
                and two identical titles a centimetre apart is just noise. */}
            {total === 0
              ? 'Nothing yet.'
              : applied
                ? `${total} matching "${applied}"`
                : `${total} in total. Click a row to read it.`}
          </p>
        )}

        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <ConfirmButton
              label={`Delete ${selected.size}`}
              confirmLabel={`Delete ${selected.size}?`}
              onClick={removeSelected}
            />
          )}
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
        <table className="w-full min-w-[44rem] border-collapse text-left">
          <thead>
            <tr className="border-y border-white/5 text-[10px] tracking-wide text-neutral-500 uppercase">
              <th className="w-9 pl-4">
                <Checkbox
                  checked={allOnPage}
                  indeterminate={onPage > 0 && !allOnPage}
                  onChange={toggleAllOnPage}
                  label="Select every dictation on this page"
                />
              </th>
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
                <td colSpan={7} className="px-3 py-8 text-center text-[12px] text-neutral-600">
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
              const picked = selected.has(d.at)
              return (
                <Fragment key={d.at}>
                  <tr
                    onClick={() => setOpenAt(open ? null : d.at)}
                    className={[
                      'cursor-pointer border-t border-white/5 align-top transition',
                      picked ? 'bg-white/[0.06]' : 'hover:bg-white/5',
                    ].join(' ')}
                  >
                    <td className="py-2 pl-4">
                      <Checkbox
                        checked={picked}
                        onChange={(on) => toggle(d.at, on)}
                        label={`Select the dictation from ${new Date(d.at).toLocaleString()}`}
                      />
                    </td>
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
                        {finalText(d) || '(no text)'}
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
                  {open && (
                    <tr className="border-t border-white/5">
                      <Detail d={d} developerMode={developerMode} />
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
