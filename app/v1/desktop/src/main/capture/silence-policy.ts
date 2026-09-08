/**
 * When to stop recording, and when to flush a chunk. Pure.
 *
 * TWO JOBS, ONE FUNCTION, DELIBERATELY. Chunk boundaries must land on pauses,
 * never on a timer, or a chunk cuts a word in half and both halves transcribe
 * badly. Since "is this a pause?" is exactly what stop detection already
 * computes, the same pass answers both and the mid-word boundary problem never
 * arises rather than being solved.
 *
 * WHY CHUNKING IS NOT OPTIONAL. Measured on this machine: Hindi costs ~283 ms
 * per second of audio, so a three-minute dictation would mean ~18 seconds of
 * spinner after you stop talking. Transcribing during speech leaves only the
 * tail at key-up.
 *
 * WHY RMS AND NOT AN ML VAD. Silero was specified originally and is over-built
 * for "has he stopped talking". RMS against an adaptive noise floor is a pure
 * function needing no model, and it removes onnxruntime from Phase 1 entirely.
 * The detector sits behind this interface, so swapping Silero in later touches
 * nothing else.
 */

export { DEFAULT_SILENCE, type SilenceConfig } from '../../shared/settings.js'
import { DEFAULT_SILENCE, type SilenceConfig } from '../../shared/settings.js'

export interface SilenceState {
  /** Wall-clock ms since capture began. */
  elapsedMs: number
  /** Total ms of frames classified as speech. */
  speechMs: number
  /** Ms since the last speech frame. 0 while speaking. */
  silenceMs: number
  /** True once `minSpeechMs` of speech has been seen. Arms stop detection. */
  heardSpeech: boolean
  /** Speech accumulated since the last chunk flush. */
  sinceChunkMs: number
  /** Rolling estimate of room noise, adapted only during silence. */
  noiseFloor: number
  /** Smoothed level for the meter, 0..1. Not used for decisions. */
  level: number
  /**
   * Longest pause seen after speech began.
   *
   * Diagnostic only, never a decision input. Without it, "chunks 0" is
   * ambiguous: you cannot tell "the speaker never paused long enough" from
   * "chunking is broken", and those need opposite responses.
   */
  longestSilenceMs: number
  /** Total silence after speech began, so speech/silence ratio is visible. */
  totalSilenceMs: number
  /**
   * Loudest frame seen, and a running mean of frames above the floor.
   *
   * Diagnostic only. If the threshold is ever mismatched to a microphone again,
   * these put the evidence directly in the exported diagnostic instead of
   * requiring someone to go and analyse a WAV by hand.
   */
  peakRms: number
  meanSpeechRms: number
  speechFrames: number
}

export function initialSilenceState(): SilenceState {
  return {
    elapsedMs: 0,
    speechMs: 0,
    silenceMs: 0,
    heardSpeech: false,
    sinceChunkMs: 0,
    noiseFloor: DEFAULT_SILENCE.minNoiseFloor,
    level: 0,
    longestSilenceMs: 0,
    totalSilenceMs: 0,
    peakRms: 0,
    meanSpeechRms: 0,
    speechFrames: 0,
  }
}

export type SilenceVerdict =
  | 'continue'
  /** A pause past `chunkAfterMs`: flush what we have and keep recording. */
  | 'emit-chunk'
  | 'stop-silence'
  | 'stop-cap'

export interface Frame {
  /** Root-mean-square amplitude of this frame, 0..1. */
  rms: number
  /** Duration this frame represents. */
  ms: number
}

/** RMS of a Float32 block. The only numeric input the policy needs. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0
    sum += s * s
  }
  return Math.sqrt(sum / samples.length)
}

/**
 * Advance the state by one frame and decide what to do.
 *
 * The adaptive window is the interesting part. One silence threshold cannot
 * serve both a one-line prompt and a five-minute spec dictation: 1.8s truncates
 * long-form thinking pauses, 3.0s makes a one-liner feel sluggish. So the
 * window widens once the utterance has proven itself long.
 */
