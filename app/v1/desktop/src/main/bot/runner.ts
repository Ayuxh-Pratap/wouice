import { EventEmitter } from 'node:events'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BotRunReason, BotRunState, BotRunView } from '../../shared/ipc.js'
import type { BotBrowser } from './browser.js'
import { meetUrl, readPage, type PageSnapshot } from './meet-ui.js'

/**
 * One run of the meeting bot: join, wait to be let in, stay, leave.
 *
 * EVERY WAY IT ENDS HAS A NAME. "The bot didn't work" has a dozen different
 * fixes - it was never let in, the meeting code was wrong, the profile was
 * signed out, Meet refused it, Meet changed its page. Each is a named reason,
 * and every failure leaves a screenshot and a snapshot of the page in the
 * run's folder beside a `run.json` of what happened when. The taxonomy is
 * Attendee's (docs/design/07-meeting-bot.md §2.4), cut down to one user.
 *
 * RETRIED ONLY WHEN TRYING AGAIN CAN HELP. Meet not loading or its page not
 * looking as expected gets two more attempts in a fresh Chrome. A wrong code,
 * a refusal, a signed-out profile or a "no" from the host never does: another
 * attempt would get the same answer, a minute later.
 *
 * STAGE B1: no captions and no audio. The bot joins and leaves correctly and
 * says why; what it keeps comes in B2.
 */

export interface BotTimings {
  /** How often the page is looked at. */
  pollMs: number
  /** From opening the link to a join button, or to being in. */
  loadMs: number
  /** Waiting to be let in. */
  lobbyMs: number
  /** Waiting for the host to start the meeting. */
  hostMs: number
  /** Alone after other people had been there. */
  aloneMs: number
  /** Alone from the start, nobody else ever arriving. */
  aloneAtStartMs: number
  /** The leave button gone with no message saying why. */
  lostMs: number
  /** The longest a run is allowed to last. */
  maxMs: number
}

export const DEFAULT_TIMINGS: BotTimings = {
  pollMs: 1_000,
  loadMs: 60_000,
  lobbyMs: 10 * 60_000,
  hostMs: 10 * 60_000,
  aloneMs: 60_000,
  aloneAtStartMs: 15 * 60_000,
  lostMs: 30_000,
  maxMs: 3 * 60 * 60_000,
}

const ATTEMPTS = 3
const RETRYABLE = new Set<BotRunReason>(['could-not-connect', 'ui-not-found', 'browser-died'])
/** Runs whose folders are kept; older ones are deleted when a new run starts. */
const KEEP_RUNS = 20

const FAILED: Partial<Record<BotRunReason, string>> = {
  'login-required': "The bot's Chrome profile is not signed in. Sign it in under Settings → Meetings.",
  'not-found': 'Meet says there is no such meeting. Check the link.',
  blocked: "Meet would not let the bot in (\"You can't join this video call\").",
  denied: 'The request to join was turned down, or nobody answered it.',
  'waiting-room-timeout': 'Nobody let the bot in.',
  'host-never-came': 'The host never started the meeting.',
  'could-not-connect': 'Meet did not load.',
  'ui-not-found': "Meet's page was not what the bot expected. The screenshot in the run folder shows what it saw.",
  'browser-died': 'Chrome closed unexpectedly.',
  'lost-meeting': 'The bot lost track of the meeting. The screenshot in the run folder shows what it saw.',
  'meeting-ended': 'The meeting ended before the bot got in.',
  removed: 'The bot was removed before it got in.',
}

const LEFT: Partial<Record<BotRunReason, string>> = {
  asked: 'Left when you asked.',
  alone: 'Left: nobody else was in the meeting.',
  removed: 'Removed from the meeting.',
  'meeting-ended': 'Left: the meeting ended.',
  'max-duration': 'Left after the longest a meeting is allowed to run.',
}

export function describeRun(state: 'ended' | 'failed', reason: BotRunReason): string {
  return (state === 'ended' ? LEFT[reason] : FAILED[reason]) ?? reason
}

export interface MeetingBotDeps {
  runsDir: string
  launch(): Promise<BotBrowser>
  /** Null when the profile is signed in as the bot; otherwise why not. */
  ensureSignedIn(): Promise<string | null>
  timings?: Partial<BotTimings>
  now?(): number
  sleep?(ms: number): Promise<void>
  writeFile?(file: string, data: string): void
  mkdir?(dir: string): void
  prune?(runsDir: string, keep: number): void
}

