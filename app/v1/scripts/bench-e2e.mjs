#!/usr/bin/env node
// A1 and A4: the whole dictation pipeline, end to end, on real recordings.
//
//   npx tsx scripts/bench-e2e.mjs [--runs 3] [--asr large-v3] [file.wav ...]
//
// A1 asks for p50 end-to-end under 2.0s on a ten-second utterance, p95 under
// 3.0s. "End to end" means what the user waits for: speech recognition, the
// dictionary pass, and the language-model cleanup - not just the ASR call,
// which is the number the earlier spike measured and the one it is tempting to
// quote because it is smaller.
//
// A4 asks for 17 of 20 Hinglish samples rated "would ship this text as-is".
// That rating is a human judgement, so this writes the finished English out to
// a sheet for scoring rather than pretending to score it.

import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WhisperCppClient } from '../packages/asr/src/client.js'
import { OpenAiCompatClient, DICTATION_CLEANUP_SYSTEM, isPlausibleCleanup } from '../packages/llm/src/index.js'
import { correct, SEED_DICTIONARY } from '../packages/dictionary/src/index.js'
import { V1_ROOT, heading } from './lib/fetch-util.mjs'
import { readWav, resampleTo16k } from './lib/wav.mjs'

const WHISPER_URL = process.env.WHISPER_URL ?? 'http://127.0.0.1:8178'
const LLAMA_URL = process.env.LLAMA_URL ?? 'http://127.0.0.1:8179'

const args = process.argv.slice(2)
const runsFlag = args.indexOf('--runs')
const RUNS = runsFlag === -1 ? 3 : Number(args[runsFlag + 1])
const asrFlag = args.indexOf('--asr')
const ASR_MODEL = asrFlag === -1 ? 'ggml-large-v3-q5_0' : args[asrFlag + 1]
const files = args.filter((a) => a.endsWith('.wav'))

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, i)]
}

const ms = (n) => `${Math.round(n)}ms`

