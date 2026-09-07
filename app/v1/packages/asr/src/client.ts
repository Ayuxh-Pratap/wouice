import { encodeWav, durationMs, SAMPLE_RATE } from './wav.js'
import {
  AsrError,
  type AsrClient,
  type AsrHealth,
  type TokenTiming,
  type TranscribeOptions,
  type TranscribeResult,
} from './types.js'

export interface WhisperClientConfig {
  /** e.g. http://127.0.0.1:8178 */
  baseUrl: string
  /** Reported back in results; the server does not tell us which model it loaded. */
  model: string
  /** Default per-request budget. Generous: a 5 minute tail can take a while. */
  timeoutMs?: number
  sampleRate?: number
}

const DEFAULT_TIMEOUT_MS = 120_000

/** whisper.cpp `verbose_json`, parsed defensively: builds differ in what they emit. */
interface WhisperResponse {
  text?: string
  language?: string
  segments?: {
    text?: string
    start?: number
    end?: number
    tokens?: unknown
    words?: { word?: string; start?: number; end?: number; probability?: number }[]
  }[]
}

/**
 * Client for whisper.cpp's bundled HTTP server.
 *
 * Speaks `POST /inference` with multipart form data. Node's fetch builds the
 * multipart body from a FormData automatically, so there is no hand-rolled
 * boundary encoding here.
 */
export class WhisperCppClient implements AsrClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly sampleRate: number

  constructor(config: WhisperClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.model = config.model
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.sampleRate = config.sampleRate ?? SAMPLE_RATE
  }

  async transcribe(pcm: Float32Array, options: TranscribeOptions = {}): Promise<TranscribeResult> {
    if (pcm.length === 0) {
      throw new AsrError('rejected', 'refusing to transcribe an empty buffer')
    }

    const audioMs = durationMs(pcm, this.sampleRate)
    const wav = encodeWav(pcm, this.sampleRate)

    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
    // verbose_json is a superset of json; we parse defensively so a build that
    // omits `segments` or `language` still yields a usable result.
    form.append('response_format', 'verbose_json')
    form.append('language', options.language ?? 'auto')
    // Greedy. Dictation wants the same text for the same audio every time, and
    // whisper's temperature fallback is a common source of invented sentences.
    form.append('temperature', '0')
    if (options.prompt) form.append('prompt', options.prompt)
    if (options.wantTimings) form.append('split_on_word', 'true')

    const started = performance.now()
    const res = await this.post('/inference', form, options)
    const latencyMs = Math.round(performance.now() - started)

    let body: WhisperResponse
    const raw = await res.text()
    try {
      body = JSON.parse(raw) as WhisperResponse
    } catch (cause) {
      throw new AsrError('malformed', `whisper returned non-JSON: ${raw.slice(0, 200)}`, cause)
    }

    const text = (body.text ?? '').trim()

    return {
      text,
      language: body.language ?? options.language ?? 'auto',
      ...(options.wantTimings ? { tokens: extractTimings(body) } : {}),
      audioMs,
      latencyMs,
      model: this.model,
    }
  }

  /**
   * "Is a process listening and answering?"
   *
   * Any HTTP response counts, including a 404. The supervisor needs to know
   * whether the sidecar is alive, and a running whisper-server that does not
   * serve the path we probed is alive. Only a connection failure means dead.
   */
  async health(): Promise<AsrHealth> {
    try {
      const res = await fetch(this.baseUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3_000),
      })
      return { ok: true, model: this.model, detail: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, model: this.model, detail: describe(err) }
    }
  }

  private async post(path: string, form: FormData, options: TranscribeOptions): Promise<Response> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs)
    // Caller cancellation (Escape) and our own timeout are different failures,
    // so they are combined here but told apart in the catch below.
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method: 'POST', body: form, signal })
    } catch (err) {
      if (options.signal?.aborted) throw new AsrError('aborted', 'cancelled by caller', err)
      if (timeout.aborted) {
        throw new AsrError('timeout', `whisper did not answer within ${options.timeoutMs ?? this.timeoutMs}ms`, err)
      }
      throw new AsrError('unreachable', `cannot reach whisper at ${this.baseUrl}: ${describe(err)}`, err)
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new AsrError('rejected', `whisper returned HTTP ${res.status}: ${detail}`)
    }
    return res
  }
}

/**
 * Flatten per-word timings out of the segment list.
 *
 * Returns an empty array rather than throwing when the build did not emit word
 * data. Dictation never asks for timings, so a Phase 2 concern must not be able
 * to break Phase 1's hot path.
 */
function extractTimings(body: WhisperResponse): TokenTiming[] {
  const out: TokenTiming[] = []
  for (const seg of body.segments ?? []) {
    for (const w of seg.words ?? []) {
      if (!w.word) continue
      out.push({
        token: w.word,
        startSec: w.start ?? 0,
        endSec: w.end ?? 0,
        confidence: w.probability ?? 0,
      })
    }
  }
  return out
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause
    return cause?.code ? `${err.message} (${cause.code})` : err.message
  }
  return String(err)
}
