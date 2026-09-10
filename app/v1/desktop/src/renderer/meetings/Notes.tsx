import { useEffect, useState } from 'react'
import type { TaskRecord, TaskState } from '@wouice/store'
import { formatStamp } from './Transcript.js'
import { versionLabel } from './versions.js'

/**
 * Notes and tasks for one meeting.
 *
 * A TASK IS A CARD YOU OPEN. The list shows what each task is, in one line, and
 * just enough to sort by at a glance: its type, its area, whose it is, when it
 * came up. The story, where the meeting landed on it and every line it came
 * from are in the task itself, one click away. A list carrying all of that on
 * every row is a list nobody can scan.
 *
 * EVERY TASK SHOWS WHAT IT CAME FROM. Open one and the lines of the transcript
 * it was found in are there, with their times and the quoted words marked.
 * That is the difference between a list you work from and a list you have to
 * take on faith.
 *
 * DONE AND DROPPED ARE DIFFERENT. A task the model invented, or one that turned
 * out not to be yours, is not "done" - dropping it says so, and keeps the
 * distinction visible for as long as anyone cares to look.
 *
 * READ-ONLY FOR AN OLDER VERSION. You work the task list of the main version;
 * an earlier one is there to compare against, and ticking a task on a list
 * nothing reads any more would be a tick that goes nowhere.
 */

