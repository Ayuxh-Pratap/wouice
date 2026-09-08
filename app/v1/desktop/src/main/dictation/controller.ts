import { EventEmitter } from 'node:events'
import { WhisperCppClient } from '@wouice/asr'
import { OpenAiCompatClient, DICTATION_CLEANUP_SYSTEM, isPlausibleCleanup } from '@wouice/llm'
import { correct, biasPrompt, SEED_DICTIONARY } from '@wouice/dictionary'
import {
  DEFAULT_SILENCE,
  initialSilenceState,
  rms,
  step as silenceStep,
  type SilenceConfig,
  type SilenceState,
} from '../capture/silence-policy.js'
import {
  initialDictationState,
  isBusy,
  reduce,
  type DictationAction,
  type DictationEvent,
  type DictationState,
} from './machine.js'
import type { SidecarSupervisor } from '../sidecars/supervisor.js'

const SAMPLE_RATE = 16_000
const FRAME_MS = 20

export interface DictationResult {
  sessionId: number
  raw: string
  corrected: string
  final: string
  language: string
  audioMs: number
  asrMs: number
  llmMs: number
  totalMs: number
  chunks: number
  asrModel: string
  llmModel: string
  degraded: string | null
  appliedCorrections: number
}

export interface ControllerDeps {
  supervisor: SidecarSupervisor
  silence?: SilenceConfig
  cleanupEnabled: () => boolean
  cleanupTimeoutMs: () => number
}

/**
 * Drives one dictation from first frame to final text.
 *
 * The state machine and the silence policy are pure and live elsewhere; this is
 * the part that holds audio, calls sidecars and emits results. Everything
 * asynchronous is stamped with a sessionId and dropped if it no longer matches,
 * which is what makes Escape actually cancel rather than merely appear to.
 *
 * THE DEGRADATION RULE: every stage falls back, no stage fails. A stalled or
 * confused LLM yields the dictionary-corrected text, which is still your words
 * with imperfect punctuation. The user always gets something.
 */
export class DictationController extends EventEmitter {
  private state: DictationState = initialDictationState()
  private silence: SilenceState = initialSilenceState()

  /** Audio for the chunk currently being accumulated. */
  private pending: Float32Array[] = []
  /** Text from chunks already transcribed, in order. */
  private chunkTexts: string[] = []
  /** In-flight chunk transcriptions, awaited at finish. */
  private chunkJobs: Promise<void>[] = []

