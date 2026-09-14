import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BotRunReason, BotRunState, BotRunView } from '../../shared/ipc.js'
import type { BotBrowser } from './browser.js'
import { scoreAgainstPanel, type CaptionScore } from './caption-score.js'
import { MeetFeed, type CaptionLine, type CaptionRevision } from './captions.js'
import { meetUrl, readPage, type PageSnapshot, type PanelTurn } from './meet-ui.js'

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
 * WHAT IT KEEPS: Meet's captions, as lines with names on them, in a meeting of
 * their own. The run hands them to a `CaptureSink` and knows nothing of the
 * store. Something wrong with what it is keeping is a warning on the run, not
 * a failure: a bot still in the call with its captions off is a bot you can
 * see is keeping nothing, and can tell to leave.
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
  /** No heartbeat from the hook in Meet's page for this long: it is not running. */
  silentPageMs: number
  /** Between tries at turning the captions on. */
  captionRetryMs: number
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
  // BOT7: a silent page is noticed within 30 seconds.
  silentPageMs: 20_000,
  captionRetryMs: 20_000,
}

const ATTEMPTS = 3
const CAPTION_TRIES = 3
/** Unreadable messages, with no caption read, before it is called a format change rather than noise. */
const UNREADABLE_BEFORE_WARNING = 10
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

/** Where what the bot hears goes. The run holds only the meeting's id. */
export interface CaptureSink {
  /** A meeting for this call, made when the bot gets in. Returns its id. */
  open(startedAt: number): number
  append(meetingId: number, lines: readonly CaptionLine[], startedAt: number): void
  /**
   * The call is over. `lines` is how many were kept; `people` the names on
   * Meet's participant list, the bot and screen shares left out - spelled by
   * Google, which is why the vocabulary takes them on its own.
   */
  close(meetingId: number, detail: { endedAt: number; lines: number; people: string[] }): void
  /**
   * Meet rewrote a caption after its line was stored: make the same change in
   * the stored line. True when a line was changed.
   */
  revise?(meetingId: number, revision: CaptionRevision, startedAt: number): boolean
}

export interface MeetingBotDeps {
  runsDir: string
  launch(): Promise<BotBrowser>
  /** Null when the profile is signed in as the bot; otherwise why not. */
  ensureSignedIn(): Promise<string | null>
  /** Where captions go. Without one the bot joins and leaves and keeps nothing. */
  sink?: CaptureSink
  /** The language to ask Meet to caption in, e.g. `hi-IN`. Null for Meet's default. */
  captionLanguage?(): string | null
  timings?: Partial<BotTimings>
  now?(): number
  sleep?(ms: number): Promise<void>
  writeFile?(file: string, data: string): void
  appendFile?(file: string, data: string): void
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
  /** What the page is forwarding, for the attempt under way. */
  feed: MeetFeed | null
  meetingId: number | null
  meetingStartedAt: number
  meetingClosed: boolean
  lines: number
  warning: string | null
  /** A failure to store captions. Sticky: the lines it failed on are gone. */
  saveProblem: string | null
  /** What was stored, for scoring against Meet's own panel at the end. */
  kept: { speaker: string | null; text: string }[]
  /** Corrections Meet made after a line was stored, made in the transcript too. */
  revised: number
}

