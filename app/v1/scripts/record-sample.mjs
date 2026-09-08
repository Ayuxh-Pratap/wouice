#!/usr/bin/env node
// Record a voice sample straight into the format the pipeline uses.
//
//   node scripts/record-sample.mjs                 # 10s, default mic
//   node scripts/record-sample.mjs hinglish-01 12  # named, 12 seconds
//   node scripts/record-sample.mjs --list          # show microphones
//   node scripts/record-sample.mjs --device "Headset (SpinBot Ranger HX300)" ...
//
// Writes 16 kHz mono 16-bit WAV into fixtures/, which is exactly what capture
// will deliver at runtime, so a benchmark on these files measures the real
// thing rather than a resampled approximation.
//
// This exists for spike V5: measuring Hinglish accuracy needs YOUR voice, your
// microphone and your room. Public English samples cannot answer it.

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { V1_ROOT, sizeOf, fmtBytes } from './lib/fetch-util.mjs'

const FIXTURES = path.join(V1_ROOT, 'fixtures')

function run(args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    let out = ''
    if (capture) {
      p.stdout?.on('data', (d) => (out += d))
      p.stderr?.on('data', (d) => (out += d))
    }
    p.on('error', () => resolve({ code: -1, out: 'ffmpeg not found on PATH' }))
    p.on('close', (code) => resolve({ code, out }))
  })
}

async function listDevices() {
  const { out } = await run(['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { capture: true })
  const names = [...out.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((n) => n && !n.startsWith('@device'))
  console.log('Input devices ffmpeg can see:\n')
  for (const n of names) console.log(`  ${n}`)
  console.log('\nPick one with --device "exact name"')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--list')) return listDevices()

  const di = argv.indexOf('--device')
  const device = di !== -1 ? argv[di + 1] : 'Microphone Array (Realtek(R) Audio)'
  const rest = argv.filter((a, i) => a !== '--device' && i !== di + 1)

  const name = rest[0] ?? `sample-${Date.now()}`
  const seconds = Number(rest[1] ?? 10)

  await mkdir(FIXTURES, { recursive: true })
  const dest = path.join(FIXTURES, `${name}.wav`)

  console.log(`Recording ${seconds}s from: ${device}`)
  console.log(`  -> ${path.relative(process.cwd(), dest)}`)
  console.log('\n  Speak now. Ctrl+C stops early and still keeps the file.\n')

  // -ar 16000 -ac 1 gives us the internal format directly, so no resampling
  // step sits between the microphone and what we benchmark.
  const { code } = await run([
    '-hide_banner', '-loglevel', 'warning',
    '-f', 'dshow',
    '-i', `audio=${device}`,
    '-t', String(seconds),
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    '-y', dest,
  ])

  const bytes = await sizeOf(dest)
  if (code !== 0 && bytes === 0) {
    console.error('\nRecording failed and produced nothing.')
    console.error('Run with --list to see the exact device names.')
    process.exit(1)
  }
  console.log(`\nSaved ${fmtBytes(bytes)}  (~${(bytes / 32_000).toFixed(1)}s of 16 kHz mono)`)
  console.log('\nBenchmark it with:')
  console.log(`  npx tsx scripts/bench-asr.mjs "${dest}"`)
}

main().catch((err) => {
  console.error(`\nrecord failed: ${err.message}`)
  process.exit(1)
})
