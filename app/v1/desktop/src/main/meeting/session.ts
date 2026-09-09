/**
 * What a recorded meeting is on disk, and the arithmetic that reassembles it.
 *
 * PURE ON PURPOSE. Everything here is naming, parsing and arithmetic, with no
 * filesystem anywhere, so the two things that decide whether a recording is
 * usable - where the channels sit relative to each other, and whether their
 * clocks stayed together - can be tested without recording anything. The
 * effectful halves are `recorder.ts` and `merge.ts`.
 *
 * THE LAYOUT.
 *
 *   <session>/
 *     manifest.json          rewritten on every rotation, never only at the end
 *     checkpoints/
 *       me-0000.f32          raw Float32, ~30s each
 *       them-0000.f32
 *       ...
 *     audio.wav              written by the merge, and only by the merge
 *
 * A directory holding `checkpoints/` and no `audio.wav` is exactly a session
 * that never finished. That is the whole crash-recovery design: there is no
 * separate "was it interrupted" flag to get out of step with reality.
 */

export const MEETING_SAMPLE_RATE = 16_000

/**
 * Seconds of audio per checkpoint file, which is also the most a crash can
 * cost. Thirty seconds is ~1.9 MB per channel held in memory before it lands.
 */
export const CHECKPOINT_SECONDS = 30
export const CHECKPOINT_SAMPLES = CHECKPOINT_SECONDS * MEETING_SAMPLE_RATE

/** `me` is the microphone, `them` is the system channel. */
export type Channel = 'me' | 'them'
export const CHANNELS: readonly Channel[] = ['me', 'them']

export function isChannel(value: string): value is Channel {
  return value === 'me' || value === 'them'
}

/**
 * What one channel did, recorded as it happens rather than reconstructed.
 *
 * `firstFrameEpochMs` is the anchor the merge aligns on. The other three exist
 * so drift is MEASURABLE: with the sample count and both endpoints, the
 * channel's effective rate falls out, and the two channels can be compared
 * against each other rather than assumed to agree.
 */
export interface ChannelRecord {
  channel: Channel
  /** Wall clock when the first frame arrived. Null until one does. */
  firstFrameEpochMs: number | null
  /** Wall clock when the most recent frame arrived. */
  lastFrameEpochMs: number | null
  /** Total samples delivered, including any still buffered. */
  samples: number
  /** Checkpoint files written so far. */
  checkpoints: number
}

export interface Manifest {
  version: 1
  sampleRate: number
  startedAt: number
  /** Null means the session never reached a clean stop. */
  endedAt: number | null
  channels: ChannelRecord[]
}

export function emptyRecord(channel: Channel): ChannelRecord {
  return { channel, firstFrameEpochMs: null, lastFrameEpochMs: null, samples: 0, checkpoints: 0 }
}

/* ------------------------------------------------------------- naming ---- */

/** Zero-padded so lexical order is chronological order for a whole day of it. */
export function checkpointName(channel: Channel, index: number): string {
  return `${channel}-${String(index).padStart(5, '0')}.f32`
}

export function parseCheckpointName(name: string): { channel: Channel; index: number } | null {
  const match = /^(me|them)-(\d{1,10})\.f32$/.exec(name)
  if (!match) return null
  const channel = match[1]!
  const index = Number(match[2])
  if (!isChannel(channel) || !Number.isFinite(index)) return null
  return { channel, index }
}

/**
 * Checkpoints per channel, in the order they were written.
 *
 * Sorted numerically rather than lexically. Padding makes the two agree today
 * and a longer meeting than the padding allows for would silently reorder the
 * audio, which is the kind of bug that shows up as a transcript that makes no
 * sense an hour in.
 */
export function groupCheckpoints(names: readonly string[]): Record<Channel, string[]> {
  const parsed = names
    .map((name) => ({ name, meta: parseCheckpointName(name) }))
    .filter((entry): entry is { name: string; meta: { channel: Channel; index: number } } =>
      entry.meta !== null
    )
    .sort((a, b) => a.meta.index - b.meta.index)

  return {
    me: parsed.filter((e) => e.meta.channel === 'me').map((e) => e.name),
    them: parsed.filter((e) => e.meta.channel === 'them').map((e) => e.name),
  }
}

/* --------------------------------------------------------------- plan ---- */

