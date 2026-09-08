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
  timeoutMs?: number
  signal?: AbortSignal
}

export interface LlmResult {
  text: string
  latencyMs: number
  provider: string
  model: string
  /** Set when the primary provider failed and a fallback answered. */
  fellBackFrom?: string
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
