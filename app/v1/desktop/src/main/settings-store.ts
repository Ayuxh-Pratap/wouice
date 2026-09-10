import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, clampZoom, type Settings } from '../shared/settings.js'
import { isCharacterId, isPetSize } from '../shared/pet.js'

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
        injection: { ...DEFAULT_SETTINGS.injection, ...raw.injection },
        audio: { ...DEFAULT_SETTINGS.audio, ...raw.audio },
        // Clamped on read, not only on write: this file is meant to be
        // hand-editable, and a zoom of 40 in it would leave a window nobody
        // could reach the settings screen inside to fix.
        appearance: { zoom: clampZoom(raw.appearance?.zoom ?? DEFAULT_SETTINGS.appearance.zoom) },
        pet: {
          enabled: raw.pet?.enabled ?? DEFAULT_SETTINGS.pet.enabled,
          // Not clamped here: `petRect` cannot express an off-screen position
          // whatever it is handed, so the clamp lives with the arithmetic that
          // needs it rather than being repeated at every entry point.
          placement: { ...DEFAULT_SETTINGS.pet.placement, ...raw.pet?.placement },
          // Checked against the list rather than trusted: an id from an older
          // build, or a typo in the file, would otherwise reach the renderer
          // and render nothing at all with no clue as to why.
          character: isCharacterId(raw.pet?.character)
            ? raw.pet.character
            : DEFAULT_SETTINGS.pet.character,
          size: isPetSize(raw.pet?.size) ? raw.pet.size : DEFAULT_SETTINGS.pet.size,
        },
        // Merged, not spread. `...raw` above replaces `meetings` wholesale, so a
        // file written before a field existed never gained it: `defaultKind`
        // was silently undefined on older files, masked only because `kindOf`
        // falls back to the default. `me` has no such fallback and would crash.
        meetings: {
          ...DEFAULT_SETTINGS.meetings,
          ...raw.meetings,
          me: { ...DEFAULT_SETTINGS.meetings.me, ...raw.meetings?.me },
          bot: { ...DEFAULT_SETTINGS.meetings.bot, ...raw.meetings?.bot },
        },
      }
    } catch {
      // A hand-edited file with a trailing comma must not brick the app.
      return structuredClone(DEFAULT_SETTINGS)
    }
  }
}
