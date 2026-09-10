import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotStatusView } from '../../shared/ipc.js'
import type { AccountFacts } from './account.js'
import { BotIdentity, SIGN_IN_URL, type ChromeWindow } from './identity.js'

/**
 * The bot's identity: sign in by hand, then a check, with the state in one place.
 */

let profileDir: string

beforeEach(() => {
  profileDir = mkdtempSync(path.join(os.tmpdir(), 'wouice-bot-identity-'))
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

const signedIn = (email = 'bot@gmail.com'): AccountFacts => ({
  signedIn: true,
  emails: [email],
  chromeVersion: '153.0.8010.36',
  checkedAt: 7,
  problem: null,
})

function identity(check: () => Promise<AccountFacts>, expected = 'bot@gmail.com') {
  const windows: { args: string[]; window: EventEmitter }[] = []
  const seen: BotStatusView[] = []
  const bot = new BotIdentity({
    profileDir,
    expected: () => expected,
    chromePath: () => 'chrome.exe',
    check,
    openWindow: (_path, args) => {
      const window = new EventEmitter()
      windows.push({ args, window })
      return window as unknown as ChromeWindow
    },
  })
  bot.on('status', (view: BotStatusView) => seen.push(view))
  return { bot, windows, seen }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the bot identity', () => {
  it('has not been checked until it is', () => {
    const { bot } = identity(async () => signedIn())
    expect(bot.view()).toMatchObject({ state: 'unknown', expected: 'bot@gmail.com' })
  })

  it('checks, says it is checking, and reports the account', async () => {
    const { bot, seen } = identity(async () => signedIn())
    const view = await bot.check()
    expect(view).toMatchObject({ state: 'signed-in', email: 'bot@gmail.com', chromeVersion: '153.0.8010.36' })
    expect(seen.map((s) => s.state)).toEqual(['checking', 'signed-in'])
  })

  it('answers two asks at once from one check', async () => {
    let runs = 0
    const { bot } = identity(async () => {
      runs++
      return signedIn()
    })
    await Promise.all([bot.check(), bot.check()])
    expect(runs).toBe(1)
  })

  it('reads the expected account fresh, so a settings change shows at once', async () => {
    let expected = 'bot@gmail.com'
    const bot = new BotIdentity({
      profileDir,
      expected: () => expected,
      chromePath: () => 'chrome.exe',
      check: async () => signedIn(),
    })
    await bot.check()
    expected = 'other@gmail.com'
    expect(bot.view().state).toBe('wrong-account')
  })

  it('opens ordinary Chrome on the profile, and checks once the window is closed', async () => {
    let runs = 0
    const { bot, windows, seen } = identity(async () => {
      runs++
      return signedIn()
    })
    expect(bot.openSignIn()).toBeNull()
    expect(bot.view().state).toBe('signing-in')
    expect(windows[0]!.args).toContain(`--user-data-dir=${profileDir}`)
    expect(windows[0]!.args).toContain(SIGN_IN_URL)
    // Nothing that drives Chrome: Google refuses sign-in in an automated browser.
    expect(windows[0]!.args.some((a) => a.includes('remote-debugging') || a.includes('headless'))).toBe(false)

    // No check while the window holds the profile.
    await bot.check()
    expect(runs).toBe(0)

    windows[0]!.window.emit('exit')
    await settle()
    expect(runs).toBe(1)
    expect(seen.at(-1)).toMatchObject({ state: 'signed-in' })
  })

  it('opens one sign-in window at a time', () => {
    const { bot } = identity(async () => signedIn())
    expect(bot.openSignIn()).toBeNull()
    expect(bot.openSignIn()).toMatch(/already open/)
  })

  it('says so when Chrome is missing', () => {
    const bot = new BotIdentity({ profileDir, expected: () => '', chromePath: () => null })
    expect(bot.openSignIn()).toMatch(/Chrome is not installed/)
  })

  it('reports a check that threw as a failure, not as signed out', async () => {
    const { bot } = identity(async () => {
      throw new Error('pipe broke')
    })
    const view = await bot.check()
    expect(view).toMatchObject({ state: 'failed', message: 'pipe broke' })
  })
})
