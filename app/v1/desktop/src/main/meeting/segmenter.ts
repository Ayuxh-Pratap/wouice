import type { TokenTiming } from '@wouice/asr'
import type { Channel } from './session.js'

/**
 * Raw ASR tokens, assembled into speaker-labelled segments.
 *
 * PURE, AND THAT IS THE POINT. Everything here is arithmetic over words and
 * timestamps: no model, no VRAM, no filesystem, no clock. The two rules that
 * decide whether a meeting transcript is readable - where one utterance ends
 * and the next begins, and which of your lines are really the far side coming
 * back through your speakers - are both testable in milliseconds.
 *
 * SPEAKER SEPARATION IS ALREADY DONE BY THE TIME ANYTHING GETS HERE. The mic is
 * you and the loopback tap is everyone else, decided by capture topology rather
 * than by a diarization model. This does not identify anybody; it only groups
 * what each channel said into sentences.
 */

export interface SegmenterConfig {
  /** Silence that closes a segment. */
  pauseGapSec: number
  /** Hard cut on a monologue, so one long answer is not one long paragraph. */
  maxSegmentSec: number
  /** |mic time − system time| for two words to count as the same moment. */
  echoWindowSec: number
  /** Consecutive matched words before a run counts as echo at all. */
  echoMinRun: number
  /** Fraction of a segment inside echo runs before the segment is flagged. */
  echoDropFraction: number
  /** How much system-channel word history to keep for echo matching. */
  systemMemorySec: number
}

export const DEFAULT_SEGMENTER: SegmenterConfig = {
  pauseGapSec: 0.8,
  maxSegmentSec: 15,
  echoWindowSec: 2.0,
  echoMinRun: 3,
  echoDropFraction: 0.7,
  systemMemorySec: 120,
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
   * wrongly kept one is merely untidy, so the transcript keeps both and the
   * reader decides.
   */
  echo: boolean
}

interface Word {
  text: string
  startMs: number
  endMs: number
}

/**
 * Tokens to words.
 *
 * Whisper and every other subword tokenizer emit pieces, and a piece that
 * begins with a space is the start of a new word - which is precisely why
 * concatenating them reproduces the transcript exactly. Splitting on anything
 * else would break the reconstruction, so this is not a heuristic, it is the
 * tokenizer's own contract.
 */
export function wordsFromTokens(tokens: readonly TokenTiming[], offsetMs = 0): Word[] {
  const words: Word[] = []

  for (const token of tokens) {
    const raw = token.token
    if (!raw || !raw.trim()) continue

    const startsWord = /^\s/.test(raw) || words.length === 0
    const startMs = Math.round(offsetMs + token.startSec * 1000)
    const endMs = Math.round(offsetMs + token.endSec * 1000)

    if (startsWord) {
      words.push({ text: raw.trim(), startMs, endMs })
    } else {
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

/**
 * Which of a segment's words also came out of the speakers at the same moment.
 *
 * THE PREMISE, WHICH IS WORTH STATING because the whole thing rests on it:
 * genuinely repeating someone almost never matches three consecutive words
 * inside two seconds. Agreeing, echoing a phrase back, or saying "yes exactly"
 * does not produce a three-word collision at the same instant; a speaker
 * bleeding into your microphone produces nothing else.
 *
 * Runs, not totals. Half a conversation shares words like "the" and "we" with
 * the other half, so counting matched words alone would flag every segment in
 * a long meeting. Requiring them CONSECUTIVE is what makes it specific.
 */
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

/**
 * Accumulates tokens per channel and hands back segments as they close.
 *
 * Stateful because a segment can span two ASR chunks: a sentence that runs
 * across a 25 second boundary is one utterance, and treating chunk edges as
 * sentence edges would chop the transcript on a schedule that has nothing to do
 * with speech.
 */
export class Segmenter {
  private readonly open: Record<Channel, Word[]> = { me: [], them: [] }
  /** System-channel words retained for echo matching. */
  private history: Word[] = []

  constructor(private readonly config: SegmenterConfig = DEFAULT_SEGMENTER) {}

  /**
   * Add one chunk's tokens for one channel.
   *
   * @param offsetMs where this chunk starts in the meeting's audio.
   * @returns segments that closed as a result. Usually none.
   */
  push(channel: Channel, tokens: readonly TokenTiming[], offsetMs: number): Segment[] {
    const words = wordsFromTokens(tokens, offsetMs)
    if (words.length === 0) return []

    if (channel === 'them') this.remember(words)

    const closed: Segment[] = []
    for (const word of words) {
      const current = this.open[channel]
      const last = current[current.length - 1]
      const first = current[0]

      const gapTooLong = last !== undefined && word.startMs - last.endMs > this.config.pauseGapSec * 1000
      const tooLong =
        first !== undefined && word.endMs - first.startMs > this.config.maxSegmentSec * 1000

      if (gapTooLong || tooLong) {
        const segment = this.close(channel)
        if (segment) closed.push(segment)
      }
      this.open[channel].push(word)
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
    const words = this.open[channel]
    if (words.length === 0) return null
    this.open[channel] = []

    // Only the mic can carry echo. The system channel is a digital tap of what
    // was played, so nothing of yours can be in it - spike V4 measured a floor
    // of exactly zero between sounds.
    const echo =
      channel === 'me' &&
      echoRunCoverage(words, this.history, this.config) >= this.config.echoDropFraction

    return {
      channel,
      startMs: words[0]!.startMs,
      endMs: words[words.length - 1]!.endMs,
      text: words.map((w) => w.text).join(' '),
      echo,
    }
  }

  private remember(words: readonly Word[]): void {
    this.history.push(...words)
    // Bounded, or an hour of the far side accumulates for nothing: a word from
    // forty minutes ago cannot be inside a two second window.
    const cutoff = (words[words.length - 1]?.endMs ?? 0) - this.config.systemMemorySec * 1000
    if (this.history.length > 0 && this.history[0]!.endMs < cutoff) {
      this.history = this.history.filter((w) => w.endMs >= cutoff)
    }
  }
}
