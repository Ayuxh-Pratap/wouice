import { writeFileSync } from 'node:fs'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { installedVersion } from './chrome.js'
import { MEET_PAYLOAD, PAGE_BINDING } from './meet-payload.js'
import { JOIN_LABELS, TEXTS, snapshotScript, type PageSnapshot } from './meet-ui.js'

/**
 * The bot's Chrome: the one place Playwright is used.
 *
 * Everything else talks to `BotBrowser`, so the joining logic can be tested
 * against a scripted page, and the driver could be swapped without touching it.
 *
 * INSTALLED CHROME, THE SIGNED-IN PROFILE, A REAL WINDOW. The profile is the
 * one you signed in to by hand (B0); Google refuses sign-in in an automated
 * browser but not a signed-in session used by one. The window is real and, for
 * now, visible: Meet treats headless browsers with suspicion, and while joining
 * is new it is worth being able to watch. Playwright talks to it over a pipe,
 * never a port.
 *
 * THE HOOK GOES IN FIRST. `meet-payload.ts` runs in every page before Meet's
 * own scripts and reaches Wouice through a binding. Both are set on the context
 * before the first navigation, so no channel Meet opens is missed.
 */

export type ClickTarget = 'join' | 'leave' | 'continue-without-devices' | 'mic-off' | 'camera-off' | 'dialog-ok'

export interface CaptionsResult {
  /** Meet shows its captions as on. */
  on: boolean
  /** Whether the caption language was chosen. Null when none was asked for. */
  languageSet: boolean | null
  /** Meet's settings dialog still open over the call afterwards. */
  settingsOpen?: boolean
}

export interface BotPage {
  goto(url: string): Promise<void>
  snapshot(): Promise<PageSnapshot>
  /** True when something was clicked. Never throws: a missing button is a false. */
  click(target: ClickTarget): Promise<boolean>
  screenshot(file: string): Promise<void>
  /** The whole page as one file, for reading what Meet actually served. */
  mhtml(file: string): Promise<void>
  /** Everything the hook in Meet's page forwards, as it arrives. One listener; a second replaces the first. */
  onMessage(listener: (raw: string) => void): void
  /** Meet's captions on, in `language` when given (e.g. `hi-IN`). Never throws. */
  enableCaptions(language: string | null): Promise<CaptionsResult>
}

export interface BotBrowser {
  page: BotPage
  chromeVersion: string | null
  readonly closed: boolean
  close(): Promise<void>
}

const SNAPSHOT = snapshotScript(JOIN_LABELS)
const CAPTIONS_ARE_ON = '[aria-label^="Turn off captions"]'
const TURN_CAPTIONS_ON = '[aria-label^="Turn on captions"]'

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function locate(page: Page, target: ClickTarget): Locator {
  switch (target) {
    case 'join':
      return page
        .getByRole('button', { name: new RegExp(`^\\s*(${JOIN_LABELS.map(escape).join('|')})\\s*$`) })
        .first()
    case 'leave':
      return page.locator('[aria-label^="Leave call"]').first()
    case 'continue-without-devices':
      return page.getByRole('button', { name: TEXTS.continueWithoutDevices }).first()
    case 'mic-off':
      return page.locator('[aria-label^="Turn off microphone"]').first()
    case 'camera-off':
      return page.locator('[aria-label^="Turn off camera"]').first()
    case 'dialog-ok':
      return page.locator('button[data-mdc-dialog-action="ok"]').first()
  }
}

/** Click, or failing that dispatch a click. False when there is nothing to press. */
async function press(element: Locator): Promise<boolean> {
  try {
    await element.click({ timeout: 3_000 })
    return true
  } catch {
    // Covered or not quite visible: Meet's own handler still runs on a
    // dispatched click, which is what Attendee falls back to as well.
    try {
      await element.dispatchEvent('click', undefined, { timeout: 1_000 })
      return true
    } catch {
      return false
    }
  }
}

/**
 * Captions on: the toolbar button, or Meet's own shortcut, c, when the toolbar
 * is hidden. Either way the answer is what the page shows afterwards.
 */
