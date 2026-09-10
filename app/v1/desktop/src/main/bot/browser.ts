import { writeFileSync } from 'node:fs'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { installedVersion } from './chrome.js'
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
 */

export type ClickTarget = 'join' | 'leave' | 'continue-without-devices' | 'mic-off' | 'camera-off' | 'dialog-ok'

export interface BotPage {
  goto(url: string): Promise<void>
  snapshot(): Promise<PageSnapshot>
  /** True when something was clicked. Never throws: a missing button is a false. */
  click(target: ClickTarget): Promise<boolean>
  screenshot(file: string): Promise<void>
  /** The whole page as one file, for reading what Meet actually served. */
  mhtml(file: string): Promise<void>
}

export interface BotBrowser {
  page: BotPage
  chromeVersion: string | null
  readonly closed: boolean
  close(): Promise<void>
}

const SNAPSHOT = snapshotScript(JOIN_LABELS)

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

export async function launchBotBrowser(options: {
  chromePath: string
  profileDir: string
}): Promise<BotBrowser> {
  const context: BrowserContext = await chromium.launchPersistentContext(options.profileDir, {
    executablePath: options.chromePath,
    headless: false,
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
    async click(target) {
      const element = locate(page, target)
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
