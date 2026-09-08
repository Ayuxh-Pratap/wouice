import { describe, expect, it } from 'vitest'
import { DEFAULT_SILENCE } from '../../shared/settings.js'
import {
  analyseCalibration,
  applyCalibration,
  describeLanguages,
  frameLevels,
  type CalibrationSample,
} from './calibrate.js'
import { rms } from './silence-policy.js'

/**
 * The real distribution measured from 60 seconds of natural speech on the
 * development machine. Every synthetic case below is built to resemble it,
 * because a calibration that only works on idealised input is worthless.
 *
 *   silence  p5 0.00032   p25 0.00091
 *   speech   p50 0.00436  p90 0.01778
 */
const REAL = { silence: 0.0005, speech: 0.012 }

/** Frames alternating between a quiet and a loud level in a given ratio. */
function frames(count: number, quiet: number, loud: number, speechRatio: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    // Jitter, so the percentiles are not degenerate single values.
    const base = i % 100 < speechRatio * 100 ? loud : quiet
    out.push(base * (0.7 + ((i * 37) % 60) / 100))
  }
  return out
}

const sample = (label: CalibrationSample['label'], rms: number[]): CalibrationSample => ({ label, rms })

describe('analyseCalibration on a realistic recording', () => {
  const samples = [
    sample('english', frames(400, REAL.silence, REAL.speech, 0.55)),
    sample('hindi', frames(400, REAL.silence, REAL.speech, 0.55)),
    sample('mixed', frames(400, REAL.silence, REAL.speech, 0.55)),
  ]
  const r = analyseCalibration(samples)

  it('succeeds', () => {
    expect(r.quality).toBe('good')
  })

  it('places the threshold BETWEEN the two clusters', () => {
    // The entire original bug was a threshold above the median speech frame.
    expect(r.threshold).toBeGreaterThan(REAL.silence)
    expect(r.threshold).toBeLessThan(REAL.speech)
  })

  it('would have counted most of the speech, unlike the old constant', () => {
    // The shipped constant was 0.010, which on this distribution counts almost
    // nothing. The calibrated one must do far better.
    const oldThreshold = 0.004 * 2.5
    const all = samples.flatMap((s) => s.rms)
    const oldRatio = all.filter((v) => v > oldThreshold).length / all.length
    expect(r.observed.speechRatio).toBeGreaterThan(oldRatio)
    expect(r.observed.speechRatio).toBeGreaterThan(0.4)
  })

  it('reports the separation it found', () => {
    expect(r.observed.separation).toBeGreaterThan(4)
  })
})

describe('it refuses to guess when the recording cannot support one', () => {
  it('rejects continuous speech with no pauses to learn from', () => {
    // No quiet cluster means no gap to place a threshold in.
    const r = analyseCalibration([sample('english', frames(600, REAL.speech, REAL.speech, 1))])
    expect(r.quality).toBe('weak')
    expect(r.reason).toMatch(/contrast|same level/i)
  })

  it('rejects a room where noise and speech overlap', () => {
    const r = analyseCalibration([sample('english', frames(600, 0.01, 0.012, 0.5))])
    expect(r.quality).toBe('weak')
  })

  it('rejects silence, which usually means the wrong input device', () => {
    const r = analyseCalibration([sample('english', new Array(600).fill(0))])
    expect(r.quality).toBe('unusable')
    expect(r.reason).toMatch(/microphone/i)
  })

  it('rejects a recording too short to describe a distribution', () => {
    const r = analyseCalibration([sample('english', frames(50, REAL.silence, REAL.speech, 0.5))])
    expect(r.quality).toBe('unusable')
  })

  it('falls back to the shipped defaults rather than a bad guess', () => {
    const r = analyseCalibration([sample('english', new Array(600).fill(0))])
    expect(r.minNoiseFloor).toBe(DEFAULT_SILENCE.minNoiseFloor)
    expect(r.speechFactor).toBe(DEFAULT_SILENCE.speechFactor)
  })
})