interface CaptionState {
  on: boolean
  onAt: number | null
  tries: number
  lastTry: number
  /** The language to caption in, e.g. `hi-IN`. Null for Meet's default. */
  wanted: string | null
  /** When the language was asked for again because captions arrived in another. */
  retriedAt: number | null
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
      meetingId: run.meetingId,
      lines: run.lines,
      warning: run.warning,
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
      feed: null,
      meetingId: null,
      meetingStartedAt: at,
      meetingClosed: false,
      lines: 0,
      warning: null,
      saveProblem: null,
      kept: [],
      revised: 0,
    }
    this.current = run
    this.changed(run)

    this.task = this.execute(run)
      .catch(async (err: unknown) => {
        if (this.browser) await this.closeBrowser(this.browser)
        this.closeMeeting(run)
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
      // Listening from before the page loads: Meet fetches its participant
      // list while the bot is still joining.
      const feed = new MeetFeed()
      run.feed = feed
      browser.page.onMessage((raw) => feed.receive(raw, this.now()))

      const outcome = await this.join(run, browser)
      if (outcome.joined) {
        const reason = await this.stay(run, browser, feed)
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

  /** In the meeting, keeping what is said, until something ends it. Returns why. */
  private async stay(run: Run, browser: BotBrowser, feed: MeetFeed): Promise<BotRunReason> {
    this.move(run, 'in-meeting')
    const joinedAt = this.now()
    this.openMeeting(run, joinedAt)
    const captions: CaptionState = {
      on: false,
      onAt: null,
      tries: 0,
      lastTry: -Infinity,
      wanted: this.deps.captionLanguage?.() ?? null,
      retriedAt: null,
    }
    let seenOthers = false
    let aloneSince: number | null = null
    let lostSince: number | null = null

    for (;;) {
      if (run.leaveRequested) return 'asked'
      if (browser.closed) return 'browser-died'
      if (this.now() - joinedAt > this.t.maxMs) return 'max-duration'

      if (!captions.on && captions.tries < CAPTION_TRIES && this.now() - captions.lastTry >= this.t.captionRetryMs) {
        await this.turnOnCaptions(run, browser, captions)
      }
      this.keep(run, feed.take(this.now()))
      this.revise(run, feed.revisions())
      this.logCaptions(run, feed)
      // The captions say which language Meet is using, whatever the menus did.
      // Meet remembers the choice from the last call, so the menus can fail on
      // a language already set - judged by the clicks, a false warning.
      if (captions.wanted && feed.lastLanguage && feed.lastLanguage !== captions.wanted && captions.retriedAt === null) {
        captions.retriedAt = this.now()
        const again = await browser.page.enableCaptions(captions.wanted)
        this.note(
          run,
          `captions arriving in ${feed.lastLanguage}; asked for ${captions.wanted} again, ${again.languageSet ? 'chosen' : 'not chosen'}`
        )
      }

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

        // Who else is here: Meet's own list once it has sent one, the tiles
        // until then. Tiles include the bot's own, and zero tiles means they
        // could not be read at all - never that nobody is there.
        const tiles = Math.max(0, snapshot.participants - 1)
        const listed = feed.roster.others()
        const others = listed ?? tiles
        if (others !== run.participants) {
          run.participants = others
          // Into the log as well as the view: leaving when alone rests on this
          // count, and a run that left too early or never left is diagnosed
          // from what the bot believed about who was there.
          this.note(run, `others in the call: ${others} (Meet's list: ${listed ?? 'not yet'}, tiles: ${snapshot.participants})`)
          this.changed(run)
        }
        // Alone only when neither says otherwise: a list that missed somebody
        // and tiles nobody could read must not add up to leaving a meeting
        // people are still in.
        if (Math.max(listed ?? 0, tiles) > 0) {
          seenOthers = true
          aloneSince = null
        } else if (listed !== null || snapshot.participants > 0) {
          aloneSince ??= this.now()
          const limit = seenOthers ? this.t.aloneMs : this.t.aloneAtStartMs
          if (this.now() - aloneSince > limit) return 'alone'
        }
      }
      this.warn(run, this.warningFor(run, feed, joinedAt, captions))
      await this.sleep(this.t.pollMs * 2)
    }
  }

  private async leaveMeeting(run: Run, browser: BotBrowser, reason: BotRunReason): Promise<void> {
    const failed = reason === 'browser-died' || reason === 'lost-meeting'
    let panel: PanelTurn[] | null = null
    if (!browser.closed) {
      await this.capture(run, browser, failed ? `failed-${reason}` : 'before-leaving', failed)
      // Meet's own caption panel, before leaving takes it away.
      panel = await browser.page.captionPanel()
      // Removed, or the call already over: there is no leave button to press,
      // and nothing to show as "leaving".
      if (reason !== 'removed' && reason !== 'meeting-ended') {
        this.move(run, 'leaving')
        await browser.page.click('leave')
        await this.sleep(1_500)
      }
    }
    await this.closeBrowser(browser)
    this.closeMeeting(run)
    const score = this.score(run, panel)
    const state = failed ? 'failed' : 'ended'
    const match = score ? `, ${percent(score.exact)} of Meet's own caption words` : ''
    const kept =
      run.meetingId === null
        ? ''
        : run.lines > 0
          ? ` Kept ${run.lines} line${run.lines === 1 ? '' : 's'} of captions${match}.`
          : ' No captions were kept.'
    this.finish(run, state, reason, describeRun(state, reason) + kept)
  }

  /* ------------------------------------------------------------ captions -- */

  private async turnOnCaptions(run: Run, browser: BotBrowser, captions: CaptionState): Promise<void> {
    captions.tries++
    captions.lastTry = this.now()
    // The language once: going through Meet's settings every twenty seconds
    // would be the bot fiddling with menus for the whole call.
    const language = captions.tries === 1 ? captions.wanted : null
    const result = await browser.page.enableCaptions(language)
    if (result.on) {
      captions.on = true
      captions.onAt = this.now()
    }
    const chosen = language ? `, ${language} ${result.languageSet ? 'chosen' : 'not chosen'}` : ''
    const open = result.settingsOpen ? ", and Meet's settings were left open over the call" : ''
    this.note(run, `captions ${result.on ? 'on' : 'not on'}${chosen}${open} (try ${captions.tries})`)
    if (!result.on || result.settingsOpen) {
      await this.capture(run, browser, `captions-try-${captions.tries}`, true)
    }
  }

  /** What is wrong with what the bot is keeping, in a sentence. Null when nothing is. */
  private warningFor(run: Run, feed: MeetFeed, joinedAt: number, captions: CaptionState): string | null {
    const now = this.now()
    if (run.saveProblem) return run.saveProblem
    if (feed.lastHeartbeat === null) {
      if (now - joinedAt > this.t.silentPageMs) return "The bot's hook is not running in Meet's page, so nothing is being kept."
    } else if (now - feed.lastHeartbeat > this.t.silentPageMs) {
      return "Meet's page has stopped answering the bot, so nothing is being kept."
    }
    if (feed.unreadable >= UNREADABLE_BEFORE_WARNING && feed.captionMessages === 0) {
      // No running count in it: a sentence that changes every poll is a new
      // warning every poll, and one run logged ninety of them.
      return "Meet's messages could not be read, so nothing is being kept. Samples of them are in the run folder."
    }
    if (!captions.on && captions.tries >= CAPTION_TRIES) {
      return "Could not turn on Meet's captions, so nothing is being kept. The run folder shows what the bot saw."
    }
    if (
      captions.onAt !== null &&
      now - captions.onAt > this.t.silentPageMs &&
      feed.captionMessages === 0 &&
      feed.channels.size > 0 &&
      !feed.channels.has('captions') &&
      !feed.channels.has('captions_v2')
    ) {
      return `Captions are on, but Meet opened no caption channel (only ${[...feed.channels].join(', ')}). Meet may have changed how it sends them.`
    }
    // Only once asked a second time and captions still came in another language.
    if (
      captions.wanted &&
      captions.retriedAt !== null &&
      feed.lastLanguage !== null &&
      feed.lastLanguage !== captions.wanted &&
      (feed.lastLanguageAt ?? 0) > captions.retriedAt
    ) {
      return `Captions are arriving in ${feed.lastLanguage}, not ${captions.wanted}, so the transcript is in the wrong language.`
    }
    return null
  }

  private openMeeting(run: Run, at: number): void {
    if (!this.deps.sink) return
    try {
      run.meetingId = this.deps.sink.open(at)
      run.meetingStartedAt = at
      this.note(run, `keeping captions in meeting ${run.meetingId}`)
      this.changed(run)
    } catch (err) {
      run.saveProblem = `No meeting could be made to keep the captions in: ${err instanceof Error ? err.message : String(err)}`
      this.note(run, run.saveProblem)
    }
  }

  private keep(run: Run, lines: CaptionLine[]): void {
    if (lines.length === 0 || run.meetingId === null || !this.deps.sink) return
    try {
      this.deps.sink.append(run.meetingId, lines, run.meetingStartedAt)
      run.lines += lines.length
      run.kept.push(...lines.map((l) => ({ speaker: l.speaker, text: l.text })))
      this.changed(run)
    } catch (err) {
      run.saveProblem = `Some captions could not be saved: ${err instanceof Error ? err.message : String(err)}`
      this.note(run, run.saveProblem)
      // Now, not at the next look: a turn is often stored as the call ends,
      // when there is no next look.
      this.warn(run, run.saveProblem)
    }
  }

  /**
   * Corrections Meet made to lines already stored, made in the transcript -
   * and in what the call is scored on, which is what was kept.
   */
  private revise(run: Run, revisions: CaptionRevision[]): void {
    if (revisions.length === 0 || run.meetingId === null || !this.deps.sink?.revise) return
    for (const r of revisions) {
      try {
        if (!this.deps.sink.revise(run.meetingId, r, run.meetingStartedAt)) continue
        run.revised++
        const kept = run.kept.find((k) => k.speaker === r.speaker && k.text.includes(r.from))
        if (kept) kept.text = kept.text.replace(r.from, r.to)
      } catch (err) {
        this.note(run, `could not correct a stored line: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.changed(run)
  }

  /** Whatever is still open becomes lines, and the meeting is closed. Once. */
  private closeMeeting(run: Run): void {
    const feed = run.feed
    let people: string[] = []
    if (feed) {
      people = feed.roster
        .people()
        .filter((p) => !p.isSelf && !p.screenShareOf && p.name)
        .map((p) => p.name!)
      this.keep(run, feed.flush())
      this.revise(run, feed.revisions())
      const c = feed.captions
      this.note(
        run,
        `captions: ${feed.captionMessages} read; kept ${c.keptFinal} at Meet's final version and ${c.keptQuiet} without one; ${c.lateRevisions} changed after being kept (${run.revised} corrected in the transcript, ${c.newUnderOldId} new words under an old caption kept as lines); ${feed.summary()}`
      )
      this.logCaptions(run, feed)
      this.writeJson(run, 'people.json', feed.roster.people())
      this.writeSamples(run, feed)
      run.feed = null
    }
    if (run.meetingId === null || run.meetingClosed || !this.deps.sink) return
    run.meetingClosed = true
    try {
      this.deps.sink.close(run.meetingId, { endedAt: this.now(), lines: run.lines, people })
    } catch (err) {
      this.note(run, `could not close meeting ${run.meetingId}: ${err instanceof Error ? err.message : String(err)}`)
    }
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

  private warn(run: Run, warning: string | null): void {
    if (run.warning === warning) return
    run.warning = warning
    this.note(run, warning ? `warning: ${warning}` : 'warning cleared')
    // What the page was sending when it went wrong, in case the run never ends cleanly.
    if (warning && run.feed) this.writeSamples(run, run.feed)
    this.changed(run)
  }

  /** The feed's raw samples, one JSON object per line, beside `run.json`. */
  private writeSamples(run: Run, feed: MeetFeed): void {
    if (feed.samples.length === 0) return
    const lines = feed.samples.map((s) => JSON.stringify({ ...s, at: new Date(s.at).toISOString() }))
    try {
      ;(this.deps.writeFile ?? ((f, d) => writeFileSync(f, d, 'utf8')))(
        path.join(run.dir, 'messages.jsonl'),
        lines.join('\n') + '\n'
      )
    } catch {
      // Evidence, not function: failing to write it must not stop the bot.
    }
  }

  /** New caption updates onto `captions.jsonl`: the call, replayable through new rules. */
  private logCaptions(run: Run, feed: MeetFeed): void {
    const logged = feed.drainLog()
    if (logged.length === 0) return
    try {
      ;(this.deps.appendFile ?? ((f, d) => appendFileSync(f, d, 'utf8')))(
        path.join(run.dir, 'captions.jsonl'),
        logged.map((u) => JSON.stringify(u)).join('\n') + '\n'
      )
    } catch {
      // As above.
    }
  }

  /**
   * What was kept, against Meet's own caption panel: into the log and
   * `score.json`, with the panel itself in `meet-panel.json`. Null when there
   * was no panel to read - the call ended under the bot, or Meet changed it.
   */
  private score(run: Run, panel: PanelTurn[] | null): CaptionScore | null {
    if (run.meetingId === null) return null
    if (!panel || panel.length === 0) {
      this.note(run, "Meet's caption panel was not there to score against")
      return null
    }
    this.writeJson(run, 'meet-panel.json', panel)
    const score = scoreAgainstPanel(panel, run.kept)
    this.writeJson(run, 'score.json', score)
    this.note(
      run,
      `against Meet's caption panel: ${percent(score.exact)} of its words kept exactly, word error rate ${percent(score.wer)}, ${percent(score.speakerWer)} counting speakers; the panel had ${score.panelWords} words in ${score.panelTurns} turns, the bot kept ${score.keptWords} in ${score.keptLines} lines`
    )
    return score
  }

  private writeJson(run: Run, name: string, data: unknown): void {
    try {
      ;(this.deps.writeFile ?? ((f, d) => writeFileSync(f, d, 'utf8')))(
        path.join(run.dir, name),
        JSON.stringify(data, null, 2) + '\n'
      )
    } catch {
      // As above.
    }
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
      meetingId: run.meetingId,
      lines: run.lines,
      warning: run.warning,
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

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
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
