import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings.js'
import {
  DEFAULT_SILENCE,
  activeWindowMs,
  initialSilenceState,
  rms,
  step,
  type Frame,
  type SilenceState,
  type SilenceVerdict,
} from './silence-policy.js'

const FRAME_MS = 20
const LOUD = 0.2
const QUIET = 0.001

const speech = (): Frame => ({ rms: LOUD, ms: FRAME_MS })
const silence = (): Frame => ({ rms: QUIET, ms: FRAME_MS })

/** Feed frames until a non-continue verdict, or until `maxMs` elapses. */
function run(
  frames: () => Frame,
  maxMs: number,
  start: SilenceState = initialSilenceState()
): { state: SilenceState; verdict: SilenceVerdict; atMs: number } {
  let state = start
  for (let t = 0; t < maxMs; t += FRAME_MS) {
    const out = step(state, frames(), DEFAULT_SILENCE)
    state = out.state
    if (out.verdict !== 'continue') return { state, verdict: out.verdict, atMs: state.elapsedMs }
  }
  return { state, verdict: 'continue', atMs: state.elapsedMs }
}

/** Speak for `speakMs`, then go quiet. */
function speakThenSilence(speakMs: number, thenMs: number) {
  let state = initialSilenceState()
  for (let t = 0; t < speakMs; t += FRAME_MS) state = step(state, speech(), DEFAULT_SILENCE).state
  for (let t = 0; t < thenMs; t += FRAME_MS) {
    const out = step(state, silence(), DEFAULT_SILENCE)
    state = out.state
    if (out.verdict !== 'continue') return { state, verdict: out.verdict, silenceMs: state.silenceMs }
  }
  return { state, verdict: 'continue' as SilenceVerdict, silenceMs: state.silenceMs }
}

describe('rms', () => {
  it('is zero for silence and for an empty buffer', () => {
    expect(rms(new Float32Array(100))).toBe(0)
    expect(rms(new Float32Array(0))).toBe(0)
  })

  it('is the amplitude of a constant signal', () => {
    expect(rms(new Float32Array(100).fill(0.5))).toBeCloseTo(0.5, 5)
  })

  it('ignores sign, so a waveform is not cancelled out', () => {
    const alternating = Float32Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.5 : -0.5))
    expect(rms(alternating)).toBeCloseTo(0.5, 5)
  })
})

describe('stop detection does not arm before speech', () => {
  it('does not stop during a long silence at the very start', () => {
    // Pressing the hotkey and pausing to think must not end the session.
    const { verdict } = run(silence, 10_000)
    expect(verdict).toBe('continue')
  })

  it('ignores a cough shorter than minSpeechMs', () => {
    let state = initialSilenceState()
    // 200ms of noise, under the 300ms floor.
    for (let t = 0; t < 200; t += FRAME_MS) state = step(state, speech(), DEFAULT_SILENCE).state
    expect(state.heardSpeech).toBe(false)
    const after = run(silence, 10_000, state)
    expect(after.verdict).toBe('continue')
  })
})

describe('the adaptive window', () => {
  it('uses the SHORT window for a brief utterance', () => {
    // A one-line prompt should not feel sluggish.
    const { verdict, state } = speakThenSilence(2_000, 5_000)
    expect(verdict).toBe('stop-silence')
    expect(state.silenceMs).toBeGreaterThanOrEqual(DEFAULT_SILENCE.shortWindowMs)
    expect(state.silenceMs).toBeLessThan(DEFAULT_SILENCE.longWindowMs)
  })

  it('uses the LONG window once the utterance proves itself long-form', () => {
    // Past 15s of speech, a 1.8s thinking pause must not truncate you.
    const { verdict, state } = speakThenSilence(16_000, 6_000)
    expect(verdict).toBe('stop-silence')
    expect(state.silenceMs).toBeGreaterThanOrEqual(DEFAULT_SILENCE.longWindowMs)
  })

  it('does NOT stop on a 2s pause in long-form, which the short window would have', () => {
    // The exact failure the adaptive window exists to prevent.
    let state = initialSilenceState()
    for (let t = 0; t < 16_000; t += FRAME_MS) state = step(state, speech(), DEFAULT_SILENCE).state
    let verdict: SilenceVerdict = 'continue'
    for (let t = 0; t < 2_000; t += FRAME_MS) {
      const out = step(state, silence(), DEFAULT_SILENCE)
      state = out.state
      verdict = out.verdict
      if (verdict !== 'continue') break
    }
    expect(verdict).toBe('continue')
  })

  it('reports which window is in force', () => {
    const short = { ...initialSilenceState(), speechMs: 5_000 }
    const long = { ...initialSilenceState(), speechMs: 20_000 }
    expect(activeWindowMs(short)).toBe(DEFAULT_SILENCE.shortWindowMs)
    expect(activeWindowMs(long)).toBe(DEFAULT_SILENCE.longWindowMs)
  })
})

