import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { abandonedSessions, mergeSession, AUDIO_NAME, CHECKPOINT_DIR } from './merge.js'
import { MeetingRecorder } from './recorder.js'
import { CHECKPOINT_SAMPLES, MEETING_SAMPLE_RATE } from './session.js'

/**
 * Stage 1 end to end, against a real directory.
 *
 * These are the checks that stand in for acceptance criteria B2 and B3, and
 * they only exist because the recorder has no Electron in it. Verifying the
 * same properties through the app would mean holding a meeting, crashing it on
 * purpose, and listening to the result - once per change.
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wouice-meeting-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

interface DecodedWav {
  channels: number
  sampleRate: number
  frames: number
  left: Float32Array
  right: Float32Array
}

function readWav(file: string): DecodedWav {
  const raw = readFileSync(file)
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  expect(String.fromCharCode(...raw.subarray(0, 4))).toBe('RIFF')
  expect(String.fromCharCode(...raw.subarray(8, 12))).toBe('WAVE')

  const channels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const dataBytes = view.getUint32(40, true)
  const frames = dataBytes / (channels * 2)

  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    left[i] = view.getInt16(44 + i * channels * 2, true) / 32767
    right[i] = channels === 2 ? view.getInt16(44 + i * 4 + 2, true) / 32767 : 0
  }
  return { channels, sampleRate, frames, left, right }
}

const filled = (n: number, value: number): Float32Array => new Float32Array(n).fill(value)

describe('a clean stop', () => {
  it('writes one stereo file with you on the left and them on the right', async () => {
    const recorder = new MeetingRecorder(root, 1_000_000)
    recorder.write('me', filled(16_000, 0.5), 1_000_000)
    recorder.write('them', filled(16_000, -0.25), 1_000_000)

    const result = await recorder.stop(1_001_000)
    expect(result).not.toBeNull()

    const wav = readWav(result!.path)
    expect(wav.channels).toBe(2)
    expect(wav.sampleRate).toBe(MEETING_SAMPLE_RATE)
    expect(wav.frames).toBe(16_000)
    expect(wav.left[8_000]).toBeCloseTo(0.5, 3)
    expect(wav.right[8_000]).toBeCloseTo(-0.25, 3)
    expect(result!.durationMs).toBe(1000)
  })

  it('pads the channel that started later, so the two line up', async () => {
    const recorder = new MeetingRecorder(root, 2_000_000)
    // The microphone is up first; the loopback stream has a display-media
    // request to get through before it delivers anything.
    recorder.write('me', filled(16_000, 0.5), 2_000_000)
    recorder.write('them', filled(16_000, -0.25), 2_000_500)

    const result = await recorder.stop(2_001_500)
    const wav = readWav(result!.path)

    // 500 ms of silence on the right, then the far side.
    expect(wav.right[100]).toBe(0)
    expect(wav.right[7_999]).toBe(0)
    expect(wav.right[8_100]).toBeCloseTo(-0.25, 3)
    expect(wav.frames).toBe(24_000)
    expect(result!.startEpochMs).toBe(2_000_000)
  })

  it('clears the checkpoints, which is what marks it finished', async () => {
    const recorder = new MeetingRecorder(root, 3_000_000)
    recorder.write('me', filled(8_000, 0.1), 3_000_000)
    const result = await recorder.stop(3_000_500)

    expect(existsSync(result!.path)).toBe(true)
    expect(existsSync(path.join(recorder.dir, CHECKPOINT_DIR))).toBe(false)
    expect(abandonedSessions(root)).toEqual([])
  })

  it('records an empty meeting as nothing rather than an empty file', async () => {
    const recorder = new MeetingRecorder(root, 4_000_000)
    expect(await recorder.stop(4_000_100)).toBeNull()
    expect(existsSync(path.join(recorder.dir, AUDIO_NAME))).toBe(false)
  })

  it('survives one channel never delivering a frame', async () => {
    // Your mic muted for the whole call is a real session, not a failure.
    const recorder = new MeetingRecorder(root, 5_000_000)
    recorder.write('them', filled(16_000, 0.4), 5_000_000)
    const result = await recorder.stop(5_001_000)

    const wav = readWav(result!.path)
    expect(wav.left[100]).toBe(0)
    expect(wav.right[100]).toBeCloseTo(0.4, 3)
  })
})

describe('rotation', () => {
  it('lands a checkpoint every 30 seconds, bounding what a crash costs', () => {
    const recorder = new MeetingRecorder(root, 6_000_000)
    recorder.write('me', filled(CHECKPOINT_SAMPLES * 2 + 5_000, 0.2), 6_000_000)

    const files = readdirSync(path.join(recorder.dir, CHECKPOINT_DIR))
    expect(files.filter((f) => f.startsWith('me-'))).toEqual(['me-00000.f32', 'me-00001.f32'])
    // The remaining 5000 samples are still in memory: that is the exposure.
    expect(recorder.snapshot().find((r) => r.channel === 'me')!.samples).toBe(
      CHECKPOINT_SAMPLES * 2 + 5_000
    )
  })

  it('keeps the manifest current as it goes, not only at the end', () => {
    const recorder = new MeetingRecorder(root, 7_000_000)
    recorder.write('me', filled(CHECKPOINT_SAMPLES, 0.2), 7_000_000)

    const manifest = JSON.parse(readFileSync(path.join(recorder.dir, 'manifest.json'), 'utf8'))
    expect(manifest.endedAt).toBeNull()
    expect(manifest.channels.find((c: { channel: string }) => c.channel === 'me').checkpoints).toBe(1)
  })

  it('crosses the merge block boundary correctly', async () => {
    // The merge walks both channels in blocks. Two and a half of them exercises
    // a partial final block, which is where an off-by-one would live.
    const recorder = new MeetingRecorder(root, 8_000_000)
    const total = CHECKPOINT_SAMPLES * 2 + 12_345
    recorder.write('me', filled(total, 0.5), 8_000_000)
    recorder.write('them', filled(total, -0.5), 8_000_000)

    const result = await recorder.stop(8_060_000)
    const wav = readWav(result!.path)
    expect(wav.frames).toBe(total)
    expect(wav.left[total - 1]).toBeCloseTo(0.5, 3)
    expect(wav.right[total - 1]).toBeCloseTo(-0.5, 3)
  })
})

describe('a session that never finished', () => {
  it('is found by having checkpoints and no audio', () => {
    const recorder = new MeetingRecorder(root, 9_000_000)
    recorder.write('me', filled(CHECKPOINT_SAMPLES, 0.3), 9_000_000)
    // No stop(): the process died here.
    expect(abandonedSessions(root)).toEqual([recorder.dir])
  })

  it('recovers through the same function a clean stop uses', async () => {
    const recorder = new MeetingRecorder(root, 10_000_000)
    recorder.write('me', filled(CHECKPOINT_SAMPLES, 0.3), 10_000_000)
    recorder.write('them', filled(CHECKPOINT_SAMPLES, -0.3), 10_000_000)

    const [abandoned] = abandonedSessions(root)
    const result = await mergeSession(abandoned!)

    const wav = readWav(result!.path)
    expect(wav.frames).toBe(CHECKPOINT_SAMPLES)
    expect(wav.left[1_000]).toBeCloseTo(0.3, 3)
    expect(wav.right[1_000]).toBeCloseTo(-0.3, 3)
    expect(result!.recoveredWithoutManifest).toBe(false)
    expect(abandonedSessions(root)).toEqual([])
  })

  it('loses only the tail since the last rotation', async () => {
    const recorder = new MeetingRecorder(root, 11_000_000)
    recorder.write('me', filled(CHECKPOINT_SAMPLES + 20_000, 0.3), 11_000_000)

    const result = await mergeSession(recorder.dir)
    // The 20,000 unrotated samples are gone; the 480,000 that landed are not.
    expect(result!.frames).toBe(CHECKPOINT_SAMPLES)
  })

  it('still merges when the manifest never got written', async () => {
    const recorder = new MeetingRecorder(root, 12_000_000)
    recorder.write('me', filled(CHECKPOINT_SAMPLES, 0.25), 12_000_000)
    rmSync(path.join(recorder.dir, 'manifest.json'), { force: true })

    const result = await mergeSession(recorder.dir)
    expect(result).not.toBeNull()
    // Flagged rather than silently mis-aligned: without the anchors the two
    // channels are merged at zero, which may be a few hundred ms out.
    expect(result!.recoveredWithoutManifest).toBe(true)
    expect(result!.frames).toBe(CHECKPOINT_SAMPLES)
  })

  it('reads a checkpoint whose last write was cut in half', async () => {
    const recorder = new MeetingRecorder(root, 13_000_000)
    recorder.write('me', filled(CHECKPOINT_SAMPLES, 0.25), 13_000_000)

    // A crash mid-write leaves a trailing fragment of a float.
    const file = path.join(recorder.dir, CHECKPOINT_DIR, 'me-00000.f32')
    const raw = readFileSync(file)
    writeFileSync(file, raw.subarray(0, raw.byteLength - 3))

    const result = await mergeSession(recorder.dir)
    expect(result!.frames).toBe(CHECKPOINT_SAMPLES - 1)
  })
})

describe('drift', () => {
  it('is reported from the merge, not assumed away', async () => {
    const recorder = new MeetingRecorder(root, 14_000_000)
    // 16,000 samples stamped as taking 1,100 ms: a slow clock, exaggerated so
    // the arithmetic is visible.
    recorder.write('me', filled(16_000, 0.2), 14_000_000)
    recorder.write('me', filled(16_000, 0.2), 14_002_200)
    recorder.write('them', filled(32_000, 0.2), 14_000_000)
    recorder.write('them', filled(32_000, 0.2), 14_002_000)

    const result = await recorder.stop(14_002_300)
    expect(result!.drift.me!.ppm).toBeLessThan(0)
    expect(result!.skewMs).not.toBeNull()
    expect(Math.abs(result!.skewMs!)).toBeGreaterThan(100)
  })
})
