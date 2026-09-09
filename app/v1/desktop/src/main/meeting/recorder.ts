import { renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { mergeSession, sessionDir, CHECKPOINT_DIR, MANIFEST_NAME, type MergeResult } from './merge.js'
import {
  checkpointName,
  emptyRecord,
  CHANNELS,
  CHECKPOINT_SAMPLES,
  MEETING_SAMPLE_RATE,
  type Channel,
  type ChannelRecord,
  type Manifest,
} from './session.js'

/**
 * Two channels of audio, onto disk, in a way that survives the app dying.
 *
 * NO ELECTRON IMPORTS, DELIBERATELY. This is plain Node against a directory, so
 * an hour of recording and a crash halfway through it can both be tested
 * without a window, a microphone, or a meeting. That property is the reason
 * criteria B2 and B3 are checkable at all; the moment this reaches for `app` it
 * stops being testable and starts being something you verify by having another
 * meeting.
 *
 * WHAT A CRASH COSTS. Frames accumulate in memory and land as a ~30 second
 * checkpoint file, so an unclean death loses at most the tail since the last
 * rotation. The manifest is rewritten on every rotation rather than at the end,
 * because a manifest written only on a clean stop is precisely the one thing
 * that is missing after an unclean one - and it holds the wall-clock anchors
 * the merge needs to line the channels up.
 */
export class MeetingRecorder {
  readonly dir: string
  private readonly checkpointDir: string
  private readonly startedAt: number
  private readonly sampleRate: number

  private readonly records: Record<Channel, ChannelRecord>
  private readonly pending: Record<Channel, Float32Array>
  private readonly filled: Record<Channel, number>
  private stopped = false

  constructor(root: string, startedAt: number = Date.now(), sampleRate = MEETING_SAMPLE_RATE) {
    this.startedAt = startedAt
    this.sampleRate = sampleRate
    this.dir = sessionDir(root, startedAt)
    this.checkpointDir = path.join(this.dir, CHECKPOINT_DIR)

    this.records = { me: emptyRecord('me'), them: emptyRecord('them') }
    this.pending = {
      me: new Float32Array(CHECKPOINT_SAMPLES),
      them: new Float32Array(CHECKPOINT_SAMPLES),
    }
    this.filled = { me: 0, them: 0 }
    this.writeManifest(null)
  }

  /**
   * One frame of 16 kHz mono Float32 from one channel.
   *
   * `at` is when the frame ARRIVED, and it is stamped per frame rather than
   * inferred from a sample count, because inferring it is what makes clock
   * drift invisible. The first stamp is the channel's anchor; the last is what
   * makes the drift measurable at the end.
   */
  write(channel: Channel, frame: Float32Array, at: number = Date.now()): void {
    if (this.stopped || frame.length === 0) return

    const record = this.records[channel]
    if (record.firstFrameEpochMs === null) record.firstFrameEpochMs = at
    record.lastFrameEpochMs = at
    record.samples += frame.length

    let offset = 0
    while (offset < frame.length) {
      const room = CHECKPOINT_SAMPLES - this.filled[channel]
      const take = Math.min(room, frame.length - offset)
      this.pending[channel].set(frame.subarray(offset, offset + take), this.filled[channel])
      this.filled[channel] += take
      offset += take
      if (this.filled[channel] === CHECKPOINT_SAMPLES) this.rotate(channel)
    }
  }

  /**
   * Flush what is buffered, record the end, and merge.
   *
   * The merge is called from here so that a clean stop and a crash recovery run
   * literally the same function - `mergeSession` - rather than two things that
   * are meant to agree.
   */
  async stop(at: number = Date.now()): Promise<MergeResult | null> {
    if (this.stopped) return null
    this.stopped = true
    for (const channel of CHANNELS) this.rotate(channel)
    this.writeManifest(at)
    return mergeSession(this.dir)
  }

  /** What each channel has delivered so far. For the live UI and diagnostics. */
  snapshot(): ChannelRecord[] {
    return CHANNELS.map((channel) => ({ ...this.records[channel] }))
  }

  /* ------------------------------------------------------------------ */

  private rotate(channel: Channel): void {
    const count = this.filled[channel]
    if (count === 0) return

    const record = this.records[channel]
    const name = checkpointName(channel, record.checkpoints)
    const samples = this.pending[channel].subarray(0, count)

    try {
      // A partial file is readable - the merge floors to whole floats - but a
      // partial file that the manifest has already counted is not, so the
      // write comes before the count goes up.
      writeFileSync(path.join(this.checkpointDir, name), Buffer.from(samples.buffer, samples.byteOffset, count * 4))
      record.checkpoints++
    } catch {
      // Losing a checkpoint costs thirty seconds of one channel. Throwing here
      // would end the meeting, which costs all of it.
    }

    this.filled[channel] = 0
    this.writeManifest(null)
  }

  /**
   * Rewritten whole, through a temp file and a rename.
   *
   * Atomic because the alternative is a crash landing in the middle of the
   * write and leaving truncated JSON, which the merge would reject - turning a
   * recoverable session into an unaligned one for no reason.
   */
  private writeManifest(endedAt: number | null): void {
    const manifest: Manifest = {
      version: 1,
      sampleRate: this.sampleRate,
      startedAt: this.startedAt,
      endedAt,
      channels: CHANNELS.map((channel) => ({ ...this.records[channel] })),
    }
    const target = path.join(this.dir, MANIFEST_NAME)
    const temp = `${target}.part`
    try {
      writeFileSync(temp, JSON.stringify(manifest, null, 2))
      renameSync(temp, target)
    } catch {
      // The merge degrades to zero-offset alignment without it, and says so.
    }
  }
}
