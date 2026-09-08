import bulbasaur from '../assets/pet/bulbasaur.webp'
import codette from '../assets/pet/codette.webp'
import kurisu from '../assets/pet/kurisu.webp'
import type { CharacterId } from '../../shared/pet.js'

/**
 * The characters, and the three animations taken from each.
 *
 * WHAT IS IN A SHEET, AND WHAT IS NOT. The manifest shipped beside each one
 * names the file and nothing else - no grid, no frame counts, no row meanings.
 * All of that was measured off the images: scanning for the fully transparent
 * gutters between cells gave a pitch of 192 across and 208 down on all of them,
 * the frame count per row came from which cells have any pixels in them, and
 * the meaning of each row came from looking at them.
 *
 * THE ROWS ARE NOT A CONVENTION TO RELY ON, and neither are the frame counts.
 * Two things this cost, both found by comparing the cells pixel by pixel rather
 * than by counting the ones that have something in them:
 *
 *   A TRAILING DUPLICATE. Kurisu's and Codette's idle rows have seven cells,
 *   and the seventh is a copy of the first - padding, not a frame. Playing all
 *   seven held frame one for two beats at the loop point, once a cycle, which
 *   reads as a stutter with nothing to point at.
 *
 *   ROWS THAT DO NOT ANIMATE. Every cell of Codette's row 3 is identical to
 *   every other, and so is her row 4. The sheet names them Waving and Jumping;
 *   she does neither. Her outcome pose is Review instead, which moves.
 *
 * So the rows and the counts are stated per character below, from measurement.
 *
 * ONLY THREE ROWS OF EACH ARE USED. The sheets also hold walk cycles in both
 * directions, a sit and a sleep. A pet that wanders across the desktop is a
 * different product; this one has a place it was put and three things to say
 * from it.
 */

export const CELL = { width: 192, height: 208 } as const

export type Pose = 'idle' | 'waiting' | 'waving'

interface Animation {
  /** Row in the sheet. */
  row: number
  frames: number
  /** One full cycle. */
  durationMs: number
}

export interface Character {
  id: CharacterId
  name: string
  src: string
  /** Sheet width and height, needed for `background-size`. */
  sheet: { width: number; height: number }
  poses: Record<Pose, Animation>
}

export const CHARACTERS: Record<CharacterId, Character> = {
  kurisu: {
    id: 'kurisu',
    name: 'Kurisu',
    src: kurisu,
    sheet: { width: 1536, height: 2288 },
    poses: {
      // SIX, not the seven cells that have pixels in them: the seventh is a
      // copy of the first.
      idle: { row: 0, frames: 6, durationMs: 1_400 },
      /**
       * Used for the whole of a dictation - waking, listening and thinking -
       * because those are one continuous act from the pet's point of view, and
       * cutting between poses inside it would draw the eye at exactly the
       * moment someone is trying to talk.
       */
      waiting: { row: 6, frames: 6, durationMs: 900 },
      waving: { row: 3, frames: 4, durationMs: 720 },
    },
  },
  codette: {
    id: 'codette',
    name: 'Codette',
    src: codette,
    sheet: { width: 1536, height: 2288 },
    /**
     * The one sheet that needs a different map entirely.
     *
     * Her row 0 idle is a near-still sit; the sheet's own Running row is the
     * loop of her working at the laptop, and that is the one worth watching
     * while nothing is happening. Rows 3 and 4 - the sheet calls them Waving
     * and Jumping - are single frames repeated, so the outcome uses Review,
     * which actually moves.
     */
    poses: {
      idle: { row: 7, frames: 6, durationMs: 1_100 },
      waiting: { row: 6, frames: 6, durationMs: 900 },
      waving: { row: 8, frames: 6, durationMs: 900 },
    },
  },
  bulbasaur: {
    id: 'bulbasaur',
    name: 'Bulbasaur',
    src: bulbasaur,
    sheet: { width: 1536, height: 1872 },
    /**
     * A different sheet entirely: nine rows of eight frames, every one of them
     * a variation on standing, and every one of them genuinely animated.
     *
     * Row 3 is NOT a wave here, so the layout the others use would have given
     * him a wave that looks exactly like his idle. Row 1 is the only real
     * gesture on the sheet - a vine sprouts from the bulb and reaches out -
     * which is as close to a wave as a Bulbasaur gets. Row 5 has a head turn
     * that reads as attention, so it carries the dictation.
     */
    poses: {
      idle: { row: 0, frames: 8, durationMs: 1_600 },
      waiting: { row: 5, frames: 8, durationMs: 1_000 },
      waving: { row: 1, frames: 8, durationMs: 1_100 },
    },
  },
}

export const CHARACTER_LIST: Character[] = Object.values(CHARACTERS)

export function characterOf(id: CharacterId): Character {
  return CHARACTERS[id] ?? CHARACTERS.kurisu
}

/**
 * The CSS needed to show one pose at a given rendered height.
 *
 * The scale is driven by height rather than width because the cells are taller
 * than they are wide, and the pet's box is square: fitting to width would crop
 * the character's head.
 */
export function spriteStyle(
  character: Character,
  pose: Pose,
  boxHeight: number
): React.CSSProperties {
  const anim = character.poses[pose]
  const scale = boxHeight / CELL.height
  return {
    width: CELL.width * scale,
    height: boxHeight,
    backgroundImage: `url(${character.src})`,
    backgroundSize: `${character.sheet.width * scale}px ${character.sheet.height * scale}px`,
    backgroundPositionX: '0px',
    backgroundPositionY: `-${anim.row * CELL.height * scale}px`,
    // Read by the keyframe, which cannot know how many frames this row has.
    ['--pet-end' as string]: `-${anim.frames * CELL.width * scale}px`,
    animationDuration: `${anim.durationMs}ms`,
  }
}

/**
 * How many frames the row has.
 *
 * Needed as a CLASS and not as a style, because `steps()` cannot read a custom
 * property: the step count has to be literal in the stylesheet. The characters
 * do not agree - four, six and eight all appear - which is exactly the kind of
 * thing that would otherwise show up as one of them stuttering, with nothing to
 * point at.
 */
export function poseFrames(character: Character, pose: Pose): number {
  return character.poses[pose].frames
}

/** One still frame, for the picker in settings. */
export function posterStyle(character: Character, boxHeight: number): React.CSSProperties {
  const scale = boxHeight / CELL.height
  return {
    width: CELL.width * scale,
    height: boxHeight,
    backgroundImage: `url(${character.src})`,
    backgroundSize: `${character.sheet.width * scale}px ${character.sheet.height * scale}px`,
    backgroundPosition: '0px 0px',
  }
}
