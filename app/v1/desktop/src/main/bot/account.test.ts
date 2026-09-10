import { describe, expect, it } from 'vitest'
import type { CdpConnection, LaunchedChrome } from './cdp.js'
import {
  checkBotAccount,
  classify,
  emailsFromLabels,
  emailsFromPreferences,
  pickEmail,
  profileInUse,
  signedInByCookies,
  type AccountFacts,
} from './account.js'

/**
 * Reading which account the bot's profile holds, minus Chrome.
 *
 * The rule under test: the check reads and reports, it never guesses. A profile
 * it cannot open says why; a profile signed in as the wrong account says so.
 */

const facts = (over: Partial<AccountFacts> = {}): AccountFacts => ({
  signedIn: true,
  emails: ['bot@gmail.com'],
  chromeVersion: '153.0.8010.36',
  checkedAt: 1,
  problem: null,
  ...over,
})

/** A Chrome that answers from a table, and remembers what it was asked. */
function fakeChrome(answers: Record<string, unknown>): { chrome: LaunchedChrome; asked: string[]; closed: () => boolean } {
  const asked: string[] = []
  let closed = false
  const cdp = {
    send: async (method: string) => {
      asked.push(method)
      const answer = answers[method]
      if (answer instanceof Error) throw answer
      return answer ?? {}
    },
  } as unknown as CdpConnection
  const chrome = {
    cdp,
    process: {} as LaunchedChrome['process'],
    close: async () => {
      closed = true
    },
  }
  return { chrome, asked, closed: () => closed }
}

const SESSION = [{ name: 'SID', domain: '.google.com' }]
const VERSION = { product: 'HeadlessChrome/153.0.8010.36', userAgent: 'Mozilla HeadlessChrome/153' }

describe('reading the facts', () => {
  it('counts a Google session cookie as signed in, and nothing else', () => {
    expect(signedInByCookies(SESSION)).toBe(true)
    expect(signedInByCookies([{ name: '__Secure-3PSID', domain: 'accounts.google.com' }])).toBe(true)
    expect(signedInByCookies([{ name: 'NID', domain: '.google.com' }])).toBe(false)
    expect(signedInByCookies([{ name: 'SID', domain: '.notgoogle.com' }])).toBe(false)
  })

  it('reads the accounts Chrome recorded in the profile', () => {
    const prefs = JSON.stringify({
      account_info: [{ email: 'Bot@Gmail.com', full_name: 'Bot' }],
      google: { services: { last_username: 'bot@gmail.com' } },
    })
    expect(emailsFromPreferences(prefs)).toEqual(['bot@gmail.com'])
    expect(emailsFromPreferences('{}')).toEqual([])
    expect(emailsFromPreferences('not json')).toEqual([])
  })

  it('reads the account out of an account button label', () => {
    expect(emailsFromLabels(['Google apps', 'Google Account: Wouice Bot  \n(bot@gmail.com)'])).toEqual([
      'bot@gmail.com',
    ])
    expect(emailsFromLabels(['Sign in'])).toEqual([])
  })

  it('reports the expected account when the profile holds several', () => {
    expect(pickEmail(['me@gmail.com', 'bot@gmail.com'], 'Bot@gmail.com')).toBe('bot@gmail.com')
    expect(pickEmail(['me@gmail.com'], 'bot@gmail.com')).toBe('me@gmail.com')
    expect(pickEmail([], 'bot@gmail.com')).toBeNull()
  })
})

describe('what the facts mean', () => {
  it('is signed in when the account is the expected one', () => {
    expect(classify(facts(), 'bot@gmail.com')).toEqual({ state: 'signed-in', message: '' })
  })

  it('says so plainly when it is another account', () => {
    const verdict = classify(facts({ emails: ['me@gmail.com'] }), 'bot@gmail.com')
    expect(verdict.state).toBe('wrong-account')
    expect(verdict.message).toContain('me@gmail.com')
  })

  it('is signed out without a session, whatever the profile remembers', () => {
    expect(classify(facts({ signedIn: false }), 'bot@gmail.com').state).toBe('signed-out')
  })

  it('passes a problem through untouched', () => {
    const problem = { state: 'profile-busy' as const, message: 'close it' }
    expect(classify(facts({ problem }), 'bot@gmail.com')).toEqual(problem)
  })

  it('asks for the account to be entered when none is set', () => {
    const verdict = classify(facts(), '')
    expect(verdict.state).toBe('signed-in')
    expect(verdict.message).toContain('bot@gmail.com')
  })
})

