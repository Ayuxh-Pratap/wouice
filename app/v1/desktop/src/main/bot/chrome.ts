import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Finding the Chrome that is already installed.
 *
 * THE BOT IS REAL CHROME, not a browser shipped with Wouice. Google refuses
 * sign-in inside embedded and automated browsers, so the bot's account is
 * signed in by hand in installed Chrome, and that same Chrome is what later
 * joins meetings. See docs/design/07-meeting-bot.md, D1.
 */

/** Where Chrome installs itself on Windows: per machine first, then per user. */
export function chromeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']]
  return roots
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
}

export function findChrome(
  candidates: readonly string[] = chromeCandidates(),
  exists: (file: string) => boolean = existsSync
): string | null {
  return candidates.find((file) => exists(file)) ?? null
}

/**
 * The newest version folder beside chrome.exe.
 *
 * Chrome keeps each installed version in a folder named for it, and asking
 * chrome.exe for `--version` on Windows opens a window instead of printing one.
 */
export function newestVersion(names: readonly string[]): string | null {
  const versions = names.filter((name) => /^\d+(\.\d+){3}$/.test(name))
  versions.sort((a, b) => {
    const x = a.split('.').map(Number)
    const y = b.split('.').map(Number)
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i]! - x[i]!
    return 0
  })
  return versions[0] ?? null
}

export function installedVersion(
  chromePath: string,
  list: (dir: string) => string[] = (dir) => readdirSync(dir)
): string | null {
  try {
    return newestVersion(list(path.dirname(chromePath)))
  } catch {
    return null
  }
}
