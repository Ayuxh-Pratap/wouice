import { useCallback, useEffect, useState } from 'react'
import type { MeetingChannelView, MeetingState, RecordedMeeting } from '../../shared/ipc.js'
import { useMeetingCapture } from '../meetings/useMeetingCapture.js'

/**
 * Meetings.
 *
 * WHAT THIS IS TODAY, SAID PLAINLY. Stage 1 records; it does not transcribe.
 * The page says so rather than showing an empty transcript panel that looks
 * broken, because a surface that promises what it cannot do is worse than one
 * that is honestly partial - you stop trusting the parts that do work.
 *
 * THE SHAPE IS THE FINISHED SHAPE. One card for what is happening now, one list
 * of what has happened. Transcript, notes and tasks all arrive inside a row of
 * that list, so nothing here has to be rearranged to make room for them.
 *
 * TWO METERS, NOT ONE. Which half is being heard is the single most useful
 * thing to show while recording: a meeting where the far side was never
 * captured looks and sounds exactly like a good one until you play it back an
 * hour later. Each channel carries its own live state and its own failure.
 */

const RECORDING_PHASES = new Set(['starting', 'recording', 'stopping', 'merging'])

export function MeetingsPage(): React.JSX.Element {
  const [state, setState] = useState<MeetingState | null>(null)
  const [meetings, setMeetings] = useState<RecordedMeeting[]>([])
  const [busy, setBusy] = useState(false)

  useMeetingCapture(state)

  const refresh = useCallback(() => {
    void window.wouice.listMeetings().then(setMeetings)
  }, [])

  useEffect(() => {
    void window.wouice.getMeetingState().then(setState)
    refresh()
    return window.wouice.onMeetingState((next) => {
      setState((previous) => {
        // The list only changes when a meeting ends, so it is fetched then
        // rather than on every one of four state pushes a second.
        if (previous && previous.phase !== 'idle' && next.phase === 'idle') refresh()
        return next
      })
    })
  }, [refresh])

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
      <section className="lift rounded-xl bg-white/[0.035] px-4 py-3.5 ring-1 ring-white/[0.08]">
        <div className="flex items-center gap-4">
          <button
            onClick={() => void toggle()}
            disabled={busy || phase === 'merging'}
            className={
              'shrink-0 rounded-lg px-4 py-2 text-[13px] font-medium transition disabled:opacity-40 ' +
              (active
                ? 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30 hover:bg-red-500/25'
                : 'bg-white/[0.06] text-neutral-200 ring-1 ring-white/10 hover:bg-white/[0.12]')
            }
          >
            {active ? 'Stop recording' : 'Start recording'}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-medium tabular-nums text-neutral-100">
                {formatElapsed(state?.elapsedMs ?? 0)}
              </span>
              <span className="text-[12px] text-neutral-500">{describePhase(phase)}</span>
            </div>
            {state?.message ? (
              <p className="mt-0.5 text-[12px] text-amber-300">{state.message}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-3.5 grid gap-2 sm:grid-cols-2">
          {(state?.channels ?? defaultChannels()).map((channel) => (
            <ChannelMeter key={channel.channel} view={channel} active={active} />
          ))}
        </div>

        {!active && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-neutral-500">
            Records two channels: your microphone and the audio your computer is playing. Nothing
            joins the call and nobody is notified. Transcription, notes and tasks come next — for
            now this saves the audio.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 px-0.5 text-[12px] font-medium text-neutral-400">
          Recorded {meetings.length ? `(${meetings.length})` : ''}
        </h2>

        {meetings.length === 0 ? (
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
                key={meeting.dir}
                className="lift flex items-center gap-3 rounded-xl bg-white/[0.035] px-4 py-2.5 ring-1 ring-white/[0.08]"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-neutral-200">
                    {formatWhen(meeting.startedAt)}
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-neutral-500">
                    {formatDuration(meeting.durationMs)} · {formatBytes(meeting.bytes)} · you on the
                    left, them on the right
                  </p>
                </div>
                <button
                  onClick={() => window.wouice.revealMeeting(meeting.dir)}
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] text-neutral-500 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-300"
                >
                  Show file
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
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
  const source = view.channel === 'me' ? 'microphone' : 'system audio'

  return (
    <div className="rounded-lg bg-black/20 px-3 py-2 ring-1 ring-white/[0.06]">
      <div className="flex items-center gap-2">
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
        <span className="text-[12px] text-neutral-300">{label}</span>
        <span className="text-[11px] text-neutral-600">{source}</span>
        <span className="ml-auto text-[11px] tabular-nums text-neutral-600">
          {view.samples > 0 ? formatDuration((view.samples / 16_000) * 1000) : ''}
        </span>
      </div>

      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{
            width: `${Math.round(Math.min(1, view.level) * 100)}%`,
            backgroundColor: view.channel === 'me' ? '#34d399' : '#60a5fa',
          }}
        />
      </div>

      {view.problem ? (
        <p className="mt-1.5 text-[11px] leading-snug text-red-300">{view.problem}</p>
      ) : null}
    </div>
  )
}

function defaultChannels(): MeetingChannelView[] {
  return [
    { channel: 'me', live: false, samples: 0, level: 0, problem: null },
    { channel: 'them', live: false, samples: 0, level: 0, problem: null },
  ]
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
      return 'writing the audio file'
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

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
