#!/usr/bin/env node
// The whole 2x2: which speech model, which language model.
//
//   npx tsx scripts/compare-models.mjs [--runs 2]
//
// Two open questions, and they interact, so measuring them apart would answer
// neither:
//
//   A1  end-to-end p50 under 2.0s. Measured at 2608-2785 ms with large-v3 plus
//       qwen3-4b, and the gap was almost entirely Hindi speech recognition.
//       turbo is far faster - but spike V5 found it silently truncating Hindi,
//       which is why it was rejected.
//   A4  the finished English has to be worth shipping. Dictation #14 came back
//       still in Hinglish from gemma-3-4b, and the same model handled every
//       short case perfectly, so the question is which model holds the
//       instruction over a real dictation.
//
// Runs each combination against the same nine recordings, starting and stopping
// the sidecars itself. Nothing else may be using the GPU: 6 GB holds one speech
// model and one language model, not two of each.

import { spawn } from 'node:child_process'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WhisperCppClient } from '../packages/asr/src/client.js'
import { OpenAiCompatClient, DICTATION_CLEANUP_SYSTEM, cleanupBudget, isPlausibleCleanup } from '../packages/llm/src/index.js'
import { correct, SEED_DICTIONARY } from '../packages/dictionary/src/index.js'
import { SIDECARS, findModel } from '../desktop/src/shared/models.js'
import { V1_ROOT, heading } from './lib/fetch-util.mjs'
import { readWav, resampleTo16k } from './lib/wav.mjs'
import { analyseLanguage } from './lib/hinglish.mjs'

const REPO_ROOT = path.resolve(V1_ROOT, '../..')
const SIDECAR_ROOT = path.join(REPO_ROOT, 'sidecars')
const MODEL_ROOT = path.join(REPO_ROOT, 'models')

const runsFlag = process.argv.indexOf('--runs')
const RUNS = runsFlag === -1 ? 2 : Number(process.argv[runsFlag + 1])

const ASR_MODELS = ['turbo', 'large-v3']
const LLM_MODELS = ['qwen3-4b', 'gemma3-4b']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Free a port before binding it, so a survivor cannot masquerade as the new server. */
async function killPort(port) {
  await new Promise((resolve) => {
    const p = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: 'ignore' }
    )
    p.on('exit', () => resolve())
    p.on('error', () => resolve())
  })
  await sleep(1_500)
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, i)]
}

/**
 * Confirm the server is serving the model we asked for.
 *
 * Learned the hard way, twice. `whisper-server` ignores the model field in a
 * request, so a benchmark can label its output with a model that is not loaded.
 * And a health check against a fixed port cannot tell a NEW server from the OLD
 * one that never died - which produced two "different" models emitting
 * byte-identical text. Ask the server what it has, and refuse to measure if it
 * is not what was requested.
 */
async function assertLoaded(port, expectFile) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(5_000) })
  const body = await res.json()
  const id = String(body.data?.[0]?.id ?? '')
  if (!id.includes(expectFile)) {
    throw new Error(`port ${port} is serving "${id}", expected ${expectFile}`)
  }
  return id
}

/** Start one sidecar with exactly the arguments the app would use. */
async function startSidecar(id, modelId) {
  const def = SIDECARS[id]
  const model = findModel(id, modelId)
  if (!model) throw new Error(`unknown ${id} model: ${modelId}`)

  await killPort(def.defaultPort)
  const exe = path.join(SIDECAR_ROOT, def.exe)
  const modelPath = path.join(MODEL_ROOT, model.file)
  const proc = spawn(exe, def.args(modelPath, def.defaultPort), {
    cwd: path.dirname(exe),
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-2000)
  })

  const url = `http://127.0.0.1:${def.defaultPort}${def.healthPath}`
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`${id}/${modelId} exited ${proc.exitCode}: ${stderr.slice(-400)}`)
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      // llama-server answers 503 while it loads the weights.
      if (res.status !== 503) {
        // llama-server reports what it loaded; whisper-server has no such
        // endpoint, so for that one the port kill above is the only guarantee.
        if (id === 'llama') await assertLoaded(def.defaultPort, model.file)
        return proc
      }
    } catch {
      // Not listening yet.
    }
    await sleep(1_000)
  }
  throw new Error(`${id}/${modelId} never became healthy`)
}

