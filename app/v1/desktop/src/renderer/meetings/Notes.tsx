import type { TaskRecord, TaskState } from '@wouice/store'
import { formatStamp } from './Transcript.js'

/**
 * Notes and tasks for one meeting.
 *
 * EVERY TASK SHOWS WHAT IT CAME FROM. The line it was extracted from sits
 * underneath it, with its timestamp. That is the difference between a list you
 * work from and a list you have to take on faith - and the first wrong task in
 * a list you cannot check teaches you to distrust all of them.
 *
 * DONE AND DROPPED ARE DIFFERENT. A task the model invented, or one that turned
 * out not to be yours, is not "done" - dropping it says so, and keeps the
 * distinction visible for as long as anyone cares to look.
 */

export function Notes({
  markdown,
  tasks,
  onTaskState,
}: {
  markdown: string | null
  tasks: TaskRecord[]
  onTaskState(id: number, state: TaskState): void
}): React.JSX.Element | null {
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
              <TaskRow key={task.id} task={task} onState={onTaskState} />
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
    </div>
  )
}

function TaskRow({
  task,
  onState,
}: {
  task: TaskRecord
  onState(id: number, state: TaskState): void
}): React.JSX.Element {
  const done = task.state === 'done'
  const dropped = task.state === 'dropped'

  return (
    <li className="rounded-lg bg-black/20 px-3 py-2 ring-1 ring-white/[0.06]">
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={done}
          onChange={() => onState(task.id, done ? 'open' : 'done')}
          disabled={dropped}
          className="mt-0.5 size-3.5 shrink-0 accent-emerald-500 disabled:opacity-30"
        />
        <div className="min-w-0 flex-1">
          <p
            className={
              'text-[13px] leading-snug ' +
              (dropped
                ? 'text-neutral-600 line-through'
                : done
                  ? 'text-neutral-500 line-through'
                  : 'text-neutral-200')
            }
          >
            {task.text}
          </p>
          {/* Why it was judged a real commitment. A task list you cannot
              question is one you stop trusting. */}
          {task.reason ? (
            <p className="mt-0.5 text-[11px] leading-snug text-neutral-600">{task.reason}</p>
          ) : null}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            {task.area !== 'other' ? <Badge>{task.area}</Badge> : null}
            {task.kind !== 'other' ? (
              <Badge tone={task.kind === 'bug' ? 'bug' : undefined}>{task.kind}</Badge>
            ) : null}
            {task.mine ? <Badge tone="mine">yours</Badge> : null}
            {task.source === 'notes' ? <Badge>from your notes</Badge> : null}
            {task.owner ? (
              <span className="text-neutral-400">{task.owner}</span>
            ) : (
              <span className="text-neutral-600">unassigned</span>
            )}
            {task.due ? <span className="text-amber-300/80">due {task.due}</span> : null}
            {task.quote ? (
              <span className="min-w-0 truncate text-neutral-600" title={task.quote}>
                · {task.quoteAtMs !== null ? `${formatStamp(task.quoteAtMs)} ` : ''}“{task.quote}”
              </span>
            ) : (
              <span className="text-red-400/70">· no line to trace this to</span>
            )}
          </div>
        </div>
        <button
          onClick={() => onState(task.id, dropped ? 'open' : 'dropped')}
          title={
            dropped
              ? 'Put it back on the list.'
              : 'Not a real commitment. Different from done, and kept visible.'
          }
          className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-neutral-600 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
        >
          {dropped ? 'Restore' : 'Not a task'}
        </button>
      </div>
    </li>
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

/** A small label on a task: what it is about, what kind, whose. */
function Badge({
  children,
  tone,
}: {
  children: React.ReactNode
  tone?: 'bug' | 'mine'
}): React.JSX.Element {
  const colours =
    tone === 'bug'
      ? 'bg-red-500/10 text-red-300/90 ring-red-500/20'
      : tone === 'mine'
        ? 'bg-emerald-500/10 text-emerald-300/90 ring-emerald-500/20'
        : 'bg-white/[0.05] text-neutral-400 ring-white/10'
  return (
    <span className={`rounded px-1.5 py-px text-[10px] ring-1 ${colours}`}>{children}</span>
  )
}