  private totalAudioMs = 0
  private asrMsTotal = 0
  private detectedLanguage = 'auto'
  private errorTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: ControllerDeps) {
    super()
  }

  get phase(): DictationState['phase'] {
    return this.state.phase
  }

  get sessionId(): number {
    return this.state.sessionId
  }

  /** Level for the HUD meter, 0..1. */
  get level(): number {
    return this.silence.level
  }

  get elapsedMs(): number {
    return this.silence.elapsedMs
  }

  send(event: DictationEvent): void {
    const { state, action } = reduce(this.state, event)
    const changed = state.phase !== this.state.phase
    this.state = state
    if (changed) this.emitState()
    void this.perform(action)
  }

  /** One 20 ms frame of 16 kHz mono Float32 from the renderer. */
  pushFrame(sessionId: number, frame: Float32Array): void {
    // A frame from a session that has already ended is not merely useless, it
    // would corrupt the next recording if the phase happened to line up.
    if (sessionId !== this.state.sessionId) return
    if (this.state.phase !== 'listening' && this.state.phase !== 'arming') return

    this.pending.push(frame)
    this.totalAudioMs += FRAME_MS

    const out = silenceStep(
      this.silence,
      { rms: rms(frame), ms: FRAME_MS },
      this.deps.silence ?? DEFAULT_SILENCE
    )
    this.silence = out.state
    this.emit('level', { level: out.state.level, elapsedMs: out.state.elapsedMs })

    switch (out.verdict) {
      case 'emit-chunk':
        this.send({ type: 'chunkEmitted' })
        break
      case 'stop-silence':
        this.send({ type: 'silenceStop' })
        break
      case 'stop-cap':
        this.send({ type: 'capStop' })
        break
    }
  }

  private async perform(action: DictationAction): Promise<void> {
    switch (action.type) {
      case 'startCapture':
        this.resetSession()
        this.deps.supervisor.setBusy('whisper', true)
        this.deps.supervisor.setBusy('llama', true)
        this.emit('startCapture', action.sessionId)
        return

      case 'discard':
        this.resetSession()
        this.releaseSidecars()
        this.emit('stopCapture', action.sessionId)
        return

      case 'flushChunk':
        this.emit('stopChunk')
        this.flushChunk(action.sessionId)
        return

      case 'finish':
        this.emit('stopCapture', action.sessionId)
        await this.finish(action.sessionId)
        return

      case 'scheduleErrorClear':
        if (this.errorTimer) clearTimeout(this.errorTimer)
        this.errorTimer = setTimeout(() => {
          this.errorTimer = null
          this.send({ type: 'errorTimeout' })
        }, action.delayMs)
        this.releaseSidecars()
        return

      case 'stopCapture':
        this.emit('stopCapture', action.sessionId)
        return
    }
  }

  /** Transcribe the accumulated audio in the background and keep recording. */
  private flushChunk(sessionId: number): void {
    const audio = this.drainPending()
    if (audio.length === 0) return
    const index = this.chunkTexts.length
    this.chunkTexts.push('')

    const job = this.transcribe(audio)
      .then((r) => {
        if (sessionId !== this.state.sessionId) return
        this.chunkTexts[index] = r.text
        this.asrMsTotal += r.latencyMs
        if (r.language && r.language !== 'auto') this.detectedLanguage = r.language
      })
      .catch((err: unknown) => {
        // A failed chunk loses that slice, not the whole dictation. Better to
        // deliver most of what was said than nothing.
        console.error('[dictation] chunk failed:', err instanceof Error ? err.message : err)
      })

    this.chunkJobs.push(job)
  }

  private async finish(sessionId: number): Promise<void> {
    const startedAt = Date.now()
    try {
      const tail = this.drainPending()

      // The tail and any in-flight chunks must both land before joining.
      const jobs = [...this.chunkJobs]
      if (tail.length > 0) {
        const r = await this.transcribe(tail)
        if (sessionId !== this.state.sessionId) return
        this.chunkTexts.push(r.text)
        this.asrMsTotal += r.latencyMs
        if (r.language && r.language !== 'auto') this.detectedLanguage = r.language
      }
      await Promise.all(jobs)
      if (sessionId !== this.state.sessionId) return

      const raw = this.chunkTexts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
      if (!raw) {
        this.send({ type: 'failed', reason: 'Nothing was transcribed' })
        return
      }

      // Dictionary BEFORE the LLM, so the model sees correct proper nouns and
      // cannot helpfully renormalise them into something else.
      const fixed = correct(raw, SEED_DICTIONARY)
      const { text: final, llmMs, degraded } = await this.cleanup(fixed.text)
      if (sessionId !== this.state.sessionId) return

      this.send({ type: 'transcribed' })

      const result: DictationResult = {
        sessionId,
        raw,
        corrected: fixed.text,
        final,
        language: this.detectedLanguage,
        audioMs: this.totalAudioMs,
        asrMs: this.asrMsTotal,
        llmMs,
        totalMs: Date.now() - startedAt + this.asrMsTotal,
        chunks: this.state.chunksSent,
        asrModel: this.deps.supervisor.snapshot('whisper').modelId,
        llmModel: this.deps.supervisor.snapshot('llama').modelId,
        degraded,
        appliedCorrections: fixed.applied.length,
      }
      this.emit('result', result)
    } catch (err) {
      this.send({ type: 'failed', reason: err instanceof Error ? err.message : String(err) })
    } finally {
      this.releaseSidecars()
    }
  }

  /** Clean up and render into English. Every failure degrades, none throws. */
  private async cleanup(
    text: string
  ): Promise<{ text: string; llmMs: number; degraded: string | null }> {
    if (!this.deps.cleanupEnabled()) return { text, llmMs: 0, degraded: null }
    if (!this.deps.supervisor.canServe('llama')) {
      return { text, llmMs: 0, degraded: 'llm-unavailable' }
    }

    const llm = new OpenAiCompatClient({
      baseUrl: this.deps.supervisor.baseUrl('llama'),
      model: this.deps.supervisor.snapshot('llama').modelId,
      timeoutMs: this.deps.cleanupTimeoutMs(),
    })

    try {
      const r = await llm.complete({
        system: DICTATION_CLEANUP_SYSTEM,
        user: text,
        temperature: 0,
        maxTokens: 1024,
      })
      const verdict = isPlausibleCleanup(text, r.text)
      if (!verdict.ok) {
        return { text, llmMs: r.latencyMs, degraded: `llm-rejected: ${verdict.reason}` }
      }
      // An empty answer means "unintelligible"; keep the raw words rather than
      // inserting nothing.
      if (!r.text.trim()) return { text, llmMs: r.latencyMs, degraded: 'llm-empty' }
      return { text: r.text, llmMs: r.latencyMs, degraded: null }
    } catch (err) {
      const kind = (err as { kind?: string }).kind ?? 'llm-failed'
      return { text, llmMs: 0, degraded: `llm-${kind}` }
    }
  }

  private async transcribe(audio: Float32Array) {
    if (!this.deps.supervisor.canServe('whisper')) {
      throw new Error('Speech recognition is not ready yet')
    }
    const asr = new WhisperCppClient({
      baseUrl: this.deps.supervisor.baseUrl('whisper'),
      model: this.deps.supervisor.snapshot('whisper').modelId,
    })
    return asr.transcribe(audio, {
      language: 'auto',
      // Short by design: a long initial prompt makes Whisper drift and invent
      // text on quiet audio.
      prompt: biasPrompt(SEED_DICTIONARY),
    })
  }

  private drainPending(): Float32Array {
    if (this.pending.length === 0) return new Float32Array(0)
    const total = this.pending.reduce((n, f) => n + f.length, 0)
    const out = new Float32Array(total)
    let offset = 0
    for (const f of this.pending) {
      out.set(f, offset)
      offset += f.length
    }
    this.pending = []
    return out
  }

  private resetSession(): void {
    this.silence = initialSilenceState()
    this.pending = []
    this.chunkTexts = []
    this.chunkJobs = []
    this.totalAudioMs = 0
    this.asrMsTotal = 0
    this.detectedLanguage = 'auto'
  }

  /** Let a queued model switch proceed, per decision A8c. */
  private releaseSidecars(): void {
    if (isBusy(this.state)) return
    this.deps.supervisor.setBusy('whisper', false)
    this.deps.supervisor.setBusy('llama', false)
  }

  private emitState(): void {
    this.emit('phase', {
      phase: this.state.phase,
      message: this.state.message,
      sessionId: this.state.sessionId,
    })
  }
}

export { SAMPLE_RATE, FRAME_MS }