describe('chunking', () => {
  it('does not emit a chunk before chunkAfterMs of speech', () => {
    let state = initialSilenceState()
    let sawChunk = false
    for (let t = 0; t < 10_000; t += FRAME_MS) {
      const out = step(state, speech(), DEFAULT_SILENCE)
      state = out.state
      if (out.verdict === 'emit-chunk') sawChunk = true
    }
    expect(sawChunk).toBe(false)
  })

  it('emits a chunk AT A PAUSE once enough speech has accumulated', () => {
    // Boundaries must land on pauses; cutting mid-word transcribes badly on
    // both halves, which is the whole reason chunking shares this function.
    let state = initialSilenceState()
    for (let t = 0; t < 21_000; t += FRAME_MS) state = step(state, speech(), DEFAULT_SILENCE).state

    let verdict: SilenceVerdict = 'continue'
    for (let t = 0; t < 1_000; t += FRAME_MS) {
      const out = step(state, silence(), DEFAULT_SILENCE)
      state = out.state
      verdict = out.verdict
      if (verdict !== 'continue') break
    }
    expect(verdict).toBe('emit-chunk')
    expect(state.silenceMs).toBeGreaterThanOrEqual(DEFAULT_SILENCE.chunkPauseMs)
  })

  it('does NOT emit a chunk mid-speech no matter how long you talk', () => {
    // 60s of unbroken speech: no pause, so no boundary, so no chunk.
    const { verdict } = run(speech, 60_000)
    expect(verdict).toBe('continue')
  })

  it('resets the chunk counter after emitting, so chunks are spaced', () => {
    let state = initialSilenceState()
    for (let t = 0; t < 21_000; t += FRAME_MS) state = step(state, speech(), DEFAULT_SILENCE).state
    let out = step(state, { rms: QUIET, ms: DEFAULT_SILENCE.chunkPauseMs }, DEFAULT_SILENCE)
    expect(out.verdict).toBe('emit-chunk')
    expect(out.state.sinceChunkMs).toBe(0)
  })
})

describe('the session cap', () => {
  it('stops at maxSessionMs even while speech continues', () => {
    // Purely a "did I forget this was recording" guard.
    const { verdict, atMs } = run(speech, DEFAULT_SILENCE.maxSessionMs + 2_000)
    expect(verdict).toBe('stop-cap')
    expect(atMs).toBeGreaterThanOrEqual(DEFAULT_SILENCE.maxSessionMs)
  })
})

describe('the adaptive noise floor', () => {
  it('rises in a noisy room so background hum is not heard as speech', () => {
    // 0.0025 is genuine room noise for this microphone: measured silence sits
    // at 0.0003-0.0009 and speech at 0.004-0.034, so this is above the floor
    // and below any real speech. (0.01 used to be the value here, which the
    // threshold calibration correctly reclassified as speech.)
    const hum = { rms: 0.0025, ms: FRAME_MS }
    let state = initialSilenceState()
    for (let t = 0; t < 5_000; t += FRAME_MS) state = step(state, hum, DEFAULT_SILENCE).state
    expect(state.noiseFloor).toBeGreaterThan(DEFAULT_SILENCE.minNoiseFloor)
    // And with the floor raised, that same hum still reads as silence.
    expect(state.speechMs).toBe(0)
  })

  it('does NOT adapt during speech', () => {
    // Adapting while someone talks would chase their own volume upward until
    // nothing counted as speech and the session never ended.
    let state = initialSilenceState()
    const before = state.noiseFloor
    for (let t = 0; t < 3_000; t += FRAME_MS) state = step(state, speech(), DEFAULT_SILENCE).state
    expect(state.noiseFloor).toBe(before)
  })

  it('never drops below the absolute floor', () => {
    let state = initialSilenceState()
    for (let t = 0; t < 20_000; t += FRAME_MS) {
      state = step(state, { rms: 0, ms: FRAME_MS }, DEFAULT_SILENCE).state
    }
    expect(state.noiseFloor).toBeGreaterThanOrEqual(DEFAULT_SILENCE.minNoiseFloor)
  })

  it('still detects loud speech in a noisy room', () => {
    let state = initialSilenceState()
    for (let t = 0; t < 5_000; t += FRAME_MS) {
      state = step(state, { rms: 0.0025, ms: FRAME_MS }, DEFAULT_SILENCE).state
    }
    for (let t = 0; t < 1_000; t += FRAME_MS) {
      state = step(state, speech(), DEFAULT_SILENCE).state
    }
    expect(state.heardSpeech).toBe(true)
  })
})

