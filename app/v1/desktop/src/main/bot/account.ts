import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { BotAccountState } from '../../shared/ipc.js'
import { launchChrome, type CdpConnection, type LaunchedChrome, type LaunchOptions } from './cdp.js'

/**
 * Which Google account the bot's Chrome profile is signed in to.
 *
 * SIGNED IN BY HAND, READ BY WOUICE. Google refuses sign-in inside automated
 * browsers, so the bot's account is signed in once, by a person, in ordinary
 * Chrome. This only ever reads the result: it opens the profile without a
 * window, asks Chrome for its cookies, and reads the account from the
 * profile's own files. It never types, never navigates to a sign-in page, and
 * never sees a password.
 *
 * TWO QUESTIONS, TWO SOURCES.
 *   - Signed in at all: Google's session cookies (`SID` and its secure
 *     variants). They are what Meet itself checks, so they are the truth for
 *     whether the bot can join as itself.
 *   - As whom: the profile's `Preferences` file, where Chrome records the
 *     account signed in to it. A local file - nothing is loaded. Only when that
 *     is missing is google.com opened, to read the account button's label.
 *
 * A PIPE, NEVER A PORT, and no window: see `launchChrome`.
 */

/** What one check found, before it is compared with the account the bot should be. */
export interface AccountFacts {
  signedIn: boolean
  /** Accounts the profile holds, lower-cased. Usually one. */
  emails: string[]
  chromeVersion: string | null
  checkedAt: number
  /** Why the check could not answer at all. */
  problem: { state: 'no-chrome' | 'profile-busy' | 'failed'; message: string } | null
}

/** Google's session cookies. Any one on a google.com domain means signed in. */
const SESSION_COOKIES = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID'])

