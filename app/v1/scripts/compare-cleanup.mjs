#!/usr/bin/env node
// The decision test: which ASR model yields better ENGLISH after the LLM pass.
//
// Comparing raw Hindi transcripts is the wrong question. The product is the
// final English text, and a slightly garbled Devanagari transcript can still
// produce perfect English if the model recovers the intent. So this runs the
// real cleanup prompt over what each ASR produced and prints the results side
// by side.
//
// Reads fixtures/comparison.json written by compare-asr.mjs, so the ASR servers
// do not need to be running: their VRAM is needed for the LLM.
//
//   node scripts/compare-cleanup.mjs

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { OpenAiCompatClient } from '../packages/llm/src/client.ts'
import { DICTATION_CLEANUP_SYSTEM, isPlausibleCleanup } from '../packages/llm/src/prompts.ts'
import { correct } from '../packages/dictionary/src/corrector.ts'
import { SEED_DICTIONARY } from '../packages/dictionary/src/seed.ts'
import { V1_ROOT, heading } from './lib/fetch-util.mjs'

const LLM_URL = process.env.LLM_URL ?? 'http://127.0.0.1:8179'
const LLM_MODEL = process.env.LLM_MODEL ?? 'qwen3-4b'

function wrap(text, indent) {
  const width = 86 - indent
  const pad = ' '.repeat(indent)
  const out = []
  let line = ''
  for (const w of String(text).split(/\s+/)) {
    if ((line + ' ' + w).trim().length > width) {
      out.push(pad + line.trim())
      line = w
    } else line += ' ' + w
  }
  if (line.trim()) out.push(pad + line.trim())
  return out.join('\n')
}

async function main() {
  const file = path.join(V1_ROOT, 'fixtures', 'comparison.json')
  const rows = JSON.parse(await readFile(file, 'utf8'))

  const llm = new OpenAiCompatClient({
    baseUrl: LLM_URL,
    model: LLM_MODEL,
    label: 'local',
    timeoutMs: 30_000, // generous for a benchmark; production budget is 4s
  })

  heading('llm health')
  const h = await llm.health()
  console.log(`  ${h.ok ? 'up' : 'DOWN'}  ${LLM_URL}  ${h.detail ?? ''}`)
  if (!h.ok) process.exit(1)

  const totals = { turbo: [], large: [] }
  const out = []

  for (const row of rows) {
    console.log(`\n${'='.repeat(86)}\n${row.file}   ${row.seconds}s\n${'='.repeat(86)}`)
    const entry = { file: row.file, models: {} }

    for (const key of ['turbo', 'large']) {
      const asrText = row.models[key]?.text ?? ''
      if (!asrText) continue

      // Dictionary runs BEFORE the LLM so the model sees correct proper nouns
      // and cannot "helpfully" renormalise them.
      const corrected = correct(asrText, SEED_DICTIONARY).text
      const r = await llm.complete({
        system: DICTATION_CLEANUP_SYSTEM,
        user: corrected,
        temperature: 0,
        maxTokens: 512,
      })
      const verdict = isPlausibleCleanup(corrected, r.text)
      totals[key].push(r.latencyMs)

      console.log(`\n  ${key === 'turbo' ? 'turbo   ' : 'large-v3'}  llm ${r.latencyMs}ms${verdict.ok ? '' : `  REJECTED: ${verdict.reason}`}`)
      console.log(wrap(r.text || '(empty)', 4))

      entry.models[key] = { asr: asrText, english: r.text, llmMs: r.latencyMs, plausible: verdict.ok }
    }
    out.push(entry)
  }

  heading('summary')
  for (const key of ['turbo', 'large']) {
    const ms = totals[key]
    if (!ms.length) continue
    const mean = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)
    console.log(`  ${key.padEnd(8)} mean llm ${mean}ms over ${ms.length} samples`)
  }

  const dest = path.join(V1_ROOT, 'fixtures', 'cleanup-comparison.json')
  await writeFile(dest, JSON.stringify(out, null, 2) + '\n')
  console.log(`\n  written to ${path.relative(process.cwd(), dest)}`)
}

main().catch((err) => {
  console.error(`\ncompare-cleanup failed: ${err.message}`)
  process.exit(1)
})
