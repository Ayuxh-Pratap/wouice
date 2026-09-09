import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { interleaveToPcm16, wavHeader } from '@wouice/asr'
import {
  channelSkewMs,
  driftOf,
  emptyRecord,
  groupCheckpoints,
  planMerge,
  CHANNELS,
  MEETING_SAMPLE_RATE,
  type Channel,
  type ChannelRecord,
  type Drift,
  type Manifest,
} from './session.js'

/**
 * Turn a session directory into one stereo WAV, left = you, right = them.
 *
 * ONE FUNCTION, TWO CALLERS, AND THAT IS THE POINT. A clean stop calls this,
 * and so does crash recovery on a session found with checkpoints and no
 * `audio.wav`. Two implementations would mean the recovery path - the one that
 * only ever runs on a bad day - is the one nobody has exercised.
 *
 * STREAMED, NOT BUFFERED. A one hour meeting is 57.6 million frames per
 * channel. Assembling that in memory costs the better part of a gigabyte to
 * hand straight to the filesystem, so this writes a header and then walks both
 * channels in step, a block at a time, yielding to the event loop between
 * blocks so the app stays responsive while it works.
 */

/** 30 seconds per block: ~3.8 MB of working memory, whatever the length. */
const BLOCK_FRAMES = 30 * MEETING_SAMPLE_RATE

export const MANIFEST_NAME = 'manifest.json'
export const CHECKPOINT_DIR = 'checkpoints'
export const AUDIO_NAME = 'audio.wav'

export interface MergeResult {
  path: string
  frames: number
  durationMs: number
  /** Epoch the file starts at. Segment timings are relative to this. */
  startEpochMs: number
  /** How far the two channels drifted apart. Null when unmeasurable. */
  skewMs: number | null
  drift: Record<Channel, Drift | null>
  /** True when the manifest was missing and the merge worked without it. */
  recoveredWithoutManifest: boolean
}

/* ------------------------------------------------------------- reading ---- */

/** Samples in a checkpoint file, tolerating a write cut short by a crash. */
function samplesInFile(file: string): number {
  try {
    return Math.floor(statSync(file).size / 4)
  } catch {
    return 0
  }
}

function readSamples(file: string): Float32Array {
  const raw = readFileSync(file)
  // A partial write leaves a trailing fragment of a float. Drop it rather than
  // reading three bytes as a number.
  const usable = Math.floor(raw.byteLength / 4) * 4
  const copy = new Uint8Array(usable)
  copy.set(raw.subarray(0, usable))
  return new Float32Array(copy.buffer)
}

/**
 * One channel as a continuous stream: leading silence, then every checkpoint in
 * order, then silence forever.
 *
 * Reading past the end returning silence is what lets the caller ask for a
 * uniform block from both channels without knowing which one ended first.
 */
class ChannelReader {
  private fileIndex = 0
  private buffer: Float32Array | null = null
  private bufferPos = 0

  constructor(
    private readonly dir: string,
    private readonly files: readonly string[],
    private silenceLeft: number
  ) {}

  read(out: Float32Array): void {
    out.fill(0)
    let at = 0

    if (this.silenceLeft > 0) {
      const skipped = Math.min(this.silenceLeft, out.length)
      this.silenceLeft -= skipped
      at += skipped
    }

    while (at < out.length) {
      if (!this.buffer || this.bufferPos >= this.buffer.length) {
        if (this.fileIndex >= this.files.length) return // past the end: silence
        this.buffer = readSamples(path.join(this.dir, this.files[this.fileIndex]!))
        this.bufferPos = 0
        this.fileIndex++
        continue
      }
      const take = Math.min(out.length - at, this.buffer.length - this.bufferPos)
      out.set(this.buffer.subarray(this.bufferPos, this.bufferPos + take), at)
      this.bufferPos += take
      at += take
    }
  }
}

/* ------------------------------------------------------------- merging ---- */

