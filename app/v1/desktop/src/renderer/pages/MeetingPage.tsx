import { useCallback, useEffect, useRef, useState } from 'react'
import type { MeetingRecord, TaskRecord, TaskState } from '@wouice/store'
import type {
  EnglishProgressView,
  MeetingSegment,
  MeetingState,
  NotesProgressView,
  RepassProgressView,
} from '../../shared/ipc.js'
import { kindOf } from '../../shared/meeting-kind.js'
import { Notes } from '../meetings/Notes.js'
import { Transcript } from '../meetings/Transcript.js'
import { Tabs } from '../shell/Tabs.js'

/**
 * One meeting, on its own page.
 *
 * TWO STATES, ONE ADDRESS. While it records, this is the recording: a clock, a
 * transcript arriving, and somewhere to jot. Afterwards it is the record: the
 * summary, the tasks, the transcript. Same page, because they are the same
 * meeting and being sent somewhere else at the moment you press stop is exactly
 * when you least want to be.
 *
 * THE PIPELINE IS NOT A SET OF BUTTONS. Stopping a meeting produces the
 * transcript, then the English rendering, then the summary and tasks, without
 * anybody pressing anything. Doing one of them again is editing, so those
 * controls are small and out of the way.
 */

const RECORDING_PHASES = new Set(['starting', 'recording', 'stopping', 'merging'])

/**
 * Three things, read at different times.
 *
 * You open a meeting to check what you agreed, or to work the task list, or to
 * read what was actually said - very rarely two of those in one visit. Stacked
 * down a page, every visit costs a scroll past the parts you did not come for.
 */
type MeetingTab = 'summary' | 'tasks' | 'transcript'

