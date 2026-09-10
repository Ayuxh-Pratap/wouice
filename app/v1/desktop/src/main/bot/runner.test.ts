import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotRunView } from '../../shared/ipc.js'
import type { BotBrowser, ClickTarget } from './browser.js'
import type { PageSnapshot } from './meet-ui.js'
import { MeetingBot, pruneRuns } from './runner.js'

/**
 * The bot's run, against a scripted Meet page and a clock that only moves
 * when the bot waits. The rule under test: every way a run ends has a name,
 * and a failure leaves evidence.
 */

let runsDir: string

beforeEach(() => {
  runsDir = mkdtempSync(path.join(os.tmpdir(), 'wouice-bot-runs-'))
})

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true })
})

const snap = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  text: '',
  nameInput: false,
  joinButton: null,
  leaveButton: false,
  continueWithoutDevices: false,
  micOn: false,
  cameraOn: false,
  dialogOk: false,
  participants: 0,
  url: '',
  ...over,
})

const LOADING = snap()
const LOBBY = snap({ joinButton: 'Ask to join', micOn: true, cameraOn: true })
const ASKING = snap({ text: 'Asking to be let in' })
const IN = (people: number): PageSnapshot => snap({ leaveButton: true, participants: people })

/** A page that answers each look from a script; the last entry repeats. */
function fakeBrowser(script: PageSnapshot[] | ((look: number, clock: number) => PageSnapshot), clock: () => number) {
  const clicks: ClickTarget[] = []
  const files: string[] = []
  let looks = 0
  let closed = false
  const browser: BotBrowser = {
    chromeVersion: '153.0.8010.36',
    page: {
      goto: async () => undefined,
      snapshot: async () => {
        const n = looks++
        return typeof script === 'function' ? script(n, clock()) : script[Math.min(n, script.length - 1)]!
      },
      click: async (target) => {
        clicks.push(target)
        return true
      },
      screenshot: async (file) => {
        files.push(path.basename(file))
      },
      mhtml: async (file) => {
        files.push(path.basename(file))
      },
    },
    get closed() {
      return closed
    },
    close: async () => {
      closed = true
    },
  }
  return { browser, clicks, files, die: () => (closed = true) }
}

function bot(options: {
  script: PageSnapshot[] | ((look: number, clock: number) => PageSnapshot)
  signedIn?: string | null
  launches?: { count: number }
}) {
  let clock = 1_000_000
  const made: ReturnType<typeof fakeBrowser>[] = []
  const views: BotRunView[] = []
  const meetingBot = new MeetingBot({
    runsDir,
    ensureSignedIn: async () => options.signedIn ?? null,
    launch: async () => {
      if (options.launches) options.launches.count++
      const fake = fakeBrowser(options.script, () => clock)
      made.push(fake)
      return fake.browser
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  })
  meetingBot.on('run', (view: BotRunView) => views.push(view))
  return { meetingBot, made, views, advance: (ms: number) => (clock += ms) }
}

const LINK = 'https://meet.google.com/abc-defg-hij'

describe('sending the bot', () => {
  it('refuses something that is not a Meet link', () => {
    const { meetingBot } = bot({ script: [LOBBY] })
    expect(meetingBot.send('https://zoom.us/j/1')).toMatch(/not a Google Meet link/)
    expect(meetingBot.view()).toBeNull()
  })

  it('goes to one meeting at a time', async () => {
    const { meetingBot } = bot({ script: [LOBBY, IN(2), snap({ text: 'Your host ended the meeting for everyone' })] })
    expect(meetingBot.send(LINK)).toBeNull()
    expect(meetingBot.send(LINK)).toMatch(/already in a meeting/)
    await meetingBot.settled()
  })

  it('never launches a signed-out profile', async () => {
    const launches = { count: 0 }
    const { meetingBot } = bot({ script: [LOBBY], signedIn: 'The bot is not signed in.', launches })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'failed', reason: 'login-required', message: 'The bot is not signed in.' })
    expect(launches.count).toBe(0)
  })
})

