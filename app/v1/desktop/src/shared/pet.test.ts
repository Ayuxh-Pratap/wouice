import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLACEMENT,
  PET_SIZES,
  STAGE_OVERHANG,
  petPixels,
  stageSize,
  petRect,
  petSide,
  placementFromPet,
  snap,
  stageBounds,
  type PetSize,
  type Rect,
} from './pet.js'

/** A 32-inch monitor's work area, and a laptop's, with an offset second screen. */
/** The medium character. The geometry is the same shape at any size. */
const PX = petPixels('medium')

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
        const r = petRect(placement, area, PX)
        expect(r.x).toBeGreaterThanOrEqual(area.x)
        expect(r.y).toBeGreaterThanOrEqual(area.y)
        expect(r.x + PX).toBeLessThanOrEqual(area.x + area.width)
        expect(r.y + PX).toBeLessThanOrEqual(area.y + area.height)
      }
    }
  })

  it('cannot be placed off screen by a bad stored value', () => {
    // The settings file is meant to be hand-editable, and a fraction is the
    // one representation where "off screen" is not expressible.
    const r = petRect({ x: 40, y: -3 }, BIG, PX)
    expect(r.x).toBe(BIG.width - PX)
    // Not zero: the top of her range is inset by the stage's overhang.
    expect(r.y).toBe(STAGE_OVERHANG)
  })

  it('falls back to the middle rather than NaN', () => {
    const r = petRect({ x: Number.NaN, y: Number.NaN }, BIG, PX)
    expect(Number.isFinite(r.x)).toBe(true)
    expect(Number.isFinite(r.y)).toBe(true)
  })

  it('survives being measured on one screen and drawn on another', () => {
    // Parked on the big monitor, then the app opens on the laptop panel. The
    // fraction is the whole reason this is not a pet at x=2400 on a 1366 screen.
    const parked = placementFromPet(2400, 1100, BIG, PX)
    const onLaptop = petRect(parked, SMALL, PX)
    expect(onLaptop.x + PX).toBeLessThanOrEqual(SMALL.width)
    expect(onLaptop.y + PX).toBeLessThanOrEqual(SMALL.height)
  })

  it('round-trips a drag back to the same pixel', () => {
    const p = placementFromPet(1234, 567, BIG, PX)
    expect(petRect(p, BIG, PX)).toMatchObject({ x: 1234, y: 567 })
  })

  it('round-trips at the vertical extremes too', () => {
    // `petRect` and `placementFromPet` have to be inverses, or a pet dropped at
    // the top of the screen reappears somewhere else.
    for (const y of [34, 700, 1270]) {
      expect(petRect(placementFromPet(500, y, BIG, PX), BIG, PX).y).toBe(y)
    }
  })

  it('measures from the work area, not from zero', () => {
    // A second monitor to the left has negative coordinates, and a taskbar
    // moves the origin down. Both are ordinary here.
    const p = placementFromPet(-1920, 120 + 34, OFFSET, PX)
    expect(p).toEqual({ x: 0, y: 0 })
    expect(petRect(p, OFFSET, PX)).toMatchObject({ x: -1920, y: 120 + 34 })
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
      const stage = stageBounds(p, BIG, PX)
      const pet = petRect(p, BIG, PX)
      const petLeftInStage = petSide(p) === 'left' ? stage.x : stage.x + stageSize(PX).width - PX
      expect(petLeftInStage).toBe(pet.x)
    }
  })

  it('leaves the same overhang above the pet at any size', () => {
    const p = { x: 0.5, y: 0.5 }
    const stage = stageBounds(p, BIG, PX)
    const pet = petRect(p, BIG, PX)
    expect(pet.y - stage.y).toBe(STAGE_OVERHANG)
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

describe('the stage stays on screen', () => {
  const corners = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 0.5, y: 1 },
  ]

  it('never hangs off the top or bottom, wherever she is parked', () => {
    // The stage is taller than the character, to give the thought bubble room.
    // Parked flush against an edge, that overhang would be off the screen - and
    // everything drawn in it, the bubble included, simply would not be there.
    // The pet's vertical range is inset by exactly the overhang to prevent it.
    for (const area of [BIG, SMALL, OFFSET]) {
      for (const p of corners) {
        const s = stageBounds(p, area, PX)
        expect(s.y).toBeGreaterThanOrEqual(area.y)
        expect(s.y + s.height).toBeLessThanOrEqual(area.y + area.height)
      }
    }
  })

  it('opens inward horizontally, so the width never leaves the screen', () => {
    // No inset is needed across: the stage always extends from the character
    // toward the middle of the display, never toward the edge she is nearest.
    for (const area of [BIG, SMALL, OFFSET]) {
      for (const p of corners) {
        const s = stageBounds(p, area, PX)
        expect(s.x).toBeGreaterThanOrEqual(area.x)
        expect(s.x + s.width).toBeLessThanOrEqual(area.x + area.width)
      }
    }
  })

  it('still holds the pet at the end it says it does', () => {
    for (const p of corners) {
      const s = stageBounds(p, BIG, PX)
      const pet = petRect(p, BIG, PX)
      const flush = petSide(p) === 'left' ? s.x : s.x + stageSize(PX).width - PX
      expect(flush).toBe(pet.x)
    }
  })

  it('costs the character the overhang at each end, and no more', () => {
    const top = petRect({ x: 0.5, y: 0 }, BIG, PX)
    const bottom = petRect({ x: 0.5, y: 1 }, BIG, PX)
    expect(top.y - BIG.y).toBe(STAGE_OVERHANG)
    expect(BIG.y + BIG.height - (bottom.y + PX)).toBe(STAGE_OVERHANG)
  })
})

describe('the character size', () => {
  const SIZES = ['small', 'medium', 'large', 'huge'] as const

  it('keeps the whole stage on screen at every size', () => {
    // The stage grows with her, so the biggest character is the one that would
    // hang off the edge if the vertical range were not inset by the overhang.
    for (const size of SIZES) {
      const px = petPixels(size)
      for (const p of [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]) {
        const s = stageBounds(p, BIG, px)
        expect(s.y).toBeGreaterThanOrEqual(BIG.y)
        expect(s.y + s.height).toBeLessThanOrEqual(BIG.y + BIG.height)
        expect(s.x).toBeGreaterThanOrEqual(BIG.x)
        expect(s.x + s.width).toBeLessThanOrEqual(BIG.x + BIG.width)
      }
    }
  })

  it('round-trips a drag at every size', () => {
    // `petRect` and `placementFromPet` both take the size now, and they have to
    // stay inverses of each other for each one of them.
    for (const size of SIZES) {
      const px = petPixels(size)
      expect(petRect(placementFromPet(700, 500, BIG, px), BIG, px)).toMatchObject({
        x: 700,
        y: 500,
      })
    }
  })

  it('keeps the pet flush to the end of the stage it is said to be at', () => {
    for (const size of SIZES) {
      const px = petPixels(size)
      const p = { x: 0.9, y: 0.5 }
      const s = stageBounds(p, BIG, px)
      expect(s.x + s.width - px).toBe(petRect(p, BIG, px).x)
    }
  })

  it('falls back rather than producing NaN for an unknown size', () => {
    expect(petPixels('enormous' as PetSize)).toBe(PET_SIZES.medium)
  })
})
