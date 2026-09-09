import type { AsrClient } from '@wouice/asr'
import { Segmenter, type Segment, type SegmenterConfig } from './segmenter.js'
import { CHANNELS, MEETING_SAMPLE_RATE, type Channel } from './session.js'

/**
 * Turns two live channels of audio into transcript segments while the meeting
 * is still happening.
 *
 * WHY CHUNKED AND NOT AT THE END. A one hour meeting transcribed in one pass is
 * a one hour wait, and the transcript is worth most while you can still act on
 * it. Each channel is cut every ~25 seconds and sent on its own, so the
 * transcript trails the conversation by about half a minute rather than by the
 * length of the call.
 *
 * ONE REQUEST AT A TIME, DELIBERATELY. whisper-server serialises anyway, so
 * firing both channels at once buys nothing and hides the thing worth watching:
 * whether the queue is GROWING. A backlog that grows by one percent per chunk
 * is invisible for five minutes and fatal at sixty, which is exactly what
 * acceptance criterion B4 is about, so the depth is measured and exposed rather
 * than assumed to be fine.
 *
 * A FAILED CHUNK LOSES ITS SLICE, NOT THE MEETING. Same rule as dictation: the
 * words are already spoken and there is no asking for them again, so a chunk
 * that will not transcribe is counted and skipped.
 */

export interface TranscriberOptions {
  asr: AsrClient
  /** Called as segments close, in the order they close. */
  onSegments(segments: Segment[]): void
  /** Seconds of audio per ASR request. */
  chunkSeconds?: number
  segmenter?: SegmenterConfig
  sampleRate?: number
}

export interface TranscriberStats {
  /** Chunks waiting, plus the one in flight. The number B4 watches. */
  queued: number
  chunksSent: number
  chunksFailed: number
  /** Wall time of the most recent successful request. */
  lastLatencyMs: number
  /** Segments handed out so far. */
  segments: number
}

interface Job {
  channel: Channel
  samples: Float32Array
  offsetMs: number
}

const DEFAULT_CHUNK_SECONDS = 25

export class MeetingTranscriber {
  private readonly asr: AsrClient
  private readonly onSegments: (segments: Segment[]) => void
  private readonly sampleRate: number
  private readonly chunkSamples: number
  private readonly segmenter: Segmenter

  private readonly pending: Record<Channel, Float32Array[]> = { me: [], them: [] }
  private readonly pendingLength: Record<Channel, number> = { me: 0, them: 0 }
  /** Where this channel's audio begins in the merged file. */
  private readonly baseOffsetMs: Record<Channel, number | null> = { me: null, them: null }
  /** Samples already cut into chunks, per channel. */
  private readonly consumed: Record<Channel, number> = { me: 0, them: 0 }

  private readonly queue: Job[] = []
  private draining: Promise<void> | null = null
  private stopped = false

  private chunksSent = 0
  private chunksFailed = 0
  private lastLatencyMs = 0
  private segmentCount = 0

  constructor(options: TranscriberOptions) {
    this.asr = options.asr
    this.onSegments = options.onSegments
    this.sampleRate = options.sampleRate ?? MEETING_SAMPLE_RATE
    this.chunkSamples = Math.round((options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS) * this.sampleRate)
    this.segmenter = new Segmenter(options.segmenter)
  }

  /**
   * One frame of audio.
   *
   * @param offsetMs where this channel's audio starts in the merged file, so a
   * segment's timestamp and the sound it came from are the same moment. Only
   * the first call per channel is used; the rest follow from the sample count.
   */
  push(channel: Channel, frame: Float32Array, offsetMs: number): void {
    if (this.stopped || frame.length === 0) return
    if (this.baseOffsetMs[channel] === null) this.baseOffsetMs[channel] = offsetMs

    this.pending[channel].push(frame)
    this.pendingLength[channel] += frame.length
    if (this.pendingLength[channel] >= this.chunkSamples) this.cut(channel)
  }

  /**
   * Transcribe whatever is left and close every open segment.
   *
   * Awaits the queue, because the tail of a meeting is where the decisions
   * usually are and dropping it to finish quickly would be the wrong trade.
   */
  async finish(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const channel of CHANNELS) this.cut(channel, true)
    await this.drain()

    const closing = this.segmenter.flush()
    if (closing.length > 0) {
      this.segmentCount += closing.length
      this.onSegments(closing)
    }
  }

  stats(): TranscriberStats {
    return {
      queued: this.queue.length + (this.draining ? 1 : 0),
      chunksSent: this.chunksSent,
      chunksFailed: this.chunksFailed,
      lastLatencyMs: this.lastLatencyMs,
      segments: this.segmentCount,
    }
  }

  /* ------------------------------------------------------------------ */

  private cut(channel: Channel, force = false): void {
    const length = this.pendingLength[channel]
    if (length === 0 || (!force && length < this.chunkSamples)) return

    const samples = new Float32Array(length)
    let at = 0
    for (const frame of this.pending[channel]) {
      samples.set(frame, at)
      at += frame.length
    }
    this.pending[channel] = []
    this.pendingLength[channel] = 0

    const offsetMs =
      (this.baseOffsetMs[channel] ?? 0) + (this.consumed[channel] / this.sampleRate) * 1000
    this.consumed[channel] += length

    this.queue.push({ channel, samples, offsetMs })
    void this.drain()
  }

  /**
   * Work the queue to empty.
   *
   * Returns the RUN IN PROGRESS when there is one rather than returning
   * immediately, which is the difference between `finish()` waiting for the
   * tail of the meeting and silently discarding it.
   */
  private drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.run().finally(() => {
        this.draining = null
      })
    }
    return this.draining
  }

  private async run(): Promise<void> {
    for (;;) {
      const job = this.queue.shift()
      if (!job) break
      await this.transcribe(job)
    }
  }

  private async transcribe(job: Job): Promise<void> {
    const started = Date.now()
    try {
      const result = await this.asr.transcribe(job.samples, {
        language: 'auto',
        // The segmenter needs per-token times to find sentence boundaries and
        // to match echo across channels. Without these it has nothing to work
        // with but the chunk edges.
        wantTimings: true,
      })
      this.chunksSent++
      this.lastLatencyMs = Date.now() - started

      const tokens = result.tokens ?? []
      if (tokens.length === 0) return

      const closed = this.segmenter.push(job.channel, tokens, job.offsetMs)
      if (closed.length > 0) {
        this.segmentCount += closed.length
        this.onSegments(closed)
      }
    } catch (err) {
      // The words are already spoken; there is no asking for them again. Losing
      // 25 seconds of one channel beats ending the meeting.
      this.chunksFailed++
      console.warn(
        `[meeting] ${job.channel} chunk at ${Math.round(job.offsetMs / 1000)}s failed:`,
        err instanceof Error ? err.message : err
      )
    }
  }
}
