import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MeetingChannelView,
  MeetingSegment,
  MeetingState,
  NotesProgressView,
} from '../../shared/ipc.js'
import type { MeetingRecord, TaskRecord, TaskState } from '@wouice/store'
import { Notes } from '../meetings/Notes.js'
import { Transcript } from '../meetings/Transcript.js'
import { useMeetingCapture } from '../meetings/useMeetingCapture.js'

/**
 * Meetings.
 *
 * THE SHAPE IS THE FINISHED SHAPE. One card for what is happening now, one list
 * of what has happened, and a transcript inside a row of that list. Notes and
 * tasks land in the same row, so nothing here has to be rearranged to make room
 * for them.
 *
 * TWO METERS, NOT ONE. Which half is being heard is the single most useful
 * thing to show while recording: a meeting where the far side was never
 * captured looks and sounds exactly like a good one until you play it back an
 * hour later.
 *
 * THE SCRATCH PAD IS AN INPUT, NOT A CONVENIENCE. What you jot during a call is
 * the one signal saying which parts mattered to you, and no summariser can
 * infer it from a transcript. It is saved as you type, because a meeting that
 * ends unexpectedly should not take your notes with it.
 */

const RECORDING_PHASES = new Set(['starting', 'recording', 'stopping', 'merging'])