export interface MergePlan {
  /** Samples of silence in front of each channel. */
  offsets: Record<Channel, number>
  /** Length of the merged file, in frames. */
  frames: number
  /** Epoch the merged file starts at, which the transcript aligns to. */
  startEpochMs: number
}

/**
 * Where each channel sits in the merged file.
 *
 * The two channels do not start together: the microphone is usually up first
 * because the loopback stream has a display-media request to get through. The
 * earlier one defines zero and the later one is pushed back by the difference,
 * which is the only thing that makes a segment's `start_ms` mean the same thing
 * on both channels.
 *
 * A channel that delivered nothing is not an error. One-sided meetings are
 * real - a call on headphones with your mic muted is exactly that - and the
 * merge should produce a lopsided file rather than refuse.
 */
export function planMerge(
  records: readonly ChannelRecord[],
  lengths: Record<Channel, number>,
  sampleRate: number = MEETING_SAMPLE_RATE
): MergePlan {
  const starts = records
    .filter((r) => r.firstFrameEpochMs !== null && lengths[r.channel] > 0)
    .map((r) => r.firstFrameEpochMs!)

  const baseline = starts.length ? Math.min(...starts) : 0
  const offsets: Record<Channel, number> = { me: 0, them: 0 }

  for (const record of records) {
    const first = record.firstFrameEpochMs
    if (first === null || lengths[record.channel] === 0) continue
    offsets[record.channel] = Math.max(0, Math.round(((first - baseline) / 1000) * sampleRate))
  }

  const frames = Math.max(
    0,
    ...CHANNELS.map((channel) => offsets[channel] + (lengths[channel] ?? 0))
  )

  return { offsets, frames, startEpochMs: baseline }
}

/* -------------------------------------------------------------- drift ---- */

export interface Drift {
  /** Samples actually delivered per second of wall clock. */
  effectiveRate: number
  /** Deviation from nominal, in parts per million. Signed. */
  ppm: number
  /**
   * How far the channel's audio clock has wandered from the wall clock over
   * the session, in milliseconds. Positive means the audio runs long.
   */
  driftMs: number
  /** Wall-clock seconds the figure is based on. Short spans mean little. */
  elapsedSec: number
}

/**
 * Whether a channel's clock kept time.
 *
 * WHY THIS IS MEASURED RATHER THAN ASSUMED. The two channels are driven by
 * different hardware clocks - the capture device's and the render device's -
 * and Chromium resamples both to 16 kHz independently. Nothing guarantees they
 * agree, and the failure is invisible for the first few minutes: alignment that
 * is right at minute zero and a second out at minute sixty still looks perfect
 * in every short test.
 *
 * The reference implementations we studied align the two START epochs and stop
 * there, which cannot see this at all. Measuring costs one subtraction and
 * tells us whether a resampler is needed, which is much better than building
 * one on suspicion.
 */
export function driftOf(
  record: ChannelRecord,
  sampleRate: number = MEETING_SAMPLE_RATE
): Drift | null {
  const { firstFrameEpochMs: first, lastFrameEpochMs: last } = record
  if (first === null || last === null || record.samples === 0) return null

  const elapsedSec = (last - first) / 1000
  // The last frame's arrival marks its START, so the audio runs one frame
  // longer than the span between the first and last arrivals. Under a second
  // of wall clock that correction is the same size as the measurement, and the
  // answer would be noise either way.
  if (elapsedSec < 1) return null

  const effectiveRate = record.samples / elapsedSec
  return {
    effectiveRate,
    ppm: ((effectiveRate - sampleRate) / sampleRate) * 1_000_000,
    driftMs: (record.samples / sampleRate) * 1000 - elapsedSec * 1000,
    elapsedSec,
  }
}

/**
 * How far apart the two channels end up by the end of the session.
 *
 * This is the number acceptance criterion B2 is about. Each channel drifting
 * equally is harmless - the pair still line up with each other - so what
 * matters is the difference between them, not either one against the wall
 * clock. Null when either channel has too little to say.
 */
export function channelSkewMs(
  records: readonly ChannelRecord[],
  sampleRate: number = MEETING_SAMPLE_RATE
): number | null {
  const me = records.find((r) => r.channel === 'me')
  const them = records.find((r) => r.channel === 'them')
  if (!me || !them) return null

  const a = driftOf(me, sampleRate)
  const b = driftOf(them, sampleRate)
  if (!a || !b) return null

  return a.driftMs - b.driftMs
}
