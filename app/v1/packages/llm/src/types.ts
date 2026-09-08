/**
 * The LLM contract.
 *
 * `llama-server` speaks the OpenAI wire format, so "local" and "cloud" differ
 * only by baseUrl, key and model. That is the whole reason there is no
 * abstraction layer here beyond a config table: the seam we wanted came free.
 */

export type Scope =
  | 'dictationCleanup'
  | 'meetingChunk'
  | 'meetingNotes'
  | 'companionChat'

export type Provider = 'local' | 'anthropic' | 'openai'

export interface ScopeConfig {
  provider: Provider
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs: number
  /** Where to fall back when this provider fails. `null` means degrade instead. */
  fallback: 'local' | null
}

export interface LlmRequest {
  system: string
  user: string
  maxTokens?: number
  /** 0 for cleanup and notes: the same audio must yield the same text. */
  temperature?: number
  /**
   * Total allowance. A backstop, not a prediction.
   *
   * It used to be the only limit, at a flat 4000 ms, which killed any dictation
   * over about 120 words: the work scales with what was said and the constant
   * did not. Callers should compute this from the input - see `cleanupBudget`.
   */
  timeoutMs?: number
  /** Nothing at all yet. Covers prompt processing, which grows with the input. */
  firstTokenTimeoutMs?: number
  /** Gap between tokens. This catches a STOPPED model, not a slow one. */
  stallTimeoutMs?: number
  /** Called with each delta as it arrives, for progress. */
  onToken?(delta: string): void
  signal?: AbortSignal
}

export interface LlmResult {
  text: string
  latencyMs: number
  provider: string
  model: string
  /** Set when the primary provider failed and a fallback answered. */
  fellBackFrom?: string
  /** How long until the first token. Prompt processing, separated from generation. */
  firstTokenMs?: number
  /**
   * Why generation stopped. 'length' means the token cap cut it off, which is a
   * silent truncation unless somebody looks at this.
   */
  finishReason?: string | null
}

export interface LlmHealth {
  ok: boolean
  model?: string
  detail?: string
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>
  health(): Promise<LlmHealth>
}

export type LlmErrorKind = 'unreachable' | 'timeout' | 'rejected' | 'malformed' | 'aborted'

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    override readonly cause?: unknown
  ) {
    super(message)
    this.name = 'LlmError'
  }
}