/** taskkill /T, because these spawn workers that outlive a plain kill. */
function stopSidecar(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve()
    const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('exit', () => setTimeout(resolve, 1_500))
    killer.on('error', () => resolve())
  })
}

async function main() {
  const fixtures = path.join(V1_ROOT, 'fixtures')
  const wavs = (await readdir(fixtures))
    .filter((f) => f.startsWith('hinglish-') && f.endsWith('.wav'))
    .sort()
    .map((f) => path.join(fixtures, f))

  const audio = []
  for (const file of wavs) {
    const { pcm, sampleRate } = await readWav(file)
    audio.push({ name: path.basename(file, '.wav'), pcm: resampleTo16k(pcm, sampleRate) })
  }

  heading(`Model matrix: ${ASR_MODELS.length} x ${LLM_MODELS.length}, ${audio.length} samples x ${RUNS} runs`)
  console.log('  Nothing else should be using the GPU.\n')

  const grid = []

  for (const asrModel of ASR_MODELS) {
    for (const llmModel of LLM_MODELS) {
      const combo = `${asrModel} + ${llmModel}`
      process.stdout.write(`  ${combo.padEnd(26)} starting... `)

      let whisper = null
      let llama = null
      try {
        whisper = await startSidecar('whisper', asrModel)
        llama = await startSidecar('llama', llmModel)
      } catch (err) {
        console.log(`FAILED: ${err.message}`)
        await stopSidecar(llama)
        await stopSidecar(whisper)
        continue
      }

      const asr = new WhisperCppClient({
        baseUrl: `http://127.0.0.1:${SIDECARS.whisper.defaultPort}`,
        model: asrModel,
      })
      const llm = new OpenAiCompatClient({
        baseUrl: `http://127.0.0.1:${SIDECARS.llama.defaultPort}`,
        model: llmModel,
      })

      // Discard a warm-up pass: the first request after a load pays for
      // initialisation that no real dictation pays again.
      try {
        const warm = await asr.transcribe(audio[0].pcm, { language: 'auto' })
        const b = cleanupBudget(warm.text)
        await llm.complete({
          system: DICTATION_CLEANUP_SYSTEM,
          user: warm.text,
          maxTokens: b.maxTokens,
          firstTokenTimeoutMs: b.firstTokenTimeoutMs,
          stallTimeoutMs: b.stallTimeoutMs,
          timeoutMs: b.totalTimeoutMs,
        })
      } catch {
        // Warm-up failures are not results.
      }
      process.stdout.write('measuring... ')

      const asrMs = []
      const llmMs = []
      const totals = []
      const samples = []
      let englishOut = 0
      let degraded = 0

      for (const clip of audio) {
        let last = null
        for (let run = 0; run < RUNS; run++) {
          const t0 = performance.now()
          const heard = await asr.transcribe(clip.pcm, { language: 'auto' })
          const tAsr = performance.now() - t0
          const fixed = correct(heard.text, SEED_DICTIONARY)

          const budget = cleanupBudget(fixed.text)
          const t1 = performance.now()
          let cleaned = fixed.text
          let why = null
          try {
            const out = await llm.complete({
              system: DICTATION_CLEANUP_SYSTEM,
              user: fixed.text,
              maxTokens: budget.maxTokens,
              firstTokenTimeoutMs: budget.firstTokenTimeoutMs,
              stallTimeoutMs: budget.stallTimeoutMs,
              timeoutMs: budget.totalTimeoutMs,
            })
            if (out.finishReason === 'length') why = 'truncated'
            else {
              const verdict = isPlausibleCleanup(fixed.text, out.text)
              if (verdict.ok) cleaned = out.text
              else why = verdict.reason
            }
          } catch (err) {
            why = err.kind ?? 'failed'
          }
          const tLlm = performance.now() - t1

          asrMs.push(tAsr)
          llmMs.push(tLlm)
          totals.push(tAsr + tLlm)
          last = { heard: heard.text, cleaned, why, language: heard.language }
        }

        if (last.why) degraded++
        // Whether Hindi survived is the quality question A4 actually asks.
        if (analyseLanguage(last.cleaned).english) englishOut++
        samples.push({ name: clip.name, ...last, heardChars: last.heard.length })
      }

      const row = {
        asrModel,
        llmModel,
        asrP50: percentile(asrMs, 50),
        llmP50: percentile(llmMs, 50),
        p50: percentile(totals, 50),
        p95: percentile(totals, 95),
        englishOut,
        degraded,
        samples,
        // A short transcript from turbo where large-v3 produced a long one is
        // the truncation V5 found. Comparable only within a column.
        meanHeardChars: Math.round(samples.reduce((n, s) => n + s.heardChars, 0) / samples.length),
      }
      grid.push(row)
      console.log(
        `p50 ${Math.round(row.p50)}ms · English ${englishOut}/${audio.length} · heard ~${row.meanHeardChars} chars`
      )

      await stopSidecar(llama)
      await stopSidecar(whisper)
      await sleep(2_000)
    }
  }

  heading('Results')
  console.log('  speech + language          asr p50   llm p50   e2e p50   e2e p95   A1    English   heard')
  console.log('  ' + '-'.repeat(96))
  for (const r of grid) {
    const a1 = r.p50 <= 2000 && r.p95 <= 3000 ? 'PASS' : 'fail'
    console.log(
      `  ${`${r.asrModel} + ${r.llmModel}`.padEnd(26)} ` +
        `${(Math.round(r.asrP50) + 'ms').padStart(7)}   ${(Math.round(r.llmP50) + 'ms').padStart(7)}   ` +
        `${(Math.round(r.p50) + 'ms').padStart(7)}   ${(Math.round(r.p95) + 'ms').padStart(7)}   ` +
        `${a1.padEnd(5)} ${`${r.englishOut}/${r.samples.length}`.padStart(7)}   ${r.meanHeardChars}`
    )
  }

  // Truncation is the reason turbo was rejected. It shows up as a shorter
  // transcript for the same audio, so compare the columns.
  heading('Does turbo truncate Hindi?')
  const byAsr = {}
  for (const r of grid) (byAsr[r.asrModel] ??= []).push(r)
  for (const asrModel of ASR_MODELS) {
    const rows = byAsr[asrModel] ?? []
    if (rows.length === 0) continue
    const mean = Math.round(rows.reduce((n, r) => n + r.meanHeardChars, 0) / rows.length)
    console.log(`  ${asrModel.padEnd(12)} heard ${mean} characters per 10s sample on average`)
  }
  const [a, b] = ASR_MODELS.map((m) => {
    const rows = byAsr[m] ?? []
    return rows.length ? rows.reduce((n, r) => n + r.meanHeardChars, 0) / rows.length : 0
  })
  if (a && b) {
    const ratio = a / b
    console.log('')
    console.log(
      ratio < 0.85
        ? `  ${ASR_MODELS[0]} heard ${Math.round((1 - ratio) * 100)}% less. That is the V5 truncation, still there.`
        : `  Within ${Math.round(Math.abs(1 - ratio) * 100)}% of each other; no gross truncation in this set.`
    )
  }

  const out = path.join(V1_ROOT, 'fixtures', 'model-matrix.json')
  await writeFile(out, JSON.stringify({ runs: RUNS, grid }, null, 2), 'utf8')
  console.log(`\n  full transcripts: ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