async function turnOnCaptions(page: Page): Promise<boolean> {
  const on = page.locator(CAPTIONS_ARE_ON).first()
  // Attached, not visible: with the toolbar hidden a visibility check would
  // say off, and the shortcut would then turn them off.
  if ((await on.count().catch(() => 0)) > 0) return true
  if (!(await press(page.locator(TURN_CAPTIONS_ON).first()))) {
    await page.keyboard.press('c').catch(() => undefined)
  }
  try {
    await on.waitFor({ state: 'attached', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/**
 * The language Meet captions in: More options, Settings, Captions, then the
 * language list, whose options carry the code. Menus are closed afterwards
 * whether or not it worked.
 */
async function setCaptionLanguage(page: Page, language: string): Promise<boolean> {
  try {
    if (!(await press(page.locator('[aria-label="More options"]').first()))) return false
    if (!(await press(page.getByRole('menuitem', { name: /Settings$/ }).first()))) return false
    if (!(await press(page.getByRole('tab', { name: /Captions/ }).first()))) return false
    if (!(await press(page.locator('[role="dialog"] [role="combobox"]').first()))) return false
    // The list Attendee picks from, by name; any option with the code if Meet renamed it.
    const option = page
      .locator(`ul[aria-label="Meeting language"] li[data-value="${language}"]`)
      .or(page.locator(`li[data-value="${language}"]`))
      .first()
    return await press(option)
  } finally {
    await closeSettings(page)
  }
}

/**
 * Close Meet's settings dialog. Two presses of Escape left it open over the
 * call in a real meeting, so: its own close button, else Escape, until it is
 * gone. True when it is.
 */
async function closeSettings(page: Page): Promise<boolean> {
  const dialog = page.locator('[role="dialog"]').filter({ hasText: 'Captions' }).first()
  for (let i = 0; i < 3; i++) {
    if (!(await dialog.isVisible().catch(() => false))) return true
    if (!(await press(dialog.locator('button[aria-label^="Close"]').first()))) {
      await page.keyboard.press('Escape').catch(() => undefined)
    }
    await page.waitForTimeout(400).catch(() => undefined)
  }
  return !(await dialog.isVisible().catch(() => false))
}

export async function launchBotBrowser(options: {
  chromePath: string
  profileDir: string
}): Promise<BotBrowser> {
  const context: BrowserContext = await chromium.launchPersistentContext(options.profileDir, {
    executablePath: options.chromePath,
    headless: false,
    // Playwright turns Chrome's sandbox off unless asked. A browser signed in
    // to a Google account, loading pages from other people's meetings, keeps
    // it - and Chrome stops showing its "unsupported command-line flag" bar.
    chromiumSandbox: true,
    // The window's own size, not an emulated one.
    viewport: null,
    locale: 'en-US',
    // No "controlled by automated software" bar, and no navigator.webdriver.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      // A meeting runs for an hour in a window nobody is looking at.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // The bot must not play the meeting through your speakers: you would
      // hear it twice, and so would your own recorder.
      '--mute-audio',
      '--window-size=1100,780',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  let listener: ((raw: string) => void) | null = null
  try {
    await context.exposeBinding(PAGE_BINDING, (_source, raw: unknown) => {
      if (typeof raw === 'string') listener?.(raw)
    })
    await context.addInitScript(MEET_PAYLOAD)
  } catch (err) {
    // A Chrome left open holds the profile, and blocks the next attempt.
    await context.close().catch(() => undefined)
    throw err
  }

  let closed = false
  context.on('close', () => {
    closed = true
  })
  const page = context.pages()[0] ?? (await context.newPage())
  page.on('crash', () => {
    closed = true
  })

  const botPage: BotPage = {
    async goto(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    },
    async snapshot() {
      return (await page.evaluate(SNAPSHOT)) as PageSnapshot
    },
    click(target) {
      return press(locate(page, target))
    },
    async screenshot(file) {
      await page.screenshot({ path: file, timeout: 5_000 })
    },
    async mhtml(file) {
      const cdp = await context.newCDPSession(page)
      try {
        const { data } = (await cdp.send('Page.captureSnapshot', { format: 'mhtml' })) as { data: string }
        writeFileSync(file, data, 'utf8')
      } finally {
        await cdp.detach().catch(() => undefined)
      }
    },
    onMessage(next) {
      listener = next
    },
    async enableCaptions(language) {
      const languageSet = language ? await setCaptionLanguage(page, language).catch(() => false) : null
      const settingsOpen = language ? !(await closeSettings(page).catch(() => false)) : false
      return { on: await turnOnCaptions(page).catch(() => false), languageSet, settingsOpen }
    },
  }

  return {
    page: botPage,
    chromeVersion: installedVersion(options.chromePath),
    get closed() {
      return closed
    },
    async close() {
      if (closed) return
      // Closing a persistent context closes its Chrome. Bounded, because a
      // Chrome left holding the profile blocks the next run and every check.
      await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 10_000))])
      closed = true
    },
  }
}
