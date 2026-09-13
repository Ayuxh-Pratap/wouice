import { useEffect, useRef, useState } from 'react'
import type { VocabularySuggestion } from '../../shared/ipc.js'
import { BUTTON, Badge, Kbd } from './parts.js'
import { KIND_LABEL, quoteParts, reviewKey, reviewMeta, type ReviewAction } from './view.js'

/**
 * What your meetings suggest, one at a time - the page's first job.
 *
 * ONE AT A TIME, ANSWERED WITH A KEY, as the Quality page rates dictations: a
 * suggestion is a yes-or-no you can give in a second when the line it came from
 * is in front of you. After an answer the next one takes its place.
 *
 * EMPTY, IT EXPLAINS ITSELF. Suggestions arrive on their own schedule - a new
 * name only once it has come up twice - so the card says how, instead of
 * leaving a blank that looks like a broken feature.
 */
export function ReviewCard({
  waiting,
  blocked,
  onEdit,
}: {
  waiting: VocabularySuggestion[]
  /** A dialog is open: the keys belong to it. */
  blocked: boolean
  onEdit(s: VocabularySuggestion): void
}): React.JSX.Element {
  const [at, setAt] = useState(0)
  const busy = useRef(false)
  const i = Math.min(at, Math.max(0, waiting.length - 1))
  const s = waiting[i]

  const run = (action: ReviewAction): void => {
    if (!s || busy.current) return
    if (action === 'prev') return setAt(Math.max(0, i - 1))
    if (action === 'next') return setAt(Math.min(waiting.length - 1, i + 1))
    if (action === 'edit') return onEdit(s)
    busy.current = true
    const answer = action === 'add' ? window.wouice.acceptSuggestion(s.id) : window.wouice.rejectSuggestion(s.id)
    void answer.finally(() => (busy.current = false))
  }

  useEffect(() => {
    if (!s || blocked) return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const action = reviewKey(e.key, e.ctrlKey || e.metaKey || e.altKey, typing)
      if (!action) return
      e.preventDefault()
      run(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!s) {
    return (
      <section className="lift rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
        <p className="text-[13px] text-neutral-300">Nothing waiting.</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-neutral-500">
          New names show here once they come up in two meetings; words that sound like yours, right away. People on a
          Meet call are added on their own.
        </p>
      </section>
    )
  }

  const quote = quoteParts(s)
  const isNew = s.type === 'new'
  return (
    <section className="lift rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
      <div className="flex items-center gap-2 text-[11px] text-neutral-500">
        <span className="size-1.5 rounded-full bg-amber-400" />
        <span className="tabular-nums">
          {i + 1} of {waiting.length} from your meetings
        </span>
        {waiting.length > 1 && (
          <span className="ml-auto flex items-center gap-1">
            <button onClick={() => run('prev')} disabled={i === 0} title="Previous (←)" className="rounded px-1.5 text-[13px] text-neutral-500 transition hover:text-neutral-200 disabled:opacity-30">
              ‹
            </button>
            <button onClick={() => run('next')} disabled={i === waiting.length - 1} title="Next (→)" className="rounded px-1.5 text-[13px] text-neutral-500 transition hover:text-neutral-200 disabled:opacity-30">
              ›
            </button>
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <span className="text-[17px] font-semibold tracking-tight text-neutral-50">{isNew ? s.term : s.heard}</span>
        {isNew ? <Badge>{KIND_LABEL[s.kind].one.toLowerCase()}</Badge> : <Badge tone="amber">heard as</Badge>}
      </div>
      {!isNew && (
        <p className="mt-0.5 text-[12px] text-neutral-400">
          sounds like <span className="font-medium text-neutral-200">{s.term}</span>
        </p>
      )}
      {quote && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-neutral-400 italic">
          “{quote.before}
          {quote.word && <mark className="rounded-sm bg-amber-500/15 px-0.5 text-neutral-100 not-italic">{quote.word}</mark>}
          {quote.after}”
        </p>
      )}
      <p className="mt-1 text-[11.5px] text-neutral-500">{reviewMeta(s)}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => run('add')} className={BUTTON.affirm}>
          {isNew ? 'Add' : 'Add as heard-as'}
          <Kbd>Y</Kbd>
        </button>
        <button onClick={() => run('edit')} className={BUTTON.second}>
          Edit first
          <Kbd>E</Kbd>
        </button>
        <button onClick={() => run('reject')} className={BUTTON.decline}>
          {isNew ? 'Not a word' : 'Not this'}
          <Kbd>N</Kbd>
        </button>
      </div>
    </section>
  )
}
