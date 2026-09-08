#!/usr/bin/env node
// Spike V2: measure real ASR latency and VRAM against a running whisper-server.
//
//   node scripts/bench-asr.mjs [file.wav ...]
//
// With no arguments it runs every wav in fixtures/. Reports per-file latency,
// realtime factor, and the VRAM the process actually holds, because the spec's
// numbers were estimates and the whole point of a spike is to replace them.

import { readdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { WhisperCppClient } from '../packages/asr/src/client.js'
import { V1_ROOT, exists, heading } from './lib/fetch-util.mjs'

const execFileAsync = promisify(execFile)
const BASE_URL = process.env.WHISPER_URL ?? 'http://127.0.0.1:8178'
const MODEL = process.env.WHISPER_MODEL ?? 'ggml-large-v3-q5_0'

/** Decode a RIFF/WAVE file to the Float32 our pipeline uses everywhere. */
async function readWav(file) {
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
function resampleTo16k(pcm, from) {
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

async function gpuUsedMiB() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ])
    const [used, total] = stdout.trim().split(',').map((s) => Number(s.trim()))
    return { used, total }
  } catch {
    return null
  }
}

async function main() {
  const fixturesDir = path.join(V1_ROOT, 'fixtures')
  let files = process.argv.slice(2)
  if (files.length === 0) {
    if (!(await exists(fixturesDir))) throw new Error(`no files given and ${fixturesDir} does not exist`)
    files = (await readdir(fixturesDir))
      .filter((f) => f.toLowerCase().endsWith('.wav'))
      .map((f) => path.join(fixturesDir, f))
  }
  if (files.length === 0) throw new Error('no wav files to benchmark')

  const client = new WhisperCppClient({ baseUrl: BASE_URL, model: MODEL })

  heading('health')
  const h = await client.health()
  console.log(`  ${h.ok ? 'up' : 'DOWN'}  ${BASE_URL}  ${h.detail ?? ''}`)
  if (!h.ok) {
    console.log('\n  start it with:')
    console.log('    ./sidecars/whisper/Release/whisper-server.exe -m ./models/ggml-large-v3-q5_0.bin --host 127.0.0.1 --port 8178')
    process.exit(1)
  }

  const before = await gpuUsedMiB()
  if (before) console.log(`  VRAM in use before: ${before.used} / ${before.total} MiB`)

  heading('transcriptions')
  const rows = []
  for (const file of files) {
    const { pcm, sampleRate } = await readWav(file)
    const audio = resampleTo16k(pcm, sampleRate)

    // Warm the model on the first call so the timings below measure steady
    // state rather than one-off graph/kernel setup.
    if (rows.length === 0) await client.transcribe(audio.subarray(0, 16_000)).catch(() => {})

    const r = await client.transcribe(audio, { language: 'auto' })
    const rtf = r.audioMs / r.latencyMs
    rows.push({ name: path.basename(file), r, rtf })

    console.log(`\n  ${path.basename(file)}`)
    console.log(`    audio ${(r.audioMs / 1000).toFixed(1)}s   asr ${r.latencyMs}ms   ${rtf.toFixed(1)}x realtime   lang=${r.language}`)
    console.log(`    "${r.text.slice(0, 160)}${r.text.length > 160 ? '...' : ''}"`)
  }

  const after = await gpuUsedMiB()

  heading('verdict')
  if (after && before) {
    console.log(`  VRAM: ${before.used} -> ${after.used} MiB of ${after.total}  (whisper holds ~${after.used - before.used} MiB)`)
  }
  const avgRtf = rows.reduce((n, x) => n + x.rtf, 0) / rows.length
  console.log(`  mean ${avgRtf.toFixed(1)}x realtime across ${rows.length} files`)

  // A realtime factor is the WRONG model for whisper.cpp. It processes in
  // 30-second windows, so every clip shorter than that costs roughly the same
  // fixed amount, and dividing by an average rtf wildly overstates short
  // utterances. Fit latency = intercept + slope * seconds instead, which is
  // what the measurements actually look like.
  const n = rows.length
  const xs = rows.map((r) => r.r.audioMs / 1000)
  const ys = rows.map((r) => r.r.latencyMs)
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  const denom = xs.reduce((acc, x) => acc + (x - mx) ** 2, 0)
  const slope = denom > 0 ? xs.reduce((acc, x, i) => acc + (x - mx) * ((ys[i] ?? 0) - my), 0) / denom : 0
  const intercept = my - slope * mx

  console.log(`  fit: latency ~= ${Math.round(intercept)}ms + ${Math.round(slope)}ms per second of audio`)
  for (const secs of [5, 10, 30]) {
    const ms = Math.round(intercept + slope * secs)
    console.log(`    ${String(secs).padStart(2)}s utterance -> ~${ms}ms`)
  }
  const at10 = Math.round(intercept + slope * 10)
  console.log(`  spike V2 budget <1500ms for 10s: ${at10 < 1500 ? 'PASS' : 'FAIL'} (${at10}ms)`)
}

main().catch((err) => {
  console.error(`\nbench failed: ${err.message}`)
  process.exit(1)
})
