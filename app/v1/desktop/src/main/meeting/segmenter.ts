import type { AsrSegment, TokenTiming } from '@wouice/asr'
import type { Channel } from './session.js'

/**
 * Raw ASR output, assembled into speaker-labelled segments.
 *
 * IT SEGMENTS ON WHISPER'S OWN BOUNDARIES, NOT ON WORD GAPS. The first version
 * of this reconstructed utterances from per-word timings, which produced a
 * transcript that was 46% one-word fragments on a real meeting. The cause is
 * in the data: whisper.cpp reports `t_dtw: -1` on every word, meaning the DTW
 * alignment is unavailable and the times are INTERPOLATED evenly across the
 * segment rather than measured. On Devanagari it splits per glyph, so "कि" and
 * "इतने" arrive as four "words" at invented times. Cutting on those is cutting
 * on noise. The segment boundaries whisper reports are real; the word
 * boundaries inside them frequently are not.
 *
 * Word timings are still used for one thing - matching echo across the two
 * channels - because an evenly-spread estimate is good enough for a two second
 * window and nothing better exists.
 *
 * PURE. No model, no clock, no filesystem. The rules that decide what a
 * transcript reads like should all be arguable in a test.
 */

export interface SegmenterConfig {
  /** Silence between whisper segments that starts a new utterance. */
  pauseGapSec: number
  /** Hard cut, so one long answer is not one long paragraph. */
  maxSegmentSec: number
  /** |mic time − system time| for two words to count as the same moment. */
  echoWindowSec: number
  /** Consecutive matched words before a run counts as echo at all. */
  echoMinRun: number
  /** Fraction of a segment inside echo runs before the segment is flagged. */
  echoDropFraction: number
  /** How much system-channel word history to keep for echo matching. */
  systemMemorySec: number
  /**
   * Above this, whisper is telling us there was probably nothing there.
   *
   * This is the guard against the confident "Thank you." that appears over a
   * quiet stretch. A real meeting produced "Thank" and "you." as five separate
   * hallucinated segments; the model knew, and nothing was reading it.
   */
  maxNoSpeechProb: number
  /** Below this the model was guessing. Very negative means noise. */
  minAvgLogprob: number
}

export const DEFAULT_SEGMENTER: SegmenterConfig = {
  pauseGapSec: 0.8,
  maxSegmentSec: 15,
  echoWindowSec: 2.0,
  echoMinRun: 3,
  echoDropFraction: 0.7,
  systemMemorySec: 120,
  maxNoSpeechProb: 0.6,
  minAvgLogprob: -1.0,
}

export interface Segment {
  channel: Channel
  /** Milliseconds from the start of the meeting's audio. */
  startMs: number
  endMs: number
  text: string
  /**
   * True when this is the far side arriving through your own microphone.
   *
   * Flagged, never deleted. A wrongly dropped line is unrecoverable and a
   * wrongly kept one is merely untidy.
   */
  echo: boolean
}

/** One chunk's worth of ASR output. */
export interface AsrChunk {
  segments: readonly AsrSegment[]
  /** Only used for echo matching, where an approximate time is enough. */
  words: readonly TokenTiming[]
}

interface Word {
  text: string
  startMs: number
  endMs: number
}

/**
 * Tokens to words, for echo matching only.
 *
 * A token beginning with a space starts a new word, which is the tokenizer's
 * own contract and the reason concatenation reproduces the transcript exactly.
 */
export function wordsFromTokens(tokens: readonly TokenTiming[], offsetMs = 0): Word[] {
  const words: Word[] = []

  for (const token of tokens) {
    const raw = token.token
    if (!raw || !raw.trim()) continue

    const startsWord = /^\s/.test(raw) || words.length === 0
    const startMs = Math.round(offsetMs + token.startSec * 1000)
    const endMs = Math.max(startMs, Math.round(offsetMs + token.endSec * 1000))

    if (startsWord) words.push({ text: raw.trim(), startMs, endMs })
    else {
      const last = words[words.length - 1]!
      last.text += raw
      last.endMs = endMs
    }
  }

  return words.filter((w) => w.text.length > 0)
}

/** Lowercased and stripped of punctuation, for comparing what was said. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** True when a line carries no actual words, only punctuation or spaces. */
export function isEmptyish(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text)
}

/**
 * Whether whisper was transcribing or inventing.
 *
 * Both signals come from the model itself and cost nothing to read. Ignoring
 * them is what let a real meeting accumulate `"Thank"` five times and
 * `"There is no website at Saradin.ai"` three times over stretches where
 * nobody was speaking.
 */