export function Notes({
  markdown,
  tasks,
  onTaskState,
  readOnly = false,
}: {
  markdown: string | null
  tasks: TaskRecord[]
  onTaskState(id: number, state: TaskState): void
  readOnly?: boolean
}): React.JSX.Element | null {
  // By id, so the open task follows the list when a tick changes it.
  const [openId, setOpenId] = useState<number | null>(null)
  const open = tasks.find((task) => task.id === openId) ?? null

  if (!markdown && tasks.length === 0) return null

  return (
    <div className="space-y-3">
      {tasks.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
            Tasks
          </h3>
          <ul className="space-y-1">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                readOnly={readOnly}
                onState={onTaskState}
                onOpen={() => setOpenId(task.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {markdown ? (
        <section>
          <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
            Notes
          </h3>
          <Markdown text={markdown} />
        </section>
      ) : null}

      {open ? (
        <TaskDialog
          task={open}
          readOnly={readOnly}
          onState={onTaskState}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  )
}

/** When a task first came up in the meeting, if it came from the transcript. */
function firstSaid(task: TaskRecord): number | null {
  return task.evidence.find((e) => e.atMs !== null)?.atMs ?? task.quoteAtMs
}

function TaskCard({
  task,
  readOnly,
  onState,
  onOpen,
}: {
  task: TaskRecord
  readOnly: boolean
  onState(id: number, state: TaskState): void
  onOpen(): void
}): React.JSX.Element {
  const done = task.state === 'done'
  const dropped = task.state === 'dropped'
  const at = firstSaid(task)

  return (
    <li className="flex items-center gap-2.5 rounded-lg bg-black/20 px-3 py-2 ring-1 ring-white/[0.06] transition hover:bg-white/[0.04] hover:ring-white/[0.12]">
      <input
        type="checkbox"
        checked={done}
        onChange={() => onState(task.id, done ? 'open' : 'done')}
        disabled={dropped || readOnly}
        aria-label={done ? 'Mark as not done' : 'Mark as done'}
        className="size-3.5 shrink-0 accent-emerald-500 disabled:opacity-30"
      />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left" title="Open this task">
        <p
          className={
            'truncate text-[13px] leading-snug ' +
            (dropped
              ? 'text-neutral-600 line-through'
              : done
                ? 'text-neutral-500 line-through'
                : 'text-neutral-200')
          }
        >
          {task.text}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px]">
          <TaskBadges task={task} />
          <span className={task.owner ? 'text-neutral-400' : 'text-neutral-600'}>
            {task.owner ?? 'unassigned'}
          </span>
          {at !== null ? <span className="text-neutral-600 tabular-nums">{formatStamp(at)}</span> : null}
        </div>
      </button>
      <span aria-hidden className="shrink-0 text-[13px] text-neutral-600">
        ›
      </span>
    </li>
  )
}

/**
 * Everything about one task: the story, where the meeting landed, whose it is,
 * and every line it came from, with the quoted words marked.
 */
function TaskDialog({
  task,
  readOnly,
  onState,
  onClose,
}: {
  task: TaskRecord
  readOnly: boolean
  onState(id: number, state: TaskState): void
  onClose(): void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const done = task.state === 'done'
  const dropped = task.state === 'dropped'
  const at = firstSaid(task)
  // A task carried from another version keeps its words as a note; those are
  // its line, not something you typed.
  const fromNotes = task.noteQuote && !task.carriedFrom ? task.noteQuote : null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={task.text}
        onClick={(e) => e.stopPropagation()}
        className="lift flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl bg-neutral-900 ring-1 ring-white/[0.12]"
      >
        <header className="shrink-0 px-5 pt-4 pb-3">
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
            <TaskBadges task={task} full />
            {done ? <Badge tone="mine">done</Badge> : null}
            {dropped ? <Badge tone="quiet">not a task</Badge> : null}
          </div>
          <h2
            className={
              'mt-2 text-[15px] leading-snug font-medium ' +
              (dropped ? 'text-neutral-500 line-through' : 'text-neutral-50')
            }
          >
            {task.text}
          </h2>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
            <div>
              <dt className="inline text-neutral-500">Owner </dt>
              <dd className="inline text-neutral-200">{task.owner ?? 'not assigned'}</dd>
            </div>
            {task.due ? (
              <div>
                <dt className="inline text-neutral-500">Due </dt>
                <dd className="inline text-amber-300/90">{task.due}</dd>
              </div>
            ) : null}
            {at !== null ? (
              <div>
                <dt className="inline text-neutral-500">Came up at </dt>
                <dd className="inline text-neutral-200 tabular-nums">{formatStamp(at)}</dd>
              </div>
            ) : null}
          </dl>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4">
          <section>
            <h3 className="mb-1 text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
              What and why
            </h3>
            <p className="text-[13px] leading-relaxed text-neutral-300">
              {task.description || task.reason || 'No description was written for this task.'}
            </p>
          </section>

          <section>
            <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-neutral-500 uppercase">
              Where it came from
            </h3>
            {task.evidence.length === 0 && !fromNotes ? (
              <p className="text-[12px] text-red-400/70">There is no line to trace this to.</p>
            ) : null}
            <ol className="space-y-1.5">
              {task.evidence.map((e) => (
                <li key={e.segmentId} className="flex gap-2.5 text-[12.5px] leading-snug">
                  <span className="w-10 shrink-0 pt-px text-right font-mono text-[11px] text-neutral-600 tabular-nums">
                    {e.atMs !== null ? formatStamp(e.atMs) : ''}
                  </span>
                  <span className="min-w-0 text-neutral-300">
                    {e.line ? (
                      <Quoted line={e.line} quote={e.quote} />
                    ) : (
                      <span className="text-neutral-600">That line is no longer in this transcript.</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
            {fromNotes ? (
              <p className="mt-2 text-[12.5px] leading-snug text-neutral-400">
                <span className="text-neutral-500">From your notes: </span>“{fromNotes}”
              </p>
            ) : null}
          </section>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
          {readOnly ? (
            <span className="mr-auto text-[11.5px] text-neutral-500">
              Read-only: tasks are ticked on the version you work from.
            </span>
          ) : (
            <>
              <button
                onClick={() => onState(task.id, dropped ? 'open' : 'dropped')}
                title={
                  dropped
                    ? 'Put it back on the list.'
                    : 'Not real work. Different from done, and kept visible.'
                }
                className="rounded-lg px-3 py-1.5 text-[12px] text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-200"
              >
                {dropped ? 'Restore' : 'Not a task'}
              </button>
              {!dropped ? (
                <button
                  onClick={() => onState(task.id, done ? 'open' : 'done')}
                  className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-[12px] font-medium text-emerald-200 ring-1 ring-emerald-400/25 transition hover:bg-emerald-500/25"
                >
                  {done ? 'Reopen' : 'Mark done'}
                </button>
              ) : null}
            </>
          )}
          <button
            onClick={onClose}
            className="rounded-lg bg-white/[0.09] px-3 py-1.5 text-[12px] font-medium text-neutral-100 ring-1 ring-white/20 transition hover:bg-white/[0.15]"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}

/** A line of the transcript, with the words the task quoted from it marked. */
function Quoted({ line, quote }: { line: string; quote: string }): React.JSX.Element {
  const at = quote ? line.toLowerCase().indexOf(quote.toLowerCase()) : -1
  if (at < 0) return <>“{line}”</>
  return (
    <>
      “{line.slice(0, at)}
      <mark className="rounded-sm bg-amber-400/15 px-0.5 text-amber-100">
        {line.slice(at, at + quote.length)}
      </mark>
      {line.slice(at + quote.length)}”
    </>
  )
}

/** What a task is, at a glance. The dialog also says where the meeting landed. */
function TaskBadges({ task, full = false }: { task: TaskRecord; full?: boolean }): React.JSX.Element {
  return (
    <>
      {task.kind !== 'other' ? (
        <Badge tone={task.kind === 'bug' ? 'bug' : undefined}>{task.kind}</Badge>
      ) : null}
      {task.area !== 'other' ? <Badge>{task.area}</Badge> : null}
      {task.mine ? <Badge tone="mine">yours</Badge> : null}
      {task.status === 'proposed' ? <Badge tone="quiet">proposed</Badge> : null}
      {full && task.status === 'agreed' ? <Badge>agreed</Badge> : null}
      {task.source === 'notes' ? <Badge>from your notes</Badge> : null}
      {task.carriedFrom ? (
        <Badge tone="carried">from the {versionLabel(task.carriedFrom).toLowerCase()}</Badge>
      ) : null}
    </>
  )
}

/**
 * The small subset of markdown the notes prompt actually produces.
 *
 * A parser rather than a library, and a rendered tree rather than
 * `dangerouslySetInnerHTML`: this text came out of a model reading a transcript
 * of what other people said, and turning that into markup is never worth it.
 */
function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks: React.ReactNode[] = []
  let bullets: string[] = []

  const flush = (key: string): void => {
    if (bullets.length === 0) return
    blocks.push(
      <ul key={key} className="mb-2.5 space-y-1">
        {bullets.map((item, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-neutral-300">
            <span className="text-neutral-600">•</span>
            <span className="min-w-0">{inline(item)}</span>
          </li>
        ))}
      </ul>
    )
    bullets = []
  }

  text.split('\n').forEach((raw, index) => {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      bullets.push(bullet[1]!)
      return
    }
    flush(`ul-${index}`)

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push(
        <h4
          key={index}
          className="mt-3 mb-1 text-[12px] font-medium text-neutral-200 first:mt-0"
        >
          {heading[2]}
        </h4>
      )
      return
    }
    if (line.trim()) {
      blocks.push(
        <p key={index} className="mb-2 text-[13px] leading-relaxed text-neutral-300">
          {inline(line)}
        </p>
      )
    }
  })
  flush('ul-end')

  return <div>{blocks}</div>
}

/** `_gap markers_` are the only inline formatting the prompts produce. */
function inline(text: string): React.ReactNode {
  const match = /^_(.+)_$/.exec(text.trim())
  if (!match) return text
  return (
    <span className="text-amber-300/80 italic" title="The model could not summarise this part.">
      {match[1]}
    </span>
  )
}

/** A small label on a task: what it is about, what kind, whose, where from. */
function Badge({
  children,
  tone,
}: {
  children: React.ReactNode
  tone?: 'bug' | 'mine' | 'carried' | 'quiet'
}): React.JSX.Element {
  const colours =
    tone === 'bug'
      ? 'bg-red-500/10 text-red-300/90 ring-red-500/20'
      : tone === 'mine'
        ? 'bg-emerald-500/10 text-emerald-300/90 ring-emerald-500/20'
        : tone === 'carried'
          ? 'bg-sky-500/10 text-sky-300/90 ring-sky-500/20'
          : tone === 'quiet'
            ? 'text-neutral-500 ring-white/[0.08]'
            : 'bg-white/[0.05] text-neutral-400 ring-white/10'
  return (
    <span className={`rounded px-1.5 py-px text-[10px] ring-1 ${colours}`}>{children}</span>
  )
}