function readManifest(dir: string): Manifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')) as Manifest
    if (!Array.isArray(parsed.channels)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Records to merge by, when the manifest is missing or unreadable.
 *
 * A crash before the first rotation can leave checkpoints with no manifest. The
 * audio is still there and still worth having; what is lost is the wall-clock
 * anchor, so the channels are aligned at zero and the result is flagged. A
 * recording that is a few hundred milliseconds out beats no recording.
 */
function recordsFromFiles(dir: string, grouped: Record<Channel, string[]>): ChannelRecord[] {
  return CHANNELS.map((channel) => ({
    ...emptyRecord(channel),
    firstFrameEpochMs: grouped[channel].length ? 0 : null,
    lastFrameEpochMs: null,
    samples: grouped[channel].reduce((n, f) => n + samplesInFile(path.join(dir, f)), 0),
    checkpoints: grouped[channel].length,
  }))
}

/**
 * @returns null when there is nothing to merge, which is not an error: a
 * session stopped before any audio arrived is simply empty.
 */
export async function mergeSession(dir: string): Promise<MergeResult | null> {
  const checkpointDir = path.join(dir, CHECKPOINT_DIR)
  if (!existsSync(checkpointDir)) return null

  const grouped = groupCheckpoints(readdirSync(checkpointDir))
  const lengths: Record<Channel, number> = { me: 0, them: 0 }
  for (const channel of CHANNELS) {
    lengths[channel] = grouped[channel].reduce(
      (n, f) => n + samplesInFile(path.join(checkpointDir, f)),
      0
    )
  }
  if (lengths.me === 0 && lengths.them === 0) {
    rmSync(checkpointDir, { recursive: true, force: true })
    return null
  }

  const manifest = readManifest(dir)
  const records = manifest?.channels ?? recordsFromFiles(checkpointDir, grouped)
  const sampleRate = manifest?.sampleRate ?? MEETING_SAMPLE_RATE
  const plan = planMerge(records, lengths, sampleRate)

  const readers: Record<Channel, ChannelReader> = {
    me: new ChannelReader(checkpointDir, grouped.me, plan.offsets.me),
    them: new ChannelReader(checkpointDir, grouped.them, plan.offsets.them),
  }

  // Written to a .part and renamed at the end, so a crash mid-merge never
  // leaves a half file that looks finished. The rename is atomic; the presence
  // of `audio.wav` is what "this session completed" means.
  const partial = path.join(dir, `${AUDIO_NAME}.part`)
  const fd = openSync(partial, 'w')
  const left = new Float32Array(BLOCK_FRAMES)
  const right = new Float32Array(BLOCK_FRAMES)

  try {
    writeSync(fd, wavHeader(plan.frames, 2, sampleRate))
    for (let written = 0; written < plan.frames; written += BLOCK_FRAMES) {
      const size = Math.min(BLOCK_FRAMES, plan.frames - written)
      const l = size === BLOCK_FRAMES ? left : left.subarray(0, size)
      const r = size === BLOCK_FRAMES ? right : right.subarray(0, size)
      readers.me.read(l)
      readers.them.read(r)
      writeSync(fd, interleaveToPcm16(l, r))
      // An hour of this is two minutes of tight loop otherwise, and the app has
      // a window to keep painting.
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    closeSync(fd)
  }

  const audioPath = path.join(dir, AUDIO_NAME)
  renameSync(partial, audioPath)
  rmSync(checkpointDir, { recursive: true, force: true })

  return {
    path: audioPath,
    frames: plan.frames,
    durationMs: Math.round((plan.frames / sampleRate) * 1000),
    startEpochMs: plan.startEpochMs,
    skewMs: channelSkewMs(records, sampleRate),
    drift: {
      me: driftOf(records.find((r) => r.channel === 'me') ?? emptyRecord('me'), sampleRate),
      them: driftOf(records.find((r) => r.channel === 'them') ?? emptyRecord('them'), sampleRate),
    },
    recoveredWithoutManifest: manifest === null,
  }
}

/* ------------------------------------------------------------ recovery ---- */

/**
 * Sessions that never finished: a `checkpoints/` directory and no `audio.wav`.
 *
 * There is no "was it interrupted" flag to keep in step with reality, because
 * the layout on disk already says it. Run at startup, hand each to
 * `mergeSession`.
 */
export function abandonedSessions(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    if (existsSync(path.join(dir, CHECKPOINT_DIR)) && !existsSync(path.join(dir, AUDIO_NAME))) {
      found.push(dir)
    }
  }
  return found.sort()
}

export interface RecordedSession {
  dir: string
  path: string
  /** From the manifest when there is one, else the directory name. */
  startedAt: number
  durationMs: number
  bytes: number
}

/**
 * Meetings that finished, newest first.
 *
 * Reads the directory rather than a table on purpose: Stage 1 has no database
 * yet, and the filesystem already holds the truth. When the schema arrives this
 * becomes the thing that reconciles it - a row with no file, or a file with no
 * row, is a real condition worth being able to see.
 */
export function finishedSessions(root: string): RecordedSession[] {
  if (!existsSync(root)) return []
  const out: RecordedSession[] = []

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const audio = path.join(dir, AUDIO_NAME)
    if (!existsSync(audio)) continue

    const manifest = readManifest(dir)
    let bytes = 0
    try {
      bytes = statSync(audio).size
    } catch {
      continue
    }
    const sampleRate = manifest?.sampleRate ?? MEETING_SAMPLE_RATE
    const frames = Math.max(0, (bytes - 44) / 4) // stereo, 16-bit
    out.push({
      dir,
      path: audio,
      startedAt: manifest?.startedAt ?? (Date.parse(entry.name.replace(/-/g, ':')) || 0),
      durationMs: Math.round((frames / sampleRate) * 1000),
      bytes,
    })
  }

  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/** The directory a session records into. Created if it is not there. */
export function sessionDir(root: string, startedAt: number): string {
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
  const dir = path.join(root, stamp)
  mkdirSync(path.join(dir, CHECKPOINT_DIR), { recursive: true })
  return dir
}