describe('the level meter', () => {
  it('attacks fast and releases slowly', () => {
    let state = initialSilenceState()
    state = step(state, speech(), DEFAULT_SILENCE).state
    const peak = state.level
    expect(peak).toBeGreaterThan(0.5)

    state = step(state, silence(), DEFAULT_SILENCE).state
    // Falls, but nowhere near instantly: a meter that snaps to zero reads as
    // a flicker rather than a voice.
    expect(state.level).toBeLessThan(peak)
    expect(state.level).toBeGreaterThan(peak * 0.5)
  })

  it('stays within 0..1 even for a clipping signal', () => {
    let state = initialSilenceState()
    for (let i = 0; i < 10; i++) state = step(state, { rms: 5, ms: FRAME_MS }, DEFAULT_SILENCE).state
    expect(state.level).toBeLessThanOrEqual(1)
  })
})

describe('the config actually reaching the policy at runtime', () => {
  /**
   * THE REGRESSION THAT MOTIVATED THIS BLOCK.
   *
   * Settings declared a partial silence shape and the policy declared a fuller
   * one, bridged in main by `as never`. Every test above passed, because they
   * all used DEFAULT_SILENCE directly. In the running app the config came from
   * settings, so `speechFactor` was undefined, the threshold was NaN, `rms >
   * NaN` was always false, and NOTHING was ever classified as speech: auto-stop
   * never armed and chunking never fired, through seven real dictations.
   *
   * A unit test of a pure function proves nothing if production feeds it a
   * different object. These assert the object production actually passes.
   */
  const required: (keyof typeof DEFAULT_SILENCE)[] = [
    'shortWindowMs',
    'longWindowMs',
    'adaptAfterMs',
    'minSpeechMs',
    'maxSessionMs',
    'chunkAfterMs',
    'chunkPauseMs',
    'speechFactor',
    'minNoiseFloor',
  ]

  it('the settings default supplies every field the policy reads', () => {
    for (const key of required) {
      expect(DEFAULT_SETTINGS.silence[key], `settings.silence.${key} is missing`).toBeTypeOf('number')
      expect(Number.isFinite(DEFAULT_SETTINGS.silence[key]), `settings.silence.${key} is not finite`).toBe(true)
    }
  })

  it('classifies loud audio as speech using the SETTINGS config, not the default', () => {
    // The exact failure: a NaN threshold makes every comparison false.
    let state = initialSilenceState()
    for (let t = 0; t < 1_000; t += FRAME_MS) {
      state = step(state, speech(), DEFAULT_SETTINGS.silence).state
    }
    expect(state.speechMs).toBeGreaterThan(0)
    expect(state.heardSpeech).toBe(true)
  })

  it('auto-stops using the SETTINGS config', () => {
    let state = initialSilenceState()
    for (let t = 0; t < 2_000; t += FRAME_MS) {
      state = step(state, speech(), DEFAULT_SETTINGS.silence).state
    }
    let verdict: SilenceVerdict = 'continue'
    for (let t = 0; t < 6_000 && verdict === 'continue'; t += FRAME_MS) {
      const out = step(state, silence(), DEFAULT_SETTINGS.silence)
      state = out.state
      verdict = out.verdict
    }
    expect(verdict).toBe('stop-silence')
  })

  it('emits chunks using the SETTINGS config', () => {
    let state = initialSilenceState()
    for (let t = 0; t < 21_000; t += FRAME_MS) {
      state = step(state, speech(), DEFAULT_SETTINGS.silence).state
    }
    const out = step(state, { rms: QUIET, ms: DEFAULT_SETTINGS.silence.chunkPauseMs }, DEFAULT_SETTINGS.silence)
    expect(out.verdict).toBe('emit-chunk')
  })
})

