import { useEffect, useState } from 'react'
import type { BotRunView } from '../../shared/ipc.js'
import { hashForMeeting } from '../shell/routes.js'

/**
 * Send the bot to a meeting, and see where it is.
 *
 * Paste a link, watch it go, and read why it stopped when it does. While it is
 * in the call it keeps Meet's captions as a meeting of their own, which opens
 * from here; anything wrong with what it is keeping shows under it in amber.
 */

const ACTIVE = new Set<BotRunView['state']>([
  'checking',
  'launching',
  'joining',
  'waiting-room',
  'waiting-for-host',
  'in-meeting',
  'leaving',
])

function describe(run: BotRunView): string {
  switch (run.state) {
    case 'checking':
      return 'Checking the bot is signed in…'
    case 'launching':
      return run.attempt > 1 ? `Opening Chrome, attempt ${run.attempt} of 3…` : 'Opening Chrome…'
    case 'joining':
      return 'Joining…'
    case 'waiting-room':
      return 'Asked to join — waiting to be let in'
    case 'waiting-for-host':
      return 'Waiting for the host to start the meeting'
    case 'in-meeting': {
      const where =
        run.participants > 0
          ? `In the meeting, with ${run.participants} other${run.participants === 1 ? '' : 's'}`
          : 'In the meeting'
      return run.lines > 0 ? `${where} · ${run.lines} line${run.lines === 1 ? '' : 's'} kept` : where
    }
    case 'leaving':
      return 'Leaving…'
    default:
      return run.message
  }
}

function colour(run: BotRunView): string {
  if (run.state === 'failed') return '#f87171'
  if (run.state === 'ended') return '#737373'
  if (run.state === 'in-meeting') return '#34d399'
  return '#fbbf24'
}

/** @param captions the language Meet will caption in, as "Spoken in" above decides it. */
export function BotPanel({ captions }: { captions: string }): React.JSX.Element {
  const [run, setRun] = useState<BotRunView | null>(null)
  const [link, setLink] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void window.wouice.getBotRun().then(setRun)
    return window.wouice.onBotRun(setRun)
  }, [])

  const active = run !== null && ACTIVE.has(run.state)

  const send = (): void => {
    setProblem(null)
    void window.wouice.sendBot(link).then((why) => {
      setProblem(why)
      if (!why) setLink('')
    })
  }

  return (
    <section className="lift rounded-xl bg-white/[0.035] px-3 py-2.5 ring-1 ring-white/[0.08]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-[12.5px] font-medium text-neutral-300">Meeting bot</span>
        {active ? (
          <>
            <span className="flex min-w-0 items-center gap-1.5 text-[12px]" style={{ color: colour(run) }}>
              <span
                className={`size-1.5 shrink-0 rounded-full ${run.state === 'in-meeting' ? '' : 'animate-pulse'}`}
                style={{ backgroundColor: colour(run) }}
              />
              <span className="truncate">{describe(run)}</span>
            </span>
            {run.meetingId !== null ? <MeetingLink meetingId={run.meetingId} /> : null}
            <button
              onClick={() => void window.wouice.leaveBot()}
              disabled={run.state === 'leaving'}
              className="ml-auto shrink-0 rounded-md px-2.5 py-1 text-[11.5px] text-neutral-300 ring-1 ring-white/10 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
            >
              Tell it to leave
            </button>
          </>
        ) : (
          <>
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && link.trim()) send()
              }}
              placeholder="Paste a Meet link"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md bg-black/25 px-2.5 py-1 text-[12px] text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-600 focus:ring-white/20"
            />
            <button
              onClick={send}
              disabled={!link.trim()}
              className="shrink-0 rounded-md bg-white/[0.06] px-2.5 py-1 text-[11.5px] font-medium text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/[0.12] disabled:opacity-40"
            >
              Send the bot
            </button>
          </>
        )}
      </div>

      {run && !active ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px]">
          <span style={{ color: colour(run) }}>{run.message}</span>
          {run.meetingId !== null ? <MeetingLink meetingId={run.meetingId} /> : null}
          <button
            onClick={() => window.wouice.revealBotRun()}
            className="text-neutral-500 underline-offset-2 transition hover:text-neutral-300 hover:underline"
          >
            Show what it saw
          </button>
        </p>
      ) : null}
      {!active ? (
        <p className="mt-1.5 text-[11px] text-neutral-500">Captions in {captions}, from “Spoken in” above.</p>
      ) : null}
      {run?.warning ? <p className="mt-1.5 text-[11.5px] text-amber-400">{run.warning}</p> : null}
      {problem ? <p className="mt-1.5 text-[11.5px] text-amber-400">{problem}</p> : null}
    </section>
  )
}

function MeetingLink({ meetingId }: { meetingId: number }): React.JSX.Element {
  return (
    <a
      href={hashForMeeting(meetingId)}
      className="shrink-0 text-[11.5px] text-neutral-500 underline-offset-2 transition hover:text-neutral-300 hover:underline"
    >
      Open the meeting
    </a>
  )
}