export function isHallucination(segment: AsrSegment, config: SegmenterConfig): boolean {
  if (isEmptyish(segment.text)) return true
  if (segment.noSpeechProb > config.maxNoSpeechProb) return true
  // A very negative average log probability with almost nothing said is noise
  // being written down. Longer text at the same score is usually real.
  if (segment.avgLogprob < config.minAvgLogprob && segment.text.trim().length < 25) return true
  return false
}

function echoRunCoverage(
  words: readonly Word[],
  history: readonly Word[],
  config: SegmenterConfig
): number {
  if (words.length === 0 || history.length === 0) return 0

  const windowMs = config.echoWindowSec * 1000
  const matched = words.map((word) => {
    const key = normalise(word.text)
    if (!key) return false
    return history.some(
      (other) =>
        normalise(other.text) === key && Math.abs(other.startMs - word.startMs) <= windowMs
    )
  })

  let covered = 0
  let run = 0
  for (let i = 0; i <= matched.length; i++) {
    if (matched[i]) {
      run++
      continue
    }
    if (run >= config.echoMinRun) covered += run
    run = 0
  }

  return covered / words.length
}

interface Open {
  startMs: number
  endMs: number
  parts: string[]
}

export class Segmenter {
  private readonly open: Record<Channel, Open | null> = { me: null, them: null }
  /** System-channel words retained for echo matching. */
  private history: Word[] = []
  /** Mic words, kept only long enough to score the segment they belong to. */
  private mine: Word[] = []

  constructor(private readonly config: SegmenterConfig = DEFAULT_SEGMENTER) {}

  /**
   * Add one chunk's output for one channel.
   *
   * @param offsetMs where this chunk starts in the meeting's audio.
   * @returns segments that closed as a result.
   */
  push(channel: Channel, chunk: AsrChunk, offsetMs: number): Segment[] {
    const words = wordsFromTokens(chunk.words, offsetMs)
    if (channel === 'them') this.remember(words)
    else this.mine.push(...words)

    const closed: Segment[] = []
    for (const raw of chunk.segments) {
      if (isHallucination(raw, this.config)) continue

      const startMs = Math.round(offsetMs + raw.startSec * 1000)
      const endMs = Math.max(startMs, Math.round(offsetMs + raw.endSec * 1000))
      const current = this.open[channel]

      // A pause between whisper's own utterances, or a segment that has grown
      // past the cap, ends the one in progress.
      const gapTooLong =
        current !== null && startMs - current.endMs > this.config.pauseGapSec * 1000
      const tooLong =
        current !== null && endMs - current.startMs > this.config.maxSegmentSec * 1000

      if (current && (gapTooLong || tooLong)) {
        const segment = this.close(channel)
        if (segment) closed.push(segment)
      }

      const open = this.open[channel]
      if (open) {
        open.parts.push(raw.text.trim())
        open.endMs = Math.max(open.endMs, endMs)
      } else {
        this.open[channel] = { startMs, endMs, parts: [raw.text.trim()] }
      }
    }

    return closed
  }

  /** Close whatever is still open. Call at the end of the meeting. */
  flush(): Segment[] {
    const out: Segment[] = []
    for (const channel of ['me', 'them'] as const) {
      const segment = this.close(channel)
      if (segment) out.push(segment)
    }
    return out.sort((a, b) => a.startMs - b.startMs)
  }

  private close(channel: Channel): Segment | null {
    const open = this.open[channel]
    if (!open) return null
    this.open[channel] = null

    const text = open.parts.join(' ').replace(/\s+/g, ' ').trim()
    if (!text || isEmptyish(text)) return null

    // Only the mic can carry echo: the system channel is a digital tap of what
    // was played, so nothing of yours can be in it. Spike V4 measured its floor
    // between sounds at exactly zero.
    let echo = false
    if (channel === 'me') {
      const within = this.mine.filter((w) => w.startMs >= open.startMs && w.startMs <= open.endMs)
      echo = echoRunCoverage(within, this.history, this.config) >= this.config.echoDropFraction
      this.mine = this.mine.filter((w) => w.startMs > open.endMs)
    }

    return { channel, startMs: open.startMs, endMs: open.endMs, text, echo }
  }

  private remember(words: readonly Word[]): void {
    this.history.push(...words)
    // Bounded: a word from forty minutes ago cannot be inside a two second
    // window, and an hour of the far side would accumulate for nothing.
    const cutoff = (words[words.length - 1]?.endMs ?? 0) - this.config.systemMemorySec * 1000
    if (this.history.length > 0 && this.history[0]!.endMs < cutoff) {
      this.history = this.history.filter((w) => w.endMs >= cutoff)
    }
  }
}
