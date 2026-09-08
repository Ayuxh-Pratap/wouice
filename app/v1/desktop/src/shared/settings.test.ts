import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  DEFAULT_SILENCE,
  PAUSE_PRESETS,
  ZOOM_RANGE,
  ZOOM_STEPS,
  applyPausePreset,
  clampZoom,
  pausePresetOf,
  stepZoom,
  zoomLabel,
} from './settings.js'

describe('pause presets', () => {
  it('recognises the shipped default as Normal', () => {
    expect(pausePresetOf(DEFAULT_SILENCE)).toBe('normal')
  })

  it('round-trips every preset', () => {
    for (const name of ['quick', 'normal', 'relaxed'] as const) {
      expect(pausePresetOf(applyPausePreset(DEFAULT_SILENCE, name))).toBe(name)
    }
  })

  it('reports hand-edited values as custom rather than pretending', () => {
    // Someone who set 2000/3500 by hand should not see "Normal" selected and
    // have it silently rewrite their choice on the next click.
    const custom = { ...DEFAULT_SILENCE, shortWindowMs: 2_000, longWindowMs: 3_500 }
    expect(pausePresetOf(custom)).toBe('custom')
  })

  it('leaves custom values alone when custom is applied', () => {
    const custom = { ...DEFAULT_SILENCE, shortWindowMs: 2_000 }
    expect(applyPausePreset(custom, 'custom')).toEqual(custom)
  })

  it('changes only the two windows, never the calibrated levels', () => {
    // The gate is measured from the user's voice. A pause preference must not
    // be able to overwrite it - that is how the original threshold bug felt.
    const calibrated = { ...DEFAULT_SILENCE, minNoiseFloor: 0.00106, speechFactor: 2 }
    const next = applyPausePreset(calibrated, 'relaxed')
    expect(next.minNoiseFloor).toBe(0.00106)
    expect(next.speechFactor).toBe(2)
    expect(next.chunkAfterMs).toBe(calibrated.chunkAfterMs)
    expect(next.maxSessionMs).toBe(calibrated.maxSessionMs)
  })

  it('keeps the long window longer than the short one in every preset', () => {
    // The short window applies early and the long one once you are clearly
    // mid-thought; inverting them would stop long dictations sooner, not later.
    for (const p of Object.values(PAUSE_PRESETS)) {
      expect(p.longWindowMs).toBeGreaterThan(p.shortWindowMs)
    }
  })

  it('orders the presets as their names promise', () => {
    expect(PAUSE_PRESETS.quick.shortWindowMs).toBeLessThan(PAUSE_PRESETS.normal.shortWindowMs)
    expect(PAUSE_PRESETS.normal.shortWindowMs).toBeLessThan(PAUSE_PRESETS.relaxed.shortWindowMs)
  })
})

describe('defaults', () => {
  it('starts on the system microphone rather than naming one', () => {
    // Naming today's default would stop the app following a headset being
    // plugged in, which is the opposite of what "default" means.
    expect(DEFAULT_SETTINGS.audio.deviceId).toBeNull()
  })

  it('ships the models the matrix measured as best', () => {
    expect(DEFAULT_SETTINGS.models.whisper).toBe('turbo')
    expect(DEFAULT_SETTINGS.models.llama).toBe('qwen3-4b')
  })
})

describe('interface scale', () => {
  it('reads as a whole percentage, never a decimal', () => {
    expect(zoomLabel(1)).toBe('100%')
    expect(zoomLabel(1.25)).toBe('125%')
    expect(zoomLabel(0.9)).toBe('90%')
  })

  it('clamps anything a hand-edited file could contain', () => {
    expect(clampZoom(40)).toBe(ZOOM_RANGE.max)
    expect(clampZoom(0)).toBe(ZOOM_RANGE.min)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(1.25)).toBe(1.25)
  })

  it('steps through the offered scales in both directions', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
  })

  it('moves a hand-edited value to the nearest step, rather than doing nothing', () => {
    expect(stepZoom(1.2, 1)).toBe(1.25)
    expect(stepZoom(1.2, -1)).toBe(1.1)
  })

  it('stops at the ends instead of wrapping', () => {
    const lowest = ZOOM_STEPS[0]!
    const highest = ZOOM_STEPS[ZOOM_STEPS.length - 1]!
    expect(stepZoom(lowest, -1)).toBe(lowest)
    expect(stepZoom(highest, 1)).toBe(highest)
  })
})
