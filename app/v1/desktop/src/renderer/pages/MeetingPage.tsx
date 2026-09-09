import { useCallback, useEffect, useRef, useState } from 'react'
import type { MeetingRecord, TaskRecord, TaskState } from '@wouice/store'
import type {
  EnglishProgressView,
  MeetingSegment,
  NotesProgressView,
} from '../../shared/ipc.js'
import { MEETING_KINDS, kindOf, type MeetingKind } from '../../shared/meeting-kind.js'
import { Notes } from '../meetings/Notes.js'
import { Transcript } from '../meetings/Transcript.js'

/**
 * One meeting, on its own page.
 *
 * EVERYTHING ABOUT IT IN ONE PLACE. A meeting is not a row in a table - it is a
 * transcript, a set of tasks, notes, the audio, and whatever you typed while it
 * was happening, and all of those are only useful next to each other. The list
 * outside is management: which meetings exist and which one to open.
 *
 * THE RAW TRANSCRIPT IS ALWAYS REACHABLE. The English rendering is what makes a
 * Hindi meeting readable, and it is a model's account of what was said, not the
 * thing itself. One toggle, never a replacement - if the two ever disagree, the
 * disagreement is the interesting part.
 */

export function MeetingPage({ meetingId }: { meetingId: number }): React.JSX.Element {
  const [meeting, setMeeting] = useState<MeetingRecord | null>(null)
  const [segments, setSegments] = useState<MeetingSegment[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [english, setEnglish] = useState(true)
  const [notesProgress, setNotesProgress] = useState<NotesProgressView | null>(null)
  const [englishProgress, setEnglishProgress] = useState<EnglishProgressView | null>(null)
  const [problem, setProblem] = useState('')
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    void window.wouice.getMeeting(meetingId).then(setMeeting)
    void window.wouice.getMeetingSegments(meetingId).then(setSegments)
    void window.wouice.getMeetingTasks(meetingId).then(setTasks)
  }, [meetingId])

  useEffect(load, [load])

  useEffect(() => {
    const offNotes = window.wouice.onNotesProgress((p) => {
      if (p.meetingId === meetingId) setNotesProgress(p)
    })
    const offEnglish = window.wouice.onEnglishProgress((p) => {
      if (p.meetingId !== meetingId) return
      setEnglishProgress(p)
      // The pass runs on its own when a meeting ends, so the page has to notice
      // it finishing without anybody having pressed anything here.
      if (p.batch >= p.batches) setTimeout(load, 500)
    })
    return () => {
      offNotes()
      offEnglish()
    }
  }, [meetingId, load])

  if (!meeting) {
    return <p className="py-10 text-center text-[13px] text-neutral-500">Loading…</p>
  }

  const kind = kindOf(meeting.kind)
  const hasEnglish = segments.some((s) => s.textEn)
  const running = notesProgress !== null || englishProgress !== null

  const write = async (): Promise<void> => {
    setProblem('')
    setNotesProgress({ meetingId, stage: 'condensing', chunk: 0, chunks: 0 })
    try {
      const outcome = await window.wouice.generateNotes(meetingId)
      if (!outcome.ok) setProblem(outcome.message)
      else load()
    } finally {
      setNotesProgress(null)
    }
  }

  const render = async (): Promise<void> => {
    setProblem('')
    setEnglishProgress({ meetingId, batch: 0, batches: 0 })
    try {
      const outcome = await window.wouice.renderEnglish(meetingId)
      if (!outcome.ok) setProblem(outcome.message)
      else load()
    } finally {
      setEnglishProgress(null)
    }
  }

  const changeTask = (taskId: number, state: TaskState): void => {
    setTasks((current) => current.map((t) => (t.id === taskId ? { ...t, state } : t)))
    void window.wouice.setTaskState(taskId, state)
  }

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
          {meeting.segments === 1 ? '' : 's'}
          {meeting.endedAt === null ? ' · never finished' : ''}
        </p>
      </header>

      <section className="lift flex flex-wrap items-center gap-2 rounded-xl bg-white/[0.035] px-3 py-2 ring-1 ring-white/[0.08]">
        <span className="text-[11.5px] text-neutral-500">Spoken in</span>
        <select
          value={meeting.kind}
          onChange={(e) => {
            const next = e.target.value as MeetingKind
            void window.wouice.setMeetingKind(meetingId, next).then(load)
          }}
          className="rounded-md bg-neutral-950 px-2 py-1 text-[12px] text-neutral-200 ring-1 ring-white/10 outline-none focus:ring-white/25"
        >
          {MEETING_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-600" title={kind.hint}>
          {kind.hint}
        </span>

        <button
          onClick={() => void window.wouice.revealMeeting(meeting.dir)}
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
          title="Which models ran, how many chunks failed, what each channel did. Paste it when something went wrong."
          className="rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
        >
          {copied ? 'Copied' : 'Diagnostic'}
        </button>
      </section>

      <section className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void write()}
          disabled={running || segments.length === 0}
          className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/[0.12] disabled:opacity-40"
        >
          {meeting.notesMd ? 'Write notes again' : 'Write notes and tasks'}
        </button>
        {kind.translate && (
          <button
            onClick={() => void render()}
            disabled={running || segments.length === 0}
            className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-[12px] text-neutral-300 ring-1 ring-white/10 transition hover:bg-white/[0.12] disabled:opacity-40"
          >
            {hasEnglish ? 'Render English again' : 'Render English'}
          </button>
        )}
        {notesProgress ? (
          <span className="text-[11.5px] text-neutral-500">{describeNotes(notesProgress)}</span>
        ) : null}
        {englishProgress ? (
          <span className="text-[11.5px] text-neutral-500">
            {englishProgress.batches > 0
              ? `rendering ${englishProgress.batch} of ${englishProgress.batches}`
              : 'rendering into English'}
          </span>
        ) : null}
        {problem ? <span className="text-[12px] text-amber-300">{problem}</span> : null}
      </section>

      <Notes markdown={meeting.notesMd} tasks={tasks} onTaskState={changeTask} />

      <ScratchPad meetingId={meetingId} initial={meeting.scratchMd} />

      <section className="lift rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="text-[12px] font-medium text-neutral-400">Transcript</h2>
          {hasEnglish ? (
            <div className="ml-auto flex gap-1">
              {[
                { on: true, label: 'English' },
                { on: false, label: 'As spoken' },
              ].map((choice) => (
                <button
                  key={choice.label}
                  onClick={() => setEnglish(choice.on)}
                  aria-pressed={english === choice.on}
                  className={
                    'rounded-md px-2 py-0.5 text-[11px] transition ring-1 ' +
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
        </div>
        <Transcript
          segments={segments}
          english={english && hasEnglish}
          emptyMessage="No transcript — it was recorded before transcription existed, or the speech model was not running."
        />
      </section>
    </div>
  )
}

/** Notes you typed during the call, editable afterwards. */
function ScratchPad({
  meetingId,
  initial,
}: {
  meetingId: number
  initial: string
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const latest = useRef(initial)
  latest.current = text

  useEffect(() => setText(initial), [initial, meetingId])

  useEffect(() => {
    const timer = setTimeout(() => {
      void window.wouice.setMeetingScratch(meetingId, latest.current)
    }, 600)
    return () => clearTimeout(timer)
  }, [text, meetingId])

  return (
    <section className="lift rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
      <h2 className="mb-2 text-[12px] font-medium text-neutral-400">Your notes</h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'pricing?? john wants Q3\nthey need SSO before rollout'}
        className="min-h-[90px] w-full resize-y rounded-md bg-black/25 px-3 py-2 text-[12.5px] leading-relaxed text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-700 focus:ring-white/20"
      />
      <p className="mt-1.5 text-[11px] text-neutral-600">
        Folded into the notes — this is what tells the summary which parts mattered to you.
      </p>
    </section>
  )
}

function describeNotes(progress: NotesProgressView): string {
  const where = progress.chunks > 0 ? ` ${progress.chunk} of ${progress.chunks}` : ''
  switch (progress.stage) {
    case 'condensing':
      return `reading part${where}`
    case 'extracting':
      return `finding commitments in part${where}`
    default:
      return 'writing the notes'
  }
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
