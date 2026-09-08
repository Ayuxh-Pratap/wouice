#!/usr/bin/env node
// Spike V3b / V5: run two ASR models over identical audio and print them
// side by side, so the model choice is settled by reading real output rather
// than by reputation.
//
// Expects both servers already running:
//   whisper-server.exe -m ./models/ggml-large-v3-turbo-q5_0.bin --port 8178
//   whisper-server.exe -m ./models/ggml-large-v3-q5_0.bin       --port 8180
//
//   node scripts/compare-asr.mjs                     # every hinglish-*.wav
//   node scripts/compare-asr.mjs fixtures/foo.wav    # specific files
//
// Both models see the same bias prompt built from the seed dictionary, because
// comparing one with a glossary against one without would not be a fair test.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WhisperCppClient } from '../packages/asr/src/client.ts'
import { biasPrompt } from '../packages/dictionary/src/bias.ts'
import { correct } from '../packages/dictionary/src/corrector.ts'
import { SEED_DICTIONARY } from '../packages/dictionary/src/seed.ts'
import { V1_ROOT, exists, heading } from './lib/fetch-util.mjs'

const MODELS = [
  { key: 'turbo', label: 'large-v3-turbo', url: 'http://127.0.0.1:8178' },
  { key: 'large', label: 'large-v3', url: 'http://127.0.0.1:8180' },
]

/** Minimal RIFF/WAVE reader. Our recorder writes 16 kHz mono 16-bit already. */
async function readWav(file) {
  const buf = await readFile(file)
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4) }
    } else if (id === 'data') data = buf.subarray(body, body + size)
    offset = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error(`${path.basename(file)}: not a usable wav`)
  const frames = Math.floor(data.length / 2 / fmt.channels)
  const pcm = new Float32Array(frames)
  for (let i = 0; i < frames; i++) pcm[i] = data.readInt16LE(i * fmt.channels * 2) / 32768
  return { pcm, sampleRate: fmt.sampleRate }
}

function wrap(text, indent) {
  const width = 88 - indent
  const pad = ' '.repeat(indent)
  const words = text.split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim())
      line = w
    } else line += ' ' + w
  }
  if (line.trim()) lines.push(line.trim())
  return lines.map((l) => pad + l).join('\n')
}

async function main() {
  const fixtures = path.join(V1_ROOT, 'fixtures')
  let files = process.argv.slice(2)
  if (files.length === 0) {
    files = (await readdir(fixtures))
      .filter((f) => /^hinglish-.*\.wav$/i.test(f))
      .sort()
      .map((f) => path.join(fixtures, f))
  }
  if (files.length === 0) throw new Error('no hinglish-*.wav files in fixtures/')

  const prompt = biasPrompt(SEED_DICTIONARY)
  const clients = MODELS.map((m) => ({
    ...m,
    client: new WhisperCppClient({ baseUrl: m.url, model: m.label }),
  }))

  heading('health')
  for (const c of clients) {
    const h = await c.client.health()
    console.log(`  ${h.ok ? 'up  ' : 'DOWN'}  ${c.label.padEnd(16)} ${c.url}`)
    if (!h.ok) {
      console.log(`\n  start it:  ./sidecars/whisper/Release/whisper-server.exe -m ./models/ggml-${c.label}-q5_0.bin --host 127.0.0.1 --port ${new URL(c.url).port}`)
      process.exit(1)
    }
  }
  console.log(`\n  bias prompt (${prompt.length} chars): ${prompt.slice(0, 100)}...`)

  const stats = Object.fromEntries(MODELS.map((m) => [m.key, { ms: [], langs: {} }]))
  const report = []

  for (const file of files) {
    const { pcm } = await readWav(file)
    const name = path.basename(file, '.wav')
    console.log(`\n${'='.repeat(88)}\n${name}   ${(pcm.length / 16000).toFixed(1)}s\n${'='.repeat(88)}`)

    const entry = { file: name, seconds: +(pcm.length / 16000).toFixed(1), models: {} }

    for (const c of clients) {
      const r = await c.client.transcribe(pcm, { language: 'auto', prompt })
      const fixed = correct(r.text, SEED_DICTIONARY)
      stats[c.key].ms.push(r.latencyMs)
      stats[c.key].langs[r.language] = (stats[c.key].langs[r.language] ?? 0) + 1

      console.log(`\n  ${c.label}  ${r.latencyMs}ms  lang=${r.language}`)
      console.log(wrap(r.text || '(empty)', 4))
      if (fixed.applied.length) {
        console.log(`    dictionary: ${fixed.applied.map((a) => `${a.from}->${a.to}`).join(', ')}`)
      }
      entry.models[c.key] = {
        text: r.text,
        latencyMs: r.latencyMs,
        language: r.language,
        afterDictionary: fixed.text,
        applied: fixed.applied,
      }
    }
    report.push(entry)
  }

  heading('summary')
  for (const m of MODELS) {
    const s = stats[m.key]
    const mean = Math.round(s.ms.reduce((a, b) => a + b, 0) / s.ms.length)
    const langs = Object.entries(s.langs).map(([k, v]) => `${k}x${v}`).join(' ')
    console.log(`  ${m.label.padEnd(16)} mean ${String(mean).padStart(5)}ms   detected: ${langs}`)
  }

  const out = path.join(V1_ROOT, 'fixtures', 'comparison.json')
  await writeFile(out, JSON.stringify(report, null, 2) + '\n')
  console.log(`\n  full transcripts written to ${path.relative(process.cwd(), out)}`)
  console.log('\n  Read the transcripts above. The question is not which is faster')
  console.log('  (turbo is, by a lot) but whether large-v3 understands your Hindi')
  console.log('  meaningfully better. If they are close, turbo wins on speed and VRAM.')
}

main().catch((err) => {
  console.error(`\ncompare failed: ${err.message}`)
  process.exit(1)
})
