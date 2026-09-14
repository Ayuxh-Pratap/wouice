import type { CheckedSummary, SummaryPoint, TaskRecord, TaskState } from '@wouice/store'
import { useState } from 'react'
import { Notes } from './Notes.js'
import { formatStamp } from './Transcript.js'

/**
 * A meeting's summary, checked against what was said.
 *
 * THE GIST, THEN WHAT IT RESTS ON. Two or three sentences to read in a glance,
 * then the key points they come from, in the order they were said. Every point
 * was checked against its lines, and carries the time it was said: one tap and
 * that line is on screen, so nothing here has to be taken on faith.
 *
 * NEXT STEPS ARE THE TASKS. The same checked list as the Tasks tab, ticked in
 * either place - never a second list written to fill a section.
 *
 * See docs/design/11-checked-summary.md.
 */

const HEADING = 'mb-1.5 text-[11px] font-medium tracking-wide text-neutral-500 uppercase'

const MARK = {
  agreed: 'bg-emerald-500/10 text-emerald-300/90 ring-emerald-500/20',
  open: 'bg-amber-500/10 text-amber-300/90 ring-amber-500/20',
} as const

export function Summary({
  summary,
  tasks,
  onTaskState,
  onJump,
  readOnly = false,
}: {
  summary: CheckedSummary
  tasks: TaskRecord[]
  onTaskState(id: number, state: TaskState): void
  /** Show the line a key point came from. */
  onJump(segmentId: number): void
  readOnly?: boolean
}): React.JSX.Element {
  const [showMore, setShowMore] = useState(false)
  const gist =
    summary.points.length === 0
      ? 'Nothing in this meeting held up as a key point.'
      : summary.gist.map((s) => s.text).join(' ')
  // Every other point that held up; a summary written before them has none.
  const more = Array.isArray(summary.more) ? summary.more : []

  const row = (point: SummaryPoint, i: number): React.JSX.Element => {
    const at = point.segmentIds[0]
    return (
      <li key={i} className="flex items-start gap-3 px-3 py-2">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-neutral-200">
          {point.mark ? (
            <span className={`mr-2 inline-block rounded px-1.5 py-px align-[1px] text-[10px] ring-1 ${MARK[point.mark]}`}>
              {point.mark}
            </span>
          ) : null}
          {point.text}
        </p>
        {point.atMs !== null && at !== undefined ? (
          <button
            onClick={() => onJump(at)}
            title={`“${point.quote}” — show this line`}
            className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] text-neutral-500 tabular-nums transition hover:bg-white/5 hover:text-neutral-200"
          >
            {formatStamp(point.atMs)}
          </button>
        ) : null}
      </li>
    )
  }
  const LIST = 'divide-y divide-white/5 rounded-lg bg-black/20 ring-1 ring-white/[0.06]'

  return (
    <div className="space-y-4">
      <section>
        <h3 className={HEADING}>In short</h3>
        {gist ? (
          <p className="text-[13.5px] leading-relaxed text-neutral-100">{gist}</p>
        ) : (
          <p className="text-[12.5px] text-neutral-500">The gist could not be written; the key points below are checked.</p>
        )}
      </section>

      {summary.points.length > 0 && (
        <section>
          <h3 className={HEADING}>Key points</h3>
          <ul className={LIST}>{summary.points.map(row)}</ul>
          {more.length > 0 ? (
            <>
              <button
                onClick={() => setShowMore((v) => !v)}
                aria-expanded={showMore}
                className="mt-1.5 rounded px-1.5 py-0.5 text-[11.5px] text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200"
              >
                {showMore ? 'Fewer points' : `${more.length} more point${more.length === 1 ? '' : 's'}`}
              </button>
              {showMore ? <ul className={`${LIST} mt-1`}>{more.map(row)}</ul> : null}
            </>
          ) : null}
        </section>
      )}

      {tasks.length > 0 ? (
        <Notes markdown={null} tasks={tasks} onTaskState={onTaskState} readOnly={readOnly} title="Next steps" />
      ) : null}
    </div>
  )
}