describe('whether the profile is open', () => {
  const lockExists = (): boolean => true

  it('is busy while Chrome holds its lock', () => {
    const busy = (): number => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    expect(profileInUse('C:\\p', busy, () => undefined, lockExists)).toBe(true)
  })

  it('is free when the lock can be opened, or is not there', () => {
    expect(profileInUse('C:\\p', () => 3, () => undefined, lockExists)).toBe(false)
    expect(profileInUse('C:\\p', () => 3, () => undefined, () => false)).toBe(false)
  })
})

describe('the check', () => {
  const base = { profileDir: 'C:\\p', inUse: () => false, now: () => 42 }

  it('says Chrome is missing without trying to launch anything', async () => {
    let launched = false
    const result = await checkBotAccount({
      ...base,
      chromePath: null,
      launch: () => {
        launched = true
        return fakeChrome({}).chrome
      },
    })
    expect(result.problem?.state).toBe('no-chrome')
    expect(launched).toBe(false)
  })

  it('refuses a profile another Chrome has open', async () => {
    const result = await checkBotAccount({ ...base, chromePath: 'chrome.exe', inUse: () => true })
    expect(result.problem?.state).toBe('profile-busy')
  })

  it('reports signed out, and closes Chrome', async () => {
    const fake = fakeChrome({ 'Browser.getVersion': VERSION, 'Storage.getCookies': { cookies: [] } })
    const result = await checkBotAccount({ ...base, chromePath: 'chrome.exe', launch: () => fake.chrome })
    expect(result).toMatchObject({ signedIn: false, emails: [], chromeVersion: '153.0.8010.36', checkedAt: 42 })
    expect(fake.closed()).toBe(true)
  })

  it('reads the account from the profile, without loading any page', async () => {
    const fake = fakeChrome({ 'Browser.getVersion': VERSION, 'Storage.getCookies': { cookies: SESSION } })
    const result = await checkBotAccount({
      ...base,
      chromePath: 'chrome.exe',
      launch: () => fake.chrome,
      readFile: () => JSON.stringify({ account_info: [{ email: 'bot@gmail.com' }] }),
    })
    expect(result).toMatchObject({ signedIn: true, emails: ['bot@gmail.com'] })
    expect(fake.asked).not.toContain('Page.navigate')
  })

  it('falls back to google.com when the profile does not say', async () => {
    const fake = fakeChrome({
      'Browser.getVersion': VERSION,
      'Storage.getCookies': { cookies: SESSION },
      'Target.createTarget': { targetId: 't1' },
      'Target.attachToTarget': { sessionId: 's1' },
      'Runtime.evaluate': { result: { value: ['Google Account: Bot (bot@gmail.com)'] } },
    })
    const result = await checkBotAccount({
      ...base,
      chromePath: 'chrome.exe',
      launch: () => fake.chrome,
      readFile: () => {
        throw new Error('no Preferences yet')
      },
    })
    expect(result.emails).toEqual(['bot@gmail.com'])
    expect(fake.asked).toContain('Target.closeTarget')
  })

  it('turns a Chrome failure into a named problem, and still closes it', async () => {
    const fake = fakeChrome({ 'Browser.getVersion': new Error('Chrome exited with code 1') })
    const tracked: (LaunchedChrome | null)[] = []
    const result = await checkBotAccount({
      ...base,
      chromePath: 'chrome.exe',
      launch: () => fake.chrome,
      track: (c) => tracked.push(c),
    })
    expect(result.problem).toMatchObject({ state: 'failed' })
    expect(result.problem?.message).toContain('Chrome exited with code 1')
    expect(fake.closed()).toBe(true)
    expect(tracked).toEqual([fake.chrome, null])
  })
})
