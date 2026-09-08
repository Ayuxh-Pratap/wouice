import type { SilenceConfig } from '../../shared/settings.js'
import { DEFAULT_SILENCE } from '../../shared/settings.js'
import { rms } from './silence-policy.js'

/**
 * Work out the speech threshold for THIS microphone and THIS voice.
 *
 * WHY THIS EXISTS. The threshold was originally a constant, `0.004 * 2.5 = 0.010`.
 * On the development machine's microphone that sat ABOVE the median speech
 * frame, so 70% of a continuous dictation was classified as silence, `speechMs`
 * never reached the chunking threshold, and chunking silently never fired
 * through ten real dictations. It was then recalibrated by hand from a recording
 * of one person on one microphone.
 *
 * That fix does not travel. Anyone who installs this with a different
 * microphone, a different gain setting or a quieter voice hits exactly the same
 * bug. A number derived from one machine cannot be shipped as a constant, so the
 * app measures it instead.
 *
 * Pure: takes frame levels, returns numbers. No audio, no I/O, no models.
 */

export type SampleLabel = 'english' | 'hindi' | 'mixed'

/**
 * Measure a recording exactly the way the live gate measures it.
 *
 * Same frame size, same `rms()`. If calibration used its own measure - a
 * different window, a peak instead of an rms, a dB conversion - the threshold
 * it produced would be tuned for a number the gate never computes, and the
 * mismatch would be invisible: everything would still run, just slightly wrong.
 * A trailing partial frame is dropped rather than measured short, since a
 * quarter-length frame reads quieter than it is and would drag the floor down.
 */
export function frameLevels(pcm: Float32Array, frameSamples: number): number[] {
  const out: number[] = []
  for (let i = 0; i + frameSamples <= pcm.length; i += frameSamples) {
    out.push(rms(pcm.subarray(i, i + frameSamples)))
  }
  return out
}

export interface CalibrationSample {
  label: SampleLabel
  /** RMS of each 20 ms frame, in order. */
  rms: number[]
  /** What the ASR made of it, filled in by the caller. Diagnostic only. */
  text?: string
  /** Which language the ASR detected. Diagnostic only. */
  language?: string
}

export interface CalibrationResult {
  /** Feed straight into SilenceConfig. */
  minNoiseFloor: number
  speechFactor: number
  /** The resulting gate, for display. */
  threshold: number
  quality: 'good' | 'weak' | 'unusable'
  /** Plain-English explanation, shown to the user. */
  reason: string
  observed: {
    frames: number
    silenceLevel: number
    speechLevel: number
    /** speechLevel / silenceLevel. The higher, the cleaner the separation. */
    separation: number
    /** Fraction of frames that would count as speech at the chosen threshold. */
    speechRatio: number
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[i] ?? 0
}

/**
 * Minimum ratio between the speech and silence clusters for the estimate to be
 * trustworthy. Below this the recording is probably all speech (no pauses to
 * learn from) or all noise (nothing was said).
 */
const MIN_SEPARATION = 4

/** Guard rails: a calibrated threshold outside this range is not believable. */
const FLOOR_MIN = 0.0002
const FLOOR_MAX = 0.02

export function analyseCalibration(samples: CalibrationSample[]): CalibrationResult {
  const all = samples.flatMap((s) => s.rms).filter((v) => Number.isFinite(v))
  const sorted = [...all].sort((a, b) => a - b)

  const fallback = (quality: CalibrationResult['quality'], reason: string): CalibrationResult => ({
    minNoiseFloor: DEFAULT_SILENCE.minNoiseFloor,
    speechFactor: DEFAULT_SILENCE.speechFactor,
    threshold: DEFAULT_SILENCE.minNoiseFloor * DEFAULT_SILENCE.speechFactor,
    quality,
    reason,
    observed: {
      frames: sorted.length,
      silenceLevel: percentile(sorted, 10),
      speechLevel: percentile(sorted, 75),
      separation: 0,
      speechRatio: 0,
    },
  })

  // 5 seconds at 20 ms frames. Less than this cannot describe a distribution.
  if (sorted.length < 250) {
    return fallback('unusable', 'Not enough audio to measure. Record a few seconds more.')
  }

  // The distribution is bimodal: a quiet cluster between words and a loud
  // cluster while speaking. p10 sits inside the quiet one, p75 inside the loud
  // one, and both are robust to the odd cough or clipped peak that would drag
  // a min or a max around.
  const silenceLevel = percentile(sorted, 10)
  const speechLevel = percentile(sorted, 75)
  const separation = silenceLevel > 0 ? speechLevel / silenceLevel : Infinity

  if (speechLevel <= 0) {
    return fallback('unusable', 'The microphone recorded silence. Check it is the right input.')
  }

  if (separation < MIN_SEPARATION) {
    // Either continuous speech with no pauses, or a room so loud that noise and
    // speech overlap. Guessing from this would be worse than the default.
    return fallback(
      'weak',
      separation < 1.5
        ? 'Speech and background noise are at the same level. Try a quieter room or a headset.'
        : 'Not enough contrast between your speech and the gaps. Speak with small pauses between sentences.'
    )
  }

  // Put the gate in the middle of the two clusters ON A LOG SCALE, because
  // loudness is perceived and distributed logarithmically. The arithmetic mean
  // would sit far too close to the speech cluster and clip quiet syllables.
  const threshold = Math.sqrt(silenceLevel * speechLevel)

  const speechFactor = DEFAULT_SILENCE.speechFactor
  const minNoiseFloor = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, threshold / speechFactor))
  const finalThreshold = minNoiseFloor * speechFactor
  const speechRatio = sorted.filter((v) => v > finalThreshold).length / sorted.length

  return {
    minNoiseFloor,
    speechFactor,
    threshold: finalThreshold,
    quality: 'good',
    reason: `Your speech sits about ${Math.round(separation)}x above the room. Threshold set to ${finalThreshold.toFixed(4)}.`,
    observed: { frames: sorted.length, silenceLevel, speechLevel, separation, speechRatio },
  }
}

/** Merge a result into a config, leaving everything else alone. */
export function applyCalibration(cfg: SilenceConfig, r: CalibrationResult): SilenceConfig {
  if (r.quality === 'unusable') return cfg
  return { ...cfg, minNoiseFloor: r.minNoiseFloor, speechFactor: r.speechFactor }
}

/**
 * What the three recordings say about language handling.
 *
 * Answers the question that cost real confusion once already: "I spoke Hindi,
 * why is the transcript English?" Whisper commits to ONE language per utterance,
 * so a mixed sentence resolves to whichever dominates, and the Hindi in it gets
 * rendered phonetically. Better to state that plainly during setup than to leave
 * someone to discover it and assume the app is broken.
 */
export function describeLanguages(samples: CalibrationSample[]): string[] {
  const notes: string[] = []
  const by = (l: SampleLabel): CalibrationSample | undefined => samples.find((s) => s.label === l)

  const hindi = by('hindi')
  if (hindi?.language && hindi.language !== 'hindi') {
    notes.push(
      `Your Hindi sample was detected as ${hindi.language}, not Hindi. Speech recognition may struggle with Hindi on this microphone.`
    )
  }

  const mixed = by('mixed')
  if (mixed?.language) {
    notes.push(
      `Your mixed sentence was detected as ${mixed.language}. Whisper picks one language per utterance, so the other language in a mixed sentence gets written out phonetically. The cleanup pass turns it into English either way.`
    )
  }

  return notes
}