export function MeetingsPage(): React.JSX.Element {
  const [state, setState] = useState<MeetingState | null>(null)
  const [meetings, setMeetings] = useState<MeetingRecord[]>([])
  const [live, setLive] = useState<MeetingSegment[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [openSegments, setOpenSegments] = useState<MeetingSegment[]>([])
  const [openTasks, setOpenTasks] = useState<TaskRecord[]>([])
  const [notesProgress, setNotesProgress] = useState<NotesProgressView | null>(null)
  const [notesError, setNotesError] = useState('')
  const [showTranscript, setShowTranscript] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MeetingSegment[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [offer, setOffer] = useState<string | null>(null)
  const [copied, setCopied] = useState(0)

  useMeetingCapture(state)

  const refresh = useCallback(() => {
    void window.wouice.listMeetings().then(setMeetings)
  }, [])

  useEffect(() => {
    void window.wouice.getMeetingState().then(setState)
    refresh()
    const offState = window.wouice.onMeetingState((next) => {
      setState((previous) => {
        if (previous && previous.phase !== 'idle' && next.phase === 'idle') {
          refresh()
          setLive([])
        }
        if (previous && previous.phase === 'idle' && next.phase === 'starting') setLive([])
        return next
      })
    })
    const offSegments = window.wouice.onMeetingSegments((segments) =>
      setLive((current) => [...current, ...segments])
    )
    const offNotes = window.wouice.onNotesProgress(setNotesProgress)
    void window.wouice.getMeetingOffer().then(setOffer)
    const offOffer = window.wouice.onMeetingOffer(setOffer)
    return () => {
      offState()
      offSegments()
      offNotes()
      offOffer()
    }
  }, [refresh])

  // Search runs against the database, so it covers meetings whose transcript is
  // not currently open. A blank box is not a search.
  useEffect(() => {
    const term = query.trim()
    if (!term) {
      setHits(null)
      return
    }
    const timer = setTimeout(() => {
      void window.wouice.searchMeetings(term).then(setHits)
    }, 180)
    return () => clearTimeout(timer)
  }, [query])

  const open = (meeting: MeetingRecord): void => {
    if (openId === meeting.id) {
      setOpenId(null)
      setOpenSegments([])
      setOpenTasks([])
      return
    }
    setOpenId(meeting.id)
    setOpenSegments([])
    setOpenTasks([])
    setNotesError('')
    setShowTranscript(false)
    void window.wouice.getMeetingSegments(meeting.id).then(setOpenSegments)
    void window.wouice.getMeetingTasks(meeting.id).then(setOpenTasks)
  }

  const writeNotes = async (meeting: MeetingRecord): Promise<void> => {
    setNotesError('')
    setNotesProgress({ meetingId: meeting.id, stage: 'condensing', chunk: 0, chunks: 0 })
    try {
      const outcome = await window.wouice.generateNotes(meeting.id)
      if (!outcome.ok) {
        setNotesError(outcome.message)
        return
      }
      refresh()
      void window.wouice.getMeetingTasks(meeting.id).then(setOpenTasks)
    } finally {
      setNotesProgress(null)
    }
  }

  const changeTask = (taskId: number, state: TaskState): void => {
    // Optimistic: the write is a single row and the checkbox should not lag
    // behind the click.
    setOpenTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, state } : task))
    )
    void window.wouice.setTaskState(taskId, state)
  }

  const remove = async (meeting: MeetingRecord): Promise<void> => {
    await window.wouice.deleteMeeting(meeting.id)
    if (openId === meeting.id) setOpenId(null)
    refresh()
  }

  const phase = state?.phase ?? 'idle'
  const active = RECORDING_PHASES.has(phase)

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      if (active) await window.wouice.stopMeeting()
      else await window.wouice.startMeeting()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {offer && !active ? (
        <div className="flex items-center gap-3 rounded-xl bg-emerald-500/10 px-4 py-2.5 ring-1 ring-emerald-500/25">
          <span className="min-w-0 flex-1 text-[12.5px] text-emerald-200">
            <span className="font-medium">{offer}</span> is using your microphone. Record this
            meeting?
          </span>
          <button
            onClick={() => void window.wouice.startMeeting()}
            className="shrink-0 rounded-md bg-emerald-500/20 px-2.5 py-1 text-[12px] font-medium text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-500/30"
          >
            Record
          </button>
          <button
            onClick={() => void window.wouice.dismissMeetingOffer()}
            className="shrink-0 rounded-md px-2 py-1 text-[11.5px] text-emerald-300/70 transition hover:text-emerald-200"
          >
            Not now
          </button>
        </div>
      ) : null}

      {/*
        One row, not a panel. Recording is a thing you start and then stop
        thinking about, so it earns a button and a clock and no more; what is
        worth the screen space is the meetings themselves. The two meters stay
        because which half is being heard is the one thing that is invisible
        until you play the file back an hour later.
      */}
      <section className="lift flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white/[0.035] px-3 py-2 ring-1 ring-white/[0.08]">
        <button
          onClick={() => void toggle()}
          disabled={busy || phase === 'merging'}
          className={
            'shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition disabled:opacity-40 ' +
            (active
              ? 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30 hover:bg-red-500/25'
              : 'bg-white/[0.06] text-neutral-200 ring-1 ring-white/10 hover:bg-white/[0.12]')
          }
        >
          {active ? 'Stop' : 'Start recording'}
        </button>

        {active ? (
          <span className="shrink-0 text-[13px] font-medium tabular-nums text-neutral-100">
            {formatElapsed(state?.elapsedMs ?? 0)}
          </span>
        ) : null}

        <span className="shrink-0 text-[11.5px] text-neutral-500">{describePhase(phase)}</span>

        {state?.transcript.queued ? (
          <span className="shrink-0 text-[11px] text-neutral-600">
            {state.transcript.queued} waiting
          </span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {(state?.channels ?? defaultChannels()).map((channel) => (
            <ChannelMeter key={channel.channel} view={channel} active={active} />
          ))}
        </div>

        {state?.message ? (
          <p className="w-full text-[11.5px] text-amber-300">{state.message}</p>
        ) : null}
      </section>

      {active && (
        <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
          <section className="lift max-h-[420px] overflow-y-auto rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
            <h2 className="mb-2.5 text-[12px] font-medium text-neutral-400">Live transcript</h2>
            <Transcript
              segments={live}
              emptyMessage="Lines appear about half a minute behind the conversation."
            />
          </section>
          <ScratchPad meetingId={state?.meetingId ?? null} />
        </div>
      )}

      <section>
        <div className="mb-2 flex items-center gap-3 px-0.5">
          <h2 className="text-[12px] font-medium text-neutral-400">
            Recorded {meetings.length ? `(${meetings.length})` : ''}
          </h2>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything said"
            className="ml-auto w-56 rounded-md bg-black/25 px-2.5 py-1 text-[12px] text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-600 focus:ring-white/20"
          />
        </div>

        {hits !== null ? (
          <div className="lift rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
            <p className="mb-2.5 text-[11.5px] text-neutral-500">
              {hits.length === 0
                ? 'Nothing matches.'
                : `${hits.length} line${hits.length === 1 ? '' : 's'} across your meetings`}
            </p>
            <Transcript segments={hits} highlight={query} emptyMessage="Nothing matches." />
          </div>
        ) : meetings.length === 0 ? (
          <div className="lift rounded-xl bg-white/[0.035] px-4 py-8 text-center ring-1 ring-white/[0.08]">
            <p className="text-[13px] text-neutral-400">No meetings recorded yet.</p>
            <p className="mt-1 text-[12px] text-neutral-600">
              Start one before your next call and it will appear here.
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {meetings.map((meeting) => (
              <li
                key={meeting.id}
                className="lift rounded-xl bg-white/[0.035] ring-1 ring-white/[0.08]"
              >
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <button
                    onClick={() => open(meeting)}
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={openId === meeting.id}
                  >
                    <p className="truncate text-[13px] text-neutral-200">
                      {meeting.title ?? formatWhen(meeting.startedAt)}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-neutral-500">
                      {meeting.endedAt === null ? (
                        <span className="text-amber-400">never finished · </span>
                      ) : null}
                      {formatDuration(meeting.durationMs)} · {meeting.segments} line
                      {meeting.segments === 1 ? '' : 's'}
                      {meeting.notesMd ? ' · notes written' : ''}
                      {meeting.scratchMd ? ' · has your notes' : ''}
                      {problemOf(meeting) ? (
                        <span className="text-amber-400"> · {problemOf(meeting)}</span>
                      ) : null}
                    </p>
                  </button>
                  <button
                    onClick={() => window.wouice.revealMeeting(meeting.dir)}
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
                  >
                    Show file
                  </button>
                  <button
                    onClick={() => void remove(meeting)}
                    title="Removes it from this list. The audio file stays on disk."
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] text-neutral-600 ring-1 ring-white/10 transition hover:bg-red-500/10 hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>

                {openId === meeting.id && (
                  <div className="space-y-3 border-t border-white/[0.06] px-4 py-3.5">
                    {meeting.scratchMd ? (
                      <div className="rounded-lg bg-black/20 px-3 py-2 ring-1 ring-white/[0.06]">
                        <p className="mb-1 text-[11px] text-neutral-500">What you wrote</p>
                        <p className="whitespace-pre-wrap text-[12.5px] text-neutral-300">
                          {meeting.scratchMd}
                        </p>
                      </div>
                    ) : null}

                    <Notes markdown={meeting.notesMd} tasks={openTasks} onTaskState={changeTask} />

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => void writeNotes(meeting)}
                        disabled={notesProgress !== null || openSegments.length === 0}
                        className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/[0.12] disabled:opacity-40"
                      >
                        {meeting.notesMd ? 'Write them again' : 'Write notes and tasks'}
                      </button>
                      {notesProgress?.meetingId === meeting.id ? (
                        <span className="text-[11.5px] text-neutral-500">
                          {describeNotes(notesProgress)}
                        </span>
                      ) : null}
                      {openSegments.length === 0 ? (
                        <span className="text-[11.5px] text-neutral-600">
                          Nothing to write notes from.
                        </span>
                      ) : null}
                      <button
                        onClick={() => setShowTranscript((was) => !was)}
                        className="ml-auto rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
                      >
                        {showTranscript ? 'Hide transcript' : `Transcript (${openSegments.length})`}
                      </button>
                      <button
                        onClick={() => {
                          void window.wouice.copyMeetingDiagnostic(meeting.id)
                          setCopied(meeting.id)
                          setTimeout(() => setCopied(0), 1500)
                        }}
                        title="Which models ran, how many chunks failed, what each channel did. Paste it when something went wrong."
                        className="rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
                      >
                        {copied === meeting.id ? 'Copied' : 'Copy diagnostic'}
                      </button>
                    </div>

                    {notesError ? <p className="text-[12px] text-amber-300">{notesError}</p> : null}

                    {showTranscript || openSegments.length === 0 ? (
                      <Transcript
                        segments={openSegments}
                        emptyMessage="This meeting has no transcript — it was recorded before transcription, or the model was not running."
                      />
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * Notes you type during the call.
 *
 * Debounced rather than saved on every keystroke, and saved on unmount, so
 * ending a meeting cannot take the last sentence with it.
 */
function ScratchPad({ meetingId }: { meetingId: number | null }): React.JSX.Element {
  const [text, setText] = useState('')
  const latest = useRef('')
  latest.current = text

  useEffect(() => {
    setText('')
  }, [meetingId])

  useEffect(() => {
    if (meetingId === null) return
    const timer = setTimeout(() => {
      void window.wouice.setMeetingScratch(meetingId, latest.current)
    }, 600)
    return () => clearTimeout(timer)
  }, [text, meetingId])

  useEffect(() => {
    if (meetingId === null) return
    return () => {
      void window.wouice.setMeetingScratch(meetingId, latest.current)
    }
  }, [meetingId])

  return (
    <section className="lift flex flex-col rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
      <h2 className="mb-2 text-[12px] font-medium text-neutral-400">Your notes</h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={meetingId === null}
        placeholder={
          'pricing?? john wants Q3\ndemo went well — latency q\nthey need SSO before rollout'
        }
        className="min-h-[200px] flex-1 resize-none rounded-md bg-black/25 px-3 py-2 text-[12.5px] leading-relaxed text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-700 focus:ring-white/20 disabled:opacity-50"
      />
      <p className="mt-2 text-[11px] leading-snug text-neutral-600">
        Rough is fine. These get folded into the notes afterwards — they are what tells the
        summary which parts mattered to you.
      </p>
    </section>
  )
}

function ChannelMeter({
  view,
  active,
}: {
  view: MeetingChannelView
  active: boolean
}): React.JSX.Element {
  const label = view.channel === 'me' ? 'You' : 'Them'
  return (
    <div
      className="flex items-center gap-1.5"
      title={view.problem ?? `${label}: ${view.channel === 'me' ? 'microphone' : 'system audio'}`}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        // Inline rather than a class: the state colour is data, and a class
        // that changes with it has been observed not to repaint here.
        style={{
          backgroundColor: view.problem
            ? '#f87171'
            : view.live
              ? '#34d399'
              : active
                ? '#fbbf24'
                : '#525252',
        }}
      />
      <span className="text-[11.5px] text-neutral-400">{label}</span>
      <div className="h-1 w-14 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{
            width: `${Math.round(Math.min(1, view.level) * 100)}%`,
            backgroundColor: view.channel === 'me' ? '#34d399' : '#60a5fa',
          }}
        />
      </div>
    </div>
  )
}

function defaultChannels(): MeetingChannelView[] {
  return [
    { channel: 'me', live: false, samples: 0, level: 0, problem: null },
    { channel: 'them', live: false, samples: 0, level: 0, problem: null },
  ]
}

/**
 * The one thing that went wrong, said in the list rather than buried.
 *
 * A meeting that recorded only one channel, or lost a fifth of its audio to a
 * failing speech model, looks exactly like a good one from the outside - and
 * you find out an hour later, reading a transcript with half a conversation in
 * it. Saying it on the row is what turns that into a question you ask now.
 */
function problemOf(meeting: MeetingRecord): string | null {
  const d = meeting.diagnostics
  const silent = (d.channels ?? []).filter((c) => c.samples === 0)
  if (silent.length === 1) {
    return `${silent[0]!.channel === 'me' ? 'your microphone' : 'system audio'} recorded nothing`
  }
  const failed = d.chunksFailed ?? 0
  const sent = d.chunksSent ?? 0
  if (failed > 0 && failed >= (sent + failed) * 0.1) return `${failed} chunks failed to transcribe`
  if (meeting.endedAt === null) return 'never finished'
  const lastRun = (d.notes ?? []).at(-1)
  if (lastRun && !lastRun.ok) return 'notes failed'
  return null
}

function describeNotes(progress: NotesProgressView): string {
  // Named by what it is doing, not by a percentage. A bar that sits at 60% for
  // twenty seconds is less informative than "reading part 3 of 5".
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

function describePhase(phase: string): string {
  switch (phase) {
    case 'starting':
      return 'opening the microphone and system audio'
    case 'recording':
      return 'recording'
    case 'stopping':
      return 'closing the streams'
    case 'merging':
      return 'writing the audio and finishing the transcript'
    default:
      return 'not recording'
  }
}

/** `mm:ss`, or `h:mm:ss` once there is an hour of it. */
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