export function MeetingPage({ meetingId }: { meetingId: number }): React.JSX.Element {
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null)
  const [segments, setSegments] = useState<MeetingSegment[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [state, setState] = useState<MeetingState | null>(null)
  const [english, setEnglish] = useState(true)
  const [notesProgress, setNotesProgress] = useState<NotesProgressView | null>(null)
  const [englishProgress, setEnglishProgress] = useState<EnglishProgressView | null>(null)
  const [repass, setRepass] = useState<RepassProgressView | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [problem, setProblem] = useState('')
  const [copied, setCopied] = useState(false)
  const [tab, setTab] = useState<MeetingTab | null>(null)

  const load = useCallback(() => {
    void window.wouice.getMeeting(meetingId).then(setMeeting)
    void window.wouice.getMeetingSegments(meetingId).then(setSegments)
    void window.wouice.getMeetingTasks(meetingId).then(setTasks)
  }, [meetingId])

  useEffect(load, [load])

  useEffect(() => {
    void window.wouice.getMeetingState().then(setState)
    const offState = window.wouice.onMeetingState(setState)
    // Segments arrive during the meeting; re-reading is a single indexed query
    // and is always right, where appending to a local list drifts on a reload.
    const offSegments = window.wouice.onMeetingSegments(() => {
      void window.wouice.getMeetingSegments(meetingId).then(setSegments)
    })
    const offNotes = window.wouice.onNotesProgress((p) => {
      if (p.meetingId === meetingId) setNotesProgress(p)
    })
    const offEnglish = window.wouice.onEnglishProgress((p) => {
      if (p.meetingId === meetingId) setEnglishProgress(p)
    })
    const offRepass = window.wouice.onRepassProgress((p) => {
      if (p.meetingId === meetingId) setRepass(p)
    })
    const offDone = window.wouice.onMeetingProcessed((id) => {
      if (id !== meetingId) return
      setNotesProgress(null)
      setEnglishProgress(null)
      setRepass(null)
      load()
    })
    return () => {
      offState()
      offSegments()
      offNotes()
      offEnglish()
      offRepass()
      offDone()
    }
  }, [meetingId, load])

  if (!meeting) {
    return <p className="py-10 text-center text-[13px] text-neutral-500">Loading…</p>
  }

  const live = state?.meetingId === meetingId && RECORDING_PHASES.has(state.phase)
  const kind = kindOf(meeting.kind)
  const hasEnglish = segments.some((s) => s.textEn)
  const working = notesProgress !== null || englishProgress !== null || repass !== null
  // Whatever there is to read. Landing on an empty Summary when the transcript
  // is right there is a click for nothing.
  const shown: MeetingTab = tab ?? (meeting.notesMd ? 'summary' : 'transcript')

  const changeTask = (taskId: number, taskState: TaskState): void => {
    setTasks((current) => current.map((t) => (t.id === taskId ? { ...t, state: taskState } : t)))
    void window.wouice.setTaskState(taskId, taskState)
  }

  const redo = async (what: 'notes' | 'english'): Promise<void> => {
    setProblem('')
    const outcome =
      what === 'notes'
        ? await window.wouice.generateNotes(meetingId)
        : await window.wouice.renderEnglish(meetingId)
    if (!outcome.ok) setProblem(outcome.message)
    setNotesProgress(null)
    setEnglishProgress(null)
    load()
  }

  /* ------------------------------------------------------------ recording -- */

  if (live) {
    const settling = state!.phase !== 'recording'
    return (
      <div className="flex h-full flex-col gap-3">
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2.5">
            <span className="size-2 shrink-0 animate-pulse rounded-full bg-red-500" />
            <span className="text-[24px] font-semibold tabular-nums text-neutral-50">
              {formatElapsed(state?.elapsedMs ?? 0)}
            </span>
          </span>

          {/*
            Two lights that answer one question: is each half being heard RIGHT
            NOW. Bright while somebody is speaking, dim while the channel is
            open and quiet, amber before it opens, red when it failed. Watching
            your own light come up as you talk is the fastest possible proof
            that the recording is real.
          */}
          <span className="flex items-center gap-3">
            {(state?.channels ?? []).map((c) => (
              <SpeakingLight key={c.channel} view={c} />
            ))}
          </span>

          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={() => void window.wouice.stopMeeting()}
              disabled={state?.phase === 'merging'}
              className="rounded-lg bg-red-500/15 px-4 py-1.5 text-[12.5px] font-medium text-red-300 ring-1 ring-red-500/30 transition hover:bg-red-500/25 disabled:opacity-40"
            >
              Stop
            </button>
          </span>
        </header>

        {/* Status belongs under the row it describes, not wedged inside it. */}
        {settling || state?.message ? (
          <p className="shrink-0 text-[11.5px] text-neutral-500">
            {state?.message || describePhase(state!.phase)}
          </p>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1.7fr_1fr]">
          <section className="lift flex min-h-0 flex-col rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <Transcript
                segments={segments}
                emptyMessage="Lines appear about half a minute behind the conversation."
              />
            </div>
          </section>

          {/*
            An input, not a button that opens one. During a call you are typing
            in fragments between sentences; a dialog to open first is a dialog
            you do not open, and the note never gets written.
          */}
          <LiveNotes meetingId={meetingId} initial={meeting.scratchMd} />
        </div>
      </div>
    )
  }

  /* ------------------------------------------------------------- finished -- */

  const aura = repass ? '#fb923c' : working ? '#34d399' : null

  return (
    <div className="relative space-y-4">
      {/*
        Something is happening, said with light rather than with a spinner. It
        sits behind the content it belongs to, so a glance at the page answers
        "is it still working" without reading anything. Green while it writes,
        orange while it re-transcribes - the slow one that costs you dictation
        should not look like the quick one.
      */}
      {aura ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-6 h-48 animate-pulse rounded-[3rem] blur-3xl"
          style={{ background: `radial-gradient(55% 100% at 50% 0%, ${aura}66 0%, transparent 72%)` }}
        />
      ) : null}

      <header className="relative flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <a
            href="#/meetings"
            className="text-[11.5px] text-neutral-500 transition hover:text-neutral-300"
          >
            ← All meetings
          </a>
          <h1 className="mt-1 truncate text-[19px] font-semibold tracking-tight text-neutral-50">
            {meeting.title ?? formatWhen(meeting.startedAt)}
          </h1>
          <p className="mt-0.5 text-[12px] text-neutral-500">
            {formatDuration(meeting.durationMs)} · {meeting.segments} line
            {meeting.segments === 1 ? '' : 's'} · {kind.label}
            {meeting.endedAt === null ? ' · never finished' : ''}
          </p>
        </div>

        {/*
          Notes is the only thing here you DO; the rest is redoing something
          that already ran. It sits level with the title rather than with the
          back link, because it belongs to this meeting, not to the navigation.
        */}
        <div className="flex shrink-0 items-center gap-1.5 self-center">
          <button
            onClick={() => setNotesOpen(true)}
            className="flex items-center gap-1 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[12px] text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/[0.12]"
          >
            <span className="text-[13px] leading-none">+</span>
            Notes{meeting.scratchMd ? ' •' : ''}
          </button>
          <Menu
            items={[
              {
                label: 'Improve accuracy',
                onClick: () => setConfirming(true),
                disabled: working || !meeting.audioPath,
              },
              ...(kind.translate
                ? [
                    {
                      label: 'Redo English',
                      onClick: () => void redo('english'),
                      disabled: working || segments.length === 0,
                    },
                  ]
                : []),
              {
                label: 'Redo summary',
                onClick: () => void redo('notes'),
                disabled: working || segments.length === 0,
              },
              { label: 'Show audio file', onClick: () => window.wouice.revealMeeting(meeting.dir) },
              {
                label: copied ? 'Copied' : 'Copy diagnostic',
                onClick: () => {
                  void window.wouice.copyMeetingDiagnostic(meetingId)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                },
              },
            ]}
          />
        </div>
      </header>

      {working ? (
        <div className="relative flex items-center gap-2.5 rounded-xl bg-white/[0.05] px-4 py-2.5 ring-1 ring-white/[0.10]">
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full"
            style={{ backgroundColor: aura ?? '#34d399' }}
          />
          <span className="text-[12.5px] text-neutral-200">
            {repass
              ? describeRepass(repass)
              : englishProgress
                ? 'Rendering into English…'
                : describeNotes(notesProgress!)}
          </span>
        </div>
      ) : null}

      {problem ? (
        <p className="relative rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          {problem}
        </p>
      ) : null}

      <div className="relative space-y-3">
        <Tabs<MeetingTab>
          tabs={[
            { id: 'summary', label: 'Summary' },
            { id: 'tasks', label: 'Tasks', badge: tasks.filter((t) => t.state === 'open').length },
            { id: 'transcript', label: 'Transcript', badge: segments.length },
          ]}
          active={shown}
          onChange={setTab}
        />

        {shown === 'summary' ? (
          meeting.notesMd ? (
            <Notes markdown={meeting.notesMd} tasks={[]} onTaskState={changeTask} />
          ) : (
            <Empty
              text={
                working
                  ? 'The summary is being written.'
                  : segments.length === 0
                    ? 'Nothing was transcribed, so there is nothing to summarise.'
                    : 'No summary yet.'
              }
              action={
                !working && segments.length > 0
                  ? { label: 'Summary and tasks', onClick: () => void redo('notes') }
                  : undefined
              }
            />
          )
        ) : null}

        {shown === 'tasks' ? (
          tasks.length > 0 ? (
            <Notes markdown={null} tasks={tasks} onTaskState={changeTask} />
          ) : (
            <Empty
              text={
                working
                  ? 'Looking for commitments.'
                  : 'No tasks. Most conversations contain none, and inventing them would be worse.'
              }
            />
          )
        ) : null}

        {shown === 'transcript' ? (
          <section className="lift flex max-h-[62vh] flex-col rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
            {hasEnglish ? (
              <div className="mb-2.5 flex shrink-0 justify-end gap-1">
                {[
                  { on: true, label: 'English' },
                  { on: false, label: 'As spoken' },
                ].map((choice) => (
                  <button
                    key={choice.label}
                    onClick={() => setEnglish(choice.on)}
                    aria-pressed={english === choice.on}
                    className={
                      'rounded-md px-2 py-0.5 text-[11px] ring-1 transition ' +
                      (english === choice.on
                        ? 'bg-white/[0.09] text-neutral-200 ring-white/20'
                        : 'text-neutral-500 ring-white/10 hover:bg-white/5')
                    }
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <Transcript
                segments={segments}
                english={english && hasEnglish}
                emptyMessage="No transcript — it was recorded before transcription existed, or the speech model was not running."
              />
            </div>
          </section>
        ) : null}
      </div>

      {confirming ? (
        <ImproveDialog
          meeting={meeting}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            setProblem('')
            setRepass({ meetingId, stage: 'loading', doneSec: 0, totalSec: 0 })
            void window.wouice.repassMeeting(meetingId).then((outcome) => {
              if (!outcome.ok) setProblem(outcome.message)
              setRepass(null)
              load()
            })
          }}
        />
      ) : null}

      {notesOpen ? (
        <NotesDialog
          meetingId={meetingId}
          initial={meeting.scratchMd}
          onClose={() => {
            setNotesOpen(false)
            load()
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * The overflow menu.
 *
 * What goes in here is everything that is not a decision: looking at the audio,
 * copying a diagnostic, redoing something that already ran. Six buttons in a row
 * is a row nobody reads and the first thing to break on a narrow window.
 */
function Menu({
  items,
}: {
  items: { label: string; onClick(): void; disabled?: boolean }[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    // Any click anywhere else, and Escape. A menu that needs its own button
    // pressed again to close is a menu that gets left open.
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen((was) => !was)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        className="rounded-lg px-2.5 py-1.5 text-[13px] leading-none text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/[0.08] hover:text-neutral-200"
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          // Two steps lighter than the panel it floats over, with a real
          // shadow. At the same value as its background it read as part of the
          // page rather than as something on top of it.
          className="absolute right-0 z-40 mt-1.5 w-52 overflow-hidden rounded-lg bg-neutral-800 py-1 shadow-2xl shadow-black/60 ring-1 ring-white/[0.16]"
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
              className="block w-full px-3 py-1.5 text-left text-[12px] text-neutral-300 transition hover:bg-white/[0.07] hover:text-neutral-100 disabled:opacity-40"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * What the careful pass costs, said before it starts.
 *
 * It stops the language model to make room for the larger speech model, so
 * dictation does not work while it runs, and on an hour of audio it is twenty
 * minutes. Finding that out by having a dictation silently fail would be the
 * worst possible way to learn it.
 */
function ImproveDialog({
  meeting,
  onCancel,
  onConfirm,
}: {
  meeting: MeetingRecord
  onCancel(): void
  onConfirm(): void
}): React.JSX.Element {
  // Measured at roughly 2.7x turbo, over both channels.
  const minutes = Math.max(1, Math.round((meeting.durationMs / 1000 / 60) * 0.75))

  return (
    <Dialog title="Transcribe this meeting again?" onClose={onCancel}>
      <p className="text-[13px] leading-relaxed text-neutral-300">
        This runs the larger speech model over the saved audio. On a Hindi meeting it recovers
        sentences the fast model loses entirely — measured against Google&apos;s own captions, it
        is close. On the far side of a call it helps less, because that audio arrives already
        damaged by the network.
      </p>
      <ul className="mt-3 space-y-1.5 text-[12.5px] text-neutral-400">
        <li>· Roughly {minutes} minute{minutes === 1 ? '' : 's'} for this meeting.</li>
        <li>· Dictation will not work while it runs — the language model is unloaded to make room.</li>
        <li>· The transcript, the English and the summary are all replaced.</li>
        <li>· Your own notes and any task you have ticked off are kept.</li>
      </ul>
      <p className="mt-3 text-[12px] text-neutral-500">
        You will get a notification when it finishes. If anything fails, the transcript you have
        now is left exactly as it is.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/5"
        >
          Not now
        </button>
        <button
          onClick={onConfirm}
          className="rounded-lg bg-white/[0.09] px-3 py-1.5 text-[12.5px] font-medium text-neutral-100 ring-1 ring-white/20 transition hover:bg-white/[0.15]"
        >
          Transcribe again
        </button>
      </div>
    </Dialog>
  )
}

/** Notes you type during or after the call, out of the way until wanted. */
function NotesDialog({
  meetingId,
  initial,
  onClose,
}: {
  meetingId: number
  initial: string
  onClose(): void
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const latest = useRef(initial)
  latest.current = text

  // Saved as you type as well as on close: a meeting that ends unexpectedly
  // should not take the last sentence with it.
  useEffect(() => {
    const timer = setTimeout(() => {
      void window.wouice.setMeetingScratch(meetingId, latest.current)
    }, 600)
    return () => clearTimeout(timer)
  }, [text, meetingId])

  const close = (): void => {
    void window.wouice.setMeetingScratch(meetingId, latest.current)
    onClose()
  }

  return (
    <Dialog title="Your notes" onClose={close}>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'pricing?? john wants Q3\nthey need SSO before rollout'}
        className="min-h-[220px] w-full resize-y rounded-md bg-black/25 px-3 py-2 text-[13px] leading-relaxed text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-700 focus:ring-white/20"
      />
      <p className="mt-2 text-[11.5px] text-neutral-600">
        Rough is fine. Folded into the summary — this is what says which parts mattered to you.
      </p>
      <div className="mt-3 flex justify-end">
        <button
          onClick={close}
          className="rounded-lg bg-white/[0.09] px-3 py-1.5 text-[12.5px] font-medium text-neutral-100 ring-1 ring-white/20 transition hover:bg-white/[0.15]"
        >
          Done
        </button>
      </div>
    </Dialog>
  )
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose(): void
  children: React.ReactNode
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="lift w-full max-w-lg rounded-xl bg-neutral-900 px-5 py-4 ring-1 ring-white/[0.12]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <h2 className="mb-3 text-[14px] font-medium text-neutral-100">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function describeRepass(p: RepassProgressView): string {
  switch (p.stage) {
    case 'loading':
      return 'Loading the larger model…'
    case 'transcribing':
      return p.totalSec > 0
        ? `Transcribing — ${Math.round((p.doneSec / p.totalSec) * 100)}% (${formatDuration(p.doneSec * 1000)} of ${formatDuration(p.totalSec * 1000)})`
        : 'Transcribing…'
    case 'restoring':
      return 'Putting the models back…'
    case 'rendering':
      return 'Rendering into English…'
    default:
      return 'Writing the summary…'
  }
}

function describeNotes(progress: NotesProgressView): string {
  const where = progress.chunks > 0 ? ` ${progress.chunk} of ${progress.chunks}` : ''
  switch (progress.stage) {
    case 'condensing':
      return `Reading part${where}…`
    case 'extracting':
      return `Finding commitments in part${where}…`
    default:
      return 'Writing the summary…'
  }
}

function describePhase(phase: string): string {
  switch (phase) {
    case 'starting':
      return 'opening the microphone and system audio'
    case 'stopping':
      return 'closing the streams'
    case 'merging':
      return 'saving the audio and finishing the transcript'
    default:
      return 'recording'
  }
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
  return `${String(minutes).padStart(2, '0')}:${seconds}`
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function formatWhen(epochMs: number): string {
  if (!epochMs) return 'Unknown time'
  return new Date(epochMs).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Empty({
  text,
  action,
}: {
  text: string
  action?: { label: string; onClick(): void }
}): React.JSX.Element {
  return (
    <div className="lift rounded-xl bg-white/[0.035] px-4 py-8 text-center ring-1 ring-white/[0.08]">
      <p className="text-[12.5px] text-neutral-400">{text}</p>
      {action ? (
        <button
          onClick={action.onClick}
          className="mt-3 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/[0.12]"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

/**
 * One channel, as a light that reacts to speech.
 *
 * The level is the same meter the dictation overlay uses, so "bright" means the
 * same thing here as it does there.
 */
function SpeakingLight({
  view,
}: {
  view: { channel: string; live: boolean; level: number; problem: string | null }
}): React.JSX.Element {
  const speaking = view.live && view.level > 0.08
  const colour = view.problem ? '#f87171' : view.live ? '#34d399' : '#fbbf24'

  return (
    <span
      className="flex items-center gap-1.5"
      title={view.problem ?? (view.live ? 'being heard' : 'not open yet')}
    >
      <span
        className="rounded-full transition-all duration-150"
        style={{
          backgroundColor: colour,
          width: speaking ? 9 : 6,
          height: speaking ? 9 : 6,
          opacity: speaking ? 1 : view.live ? 0.45 : 0.8,
          boxShadow: speaking ? `0 0 8px ${colour}` : 'none',
        }}
      />
      <span
        className="text-[11.5px] transition-colors"
        style={{ color: speaking ? colour : '#a3a3a3' }}
      >
        {view.channel === 'me' ? 'You' : 'Them'}
      </span>
    </span>
  )
}

/** The scratch pad, inline, for the length of the call. */
function LiveNotes({
  meetingId,
  initial,
}: {
  meetingId: number
  initial: string
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const latest = useRef(initial)
  latest.current = text

  // Saved as you type. A meeting that ends unexpectedly should not take the
  // last sentence with it.
  useEffect(() => {
    const timer = setTimeout(() => {
      void window.wouice.setMeetingScratch(meetingId, latest.current)
    }, 600)
    return () => clearTimeout(timer)
  }, [text, meetingId])

  useEffect(() => {
    return () => {
      void window.wouice.setMeetingScratch(meetingId, latest.current)
    }
  }, [meetingId])

  return (
    <section className="lift flex min-h-0 flex-col rounded-xl bg-white/[0.035] px-3.5 py-3 ring-1 ring-white/[0.08]">
      <h2 className="mb-2 shrink-0 text-[11.5px] font-medium text-neutral-400">Your notes</h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'pricing?? john wants Q3\nthey need SSO before rollout'}
        className="min-h-0 flex-1 resize-none rounded-md bg-black/25 px-3 py-2 text-[12.5px] leading-relaxed text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-700 focus:ring-white/20"
      />
      <p className="mt-2 shrink-0 text-[10.5px] leading-snug text-neutral-600">
        Rough is fine. Used for the summary, and to spell names right.
      </p>
    </section>
  )
}
