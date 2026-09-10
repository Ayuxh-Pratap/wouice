import { describe, expect, it } from 'vitest'
import { backgroundRms, heardSegments, speechGate, stretchRms } from './heard.js'

/**
 * Lines written over silence, dropped by their own audio.
 *
 * The levels below are the ones measured on a real meeting: a quiet room at
 * about 0.0015 RMS, invented lines at 0.0014 to 0.0034, and real speech on the
 * same microphone at 0.0126 and up.
 */

const RATE = 16_000

/** A square wave at this RMS: its level is exactly `level`. */
function tone(seconds: number, level: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? level : -level
  return out
}

/** A 25 second chunk of room noise with speech laid over parts of it. */
function chunk(speech: { from: number; to: number; level: number }[], room = 0.0015): Float32Array {
  const out = tone(25, room)
  for (const s of speech) {
    const loud = tone(s.to - s.from, s.level)
    out.set(loud, Math.round(s.from * RATE))
  }
  return out
}

describe('measuring the audio', () => {
  it('reads the level of a stretch', () => {
    expect(stretchRms(tone(1, 0.02), RATE, 0, 1)).toBeCloseTo(0.02, 5)
  })

  it('reads the background from the quietest part, not the speech', () => {
    const pcm = chunk([{ from: 2, to: 12, level: 0.08 }])
    expect(backgroundRms(pcm, RATE)).toBeCloseTo(0.0015, 4)
  })

  it('never lets a noisy room silence a soft voice', () => {
    expect(speechGate(0.0015)).toBeCloseTo(0.0045, 4)
    expect(speechGate(0)).toBe(0.004)
    expect(speechGate(0.05)).toBe(0.015)
  })
})

describe('which lines were heard', () => {
  it('drops a line written over the room, keeps one that was spoken', () => {
    // The real case: "Thank you." over a quiet microphone, and a real line.
    const pcm = chunk([{ from: 5, to: 9, level: 0.0246 }])
    const segments = [
      { startSec: 5.2, endSec: 8.8, text: 'thought to put forward, like if we are giving so much priority' },
      { startSec: 15, endSec: 16, text: 'Thank you.' },
      { startSec: 20, endSec: 24, text: "I'm a student at the University of Minnesota" },
    ]
    const { heard, unheard } = heardSegments(segments, pcm, RATE)
    expect(heard.map((s) => s.text)).toEqual([
      'thought to put forward, like if we are giving so much priority',
    ])
    expect(unheard).toBe(2)
  })

  it('keeps a line whose times drifted just off its own speech', () => {
    // Whisper put the end of the line a little before the sound ended.
    const pcm = chunk([{ from: 10, to: 10.8, level: 0.03 }])
    const { heard } = heardSegments([{ startSec: 10.9, endSec: 11.2, text: 'yeah' }], pcm, RATE)
    expect(heard).toHaveLength(1)
  })

  it('keeps soft far-side speech over a digital silence', () => {
    // The system channel is a digital tap: its background is exactly zero.
    const pcm = chunk([{ from: 3, to: 4, level: 0.0093 }], 0)
    const { heard } = heardSegments([{ startSec: 3, endSec: 4, text: 'yeah' }], pcm, RATE)
    expect(heard).toHaveLength(1)
  })

  it('has nothing to drop in an empty answer', () => {
    expect(heardSegments([], tone(1, 0.01), RATE)).toEqual({ heard: [], unheard: 0 })
  })
})
