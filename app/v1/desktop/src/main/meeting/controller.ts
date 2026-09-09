import { EventEmitter } from 'node:events'
import type { AsrClient } from '@wouice/asr'
import type { Meetings } from '@wouice/store'
import { meterLevel, rms } from '../capture/silence-policy.js'
import { abandonedSessions, mergeSession, type MergeResult } from './merge.js'
import { MeetingRecorder } from './recorder.js'
import { MeetingTranscriber } from './transcriber.js'
import type { Segment } from './segmenter.js'
import { CHANNELS, type Channel } from './session.js'

/**
 * One meeting, from the moment it starts to the moment its audio is on disk.
 *
 * MAIN OWNS THE DECISION TO RECORD, NOT THE WINDOW. The button in the Meetings
 * page asks for a meeting; it does not open a microphone and inform anyone
 * afterwards. That looks like indirection for one caller today and stops
 * looking like it the moment a second caller exists - automatic detection is
 * coming, and it lives in main, where the mic-watcher is. Both callers then
 * reach the same state machine instead of a second capture path that has to be
 * kept in step with the first.
 *
 * WHY THE RENDERER IS STILL INVOLVED. `getUserMedia` and `getDisplayMedia` are
 * web APIs and exist only in a window, so capture is necessarily there. Main
 * announces the phase, the renderer opens or closes the two streams to match,
 * and reports back. The frames come home as they arrive.
 */

export type MeetingPhase =
  /** Nothing recording. */
  | 'idle'
  /** Asked for; the renderer is opening the microphone and the loopback tap. */
  | 'starting'
  /** Both channels live, audio landing on disk. */
  | 'recording'
  /** Asked to stop; the renderer is closing its streams. */
  | 'stopping'
  /** Streams closed, checkpoints being merged into one file. */
  | 'merging'

export interface ChannelView {
  channel: Channel
  /** Whether frames are currently arriving. */
  live: boolean
  samples: number
  /** 0..1 for a meter, on the same curve the dictation HUD uses. */
  level: number
  /** Set when the channel could not be opened. Null when it is fine. */
  problem: string | null
}

export interface MeetingState {
  phase: MeetingPhase
  sessionId: number
  startedAt: number | null
  elapsedMs: number
  channels: ChannelView[]
  /** The database row, once there is one. Null when nothing is recording. */
  meetingId: number | null
  /** Transcript progress, so a queue that is growing is visible. */
  transcript: { segments: number; queued: number; failed: number; live: boolean }
  /** Plain-language detail for the UI. Empty when there is nothing to say. */
  message: string
}

export interface MeetingDeps {
  /** Absent means record without transcribing, which still produces audio. */
  asr?: AsrClient
  store?: Meetings
  chunkSeconds?: number
}

/**
 * How long to wait for the renderer to confirm its streams are closed before
 * merging anyway.
 *
 * A window that has crashed or been closed mid-meeting must not be able to
 * strand an hour of audio in checkpoints. The merge is safe to run either way:
 * frames that arrive after it starts are simply not in the file.
 */
const CLOSE_GRACE_MS = 4_000

/** A channel with no frames for this long is not live any more. */
const STALE_MS = 1_500

export class MeetingController extends EventEmitter {
  private recorder: MeetingRecorder | null = null
  private phase: MeetingPhase = 'idle'
  private session = 0
  private startedAt: number | null = null
  private message = ''
  private closeTimer: NodeJS.Timeout | null = null

  private readonly levels: Record<Channel, number> = { me: 0, them: 0 }
  private readonly lastFrameAt: Record<Channel, number> = { me: 0, them: 0 }
  private readonly problems: Record<Channel, string | null> = { me: null, them: null }

  private transcriber: MeetingTranscriber | null = null
  private meetingId: number | null = null

  constructor(
    private readonly root: string,
    private readonly deps: MeetingDeps = {}
  ) {
    super()
  }

  /**
   * Begin a meeting.
   *
   * @returns the session id the renderer must stamp its frames with, or null
   * when one is already running. The id is what stops a late frame from a
   * previous meeting landing in the current one.
   */
  start(at: number = Date.now()): number | null {
    if (this.phase !== 'idle') return null

    this.session++
    this.startedAt = at
    this.message = ''
    for (const channel of CHANNELS) {
      this.levels[channel] = 0
      this.lastFrameAt[channel] = 0
      this.problems[channel] = null
    }

    try {
      this.recorder = new MeetingRecorder(this.root, at)
      this.meetingId = this.deps.store?.start(this.recorder.dir, at) ?? null
      this.transcriber = this.deps.asr
        ? new MeetingTranscriber({
            asr: this.deps.asr,
            chunkSeconds: this.deps.chunkSeconds,
            onSegments: (segments) => this.record(segments),
          })
        : null
    } catch (err) {
      this.startedAt = null
      this.message = `could not open a session directory: ${describe(err)}`
      this.emitState()
      return null
    }

    this.setPhase('starting')
    return this.session
  }

  /** The renderer has both streams open. */
  captureReady(session: number): void {
    if (session !== this.session || this.phase !== 'starting') return
    this.setPhase('recording')
  }

  /**
   * One channel could not be opened, or died.
   *
   * NOT FATAL. A meeting with one channel is worth far more than no meeting: a
   * refused microphone still leaves the far side recorded, and a machine with
   * no loopback still records you. The problem is carried in the state so the
   * UI can say which half is missing rather than pretending it is fine.
   */
  captureFailed(session: number, channel: Channel, reason: string): void {
    if (session !== this.session) return
    this.problems[channel] = reason || 'unavailable'
    if (this.phase === 'starting' && CHANNELS.every((c) => this.problems[c])) {
      this.message = 'neither the microphone nor system audio could be opened'
      void this.stop()
      return
    }
    if (this.phase === 'starting') this.setPhase('recording')
    else this.emitState()
  }

