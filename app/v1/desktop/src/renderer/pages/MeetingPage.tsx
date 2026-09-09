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
    return (
      <div className="flex h-full flex-col gap-3">
        <header className="flex shrink-0 items-center gap-3">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="text-[22px] font-semibold tabular-nums text-neutral-50">
            {formatElapsed(state?.elapsedMs ?? 0)}
          </span>
          <span className="text-[12px] text-neutral-500">{describePhase(state!.phase)}</span>

          {/* Two lights, not two meters. The only thing worth knowing while a
              call runs is that both halves are arriving. */}
          <div className="ml-auto flex items-center gap-3">
            {(state?.channels ?? []).map((c) => (
              <span key={c.channel} className="flex items-center gap-1.5" title={c.problem ?? ''}>
                <span
                  className="size-1.5 rounded-full"
                  style={{
                    backgroundColor: c.problem ? '#f87171' : c.live ? '#34d399' : '#fbbf24',
                  }}
                />
                <span className="text-[11.5px] text-neutral-400">
                  {c.channel === 'me' ? 'You' : 'Them'}
                </span>
              </span>
            ))}
            <button
              onClick={() => setNotesOpen(true)}
              className="rounded-lg px-2.5 py-1.5 text-[12px] text-neutral-300 ring-1 ring-white/10 transition hover:bg-white/[0.08]"
            >
              Notes{meeting.scratchMd ? ' •' : ''}
            </button>
            <button
              onClick={() => void window.wouice.stopMeeting()}
              disabled={state?.phase === 'merging'}
              className="rounded-lg bg-red-500/15 px-3.5 py-1.5 text-[12.5px] font-medium text-red-300 ring-1 ring-red-500/30 transition hover:bg-red-500/25 disabled:opacity-40"
            >
              Stop
            </button>
          </div>
        </header>

        {state?.message ? <p className="text-[12px] text-amber-300">{state.message}</p> : null}

        <section className="lift flex min-h-0 flex-1 flex-col rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <Transcript
              segments={segments}
              emptyMessage="Lines appear about half a minute behind the conversation."
            />
          </div>
        </section>

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

  /* ------------------------------------------------------------- finished -- */

  return (
    <div className="space-y-4">
      <header>
        <a
          href="#/meetings"
          className="text-[11.5px] text-neutral-500 transition hover:text-neutral-300"
        >
          ← All meetings
        </a>
        <h1 className="mt-1 text-[19px] font-semibold tracking-tight text-neutral-50">
          {meeting.title ?? formatWhen(meeting.startedAt)}
        </h1>
        <p className="mt-0.5 text-[12px] text-neutral-500">
          {formatDuration(meeting.durationMs)} · {meeting.segments} line
          {meeting.segments === 1 ? '' : 's'} · {kind.label}
          {meeting.endedAt === null ? ' · never finished' : ''}
        </p>
      </header>

      {working ? (
        <div className="flex items-center gap-2.5 rounded-xl bg-white/[0.035] px-4 py-2.5 ring-1 ring-white/[0.08]">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-[12.5px] text-neutral-300">
            {repass
              ? describeRepass(repass)
              : englishProgress
                ? 'Rendering into English…'
                : describeNotes(notesProgress!)}
          </span>
        </div>
      ) : null}

      {problem ? (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">{problem}</p>
      ) : null}

      <Notes markdown={meeting.notesMd} tasks={tasks} onTaskState={changeTask} />

      {!meeting.notesMd && !working && segments.length > 0 ? (
        <button
          onClick={() => void redo('notes')}
          className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/[0.12]"
        >
          Summary and tasks
        </button>
      ) : null}

      <section className="lift flex max-h-[58vh] flex-col rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
        <div className="mb-2.5 flex shrink-0 flex-wrap items-center gap-2">
          <h2 className="text-[12px] font-medium text-neutral-400">Transcript</h2>
          {hasEnglish ? (
            <div className="flex gap-1">
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

          {/* Editing, not the flow. Small, and to one side. */}
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <button
              onClick={() => setNotesOpen(true)}
              className="rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
            >
              Your notes{meeting.scratchMd ? ' •' : ''}
            </button>
            <button
              onClick={() => setConfirming(true)}
              disabled={working || !meeting.audioPath}
              title="Transcribe again with the larger, slower model."
              className="rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300 disabled:opacity-40"
            >
              Improve accuracy
            </button>
            {meeting.notesMd ? (
              <button
                onClick={() => void redo('notes')}
                disabled={working}
                className="rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300 disabled:opacity-40"
              >
                Redo summary
              </button>
            ) : null}
            {kind.translate ? (
              <button
                onClick={() => void redo('english')}
                disabled={working}
                className="rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300 disabled:opacity-40"
              >
                Redo English
              </button>
            ) : null}
            <button
              onClick={() => window.wouice.revealMeeting(meeting.dir)}
              className="rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
            >
              Audio
            </button>
            <button
              onClick={() => {
                void window.wouice.copyMeetingDiagnostic(meetingId)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              title="Which models ran, how many chunks failed, what each channel did."
              className="rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
            >
              {copied ? 'Copied' : 'Diagnostic'}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <Transcript
            segments={segments}
            english={english && hasEnglish}
            emptyMessage="No transcript — it was recorded before transcription existed, or the speech model was not running."
          />
        </div>
      </section>

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
