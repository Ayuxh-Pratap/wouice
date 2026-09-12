import { useEffect, useState } from 'react'
import type { BotRunView } from '../../shared/ipc.js'

/**
 * The meeting bot's current run, for every screen that has to agree on it.
 *
 * A meeting the bot is filling is live: its duration counts up, and its
 * English, summary and tasks do not exist yet because they are written when
 * the bot leaves. Read in three places - the bot panel, the list and the
 * meeting's own page - so they are told in one.
 */

/** On its way to a call, in one, or leaving it. */
export const BOT_ACTIVE = new Set<BotRunView['state']>([
  'checking',
  'launching',
  'joining',
  'waiting-room',
  'waiting-for-host',
  'in-meeting',
  'leaving',
])

/** The current run, kept up to date. Null before the bot has been sent anywhere. */
export function useBotRun(): BotRunView | null {
  const [run, setRun] = useState<BotRunView | null>(null)
  useEffect(() => {
    void window.wouice.getBotRun().then(setRun)
    return window.wouice.onBotRun(setRun)
  }, [])
  return run
}

/** Whether the bot is in this meeting's call right now. */
export function botIsIn(run: BotRunView | null, meetingId: number): boolean {
  return run !== null && run.meetingId === meetingId && (run.state === 'in-meeting' || run.state === 'leaving')
}

/** The time, ticking every second while `on`, for a duration that counts up. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [on])
  return now
}
