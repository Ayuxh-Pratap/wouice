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
