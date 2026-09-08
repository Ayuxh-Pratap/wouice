/**
 * The last few seconds of what the microphone heard.
 *
 * WHY THIS REPLACED THE METER. The old overlay drew 28 bars from a single
 * level, fanned across a fixed falloff curve. It looked like a spectrum
 * analyser and was one number; every bar showed the same instant, so it could
 * not answer the only question a meter exists to answer - was I audible three
 * seconds ago? When a dictation came back short, the display had already
 * forgotten the evidence.
 *
 * This keeps a rolling window instead. Silence shows as a flat run you can
 * point at, and when recording stops the shape stays on screen while the text
 * is being worked on, so what is being processed is visible rather than
 * described.
 *
 * PEAK, NOT MEAN, within a bar. Averaging 60ms of frames flattens a consonant
 * into the quiet around it, and the thing being looked for is exactly whether
 * anything got through at all.
 */

/** ~2.8 seconds at 60ms a bar. Long enough to see a pause, short enough to read. */
export const BARS = 46

/** Frames are 20ms, so three of them make one bar. */
export const FRAMES_PER_BAR = 3

export interface Waveform {
  /** Oldest first, newest last. Always `BARS` long. */
  bars: number[]
  /** The bar being filled, and how many frames have gone into it. */
  peak: number
  filled: number
}

export function emptyWaveform(): Waveform {
  return { bars: Array<number>(BARS).fill(0), peak: 0, filled: 0 }
}

/**
 * Fold one 20ms frame in.
 *
 * Returns the same object when the bar is still filling, so React re-renders
 * at the bar rate - about 17 times a second - rather than at the frame rate of
 * 50. The overlay is drawn over whatever someone is working in; it does not get
 * to spend three times the paints for a resolution nobody can see.
 */
export function pushLevel(w: Waveform, level: number): Waveform {
  const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
  const peak = Math.max(w.peak, clamped)
  const filled = w.filled + 1

  if (filled < FRAMES_PER_BAR) return { bars: w.bars, peak, filled }

  return { bars: [...w.bars.slice(1), peak], peak: 0, filled: 0 }
}

/**
 * Fade the shape out without discarding it.
 *
 * Used when recording stops: the bars stay where they are and the caller draws
 * them dimmed. Clearing instead would throw away the one piece of evidence
 * about the audio that is now being transcribed.
 */
export function isSilent(w: Waveform): boolean {
  return w.bars.every((b) => b <= 0.002)
}

/**
 * Bar heights in pixels, oldest first.
 *
 * A floor of 2px so a silent stretch is a visible line rather than a gap: an
 * empty region reads as "not recording", and a flat line reads as "recording,
 * heard nothing", which are opposite diagnoses.
 */
export function heights(w: Waveform, max: number, floor = 2): number[] {
  return w.bars.map((b) => floor + b * Math.max(0, max - floor))
}
