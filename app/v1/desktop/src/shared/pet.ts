/**
 * Where the dictation overlay lives, and which way it opens.
 *
 * THE OVERLAY IS A STAGE, NOT A PILL. The old one was a 340x76 window that WAS
 * the pill: every state got the same rectangle whether it had a word to say or
 * a waveform to draw, and any change of size meant changing the window and the
 * CSS together and watching it jump. This is a larger, invisible, click-through
 * window inside which the pet sits at one end and the capsule grows out of it.
 * Nothing about the window changes between phases, so the capsule can animate
 * its own width freely.
 *
 * PLACEMENT IS THE PET, NOT THE WINDOW. Someone parks the character somewhere;
 * they have no idea the stage around it is three times as wide. Storing the
 * pet's position and deriving the window from it is what keeps the pet still
 * when the capsule flips sides.
 *
 * STORED AS A FRACTION of the usable range rather than in pixels. This machine
 * has a 32-inch monitor and a laptop panel; pixel coordinates from one are
 * meaningless on the other, and a pet parked at x=2800 would simply be gone.
 */

/** The invisible window. Wide enough for the longest capsule it can open. */
export const PET_STAGE = { width: 432, height: 128 } as const

/** The character itself, square, at the near end of the stage. */
export const PET_SIZE = 76

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the pet is parked, as a fraction of the usable range in each axis.
 *
 * 0 is hard against the left or top of the work area, 1 hard against the right
 * or bottom. Fractions of the RANGE and not of the screen, so the pet can never
 * be placed half off the edge: the arithmetic cannot express it.
 */
export interface PetPlacement {
  x: number
  y: number
}

/**
 * Bottom right, above where a taskbar usually is.
 *
 * Not hard into the corner: 0.97 leaves a sliver so the pet reads as sitting on
 * the desktop rather than as something clipped by it.
 */
export const DEFAULT_PLACEMENT: PetPlacement = { x: 0.97, y: 0.82 }

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5
  return Math.min(1, Math.max(0, n))
}

/**
 * Which end of the stage the pet occupies.
 *
 * The capsule always grows toward the middle of the screen, because growing the
 * other way would send it off the edge. A pet parked on the right therefore
 * sits at the stage's right edge with the capsule opening leftwards.
 */
export function petSide(placement: PetPlacement): 'left' | 'right' {
  return clamp01(placement.x) > 0.5 ? 'right' : 'left'
}

/** The pet's own square, in screen coordinates. */
export function petRect(placement: PetPlacement, workArea: Rect): Rect {
  const x = clamp01(placement.x)
  const y = clamp01(placement.y)
  return {
    x: Math.round(workArea.x + x * Math.max(0, workArea.width - PET_SIZE)),
    y: Math.round(workArea.y + y * Math.max(0, workArea.height - PET_SIZE)),
    width: PET_SIZE,
    height: PET_SIZE,
  }
}

/**
 * The window to create, derived from where the pet should appear.
 *
 * The stage is taller than the pet so the capsule has room to sit centred on
 * it, and the pet is centred vertically inside that.
 */
export function stageBounds(placement: PetPlacement, workArea: Rect): Rect {
  const pet = petRect(placement, workArea)
  const side = petSide(placement)
  return {
    x: side === 'left' ? pet.x : pet.x + PET_SIZE - PET_STAGE.width,
    y: Math.round(pet.y - (PET_STAGE.height - PET_SIZE) / 2),
    width: PET_STAGE.width,
    height: PET_STAGE.height,
  }
}

/**
 * Turn a dragged pet position back into a placement.
 *
 * Takes the PET's top-left in screen coordinates, not the window's: a drag
 * moves the character, and the window is wherever it has to be for the
 * character to be there.
 */
export function placementFromPet(x: number, y: number, workArea: Rect): PetPlacement {
  const rangeX = Math.max(1, workArea.width - PET_SIZE)
  const rangeY = Math.max(1, workArea.height - PET_SIZE)
  return {
    x: clamp01((x - workArea.x) / rangeX),
    y: clamp01((y - workArea.y) / rangeY),
  }
}

/**
 * Snap to an edge when the pet is dropped near one.
 *
 * A pet three pixels off the right edge looks like a mistake rather than a
 * choice, and nobody can place it exactly by hand. The threshold is in
 * fractions rather than pixels so it means the same thing on both monitors.
 */
const SNAP = 0.04

export function snap(placement: PetPlacement): PetPlacement {
  const axis = (v: number): number => {
    const c = clamp01(v)
    if (c < SNAP) return 0
    if (c > 1 - SNAP) return 1
    return c
  }
  return { x: axis(placement.x), y: axis(placement.y) }
}