describe('joining', () => {
  it('asks to join with mic and camera off, waits, gets in, and leaves when the call ends', async () => {
    const { meetingBot, made, views } = bot({
      script: [LOADING, LOBBY, ASKING, ASKING, IN(3), IN(3), snap({ text: 'Your host ended the meeting for everyone' })],
    })
    meetingBot.send(LINK)
    await meetingBot.settled()

    expect(made[0]!.clicks).toEqual(['mic-off', 'camera-off', 'join'])
    expect(views.map((v) => v.state)).toEqual([
      'checking',
      'launching',
      'joining',
      'waiting-room',
      'in-meeting',
      'in-meeting', // the participant count arriving
      'ended',
    ])
    expect(meetingBot.view()).toMatchObject({ state: 'ended', reason: 'meeting-ended', participants: 2 })
    expect(made[0]!.browser.closed).toBe(true)
  })

  it('walks straight in when it is invited, pressing nothing it does not need to', async () => {
    const { meetingBot, made } = bot({ script: [snap({ joinButton: 'Join now' }), IN(2)] })
    meetingBot.send(LINK)
    meetingBot.leave()
    await meetingBot.settled()
    expect(made.length).toBeLessThanOrEqual(1)
  })

  it('does not retry a refusal, and keeps a screenshot and the page', async () => {
    const launches = { count: 0 }
    const { meetingBot, made } = bot({
      script: [LOBBY, ASKING, snap({ text: 'Someone in the call denied your request to join' })],
      launches,
    })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'failed', reason: 'denied' })
    expect(launches.count).toBe(1)
    expect(made[0]!.files).toEqual(['attempt-1-denied.png', 'attempt-1-denied.mhtml'])
  })

  it('gives a page it does not recognise three tries in a fresh Chrome, then says so', async () => {
    const launches = { count: 0 }
    const { meetingBot } = bot({ script: [LOADING], launches })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(launches.count).toBe(3)
    expect(meetingBot.view()).toMatchObject({ state: 'failed', reason: 'ui-not-found', attempt: 3 })
  })

  it('stops waiting to be let in after the lobby limit', async () => {
    const { meetingBot } = bot({ script: [LOBBY, ASKING] })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'failed', reason: 'waiting-room-timeout' })
  })

  it('reports a wrong code without trying again', async () => {
    const launches = { count: 0 }
    const { meetingBot } = bot({ script: [snap({ text: 'Check your meeting code' })], launches })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'failed', reason: 'not-found' })
    expect(launches.count).toBe(1)
  })

  it('treats the guest name box as signed out, never joining as a guest', async () => {
    const { meetingBot, made } = bot({ script: [snap({ nameInput: true, joinButton: 'Ask to join' })] })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'failed', reason: 'login-required' })
    expect(made[0]!.clicks).not.toContain('join')
  })
})

describe('leaving', () => {
  it('leaves a minute after everyone else has gone', async () => {
    const { meetingBot, made } = bot({
      script: (look, clock) => (look < 2 ? (look === 0 ? LOBBY : IN(3)) : clock < 1_010_000 ? IN(3) : IN(1)),
    })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'ended', reason: 'alone' })
    expect(made[0]!.clicks.at(-1)).toBe('leave')
  })

  it('does not leave when the participant count cannot be read at all', async () => {
    // Zero tiles means the selector found nothing - not that nobody is there.
    const { meetingBot } = bot({
      script: (look, clock) => (look === 0 ? LOBBY : clock < 1_000_000 + 2 * 60 * 60_000 ? IN(0) : snap({ text: 'Your host ended the meeting for everyone' })),
    })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()?.reason).toBe('meeting-ended')
  })

  it('knows being removed from the call ending', async () => {
    const { meetingBot, made } = bot({ script: [LOBBY, IN(2), snap({ text: "You've been removed from the meeting" })] })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'ended', reason: 'removed' })
    // No leave button to press once removed.
    expect(made[0]!.clicks).not.toContain('leave')
  })

  it('leaves when asked, pressing the leave button', async () => {
    // Asked from inside the meeting: with a clock that only moves when the bot
    // waits, the whole run would otherwise be over before anyone could ask.
    const holder: { bot?: MeetingBot } = {}
    const { meetingBot, made } = bot({
      script: (look) => {
        if (look === 3) holder.bot!.leave()
        return look === 0 ? LOBBY : IN(2)
      },
    })
    holder.bot = meetingBot
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'ended', reason: 'asked' })
    expect(made[0]!.clicks).toContain('leave')
  })

  it('notices Chrome dying in the middle of a call', async () => {
    let fake: ReturnType<typeof fakeBrowser> | null = null
    let clock = 5_000
    const meetingBot = new MeetingBot({
      runsDir,
      ensureSignedIn: async () => null,
      launch: async () => {
        fake = fakeBrowser((look) => {
          if (look > 3) fake!.die()
          return look === 0 ? LOBBY : IN(2)
        }, () => clock)
        return fake.browser
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'failed', reason: 'browser-died' })
  })

  it('leaves after the longest a meeting may run', async () => {
    const { meetingBot } = bot({ script: [LOBBY, IN(4)] })
    meetingBot.send(LINK)
    await meetingBot.settled()
    expect(meetingBot.view()).toMatchObject({ state: 'ended', reason: 'max-duration' })
  })
})

describe('the record of a run', () => {
  it('writes what happened, when, into the run folder', async () => {
    const { meetingBot } = bot({ script: [snap({ text: 'Check your meeting code' })] })
    meetingBot.send(LINK)
    await meetingBot.settled()
    const dir = meetingBot.view()!.dir
    const record = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')) as {
      state: string
      reason: string
      chromeVersion: string
      events: { state?: string; note?: string }[]
    }
    expect(record).toMatchObject({ state: 'failed', reason: 'not-found', chromeVersion: '153.0.8010.36' })
    expect(record.events.map((e) => e.state).filter(Boolean)).toEqual(['checking', 'launching', 'joining', 'failed'])
  })

  it('keeps only the newest runs', () => {
    for (const name of ['2026-01-01', '2026-01-02', '2026-01-03']) mkdirSync(path.join(runsDir, name))
    pruneRuns(runsDir, 2)
    expect(readdirSync(runsDir).sort()).toEqual(['2026-01-02', '2026-01-03'])
  })
})