export function signedInByCookies(cookies: readonly { name: string; domain: string }[]): boolean {
  return cookies.some(
    (c) => SESSION_COOKIES.has(c.name) && /(^|\.)google\.com$/.test(c.domain.replace(/^\./, ''))
  )
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

/** The accounts Chrome recorded in a profile's Preferences, lower-cased. */
export function emailsFromPreferences(raw: string): string[] {
  let prefs: {
    account_info?: { email?: unknown }[]
    google?: { services?: { last_username?: unknown; last_signed_in_username?: unknown } }
  }
  try {
    prefs = JSON.parse(raw) as typeof prefs
  } catch {
    return []
  }
  const found = new Set<string>()
  for (const account of Array.isArray(prefs.account_info) ? prefs.account_info : []) {
    if (typeof account?.email === 'string' && EMAIL.test(account.email)) {
      found.add(account.email.toLowerCase())
    }
  }
  for (const name of [prefs.google?.services?.last_signed_in_username, prefs.google?.services?.last_username]) {
    if (typeof name === 'string' && EMAIL.test(name)) found.add(name.toLowerCase())
  }
  return [...found]
}

/** An email inside an account button's label: "Google Account: Name (someone@gmail.com)". */
export function emailsFromLabels(labels: readonly string[]): string[] {
  const found = new Set<string>()
  for (const label of labels) {
    const match = EMAIL.exec(label)
    if (match) found.add(match[0].toLowerCase())
  }
  return [...found]
}

/** The account to report: the expected one if the profile holds it, else the first. */
export function pickEmail(emails: readonly string[], expected: string): string | null {
  const want = expected.trim().toLowerCase()
  if (want && emails.includes(want)) return want
  return emails[0] ?? null
}

/** What the facts mean for the account the bot is supposed to be. */
export function classify(
  facts: AccountFacts,
  expected: string
): { state: BotAccountState; message: string } {
  if (facts.problem) return facts.problem
  const want = expected.trim().toLowerCase()
  const email = pickEmail(facts.emails, want)
  if (!facts.signedIn) {
    return { state: 'signed-out', message: "The bot's Chrome profile is not signed in to Google." }
  }
  if (!email) {
    return { state: 'signed-in', message: 'Signed in, but which account could not be read.' }
  }
  if (want && email !== want) {
    return {
      state: 'wrong-account',
      message: `Signed in as ${email}, not ${want}. Sign that account out in the bot's Chrome window and sign in as the bot.`,
    }
  }
  if (!want) {
    return { state: 'signed-in', message: `Enter ${email} above, so a wrong account is caught next time.` }
  }
  return { state: 'signed-in', message: '' }
}

/**
 * Whether a Chrome already has this profile open.
 *
 * Chrome holds `lockfile` in the profile directory open without sharing for as
 * long as it runs (measured: EBUSY while running, gone after exit). A second
 * Chrome started on a busy profile does not open it - it hands its work to the
 * one already running and exits - so this is asked before launching, not
 * discovered from a confusing failure afterwards.
 */
export function profileInUse(
  dir: string,
  open: (file: string, flags: string) => number = openSync,
  close: (fd: number) => void = closeSync,
  exists: (file: string) => boolean = existsSync
): boolean {
  const lock = path.join(dir, 'lockfile')
  if (!exists(lock)) return false
  try {
    close(open(lock, 'r+'))
    return false
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EBUSY' || code === 'EPERM'
  }
}

export interface CheckOptions {
  chromePath: string | null
  profileDir: string
  launch?: (options: LaunchOptions) => LaunchedChrome
  readFile?: (file: string) => string
  inUse?: (dir: string) => boolean
  /** Told about the Chrome it opens, so a quit mid-check can close it. */
  track?: (chrome: LaunchedChrome | null) => void
  now?: () => number
}

export async function checkBotAccount(options: CheckOptions): Promise<AccountFacts> {
  const now = options.now ?? Date.now
  const facts = (over: Partial<AccountFacts>): AccountFacts => ({
    signedIn: false,
    emails: [],
    chromeVersion: null,
    checkedAt: now(),
    problem: null,
    ...over,
  })

  if (!options.chromePath) {
    return facts({
      problem: { state: 'no-chrome', message: 'Chrome is not installed. The bot runs in Google Chrome.' },
    })
  }
  if ((options.inUse ?? profileInUse)(options.profileDir)) {
    return facts({
      problem: {
        state: 'profile-busy',
        message: "Chrome is still open on the bot's profile. Close that window and check again.",
      },
    })
  }

  const chrome = (options.launch ?? launchChrome)({
    chromePath: options.chromePath,
    userDataDir: options.profileDir,
    headless: true,
  })
  options.track?.(chrome)
  try {
    const version = await chrome.cdp.send<{ product?: string; userAgent?: string }>('Browser.getVersion')
    const { cookies = [] } = await chrome.cdp.send<{ cookies?: { name: string; domain: string }[] }>(
      'Storage.getCookies'
    )
    const signedIn = signedInByCookies(cookies)

    let emails: string[] = []
    if (signedIn) {
      emails = readPreferences(options.profileDir, options.readFile)
      if (emails.length === 0) emails = await emailsFromGoogle(chrome.cdp, version.userAgent ?? '')
    }
    return facts({
      signedIn,
      emails,
      chromeVersion: version.product?.replace(/^(Headless)?Chrome\//, '') ?? null,
    })
  } catch (err) {
    return facts({
      problem: {
        state: 'failed',
        message: `Could not read the bot's profile: ${err instanceof Error ? err.message : String(err)}`,
      },
    })
  } finally {
    await chrome.close()
    options.track?.(null)
  }
}

function readPreferences(profileDir: string, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): string[] {
  try {
    return emailsFromPreferences(read(path.join(profileDir, 'Default', 'Preferences')))
  } catch {
    return []
  }
}

/**
 * The fallback: google.com's account button, whose label names the account.
 *
 * Loaded with the ordinary Chrome user agent - a headless one announces itself
 * in its name, and there is no reason to look different from the window the
 * account was signed in with.
 */
async function emailsFromGoogle(cdp: CdpConnection, userAgent: string): Promise<string[]> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    if (userAgent) {
      await cdp.send(
        'Network.setUserAgentOverride',
        { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') },
        sessionId
      )
    }
    await cdp.send('Page.navigate', { url: 'https://www.google.com/' }, sessionId)
    const read = `[...document.querySelectorAll('a[aria-label]')].map((a) => a.getAttribute('aria-label'))`
    for (let attempt = 0; attempt < 16; attempt++) {
      const { result } = await cdp.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: read, returnByValue: true },
        sessionId
      )
      const labels = Array.isArray(result?.value)
        ? result.value.filter((l): l is string => typeof l === 'string')
        : []
      const emails = emailsFromLabels(labels)
      if (emails.length > 0) return emails
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return []
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }
}
