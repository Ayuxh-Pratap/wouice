import { LlmError, type LlmClient, type LlmHealth, type LlmRequest, type LlmResult } from './types.js'
import { consumeSse } from './stream.js'

export interface OpenAiCompatConfig {
  /** e.g. http://127.0.0.1:8179  (llama-server) or https://api.openai.com */
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
  /** Reported in results so history can tell local from cloud. */
  label?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_FIRST_TOKEN_MS = 15_000
const DEFAULT_STALL_MS = 4_000

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

  /**
   * Ask for a completion, streaming the answer.
   *
   * STREAMING IS NOT FOR THE PROGRESS BAR. It is what makes a slow model
   * distinguishable from a stopped one. The previous version waited for the
   * whole response under a single flat timeout, so "still generating" and
   * "crashed" looked identical - and the timeout that caught the second one
   * killed every dictation long enough to need the first.
   *
   * Three limits, each answering a different question:
   *   firstTokenTimeoutMs   has it started?      grows with the input
   *   stallTimeoutMs        is it still going?   fixed; a gap means stopped
   *   timeoutMs             has it run away?     backstop, generous
   */
  async complete(req: LlmRequest): Promise<LlmResult> {
    const totalMs = req.timeoutMs ?? this.timeoutMs
    const firstTokenMs = req.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_MS
    const stallMs = req.stallTimeoutMs ?? DEFAULT_STALL_MS

    const controller = new AbortController()
    const total = AbortSignal.timeout(totalMs)
    const signal = req.signal
      ? AbortSignal.any([req.signal, total, controller.signal])
      : AbortSignal.any([total, controller.signal])

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    const started = performance.now()
    /** Set when we abort ourselves, so the reason survives the generic error. */
    let stalledAfterMs: number | null = null
    let sawFirstToken = false

    // Reset on every delta. Before the first token it allows for prompt
    // processing; after it, a much shorter gap means the stream has died.
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        stalledAfterMs = Math.round(performance.now() - started)
        controller.abort()
      }, ms)
    }

    let res: Response
    try {
      arm(firstTokenMs)
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
          stream: true,
        }),
      })
    } catch (err) {
      clearTimeout(watchdog)
      throw this.failure(err, req, { totalMs, firstTokenMs, stalledAfterMs, sawFirstToken, total })
    }

    if (!res.ok || !res.body) {
      clearTimeout(watchdog)
      const raw = await res.text().catch(() => '')
      throw new LlmError('rejected', `HTTP ${res.status}: ${raw.slice(0, 300)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let firstTokenAt: number | null = null
    let finishReason: string | null = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const progress = consumeSse(buffer, decoder.decode(value, { stream: true }))
        buffer = progress.rest

        for (const delta of progress.deltas) {
          if (firstTokenAt === null) {
            firstTokenAt = performance.now() - started
            sawFirstToken = true
          }
          text += delta
          req.onToken?.(delta)
        }
        // Any traffic at all counts as alive, so a model emitting keep-alives
        // while it thinks is not mistaken for a corpse.
        arm(sawFirstToken ? stallMs : firstTokenMs)

        if (progress.finishReason) finishReason = progress.finishReason
        if (progress.done) break
      }

      // Flush whatever is left. `consumeSse` holds back everything after the
      // last newline, because that is normally half a frame still in flight -
      // but at end of stream there is nothing more coming, and a server that
      // does not end on a newline would otherwise lose its final delta.
      if (buffer.trim().length > 0) {
        const tail = consumeSse(buffer, '\n')
        for (const delta of tail.deltas) {
          if (firstTokenAt === null) {
            firstTokenAt = performance.now() - started
            sawFirstToken = true
          }
          text += delta
          req.onToken?.(delta)
        }
        if (tail.finishReason) finishReason = tail.finishReason
      }
    } catch (err) {
      throw this.failure(err, req, { totalMs, firstTokenMs, stalledAfterMs, sawFirstToken, total })
    } finally {
      clearTimeout(watchdog)
      await reader.cancel().catch(() => {})
    }

    if (text.length === 0) {
      throw new LlmError('malformed', 'the stream carried no text')
    }

    return {
      text: text.trim(),
      latencyMs: Math.round(performance.now() - started),
      provider: this.label,
      model: this.model,
      ...(firstTokenAt !== null ? { firstTokenMs: Math.round(firstTokenAt) } : {}),
      finishReason,
    }
  }

  /** Turn an abort into the specific reason it happened. */
  private failure(
    err: unknown,
    req: LlmRequest,
    ctx: {
      totalMs: number
      firstTokenMs: number
      stalledAfterMs: number | null
      sawFirstToken: boolean
      total: AbortSignal
    }
  ): LlmError {
    if (req.signal?.aborted) return new LlmError('aborted', 'cancelled by caller', err)

    // A stalled model must never cost the user an utterance they already spoke,
    // so these stay distinct, recoverable failures - and now they say WHICH.
    if (ctx.stalledAfterMs !== null) {
      return new LlmError(
        'timeout',
        ctx.sawFirstToken
          ? `stopped mid-answer after ${ctx.stalledAfterMs}ms`
          : `never started answering within ${ctx.firstTokenMs}ms`,
        err
      )
    }
    if (ctx.total.aborted) {
      return new LlmError('timeout', `still answering after ${ctx.totalMs}ms`, err)
    }
    return new LlmError('unreachable', `cannot reach ${this.baseUrl}: ${describe(err)}`, err)
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