/**
 * Frame loudness as a 0..1 meter reading.
 *
 * CALIBRATED FROM THE SAME RECORDING AS THE THRESHOLDS, which the first version
 * was not. It divided by 0.25, and the measured distribution on this machine's
 * microphone is:
 *
 *   true silence   p5  0.00032   p25 0.00091
 *   speech         p50 0.00436   p90 0.01778
 *
 * so an ordinary speech frame produced 0.0174 and a loud one 0.071. The meter
 * was pinned to the bottom of its range for every sound a person can make into
 * it - and the unit test that was supposed to catch this fed it `rms: 0.2`,
 * eleven times louder than the loudest real frame, and passed.
 *
 * SQUARE ROOT, not a straight ratio. Loudness is perceived closer to the root
 * of amplitude, and a linear meter over this range leaves normal speech
 * huddled near zero while shouting takes the whole scale. With the full scale
 * a little above p90, an ordinary frame reads about 0.38 and a loud one 0.77.
 */
const METER_FULL_SCALE = 0.03

export function meterLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  return Math.min(1, Math.sqrt(rms / METER_FULL_SCALE))
}

export function step(
  state: SilenceState,
  frame: Frame,
  cfg: SilenceConfig = DEFAULT_SILENCE
): { state: SilenceState; verdict: SilenceVerdict } {
  const elapsedMs = state.elapsedMs + frame.ms
  const threshold = Math.max(state.noiseFloor * cfg.speechFactor, cfg.minNoiseFloor * cfg.speechFactor)
  const isSpeech = frame.rms > threshold

  // Adapt the noise floor ONLY on silent frames. Adapting during speech would
  // chase the speaker's own volume upward until nothing counted as speech.
  const noiseFloor = isSpeech
    ? state.noiseFloor
    : Math.max(cfg.minNoiseFloor, state.noiseFloor * 0.95 + frame.rms * 0.05)

  // Fast attack, slow release: the meter should jump on speech and fall gently,
  // which reads as a voice rather than a flicker.
  const target = meterLevel(frame.rms)
  const level = target > state.level ? target : state.level * 0.85 + target * 0.15

  const silenceMs = isSpeech ? 0 : state.silenceMs + frame.ms
  const next: SilenceState = {
    elapsedMs,
    speechMs: state.speechMs + (isSpeech ? frame.ms : 0),
    silenceMs,
    heardSpeech: state.heardSpeech || state.speechMs + (isSpeech ? frame.ms : 0) >= cfg.minSpeechMs,
    sinceChunkMs: state.sinceChunkMs + (isSpeech ? frame.ms : 0),
    noiseFloor,
    level,
    // Only count pauses once speech has started; leading silence is not a pause.
    longestSilenceMs: state.heardSpeech
      ? Math.max(state.longestSilenceMs, silenceMs)
      : state.longestSilenceMs,
    totalSilenceMs: state.totalSilenceMs + (isSpeech || !state.heardSpeech ? 0 : frame.ms),
    peakRms: Math.max(state.peakRms, frame.rms),
    speechFrames: state.speechFrames + (isSpeech ? 1 : 0),
    meanSpeechRms: isSpeech
      ? (state.meanSpeechRms * state.speechFrames + frame.rms) / (state.speechFrames + 1)
      : state.meanSpeechRms,
  }

  if (elapsedMs >= cfg.maxSessionMs) return { state: next, verdict: 'stop-cap' }

  // Stop detection does not arm until real speech has been heard, so a pause
  // before you begin talking cannot end the session immediately.
  if (next.heardSpeech) {
    const window = next.speechMs >= cfg.adaptAfterMs ? cfg.longWindowMs : cfg.shortWindowMs
    if (next.silenceMs >= window) return { state: next, verdict: 'stop-silence' }

    // Cut at a pause, never on a timer. A shorter pause than a stop, so we get
    // a boundary well before the user is finished.
    if (next.sinceChunkMs >= cfg.chunkAfterMs && next.silenceMs >= cfg.chunkPauseMs) {
      return { state: { ...next, sinceChunkMs: 0 }, verdict: 'emit-chunk' }
    }
  }

  return { state: next, verdict: 'continue' }
}

/** Which silence window is currently in force. For the HUD and for tests. */
export function activeWindowMs(state: SilenceState, cfg: SilenceConfig = DEFAULT_SILENCE): number {
  return state.speechMs >= cfg.adaptAfterMs ? cfg.longWindowMs : cfg.shortWindowMs
}
