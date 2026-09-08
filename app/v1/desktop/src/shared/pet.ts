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

/**
 * How much invisible window there is around the character.
 *
 * ACROSS: room for the bubble to open inward from her. DOWN: room for the
 * thought bubble to sit above her head without leaving the window - it hangs a
 * fixed distance off her shoulder whatever size she is, so this is a constant
 * rather than a proportion.
 */
export const STAGE_PAD_X = 344
export const STAGE_OVERHANG = 34

/** The window for a character of `px`. Everything else is derived from this. */
export function stageSize(px: number): { width: number; height: number } {
  return { width: px + STAGE_PAD_X, height: px + STAGE_OVERHANG * 2 }
}

/**
 * How big the character is drawn, as named sizes rather than a number.
 *
 * WHY IT IS A SETTING. The sheets do not agree on how much of a cell the
 * character fills - Kurisu stands full height, Bulbasaur is a squat blob, and
 * Codette is sitting down - so one pixel size that suits one of them leaves
 * another looking wrong. Rather than hand-tune a fudge factor per character and
 * get it wrong for the next one, the size is something you set.
 *
 * The sprite cells are 192x208, taller than they are wide, and are fitted by
 * HEIGHT - fitting by width would crop the character's head. So she draws about
 * 0.92 of this across, and this square is what the hover and drag hit-testing
 * uses.
 */
export const PET_SIZES = { small: 68, medium: 88, large: 116, huge: 148 } as const

export type PetSize = keyof typeof PET_SIZES
export const DEFAULT_PET_SIZE: PetSize = 'medium'

export const PET_SIZE_LABELS: Record<PetSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  huge: 'Huge',
}

export function petPixels(size: PetSize): number {
  return PET_SIZES[size] ?? PET_SIZES[DEFAULT_PET_SIZE]
}

export function isPetSize(v: unknown): v is PetSize {
  return typeof v === 'string' && v in PET_SIZES
}

/**
 * The characters that ship with the app.
 *
 * Listed HERE, in shared, rather than in the renderer that draws them: the
 * setting has to be validated in main, and main cannot import a module that
 * pulls in three megabytes of sprite sheets. The renderer keeps the artwork and
 * the frame data; this is only the list of names that are allowed.
 */
export const CHARACTER_IDS = ['kurisu', 'codette', 'bulbasaur'] as const
export type CharacterId = (typeof CHARACTER_IDS)[number]
export const DEFAULT_CHARACTER: CharacterId = 'kurisu'

export function isCharacterId(v: unknown): v is CharacterId {
  return typeof v === 'string' && (CHARACTER_IDS as readonly string[]).includes(v)
}

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

/**
 * How far the stage sticks out above and below the character.
 *
 * The room the thought bubble needs. It is also the reason the pet cannot be
 * parked flush against the top or bottom of the screen: the window around her
 * would hang off the edge, and everything drawn in the part that is off screen
 * - the bubble included - would simply not be there.
 *
 * Thirty-four pixels of unreachable margin is a better trade than a bubble that
 * vanishes in the corner someone most wants to park in.
 */
/** The pet's own square, in screen coordinates. */
export function petRect(placement: PetPlacement, workArea: Rect, px: number): Rect {
  const x = clamp01(placement.x)
  const y = clamp01(placement.y)
  // The vertical range is inset so the whole stage stays on screen; the
  // horizontal is not, because the stage only ever extends inward from her.
  const top = workArea.y + STAGE_OVERHANG
  const travel = Math.max(0, workArea.height - px - STAGE_OVERHANG * 2)
  return {
    x: Math.round(workArea.x + x * Math.max(0, workArea.width - px)),
    y: Math.round(top + y * travel),
    width: px,
    height: px,
  }
}

/**
 * The window to create, derived from where the pet should appear.
 *
 * The stage is taller than the pet so the capsule has room to sit centred on
 * it, and the pet is centred vertically inside that.
 */
export function stageBounds(placement: PetPlacement, workArea: Rect, px: number): Rect {
  const pet = petRect(placement, workArea, px)
  const side = petSide(placement)
  const stage = stageSize(px)
  return {
    x: side === 'left' ? pet.x : pet.x + px - stage.width,
    y: Math.round(pet.y - STAGE_OVERHANG),
    width: stage.width,
    height: stage.height,
  }
}

/**
 * Turn a dragged pet position back into a placement.
 *
 * Takes the PET's top-left in screen coordinates, not the window's: a drag
 * moves the character, and the window is wherever it has to be for the
 * character to be there.
 */
export function placementFromPet(
  x: number,
  y: number,
  workArea: Rect,
  px: number
): PetPlacement {
  const rangeX = Math.max(1, workArea.width - px)
  // The same inset range `petRect` uses, or a drag would not land where it was
  // dropped: the two have to be inverses of each other.
  const rangeY = Math.max(1, workArea.height - px - STAGE_OVERHANG * 2)
  return {
    x: clamp01((x - workArea.x) / rangeX),
    y: clamp01((y - workArea.y - STAGE_OVERHANG) / rangeY),
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
