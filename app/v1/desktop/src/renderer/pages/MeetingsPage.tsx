import { useCallback, useEffect, useRef, useState } from 'react'
import type { MeetingJobsView, MeetingSegment, MeetingState } from '../../shared/ipc.js'
import type { MeetingRecord } from '@wouice/store'
import type { Settings } from '../../shared/settings.js'
import { MEETING_KINDS, type MeetingKind } from '../../shared/meeting-kind.js'
import { describeJob, jobColour, useMeetingJobs } from '../meetings/jobs.js'
import { isImproved, mainVersion } from '../meetings/versions.js'
import { hashForMeeting } from '../shell/routes.js'
import { Transcript } from '../meetings/Transcript.js'

/**
 * Meetings: the overview.
 *
 * MANAGEMENT ONLY. Start one, find one, open one, remove one. Everything about
 * a particular meeting - its transcript, its summary, its tasks, what you typed
 * during it - lives on that meeting's own page, and starting a recording takes
 * you straight there.
 *
 * NO METERS HERE. They belonged to a screen you sat and watched, and this is not
 * one. The two channel lights follow you into the meeting, which is where
 * knowing the far side is being captured is still worth something.
 */

const RECORDING_PHASES = new Set(['starting', 'recording', 'stopping', 'merging'])

export function MeetingsPage(): React.JSX.Element {
  const [state, setState] = useState<MeetingState | null>(null)
  const [meetings, setMeetings] = useState<MeetingRecord[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [offer, setOffer] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MeetingSegment[] | null>(null)
  const [busy, setBusy] = useState(false)
  /** Why the last Remove did not happen: still recording, or the file is open. */
  const [removeProblem, setRemoveProblem] = useState<string | null>(null)
  /** So a meeting that has already sent us to its page cannot do it twice. */
  const sentTo = useRef(0)
  const jobs = useMeetingJobs()

  const refresh = useCallback(() => {
    void window.wouice.listMeetings().then(setMeetings)
  }, [])

  useEffect(() => {
    void window.wouice.getSettings().then(setSettings)
    void window.wouice.getMeetingState().then(setState)
    void window.wouice.getMeetingOffer().then(setOffer)
    refresh()

    const offSettings = window.wouice.onSettingsChanged(setSettings)
    const offOffer = window.wouice.onMeetingOffer(setOffer)
    const offState = window.wouice.onMeetingState((next) => {
      setState(next)
      // Into the meeting, the moment there is one. Whether it was started here
      // or offered by the watcher, the recording is what you want in front of
      // you - not the list of every other meeting.
      if (
        next.meetingId !== null &&
        sentTo.current !== next.meetingId &&
        RECORDING_PHASES.has(next.phase)
      ) {
        sentTo.current = next.meetingId
        window.location.hash = hashForMeeting(next.meetingId)
      }
      if (next.phase === 'idle') refresh()
    })
    const offProcessed = window.wouice.onMeetingProcessed(() => refresh())

    return () => {
      offSettings()
      offOffer()
      offState()
      offProcessed()
    }
  }, [refresh])

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

  const active = RECORDING_PHASES.has(state?.phase ?? 'idle')

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.wouice.startMeeting()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (meeting: MeetingRecord): Promise<void> => {
    setRemoveProblem(await window.wouice.deleteMeeting(meeting.id))
    refresh()
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
            onClick={() => void start()}
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

      <section className="lift flex flex-wrap items-center gap-3 rounded-xl bg-white/[0.035] px-3 py-2.5 ring-1 ring-white/[0.08]">
        <button
          onClick={() => void start()}
          disabled={busy || active}
          className="shrink-0 rounded-lg bg-white/[0.06] px-3.5 py-1.5 text-[12.5px] font-medium text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/[0.12] disabled:opacity-40"
        >
          {active ? 'Recording…' : 'Start recording'}
        </button>

        {/*
          Chosen BEFORE the button. The recognition language is fixed the moment
          the first chunk is sent, and automatic detection starts a meeting from
          a notification, where there is no other chance to say.
        */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-[11.5px] text-neutral-500">Spoken in</span>
          <select
            value={settings?.meetings.defaultKind ?? 'mixed'}
            disabled={active || !settings}
            onChange={(e) => {
              const defaultKind = e.target.value as MeetingKind
              setSettings((current) =>
                current ? { ...current, meetings: { ...current.meetings, defaultKind } } : current
              )
              void window.wouice.setSettings({ meetings: { ...settings!.meetings, defaultKind } })
            }}
            className="rounded-md bg-neutral-950 px-2 py-1 text-[12px] text-neutral-200 ring-1 ring-white/10 outline-none focus:ring-white/25 disabled:opacity-50"
          >
            {MEETING_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      </section>

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

        {removeProblem ? (
          <p className="mb-2 px-0.5 text-[11.5px] text-amber-400">{removeProblem}</p>
        ) : null}

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
                <a
                  href={hashForMeeting(meeting.id)}
                  className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-white/[0.03]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-neutral-200">
                      {meeting.title ?? formatWhen(meeting.startedAt)}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-neutral-500">
                      {meeting.endedAt === null ? (
                        <span className="text-amber-400">never finished · </span>
                      ) : null}
                      {formatDuration(meeting.durationMs)} · {meeting.segments} line
                      {meeting.segments === 1 ? '' : 's'}
                      {meeting.notesMd ? ' · summarised' : ''}
                      {isImproved(meeting) ? (
                        <span className="text-sky-300/80"> · improved</span>
                      ) : null}
                      {problemOf(meeting) ? (
                        <span className="text-amber-400"> · {problemOf(meeting)}</span>
                      ) : null}
                    </p>
                  </div>
                  <JobChip meetingId={meeting.id} jobs={jobs} />
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      void remove(meeting)
                    }}
                    title="Removes it from Wouice and moves the recording to the Recycle Bin."
                    className="shrink-0 rounded-md px-2 py-1 text-[11px] text-neutral-600 ring-1 ring-white/10 transition hover:bg-red-500/10 hover:text-red-300"
                  >
                    Remove
                  </button>
                  <span className="shrink-0 text-[13px] text-neutral-600">›</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * The one thing that went wrong, said in the list rather than buried.
 *
 * A meeting that recorded only one channel looks exactly like a good one from
 * the outside, and you find out an hour later reading half a conversation.
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
  const lastRun = (mainVersion(meeting)?.diagnostics.notes ?? []).at(-1)
  if (lastRun && !lastRun.ok) return 'summary failed'
  return null
}

/**
 * Work on a meeting, on its own row: green while it writes, orange while it is
 * improved, grey while it waits its turn. Read from the job queue, so the list
 * is right the moment it is opened rather than at the next progress message.
 */
function JobChip({
  meetingId,
  jobs,
}: {
  meetingId: number
  jobs: MeetingJobsView
}): React.JSX.Element | null {
  const running = jobs.running?.meetingId === meetingId ? jobs.running : null
  const waiting = running ? null : jobs.queued.find((j) => j.meetingId === meetingId)
  if (!running && !waiting) return null
  const colour = running ? jobColour(running.kind) : '#737373'
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-[11px]"
      style={{ color: running ? colour : '#a3a3a3' }}
    >
      <span
        className={`size-1.5 rounded-full ${running ? 'animate-pulse' : ''}`}
        style={{ backgroundColor: colour }}
      />
      {running ? describeJob(running.kind) : 'Waiting'}
    </span>
  )
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
