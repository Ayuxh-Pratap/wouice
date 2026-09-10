import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import type { BotStatusView } from '../../shared/ipc.js'
import { checkBotAccount, classify, pickEmail, type AccountFacts, type CheckOptions } from './account.js'
import type { LaunchedChrome } from './cdp.js'

/**
 * The meeting bot's identity: its own Chrome profile, the window you sign in
 * through, and the check that says who it is signed in as.
 *
 * THE FLOW. "Sign in" opens ordinary Chrome on the bot's profile - no
 * automation, nothing driving it - and you sign in as the bot yourself.
 * Closing that window is the signal: the check then runs on its own. Nothing
 * can check while the window is open, because that Chrome holds the profile.
 *
 * STATE LIVES HERE, not in the window. Settings, the meetings page and later
 * the bot itself ask this, and it pushes a new view whenever anything changes.
 */

/** Where the sign-in window starts: Google's sign-in, then Meet. */
export const SIGN_IN_URL =
  'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmeet.google.com%2F'

/** What `openWindow` must return: something that says when it has gone. */
export interface ChromeWindow {
  once(event: 'exit', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export interface BotIdentityDeps {
  profileDir: string
  /** The account the bot should be, from settings. Read fresh every time. */
  expected(): string
  chromePath(): string | null
  check?(options: CheckOptions): Promise<AccountFacts>
  openWindow?(chromePath: string, args: string[]): ChromeWindow
}

type Phase = 'idle' | 'checking' | 'signing-in'

export class BotIdentity extends EventEmitter {
  private facts: AccountFacts | null = null
  private phase: Phase = 'idle'
  private running: Promise<BotStatusView> | null = null
  private window: ChromeWindow | null = null
  private checkingChrome: LaunchedChrome | null = null

  constructor(private readonly deps: BotIdentityDeps) {
    super()
  }

  view(): BotStatusView {
    const expected = this.deps.expected().trim().toLowerCase()
    const facts = this.facts
    const base = {
      expected,
      email: facts ? pickEmail(facts.emails, expected) : null,
      chromeVersion: facts?.chromeVersion ?? null,
      checkedAt: facts?.checkedAt ?? null,
    }
    if (this.phase === 'signing-in') {
      return {
        ...base,
        state: 'signing-in',
        message: 'Sign in as the bot in the Chrome window, then close it. Wouice checks by itself.',
      }
    }
    if (this.phase === 'checking') {
      return { ...base, state: 'checking', message: "Opening the bot's profile to see who it is signed in as." }
    }
    if (!facts) return { ...base, state: 'unknown', message: 'Not checked yet.' }
    return { ...base, ...classify(facts, expected) }
  }

  /** Read the profile. Asked twice at once, it answers both from one check. */
  check(): Promise<BotStatusView> {
    if (this.running) return this.running
    // The sign-in window holds the profile; its closing starts a check anyway.
    if (this.phase === 'signing-in') return Promise.resolve(this.view())

    this.phase = 'checking'
    this.changed()
    const check = this.deps.check ?? checkBotAccount
    this.running = check({
      chromePath: this.deps.chromePath(),
      profileDir: this.deps.profileDir,
      track: (chrome) => {
        this.checkingChrome = chrome
      },
    })
      .then((facts) => {
        this.facts = facts
      })
      .catch((err: unknown) => {
        this.facts = {
          signedIn: false,
          emails: [],
          chromeVersion: null,
          checkedAt: Date.now(),
          problem: { state: 'failed', message: err instanceof Error ? err.message : String(err) },
        }
      })
      .then(() => {
        this.phase = 'idle'
        this.running = null
        this.changed()
        return this.view()
      })
    return this.running
  }

  /**
   * Open ordinary Chrome on the bot's profile, to sign in by hand.
   *
   * @returns why it could not, or null once the window is on its way.
   */
  openSignIn(): string | null {
    const chromePath = this.deps.chromePath()
    if (!chromePath) return 'Chrome is not installed. The bot runs in Google Chrome.'
    if (this.window) return 'The sign-in window is already open.'
    if (this.phase === 'checking') return 'A check is running. Try again in a few seconds.'

    mkdirSync(this.deps.profileDir, { recursive: true })
    const open = this.deps.openWindow ?? openChromeWindow
    const window = open(chromePath, [
      `--user-data-dir=${this.deps.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      SIGN_IN_URL,
    ])
    this.window = window
    this.phase = 'signing-in'
    this.changed()

    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      this.window = null
      this.phase = 'idle'
      void this.check()
    }
    window.once('exit', done)
    window.once('error', (error: Error) => {
      if (settled) return
      settled = true
      this.window = null
      this.phase = 'idle'
      this.facts = {
        signedIn: false,
        emails: [],
        chromeVersion: null,
        checkedAt: Date.now(),
        problem: { state: 'failed', message: `Chrome could not open: ${error.message}` },
      }
      this.changed()
    })
    return null
  }

  /**
   * On quit: a check's Chrome is closed rather than left holding the profile.
   * A sign-in window is yours and stays open.
   */
  dispose(): void {
    this.checkingChrome?.process.kill()
    this.checkingChrome = null
    this.removeAllListeners()
  }

  private changed(): void {
    this.emit('status', this.view())
  }
}

function openChromeWindow(chromePath: string, args: string[]): ChromeWindow {
  return spawn(chromePath, args, { stdio: 'ignore' })
}