  /** One frame of 16 kHz mono Float32 from one channel. */
  frame(session: number, channel: Channel, samples: Float32Array, at: number = Date.now()): void {
    if (session !== this.session || !this.recorder) return
    if (this.phase !== 'recording' && this.phase !== 'starting') return

    this.recorder.write(channel, samples, at)
    // Where this channel begins in the merged file. The merge pads the later
    // channel by exactly this, so a segment's timestamp and the sound it came
    // from stay the same moment.
    const base = Math.max(0, at - (this.startedAt ?? at))
    this.transcriber?.push(channel, samples, base)
    this.levels[channel] = meterLevel(rms(samples))
    this.lastFrameAt[channel] = at
  }

  /** Ask for the meeting to end. The merge happens once the streams are shut. */
  requestStop(): void {
    if (this.phase !== 'starting' && this.phase !== 'recording') return
    this.setPhase('stopping')
    this.closeTimer = setTimeout(() => {
      // The window never confirmed. Merge regardless: the audio matters more
      // than the handshake.
      void this.stop()
    }, CLOSE_GRACE_MS)
  }

  /** The renderer has closed both streams. */
  captureClosed(session: number): void {
    if (session !== this.session) return
    void this.stop()
  }

  /** Flush, merge, and return to idle. Safe to call more than once. */
  async stop(at: number = Date.now()): Promise<MergeResult | null> {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    const recorder = this.recorder
    if (!recorder) {
      if (this.phase !== 'idle') this.setPhase('idle')
      return null
    }

    this.recorder = null
    const transcriber = this.transcriber
    this.transcriber = null
    const meetingId = this.meetingId
    this.meetingId = null
    this.setPhase('merging')

    // Both at once. The merge is disk-bound and the transcript tail is waiting
    // on a model, so running them in sequence would add one to the other for no
    // reason - and the tail of a meeting is where the decisions usually are.
    const [merged, transcribed] = await Promise.allSettled([
      recorder.stop(at),
      transcriber?.finish() ?? Promise.resolve(),
    ])

    let result: MergeResult | null = null
    if (merged.status === 'fulfilled') result = merged.value
    else this.message = `the recording could not be merged: ${describe(merged.reason)}`
    if (transcribed.status === 'rejected') {
      // The audio is safe either way, and it can be transcribed again later.
      console.warn('[meeting] the transcript tail failed:', transcribed.reason)
    }

    if (meetingId !== null && this.deps.store) {
      try {
        this.deps.store.finish(meetingId, {
          endedAt: at,
          audioPath: result?.path ?? null,
          durationMs: result?.durationMs ?? 0,
        })
      } catch (err) {
        console.warn('[meeting] could not close the meeting row:', err)
      }
    }

    this.startedAt = null
    this.setPhase('idle')
    if (result) this.emit('recorded', result)
    return result
  }

  state(now: number = Date.now()): MeetingState {
    const snapshot = this.recorder?.snapshot() ?? []
    const stats = this.transcriber?.stats()
    return {
      phase: this.phase,
      sessionId: this.session,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? Math.max(0, now - this.startedAt) : 0,
      meetingId: this.meetingId,
      transcript: {
        segments: stats?.segments ?? 0,
        queued: stats?.queued ?? 0,
        failed: stats?.chunksFailed ?? 0,
        live: this.transcriber !== null,
      },
      channels: CHANNELS.map((channel) => {
        const fresh = now - this.lastFrameAt[channel] < STALE_MS
        return {
          channel,
          live: this.lastFrameAt[channel] > 0 && fresh,
          samples: snapshot.find((r) => r.channel === channel)?.samples ?? 0,
          // A meter that keeps showing the last level after the audio stops is
          // worse than one showing nothing: it says "still listening".
          level: fresh ? this.levels[channel] : 0,
          problem: this.problems[channel],
        }
      }),
      message: this.message,
    }
  }

  /**
   * Merge anything left behind by a previous run, at startup.
   *
   * A session directory holding checkpoints and no `audio.wav` is exactly one
   * that never finished, so there is no flag to consult and nothing to get out
   * of step. This runs the same merge a clean stop runs.
   *
   * @returns how many were recovered.
   */
  async recoverAbandoned(): Promise<number> {
    let recovered = 0
    for (const dir of abandonedSessions(this.root)) {
      try {
        const result = await mergeSession(dir)
        if (result) {
          recovered++
          this.emit('recorded', result)
          console.log(
            `[meeting] recovered ${Math.round(result.durationMs / 1000)}s from ${dir}` +
              (result.recoveredWithoutManifest ? ' (no manifest; channels aligned at zero)' : '')
          )
        }
      } catch (err) {
        // One unreadable session must not stop the app, or a single bad
        // directory becomes a launch failure forever.
        console.warn(`[meeting] could not recover ${dir}:`, err)
      }
    }
    return recovered
  }

  /**
   * Segments, as they close.
   *
   * Written during the meeting rather than batched at the end, so a crash costs
   * the tail rather than the whole transcript - the same trade the audio
   * checkpoints make.
   */
  private record(segments: Segment[]): void {
    if (segments.length === 0) return
    if (this.meetingId !== null && this.deps.store) {
      try {
        this.deps.store.addSegments(this.meetingId, segments)
      } catch (err) {
        console.warn('[meeting] could not save segments:', err)
      }
    }
    this.emit('segments', segments)
    this.emitState()
  }

  private setPhase(phase: MeetingPhase): void {
    this.phase = phase
    this.emitState()
  }

  private emitState(): void {
    this.emit('state', this.state())
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