describe('it works across very different microphones', () => {
  it('a hot mic, everything loud', () => {
    const r = analyseCalibration([sample('english', frames(600, 0.01, 0.25, 0.5))])
    expect(r.quality).toBe('good')
    expect(r.threshold).toBeGreaterThan(0.01)
    expect(r.threshold).toBeLessThan(0.25)
  })

  it('a very quiet mic, everything tiny', () => {
    const r = analyseCalibration([sample('english', frames(600, 0.00008, 0.0015, 0.5))])
    expect(r.quality).toBe('good')
    expect(r.threshold).toBeGreaterThan(0.00008)
    expect(r.threshold).toBeLessThan(0.0015)
  })

  it('never returns a threshold outside believable bounds', () => {
    for (const [q, l] of [[1e-9, 1e-7], [0.4, 0.9]] as const) {
      const r = analyseCalibration([sample('english', frames(600, q, l, 0.5))])
      expect(r.minNoiseFloor).toBeGreaterThanOrEqual(0.0002)
      expect(r.minNoiseFloor).toBeLessThanOrEqual(0.02)
    }
  })
})

describe('applyCalibration', () => {
  it('changes only the two level fields', () => {
    const r = analyseCalibration([sample('english', frames(600, REAL.silence, REAL.speech, 0.5))])
    const next = applyCalibration(DEFAULT_SILENCE, r)
    expect(next.minNoiseFloor).toBe(r.minNoiseFloor)
    expect(next.shortWindowMs).toBe(DEFAULT_SILENCE.shortWindowMs)
    expect(next.chunkAfterMs).toBe(DEFAULT_SILENCE.chunkAfterMs)
  })

  it('leaves config untouched when the result is unusable', () => {
    const r = analyseCalibration([sample('english', new Array(600).fill(0))])
    expect(applyCalibration(DEFAULT_SILENCE, r)).toEqual(DEFAULT_SILENCE)
  })
})

describe('describeLanguages', () => {
  it('warns when the Hindi sample was not detected as Hindi', () => {
    const notes = describeLanguages([{ label: 'hindi', rms: [], language: 'english' }])
    expect(notes.join(' ')).toMatch(/detected as english, not Hindi/i)
  })

  it('says nothing about Hindi when it was detected correctly', () => {
    const notes = describeLanguages([{ label: 'hindi', rms: [], language: 'hindi' }])
    expect(notes.join(' ')).not.toMatch(/not Hindi/i)
  })

  it('explains the one-language-per-utterance behaviour for the mixed sample', () => {
    // This is the exact confusion that cost real time: "I spoke Hindi, why is
    // the transcript English?"
    const notes = describeLanguages([{ label: 'mixed', rms: [], language: 'english' }])
    expect(notes.join(' ')).toMatch(/picks one language per utterance/i)
  })
})

describe('frameLevels measures the same thing the live gate measures', () => {
  const FRAME = 320

  it('agrees with rms() frame for frame', () => {
    const pcm = Float32Array.from({ length: FRAME * 5 }, (_, i) => Math.sin(i / 7) * 0.3)
    const levels = frameLevels(pcm, FRAME)
    expect(levels).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(levels[i]).toBeCloseTo(rms(pcm.subarray(i * FRAME, (i + 1) * FRAME)), 12)
    }
  })

  it('drops a trailing partial frame rather than measuring it short', () => {
    // A part-full frame reads quieter than a full one and would drag p10 down.
    expect(frameLevels(new Float32Array(FRAME * 3 + 100), FRAME)).toHaveLength(3)
    expect(frameLevels(new Float32Array(FRAME - 1), FRAME)).toHaveLength(0)
  })

  it('carries a real amplitude difference through to the analysis', () => {
    // Loud and quiet halves at known amplitudes: the analysis must land between.
    const tone = (n: number, amp: number): number[] =>
      Array.from({ length: n * FRAME }, (_, i) => Math.sin(i / 3) * amp)
    const pcm = Float32Array.from([...tone(300, 0.002), ...tone(300, 0.05)])
    const r = analyseCalibration([{ label: 'english', rms: frameLevels(pcm, FRAME) }])
    expect(r.quality).toBe('good')
    expect(r.threshold).toBeGreaterThan(0.002 * 0.7)
    expect(r.threshold).toBeLessThan(0.05 * 0.7)
  })
})
