// Reading WAV files, for the benchmarks.
//
// Extracted from bench-asr so the end-to-end bench reads audio the same way.
// Two decoders drifting apart would make two benchmarks incomparable, which is
// the one thing a benchmark cannot afford.

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** Decode a RIFF/WAVE file to the Float32 our pipeline uses everywhere. */
export async function readWav(file) {
  const buf = await readFile(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path.basename(file)} is not a RIFF/WAVE file`)
  }

  // Walk the chunk list rather than assuming a 44-byte header: real-world wavs
  // carry LIST/INFO and fact chunks before the data.
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, body + size)
    }
    offset = body + size + (size % 2) // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error(`${path.basename(file)}: missing fmt or data chunk`)
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`${path.basename(file)}: expected 16-bit PCM, got format ${fmt.format}/${fmt.bits}-bit`)
  }

  // Downmix to mono; whisper wants one channel.
  const frames = Math.floor(data.length / 2 / fmt.channels)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2)
    out[i] = sum / fmt.channels / 32768
  }
  return { pcm: out, sampleRate: fmt.sampleRate }
}

/** Naive linear resample. Fine for a benchmark; capture will deliver 16k directly. */
export function resampleTo16k(pcm, from) {
  if (from === 16_000) return pcm
  const ratio = from / 16_000
  const out = new Float32Array(Math.floor(pcm.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio
    const a = Math.floor(src)
    const b = Math.min(a + 1, pcm.length - 1)
    const t = src - a
    out[i] = (pcm[a] ?? 0) * (1 - t) + (pcm[b] ?? 0) * t
  }
  return out
}
