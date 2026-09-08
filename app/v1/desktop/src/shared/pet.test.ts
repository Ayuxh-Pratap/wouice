import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLACEMENT,
  PET_SIZE,
  PET_STAGE,
  petRect,
  petSide,
  placementFromPet,
  snap,
  stageBounds,
  type Rect,
} from './pet.js'

/** A 32-inch monitor's work area, and a laptop's, with an offset second screen. */
const BIG: Rect = { x: 0, y: 0, width: 2560, height: 1392 }
const SMALL: Rect = { x: 0, y: 0, width: 1366, height: 728 }
const OFFSET: Rect = { x: -1920, y: 120, width: 1920, height: 1000 }

describe('where the pet is parked', () => {
  it('keeps the whole pet on screen at both extremes', () => {
    for (const area of [BIG, SMALL, OFFSET]) {
      for (const placement of [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]) {
        const r = petRect(placement, area)
        expect(r.x).toBeGreaterThanOrEqual(area.x)
        expect(r.y).toBeGreaterThanOrEqual(area.y)
        expect(r.x + PET_SIZE).toBeLessThanOrEqual(area.x + area.width)
        expect(r.y + PET_SIZE).toBeLessThanOrEqual(area.y + area.height)
      }
    }
  })

  it('cannot be placed off screen by a bad stored value', () => {
    // The settings file is meant to be hand-editable, and a fraction is the
    // one representation where "off screen" is not expressible.
    const r = petRect({ x: 40, y: -3 }, BIG)
    expect(r.x).toBe(BIG.width - PET_SIZE)
    expect(r.y).toBe(0)
  })

  it('falls back to the middle rather than NaN', () => {
    const r = petRect({ x: Number.NaN, y: Number.NaN }, BIG)
    expect(Number.isFinite(r.x)).toBe(true)
    expect(Number.isFinite(r.y)).toBe(true)
  })

  it('survives being measured on one screen and drawn on another', () => {
    // Parked on the big monitor, then the app opens on the laptop panel. The
    // fraction is the whole reason this is not a pet at x=2400 on a 1366 screen.
    const parked = placementFromPet(2400, 1100, BIG)
    const onLaptop = petRect(parked, SMALL)
    expect(onLaptop.x + PET_SIZE).toBeLessThanOrEqual(SMALL.width)
    expect(onLaptop.y + PET_SIZE).toBeLessThanOrEqual(SMALL.height)
  })

  it('round-trips a drag back to the same pixel', () => {
    const p = placementFromPet(1234, 567, BIG)
    expect(petRect(p, BIG)).toMatchObject({ x: 1234, y: 567 })
  })

  it('measures from the work area, not from zero', () => {
    // A second monitor to the left has negative coordinates, and a taskbar
    // moves the origin down. Both are ordinary here.
    const p = placementFromPet(-1920, 120, OFFSET)
    expect(p).toEqual({ x: 0, y: 0 })
    expect(petRect(p, OFFSET)).toMatchObject({ x: -1920, y: 120 })
  })
})

describe('which way the capsule opens', () => {
  it('opens inward from whichever side the pet is parked on', () => {
    expect(petSide({ x: 0.9, y: 0.5 })).toBe('right')
    expect(petSide({ x: 0.1, y: 0.5 })).toBe('left')
  })

  it('ships parked on the right', () => {
    expect(petSide(DEFAULT_PLACEMENT)).toBe('right')
  })

  it('leaves the pet where it is when the stage flips sides', () => {
    // The stage is three times the pet's width and invisible. If flipping sides
    // moved the character, the pet would appear to teleport for no reason the
    // user could see.
    const left = { x: 0.2, y: 0.5 }
    const right = { x: 0.8, y: 0.5 }
    for (const p of [left, right]) {
      const stage = stageBounds(p, BIG)
      const pet = petRect(p, BIG)
      const petLeftInStage = petSide(p) === 'left' ? stage.x : stage.x + PET_STAGE.width - PET_SIZE
      expect(petLeftInStage).toBe(pet.x)
    }
  })

  it('centres the pet vertically in the stage', () => {
    const p = { x: 0.5, y: 0.5 }
    const stage = stageBounds(p, BIG)
    const pet = petRect(p, BIG)
    expect(pet.y - stage.y).toBe((PET_STAGE.height - PET_SIZE) / 2)
  })
})

describe('snapping', () => {
  it('takes a near miss to the edge', () => {
    expect(snap({ x: 0.01, y: 0.5 })).toEqual({ x: 0, y: 0.5 })
    expect(snap({ x: 0.98, y: 0.5 })).toEqual({ x: 1, y: 0.5 })
  })

  it('leaves a deliberate position alone', () => {
    expect(snap({ x: 0.4, y: 0.6 })).toEqual({ x: 0.4, y: 0.6 })
  })
})
