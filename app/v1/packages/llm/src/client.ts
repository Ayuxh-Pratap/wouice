import { LlmError, type LlmClient, type LlmHealth, type LlmRequest, type LlmResult } from './types.js'

export interface OpenAiCompatConfig {
  /** e.g. http://127.0.0.1:8179  (llama-server) or https://api.openai.com */
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
  /** Reported in results so history can tell local from cloud. */
  label?: string
}

const DEFAULT_TIMEOUT_MS = 4_000

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
  error?: { message?: string }
}

/**
 * Client for any OpenAI-compatible `/v1/chat/completions` endpoint.
 *
 * That covers `llama-server` running locally and the cloud providers, which is
 * the entire point: switching between them is configuration, not code. Anthropic
 * needs a thin adapter because its wire format differs; everything else lands
 * here unchanged.
 */
export class OpenAiCompatClient implements LlmClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number
  private readonly label: string

  constructor(config: OpenAiCompatConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.model = config.model
    this.apiKey = config.apiKey
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.label = config.label ?? 'local'
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const timeoutMs = req.timeoutMs ?? this.timeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    const started = performance.now()
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          temperature: req.temperature ?? 0,
          max_tokens: req.maxTokens ?? 1024,
          stream: false,
        }),
      })
    } catch (err) {
      if (req.signal?.aborted) throw new LlmError('aborted', 'cancelled by caller', err)
      // A stalled model must never cost the user an utterance they already
      // spoke, so a timeout is a distinct, recoverable failure.
      if (timeout.aborted) throw new LlmError('timeout', `no answer within ${timeoutMs}ms`, err)
      throw new LlmError('unreachable', `cannot reach ${this.baseUrl}: ${describe(err)}`, err)
    }

    const raw = await res.text()
    if (!res.ok) {
      throw new LlmError('rejected', `HTTP ${res.status}: ${raw.slice(0, 300)}`)
    }

    let body: ChatResponse
    try {
      body = JSON.parse(raw) as ChatResponse
    } catch (cause) {
      throw new LlmError('malformed', `non-JSON response: ${raw.slice(0, 200)}`, cause)
    }
    if (body.error) throw new LlmError('rejected', body.error.message ?? 'provider returned an error')

    const text = body.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      throw new LlmError('malformed', 'response had no message content')
    }

    return {
      text: text.trim(),
      latencyMs: Math.round(performance.now() - started),
      provider: this.label,
      model: this.model,
    }
  }

  /** "Is something listening?" Any HTTP answer counts; only a connect failure is dead. */
  async health(): Promise<LlmHealth> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) })
      return { ok: true, model: this.model, detail: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, model: this.model, detail: describe(err) }
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause
    return cause?.code ? `${err.message} (${cause.code})` : err.message
  }
  return String(err)
}
