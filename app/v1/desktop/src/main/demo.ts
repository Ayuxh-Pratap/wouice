/**
 * A bot in a call, without a call.
 *
 * The live side of the app cannot be photographed from a database: the bot's
 * run exists only in memory, for as long as the call does, and when the call
 * ends the state being photographed is gone. This stands one up from the demo
 * profile - the run the pages read, and a caption line arriving every few
 * seconds, so a transcript fills while you watch it.
 *
 * ONLY WITH `WOUICE_DEMO=1`, which `scripts/demo-run.mjs` sets. It works on the
 * unfinished bot meeting that `scripts/demo-seed.ts` leaves in a profile of its
 * own, and touches nothing else: no Chrome is started, no meeting of yours is
 * opened, and in a normal run none of this is reachable.
 */

import { ipcMain } from 'electron'
import { MEET_CAPTIONS_SOURCE, type Store } from '@wouice/store'
import { IPC, type BotRunView } from '../shared/ipc.js'
import { broadcast } from './windows.js'

/** Lines still to come, in the order Meet would send them. Invented, like the rest of the profile. */
const ARRIVING: { who: string; text: string; en: string }[] = [
  { who: 'Devansh Rao', text: 'वो retry वाला काम हो गया है, कल deploy कर दूंगा', en: 'The retry work is done - I will deploy it tomorrow' },
  { who: 'Aarav Mehta', text: 'अच्छा, तो launch अट्ठाईस को हो जाएगा', en: 'Good, so the launch can be on the 28th' },
  { who: 'Priya Nair', text: 'pricing page का नया copy भी ready है', en: 'The new copy for the pricing page is ready too' },
  { who: 'Aarav Mehta', text: 'उसको आज ही review कर लेते हैं', en: 'Let us review it today itself' },
  { who: 'Devansh Rao', text: 'PayKit वाला step inline हो सकता है, मैंने देख लिया', en: 'The PayKit step can be inline - I have checked' },
  { who: 'Priya Nair', text: 'तो onboarding का drop कम हो जाएगा', en: 'Then the drop-off in onboarding will come down' },
]

/** How often a line arrives. Slow enough to read, quick enough to photograph. */
const EVERY_MS = 4_000

export function startDemoBot(store: Store): void {
  const live = store.meetings.list(20).find((m) => m.endedAt === null && m.dir.endsWith('-bot'))
  if (!live) {
    console.warn('[demo] no unfinished bot meeting in this profile; run: npm run demo:seed')
    return
  }

  const view: BotRunView = {
    id: new Date(live.startedAt).toISOString().replace(/[:.]/g, '-'),
    url: 'https://meet.google.com/dmo-aqpz-xyz',
    state: 'in-meeting',
    reason: null,
    message: '',
    startedAt: live.startedAt,
    since: live.startedAt,
    attempt: 1,
    dir: live.dir,
    participants: 2,
    meetingId: live.id,
    lines: live.segments,
    warning: null,
  }

  // The page asks once when it opens, and is told again on every change.
  ipcMain.removeHandler(IPC.getBotRun)
  ipcMain.handle(IPC.getBotRun, () => view)
  broadcast(IPC.botRun, view)

  let next = 0
  const timer = setInterval(() => {
    const line = ARRIVING[next++]
    if (!line) {
      clearInterval(timer)
      return
    }
    const at = Date.now() - live.startedAt
    try {
      const versionId = store.meetings.appendToVersion(live.id, MEET_CAPTIONS_SOURCE, [
        { channel: line.who === 'Aarav Mehta' ? 'me' : 'them', startMs: at, endMs: at + 3_500, text: line.text, echo: false, speaker: line.who },
      ])
      const stored = store.meetings.segments(live.id, versionId)
      const added = stored.at(-1)
      if (added) store.meetings.setEnglish([{ id: added.id, textEn: line.en }])
      view.lines = stored.length
      broadcast(IPC.botRun, view)
      broadcast(IPC.meetingUpdated, live.id)
    } catch (err) {
      console.warn('[demo] could not add a line:', err)
      clearInterval(timer)
    }
  }, EVERY_MS)
  timer.unref?.()

  console.log(`[demo] the bot is "in" meeting ${live.id}; ${ARRIVING.length} more lines will arrive, one every ${EVERY_MS / 1000}s`)
}
