import type { AsrSegment } from '@wouice/asr'

/**
 * Whether a line the speech model returned was actually heard.
 *
 * THE MODEL WRITES OVER SILENCE. Handed a chunk that is mostly room noise, it
 * does not answer "nothing was said" - it produces the stock phrases of its
 * training data. One real meeting collected "Thank you." fifteen times, "I'm a
 * student at the University of Minnesota" and "I'm going to add a little bit of
 * water to the water", all on a microphone nobody was speaking into, and the
 * model's own confidence scores did not flag one of them.
 *
 * THE AUDIO DOES. On that meeting every invented line sat at 0.0014 to 0.0034
 * RMS - the room - while every real line on the same microphone was above
 * 0.0126. The chunk-level gate could not see it: it skips a whole 25 seconds
 * only below 0.001, and the room was just above that. So each line is checked
 * against its own stretch of audio and against the background of the chunk it
 * came from. A line no louder than the room was not said.
 *
 * The stretch is padded a little either side, because whisper's segment times
 * drift by a fraction of a second, and a real short "yeah" at the edge of
 * speech should not be dropped for being measured just beside itself.
 */

/** Below this, nothing counts as speech, whatever the background. */
export const MIN_SPEECH_RMS = 0.004
/** A line has to be this many times louder than its chunk's background... */
export const OVER_BACKGROUND = 3
/** ...but never has to clear more than this, so a noisy room cannot silence a soft voice. */
export const MAX_GATE_RMS = 0.015
/** Padding either side of a line's times, for drift in whisper's timestamps. */
const PAD_SEC = 0.5
/** The frames the background is measured in. */
const FRAME_SEC = 0.05

/** Loudness of a stretch of `pcm`, in seconds from its start. */
export function stretchRms(
  pcm: Float32Array,
  sampleRate: number,
  fromSec: number,
  toSec: number
): number {
  const from = Math.max(0, Math.floor(fromSec * sampleRate))
  const to = Math.min(pcm.length, Math.ceil(toSec * sampleRate))
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i++) sum += pcm[i]! * pcm[i]!
  return Math.sqrt(sum / (to - from))
}

/** The chunk's background: how loud its quietest tenth is, in 50 ms frames. */
export function backgroundRms(pcm: Float32Array, sampleRate: number): number {
  const frame = Math.max(1, Math.round(FRAME_SEC * sampleRate))
  const levels: number[] = []
  for (let at = 0; at + frame <= pcm.length; at += frame) {
    let sum = 0
    for (let i = at; i < at + frame; i++) sum += pcm[i]! * pcm[i]!
    levels.push(Math.sqrt(sum / frame))
  }
  if (levels.length === 0) return 0
  levels.sort((a, b) => a - b)
  return levels[Math.floor(levels.length * 0.1)]!
}

/** What a line in a chunk with this background has to clear. */
export function speechGate(background: number): number {
  return Math.max(MIN_SPEECH_RMS, Math.min(background * OVER_BACKGROUND, MAX_GATE_RMS))
}

/**
 * The segments that were actually heard, and how many were not.
 *
 * Segment times are seconds from the start of `pcm`, as whisper reports them
 * for the chunk it was given.
 */
export function heardSegments<T extends Pick<AsrSegment, 'startSec' | 'endSec'>>(
  segments: readonly T[],
  pcm: Float32Array,
  sampleRate: number
): { heard: T[]; unheard: number } {
  if (segments.length === 0) return { heard: [], unheard: 0 }
  const gate = speechGate(backgroundRms(pcm, sampleRate))
  const heard = segments.filter(
    (s) => stretchRms(pcm, sampleRate, s.startSec - PAD_SEC, s.endSec + PAD_SEC) >= gate
  )
  return { heard, unheard: segments.length - heard.length }
}