interface RunEvent {
  at: number
  state?: BotRunState
  reason?: BotRunReason
  note?: string
}

interface Run {
  id: string
  url: string
  dir: string
  state: BotRunState
  reason: BotRunReason | null
  message: string
  startedAt: number
  since: number
  attempt: number
  participants: number
  chromeVersion: string | null
  leaveRequested: boolean
  events: RunEvent[]
}

type JoinOutcome = { joined: true } | { joined: false; reason: BotRunReason }

export class MeetingBot extends EventEmitter {
  private current: Run | null = null
  private task: Promise<void> | null = null
  private browser: BotBrowser | null = null
  private readonly t: BotTimings
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: MeetingBotDeps) {
    super()
    this.t = { ...DEFAULT_TIMINGS, ...deps.timings }
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  view(): BotRunView | null {
    const run = this.current
    if (!run) return null
    return {
      id: run.id,
      url: run.url,
      state: run.state,
      reason: run.reason,
      message: run.message,
      startedAt: run.startedAt,
      since: run.since,
      attempt: run.attempt,
      dir: run.dir,
      participants: run.participants,
    }
  }

  /** Whether a run is under way. */
  get busy(): boolean {
    return this.task !== null
  }

  /**
   * Send the bot to a meeting.
   *
   * @returns why it could not go, or null once it is on its way.
   */
  send(input: string): string | null {
    if (this.task) return 'The bot is already in a meeting, or on its way. Tell it to leave first.'
    const url = meetUrl(input)
    if (!url) return 'That is not a Google Meet link. It looks like https://meet.google.com/abc-defg-hij.'

    const at = this.now()
    const id = new Date(at).toISOString().replace(/[:.]/g, '-')
    const dir = path.join(this.deps.runsDir, id)
    ;(this.deps.mkdir ?? ((d) => mkdirSync(d, { recursive: true })))(dir)
    ;(this.deps.prune ?? pruneRuns)(this.deps.runsDir, KEEP_RUNS)

    const run: Run = {
      id,
      url,
      dir,
      state: 'checking',
      reason: null,
      message: '',
      startedAt: at,
      since: at,
      attempt: 0,
      participants: 0,
      chromeVersion: null,
      leaveRequested: false,
      events: [{ at, state: 'checking' }],
    }
    this.current = run
    this.changed(run)

    this.task = this.execute(run)
      .catch(async (err: unknown) => {
        if (this.browser) await this.closeBrowser(this.browser)
        this.finish(run, 'failed', 'ui-not-found', `Something the bot did not expect: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        this.task = null
      })
    return null
  }

  /** Ask the bot to leave. It goes at its next look at the page. */
  leave(): void {
    if (this.current && this.task) this.current.leaveRequested = true
  }

  /** Resolves when no run is under way. */
  settled(): Promise<void> {
    return this.task ?? Promise.resolve()
  }

  /** On quit: leave properly if it can, within a few seconds, and close Chrome regardless. */
  async dispose(): Promise<void> {
    this.leave()
    await Promise.race([this.settled(), new Promise((resolve) => setTimeout(resolve, 8_000))])
    if (this.browser) await this.closeBrowser(this.browser)
    this.removeAllListeners()
  }

  /* ------------------------------------------------------------ the run -- */

  private async execute(run: Run): Promise<void> {
    const problem = await this.deps.ensureSignedIn()
    if (problem) return this.finish(run, 'failed', 'login-required', problem)

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (run.leaveRequested) return this.finish(run, 'ended', 'asked')
      run.attempt = attempt
      this.move(run, 'launching')

      let browser: BotBrowser
      try {
        browser = await this.deps.launch()
      } catch (err) {
        this.note(run, `Chrome did not start: ${err instanceof Error ? err.message : String(err)}`)
        if (attempt === ATTEMPTS) return this.finish(run, 'failed', 'browser-died')
        continue
      }
      this.browser = browser
      run.chromeVersion = browser.chromeVersion

      const outcome = await this.join(run, browser)
      if (outcome.joined) {
        const reason = await this.stay(run, browser)
        return this.leaveMeeting(run, browser, reason)
      }
      if (outcome.reason === 'asked') {
        await this.closeBrowser(browser)
        return this.finish(run, 'ended', 'asked')
      }

      await this.capture(run, browser, `attempt-${attempt}-${outcome.reason}`, true)
      await this.closeBrowser(browser)
      if (!RETRYABLE.has(outcome.reason) || attempt === ATTEMPTS) {
        return this.finish(run, 'failed', outcome.reason)
      }
      this.note(run, `attempt ${attempt} failed (${outcome.reason}); trying again in a fresh Chrome`)
    }
  }

  private async join(run: Run, browser: BotBrowser): Promise<JoinOutcome> {
    this.move(run, 'joining')
    try {
      await browser.page.goto(run.url)
    } catch {
      return { joined: false, reason: browser.closed ? 'browser-died' : 'could-not-connect' }
    }

    const opened = this.now()
    let clickedAt: number | null = null
    let lobbySince: number | null = null
    let hostSince: number | null = null

    for (;;) {
      if (run.leaveRequested) return { joined: false, reason: 'asked' }
      if (browser.closed) return { joined: false, reason: 'browser-died' }

      const snapshot = await this.look(browser)
      if (snapshot) {
        if (snapshot.dialogOk) await browser.page.click('dialog-ok')
        const verdict = readPage(snapshot)
        switch (verdict.kind) {
          case 'in-meeting':
            return { joined: true }
          case 'failed':
            return { joined: false, reason: verdict.reason }
          case 'removed':
            return { joined: false, reason: 'removed' }
          case 'ended':
            return { joined: false, reason: 'meeting-ended' }
          case 'self-left':
            return { joined: false, reason: 'denied' }
          case 'continue-without-devices':
            await browser.page.click('continue-without-devices')
            break
          case 'ready':
            if (clickedAt === null || this.now() - clickedAt > 15_000) {
              // Before asking: nothing from the bot's side of the call, ever.
              if (snapshot.micOn) await browser.page.click('mic-off')
              if (snapshot.cameraOn) await browser.page.click('camera-off')
              if (await browser.page.click('join')) {
                if (clickedAt === null) this.note(run, `clicked "${verdict.join}"`)
                clickedAt = this.now()
              }
            }
            break
          case 'asking':
            if (lobbySince === null) {
              lobbySince = this.now()
              this.move(run, 'waiting-room')
            }
            if (this.now() - lobbySince > this.t.lobbyMs) return { joined: false, reason: 'waiting-room-timeout' }
            break
          case 'waiting-for-host':
            if (hostSince === null) {
              hostSince = this.now()
              this.move(run, 'waiting-for-host')
            }
            if (this.now() - hostSince > this.t.hostMs) return { joined: false, reason: 'host-never-came' }
            break
          case 'loading':
            break
        }
      }

      // Nothing recognisable for too long: the page is not what the bot knows.
      if (lobbySince === null && hostSince === null) {
        const since = clickedAt ?? opened
        if (this.now() - since > this.t.loadMs) return { joined: false, reason: 'ui-not-found' }
      }
      await this.sleep(this.t.pollMs)
    }
  }

  /** In the meeting, until something ends it. Returns why. */
  private async stay(run: Run, browser: BotBrowser): Promise<BotRunReason> {
    this.move(run, 'in-meeting')
    const joinedAt = this.now()
    let seenOthers = false
    let aloneSince: number | null = null
    let lostSince: number | null = null

    for (;;) {
      if (run.leaveRequested) return 'asked'
      if (browser.closed) return 'browser-died'
      if (this.now() - joinedAt > this.t.maxMs) return 'max-duration'

      const snapshot = await this.look(browser)
      if (snapshot) {
        if (snapshot.dialogOk) await browser.page.click('dialog-ok')
        const verdict = readPage(snapshot)
        if (verdict.kind === 'removed') return 'removed'
        if (verdict.kind === 'ended' || verdict.kind === 'self-left') return 'meeting-ended'

        if (verdict.kind === 'in-meeting') {
          lostSince = null
        } else {
          lostSince ??= this.now()
          if (this.now() - lostSince > this.t.lostMs) return 'lost-meeting'
        }

        // Tiles include the bot's own. Zero means they could not be read at
        // all, and an unreadable count must never make the bot leave.
        const others = Math.max(0, snapshot.participants - 1)
        if (others !== run.participants) {
          run.participants = others
          // Into the log as well as the view: leaving when alone rests on this
          // count, and a run that left too early or never left is diagnosed
          // from what the bot believed about who was there.
          this.note(run, `participant tiles: ${snapshot.participants} (${others} other${others === 1 ? '' : 's'})`)
          this.changed(run)
        }
        if (others > 0) {
          seenOthers = true
          aloneSince = null
        } else if (snapshot.participants > 0) {
          aloneSince ??= this.now()
          const limit = seenOthers ? this.t.aloneMs : this.t.aloneAtStartMs
          if (this.now() - aloneSince > limit) return 'alone'
        }
      }
      await this.sleep(this.t.pollMs * 2)
    }
  }

  private async leaveMeeting(run: Run, browser: BotBrowser, reason: BotRunReason): Promise<void> {
    const failed = reason === 'browser-died' || reason === 'lost-meeting'
    if (!browser.closed) {
      await this.capture(run, browser, failed ? `failed-${reason}` : 'before-leaving', failed)
      // Removed, or the call already over: there is no leave button to press,
      // and nothing to show as "leaving".
      if (reason !== 'removed' && reason !== 'meeting-ended') {
        this.move(run, 'leaving')
        await browser.page.click('leave')
        await this.sleep(1_500)
      }
    }
    await this.closeBrowser(browser)
    this.finish(run, failed ? 'failed' : 'ended', reason)
  }

  /* ------------------------------------------------------------- helpers -- */

  /** One look at the page. Null while it is between pages or not answering. */
  private async look(browser: BotBrowser): Promise<PageSnapshot | null> {
    try {
      return await browser.page.snapshot()
    } catch {
      return null
    }
  }

  private async capture(run: Run, browser: BotBrowser, name: string, full: boolean): Promise<void> {
    if (browser.closed) return
    const saved: string[] = []
    try {
      await browser.page.screenshot(path.join(run.dir, `${name}.png`))
      saved.push(`${name}.png`)
    } catch {
      // A page that cannot be photographed is itself a finding; the log says so.
    }
    if (full) {
      try {
        await browser.page.mhtml(path.join(run.dir, `${name}.mhtml`))
        saved.push(`${name}.mhtml`)
      } catch {
        // As above.
      }
    }
    this.note(run, saved.length ? `saved ${saved.join(', ')}` : `could not capture the page (${name})`)
  }

  private async closeBrowser(browser: BotBrowser): Promise<void> {
    try {
      await browser.close()
    } catch {
      // Closing is best effort; `closed` is what the next run relies on.
    }
    if (this.browser === browser) this.browser = null
  }

  private move(run: Run, state: BotRunState): void {
    if (run.state === state) return
    run.state = state
    run.since = this.now()
    run.events.push({ at: run.since, state })
    this.changed(run)
  }

  private finish(run: Run, state: 'ended' | 'failed', reason: BotRunReason, message?: string): void {
    run.state = state
    run.reason = reason
    run.message = message ?? describeRun(state, reason)
    run.since = this.now()
    run.events.push({ at: run.since, state, reason })
    this.changed(run)
  }

  private note(run: Run, note: string): void {
    run.events.push({ at: this.now(), note })
    this.write(run)
  }

  private changed(run: Run): void {
    this.write(run)
    if (run === this.current) this.emit('run', this.view())
  }

  private write(run: Run): void {
    const record = {
      url: run.url,
      startedAt: new Date(run.startedAt).toISOString(),
      state: run.state,
      reason: run.reason,
      message: run.message,
      attempt: run.attempt,
      chromeVersion: run.chromeVersion,
      events: run.events.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    }
    try {
      ;(this.deps.writeFile ?? ((f, d) => writeFileSync(f, d, 'utf8')))(
        path.join(run.dir, 'run.json'),
        JSON.stringify(record, null, 2) + '\n'
      )
    } catch {
      // The log is for reading afterwards; failing to write it must not stop the bot.
    }
  }
}

/** Keep the newest runs' folders; the names are timestamps, so they sort by age. */
export function pruneRuns(runsDir: string, keep: number): void {
  try {
    const runs = readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
      rmSync(path.join(runsDir, name), { recursive: true, force: true })
    }
  } catch {
    // Nothing to prune yet.
  }
}