describe('pause diagnostics', () => {
  it('records the longest pause, so "chunks 0" is explainable', () => {
    // Without this you cannot tell "he never paused" from "chunking is broken".
    let state = initialSilenceState()
    for (let t = 0; t < 1_000; t += FRAME_MS) state = step(state, speech(), DEFAULT_SILENCE).state
    for (let t = 0; t < 400; t += FRAME_MS) state = step(state, silence(), DEFAULT_SILENCE).state
    for (let t = 0; t < 500; t += FRAME_MS) state = step(state, speech(), DEFAULT_SILENCE).state
    for (let t = 0; t < 300; t += FRAME_MS) state = step(state, silence(), DEFAULT_SILENCE).state
    expect(state.longestSilenceMs).toBeGreaterThanOrEqual(380)
    expect(state.longestSilenceMs).toBeLessThan(500)
  })

  it('ignores leading silence, which is not a pause', () => {
    let state = initialSilenceState()
    for (let t = 0; t < 5_000; t += FRAME_MS) state = step(state, silence(), DEFAULT_SILENCE).state
    expect(state.longestSilenceMs).toBe(0)
  })

  it('totals silence separately from speech', () => {
    let state = initialSilenceState()
    for (let t = 0; t < 1_000; t += FRAME_MS) state = step(state, speech(), DEFAULT_SILENCE).state
    for (let t = 0; t < 600; t += FRAME_MS) state = step(state, silence(), DEFAULT_SILENCE).state
    expect(state.speechMs).toBeGreaterThan(900)
    expect(state.totalSilenceMs).toBeGreaterThanOrEqual(580)
  })
})

describe('the threshold suits a real microphone', () => {
  /**
   * Calibrated against 60 seconds of natural speech recorded on this machine.
   * The original 0.004 x 2.5 = 0.010 sat above the MEDIAN speech frame, so 70%
   * of a continuous dictation counted as silence and chunking never fired.
   * These pin the distribution so a future tweak cannot quietly undo it.
   */
  const MEASURED = {
    silenceP5: 0.00032,
    silenceP25: 0.00091,
    speechP50: 0.00436,
    speechP90: 0.01778,
  }

  const threshold = DEFAULT_SILENCE.minNoiseFloor * DEFAULT_SILENCE.speechFactor

  it('sits above real silence', () => {
    expect(threshold).toBeGreaterThan(MEASURED.silenceP25)
  })

  it('sits BELOW the median speech frame, which is what broke chunking', () => {
    expect(threshold).toBeLessThan(MEASURED.speechP50)
  })

  it('counts a median-loudness speech frame as speech', () => {
    const out = step(initialSilenceState(), { rms: MEASURED.speechP50, ms: FRAME_MS }, DEFAULT_SILENCE)
    expect(out.state.speechMs).toBe(FRAME_MS)
  })

  it('counts a quiet inter-word gap as silence', () => {
    const out = step(initialSilenceState(), { rms: MEASURED.silenceP25, ms: FRAME_MS }, DEFAULT_SILENCE)
    expect(out.state.speechMs).toBe(0)
  })

  it('records the levels seen, so a mismatched mic is visible in diagnostics', () => {
    let state = initialSilenceState()
    for (let t = 0; t < 600; t += FRAME_MS) {
      state = step(state, { rms: MEASURED.speechP90, ms: FRAME_MS }, DEFAULT_SILENCE).state
    }
    expect(state.peakRms).toBeCloseTo(MEASURED.speechP90, 5)
    expect(state.meanSpeechRms).toBeCloseTo(MEASURED.speechP90, 5)
    expect(state.speechFrames).toBe(30)
  })
})