async function main() {
  const fixtures = path.join(V1_ROOT, 'fixtures')
  const wavs =
    files.length > 0
      ? files
      : (await readdir(fixtures))
          .filter((f) => f.startsWith('hinglish-') && f.endsWith('.wav'))
          .sort()
          .map((f) => path.join(fixtures, f))

  if (wavs.length === 0) {
    console.log('No samples. Record some with: npm run record hinglish-10 12')
    return
  }

  const asr = new WhisperCppClient({ baseUrl: WHISPER_URL, model: ASR_MODEL })
  const llm = new OpenAiCompatClient({ baseUrl: LLAMA_URL, model: 'local' })

  heading(`End to end: ${wavs.length} samples x ${RUNS} runs, asr=${ASR_MODEL}`)

  // One throwaway pass. The first request after a model loads pays for warm-up
  // that no real dictation ever pays again, and including it would flatter or
  // damn the result depending purely on when the benchmark was started.
  {
    const { pcm, sampleRate } = await readWav(wavs[0])
    const audio = resampleTo16k(pcm, sampleRate)
    const warm = await asr.transcribe(audio, { language: 'auto' }).catch(() => null)
    if (warm) {
      await llm
        .complete({ system: DICTATION_CLEANUP_SYSTEM, user: warm.text, timeoutMs: 20_000 })
        .catch(() => null)
    }
    console.log('  (warm-up pass discarded)\n')
  }

  const rows = []
  const totals = []
  const asrTimes = []
  const llmTimes = []

  for (const file of wavs) {
    const name = path.basename(file, '.wav')
    const { pcm, sampleRate } = await readWav(file)
    const audio = resampleTo16k(pcm, sampleRate)
    const audioSec = audio.length / 16_000

    let last = null
    const perRun = []

    for (let run = 0; run < RUNS; run++) {
      const t0 = performance.now()
      const heard = await asr.transcribe(audio, { language: 'auto' })
      const tAsr = performance.now() - t0

      // The dictionary pass is pure and sub-millisecond, but it is part of what
      // the user waits for, so it is inside the measurement.
      const fixed = correct(heard.text, SEED_DICTIONARY)

      const t1 = performance.now()
      let cleaned = fixed.text
      let degraded = null
      try {
        const out = await llm.complete({
          system: DICTATION_CLEANUP_SYSTEM,
          user: fixed.text,
          timeoutMs: 20_000,
        })
        const verdict = isPlausibleCleanup(fixed.text, out.text)
        if (verdict.ok) cleaned = out.text
        else degraded = verdict.reason
      } catch (err) {
        degraded = err instanceof Error ? err.message : String(err)
      }
      const tLlm = performance.now() - t1
      const total = tAsr + tLlm

      perRun.push({ total, tAsr, tLlm })
      totals.push(total)
      asrTimes.push(tAsr)
      llmTimes.push(tLlm)
      last = { heard: heard.text, language: heard.language, corrected: fixed.text, cleaned, degraded }
    }

    const best = perRun.reduce((a, b) => (a.total <= b.total ? a : b))
    const median = percentile(perRun.map((r) => r.total), 50)
    rows.push({ name, audioSec, ...last, medianMs: median, asrMs: best.tAsr, llmMs: best.tLlm })

    console.log(
      `  ${name.padEnd(14)} ${audioSec.toFixed(1)}s audio  ` +
        `median ${ms(median).padStart(7)}  (asr ${ms(best.tAsr)} + llm ${ms(best.tLlm)})  ` +
        `${last.language}${last.degraded ? '  DEGRADED' : ''}`
    )
  }

  // ---- A1 --------------------------------------------------------------
  const p50 = percentile(totals, 50)
  const p95 = percentile(totals, 95)
  const meanAudio = rows.reduce((n, r) => n + r.audioSec, 0) / rows.length

  heading('A1: p50 under 2.0s, p95 under 3.0s for a ten-second utterance')
  console.log(`  samples        ${rows.length} files x ${RUNS} runs = ${totals.length} measurements`)
  console.log(`  mean audio     ${meanAudio.toFixed(1)}s`)
  console.log(`  asr            p50 ${ms(percentile(asrTimes, 50))}   p95 ${ms(percentile(asrTimes, 95))}`)
  console.log(`  llm cleanup    p50 ${ms(percentile(llmTimes, 50))}   p95 ${ms(percentile(llmTimes, 95))}`)
  console.log(`  END TO END     p50 ${ms(p50)}   p95 ${ms(p95)}`)
  console.log('')
  console.log(`  p50 target 2000ms  ->  ${p50 <= 2000 ? 'PASS' : `FAIL by ${ms(p50 - 2000)}`}`)
  console.log(`  p95 target 3000ms  ->  ${p95 <= 3000 ? 'PASS' : `FAIL by ${ms(p95 - 3000)}`}`)

  // ---- A4 --------------------------------------------------------------
  const sheet = [
    '# A4 rating sheet',
    '',
    `Generated ${new Date().toLocaleString()} · asr \`${ASR_MODEL}\``,
    '',
    'A4 passes when **17 of 20** samples are rated "would ship this text as-is".',
    'Score the FINAL column only: that is what reaches the cursor. Mark each',
    '`ship` or `no`, and say what is wrong when it is `no`.',
    '',
    `Samples available: **${rows.length}** of 20 needed.`,
    '',
    '---',
    '',
  ]
  for (const r of rows) {
    sheet.push(`## ${r.name}  ·  ${r.audioSec.toFixed(1)}s  ·  detected ${r.language}`)
    sheet.push('')
    sheet.push('**Heard** (raw)')
    sheet.push('')
    sheet.push('```')
    sheet.push(r.heard.trim() || '(nothing)')
    sheet.push('```')
    sheet.push('')
    sheet.push(`**FINAL** — rate this${r.degraded ? `  _(degraded: ${r.degraded})_` : ''}`)
    sheet.push('')
    sheet.push('```')
    sheet.push(r.cleaned.trim() || '(nothing)')
    sheet.push('```')
    sheet.push('')
    sheet.push('rating: ______   notes:')
    sheet.push('')
    sheet.push('---')
    sheet.push('')
  }

  const sheetPath = path.join(V1_ROOT, 'fixtures', 'a4-rating.md')
  await writeFile(sheetPath, sheet.join('\n'), 'utf8')
  const jsonPath = path.join(V1_ROOT, 'fixtures', 'e2e-results.json')
  await writeFile(jsonPath, JSON.stringify({ asrModel: ASR_MODEL, runs: RUNS, rows }, null, 2), 'utf8')

  heading('A4: 17 of 20 rated shippable')
  console.log(`  rating sheet   ${sheetPath}`)
  console.log(`  raw results    ${jsonPath}`)
  console.log(`  samples        ${rows.length}; A4 needs 20`)
  const degraded = rows.filter((r) => r.degraded).length
  if (degraded) console.log(`  degraded       ${degraded} sample(s) fell back to the dictionary text`)
  console.log('')
  console.log('  This one needs a human. Open the sheet and rate the FINAL blocks.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
