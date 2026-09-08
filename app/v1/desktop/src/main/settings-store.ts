import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings.js'

/**
 * Settings as a single JSON file in userData.
 *
 * Deliberately not SQLite: settings are small, read at startup, and the ability
 * to open the file in an editor when something is wedged is worth more than
 * transactional writes. Unknown keys survive a round trip, and a corrupt file
 * falls back to defaults rather than refusing to launch.
 */
export class SettingsStore {
  private readonly file: string
  private cache: Settings

  constructor(dir = app.getPath('userData')) {
    mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'settings.json')
    this.cache = this.read()
  }

  get path(): string {
    return this.file
  }

  get(): Settings {
    return this.cache
  }

  /** Shallow-merges one level deep, so a partial `hotkeys` does not wipe siblings. */
  set(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.cache }
    for (const [key, value] of Object.entries(patch)) {
      const k = key as keyof Settings
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        next[k] = { ...(this.cache[k] as object), ...(value as object) } as never
      } else if (value !== undefined) {
        next[k] = value as never
      }
    }
    this.cache = next
    writeFileSync(this.file, JSON.stringify(next, null, 2) + '\n', 'utf8')
    return next
  }

  private read(): Settings {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_SETTINGS)
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      // Merge over defaults so a settings file written by an older build gains
      // new keys instead of leaving them undefined at the point of use.
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...raw.hotkeys },
        models: { ...DEFAULT_SETTINGS.models, ...raw.models },
        silence: { ...DEFAULT_SETTINGS.silence, ...raw.silence },
        cleanup: { ...DEFAULT_SETTINGS.cleanup, ...raw.cleanup },
        developerMode: raw.developerMode ?? DEFAULT_SETTINGS.developerMode,
        retainAudio: raw.retainAudio ?? DEFAULT_SETTINGS.retainAudio,
        // Null is a meaningful value here - "never calibrated" - so this must
        // not fall back to the default when it is explicitly null.
        calibration: raw.calibration ?? null,
      }
    } catch {
      // A hand-edited file with a trailing comma must not brick the app.
      return structuredClone(DEFAULT_SETTINGS)
    }
  }
}
