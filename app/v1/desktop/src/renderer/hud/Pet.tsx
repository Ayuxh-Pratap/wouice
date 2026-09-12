import { petPixels, type CharacterId, type PetSize } from '../../shared/pet.js'
import type { Tone } from './phase.js'
import { characterOf, poseFrames, spriteStyle, type Pose } from './sprite.js'

/**
 * The character on the desktop.
 *
 * NO PLATE BEHIND HER. The first version drew the app's waveform mark inside a
 * rounded card, which was fine as a glyph and wrong as a pet: a card is a
 * button, and a button in the corner of the screen is something you avoid
 * rather than something that lives there. The sprite sits directly on the
 * desktop with a soft contact shadow under it, so it reads as an object in the
 * room rather than a control floating over one.
 *
 * STATE IS THE POSE PLUS ONE RING OF LIGHT. A character read out of the corner
 * of the eye is worse than a coloured dot at conveying state, so the glow does
 * that job - red while recording, and nothing else in the app is red - and the
 * pose says what she is doing. Three poses, no more: idle, waiting through the
 * whole of a dictation, and a wave when it lands.
 *
 * ANIMATION IS ONE COMPOSITED PROPERTY. `background-position-x` stepped by
 * `steps()`, which the compositor handles without touching layout or paint.
 * This window is on top of everything for the whole session on a machine
 * already holding two model sidecars in 6 GB of VRAM.
 */

/**
 * The tint of the shadow she stands on. That is the whole of the state colour.
 *
 * MUCH LESS THAN IT WAS. The first version put a blurred aura over her whole
 * body as well, at around 0.35 alpha, and on a dark desktop it read as a lens
 * flare with a character somewhere inside it - the loudest thing on the screen,
 * for a state you are meant to catch out of the corner of your eye. All that is
 * left is a coloured contact shadow at her feet: enough to tell red from amber
 * from green at a glance, not enough to look at.
 */
const AURA: Record<Tone, string> = {
  idle: 'rgb(0 0 0 / 0.45)',
  waking: 'rgb(251 191 36 / 0.22)',
  listening: 'rgb(239 68 68 / 0.26)',
  thinking: 'rgb(251 191 36 / 0.22)',
  inserted: 'rgb(52 211 153 / 0.24)',
  copied: 'rgb(56 189 248 / 0.24)',
  error: 'rgb(220 38 38 / 0.30)',
  paused: 'rgb(251 146 60 / 0.24)',
}

export function Pet({
  character,
  size,
  tone,
  pose,
  hovered,
  dragging,
  children,
}: {
  character: CharacterId
  size: PetSize
  tone: Tone
  pose: Pose
  hovered: boolean
  dragging: boolean
  /** The thought bubble, positioned against this box. */
  children?: React.ReactNode
}): React.JSX.Element {
  const who = characterOf(character)
  // Main sizes the window from the same setting, so the two agree by
  // construction rather than by both happening to use the same constant.
  const box = petPixels(size)
  const sprite = spriteStyle(who, pose, box)

  return (
    <div
      className="relative grid shrink-0 place-items-end justify-items-center select-none"
      style={{ width: box, height: box }}
      aria-hidden="true"
    >
      {/*
        One contact shadow, and nothing else. Squashed and drawn under her feet,
        which is what makes it read as ground rather than as a halo.
      */}
      <span
        className="pointer-events-none absolute bottom-0 left-1/2 h-2.5 w-[62%] -translate-x-1/2 rounded-[50%] blur-[5px] transition-colors duration-500"
        style={{ background: AURA[tone] }}
      />

      {children}

      <div
        className={[
          'pet-sprite relative',
          // The step count has to be literal in the stylesheet, and it differs
          // between characters: Mai's idle is seven frames, the others' six.
          `pet-steps-${poseFrames(who, pose)}`,
          // Grows a touch under the cursor and presses in while being moved:
          // this window can never change the mouse pointer, so the only
          // acknowledgement a click can get is from the pet itself.
          'transition-transform duration-200',
          dragging ? 'scale-95' : hovered ? 'scale-110' : 'scale-100',
        ].join(' ')}
        style={{
          ...sprite,
          // Pixel art. Smoothing it turns a crisp chibi into a smear.
          imageRendering: 'pixelated',
          filter: tone === 'idle' && !hovered ? 'saturate(0.85) brightness(0.92)' : 'none',
        }}
      />
    </div>
  )
}
