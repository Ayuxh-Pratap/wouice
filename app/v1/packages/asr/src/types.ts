/**
 * The ASR contract.
 *
 * This being an HTTP boundary rather than a library import is what makes the
 * whole stack decision reversible. If whisper.cpp's Hinglish accuracy
 * disappoints, a Python faster-whisper or IndicWhisper sidecar implementing
 * this same interface is a drop-in replacement and the application does not
 * change by one line. Keep it narrow, and resist adding anything that only one
 * engine could satisfy.
 */

export type Language = 'auto' | 'en' | 'hi' | (string & {})

export interface TranscribeOptions {
  /** 'auto' lets the engine detect. Forcing 'hi' hurts code-mixed speech. */
  language?: Language
  /**
   * Glossary handed to the decoder before it runs. MUST be short: a long
   * initial prompt makes Whisper drift and invent text on quiet audio. Build it
   * with `biasPrompt()` from @wouice/dictionary, which enforces a budget.
   */
  prompt?: string
  /** Per-token timestamps. Not needed for dictation; Phase 2's segmenter wants them. */
  wantTimings?: boolean
  /** Overrides the client default. */
  timeoutMs?: number
  /** Cancel an in-flight request, e.g. the user pressed Escape. */
  signal?: AbortSignal
}

/**
 * One utterance, as whisper itself cut it.
 *
 * PREFER THESE OVER RECONSTRUCTING FROM WORD TIMINGS. whisper.cpp reports
 * `t_dtw: -1` on every word when DTW alignment is unavailable, which means the
 * per-word times are INTERPOLATED across the segment rather than measured -
 * evenly spaced, and on Devanagari split per glyph rather than per word. Cutting
 * a transcript on those produces one-word fragments at times nothing actually
 * happened. The segment boundaries are real; the word boundaries inside them
 * frequently are not.
 */
export interface AsrSegment {
  text: string
  startSec: number
  endSec: number
  /**
   * The model's own estimate that this is silence. High values are how a
   * hallucinated "Thank you." over a quiet stretch announces itself.
   */
  noSpeechProb: number
  /** Mean log probability. Very negative means the model was guessing. */
  avgLogprob: number
}

export interface TokenTiming {
  token: string
  startSec: number
  endSec: number
  confidence: number
}

export interface TranscribeResult {
  text: string
  /** What the engine detected, or the language that was forced. */
  language: string
  /** Present only when `wantTimings` was requested and the engine supplied them. */
  tokens?: TokenTiming[]
  /** whisper's own utterance boundaries, which are the trustworthy ones. */
  segments?: AsrSegment[]
  /** Length of the audio submitted. */
  audioMs: number
  /** Wall time of the call, including transport. */
  latencyMs: number
  model: string
}

export interface AsrHealth {
  ok: boolean
  model: string
  /** Why it is not ok. Surfaced verbatim so a failure is diagnosable. */
  detail?: string
}

export interface AsrClient {
  transcribe(pcm: Float32Array, options?: TranscribeOptions): Promise<TranscribeResult>
  health(): Promise<AsrHealth>
}

/**
 * Distinguishes the failure modes that matter to a caller, because they need
 * different responses: a dead sidecar should be respawned, a timeout should be
 * retried or degraded, and a rejection is a bug in our request.
 */
export type AsrErrorKind = 'unreachable' | 'timeout' | 'rejected' | 'malformed' | 'aborted'

export class AsrError extends Error {
  constructor(
    readonly kind: AsrErrorKind,
    message: string,
    override readonly cause?: unknown
  ) {
    super(message)
    this.name = 'AsrError'
  }
}
