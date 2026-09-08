#!/usr/bin/env node
// Is gemma's translation failure real, or was the matrix run flaky?
//
//   npx tsx scripts/recheck-gemma.mjs [--runs 5]
//
// The matrix recorded gemma-3-4b returning three of nine samples untranslated,
// and that was reported as "gemma does not translate". The user's own history
// contradicts it: six real dictations cleaned correctly, including one with 124
// Devanagari characters that came back as fluent English.
//
// Both cannot be summarised as a single verdict, so this repeats only the three
// samples that failed, several times each, on both models. A failure that
// reproduces every time is a property of the model. One that comes and goes is
// a property of the measurement, and the original claim was too strong either
// way.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { OpenAiCompatClient, DICTATION_CLEANUP_SYSTEM, cleanupBudget } from '../packages/llm/src/index.js'
import { SIDECARS, findModel } from '../desktop/src/shared/models.js'
import { V1_ROOT, heading } from './lib/fetch-util.mjs'
import { analyseLanguage } from './lib/hinglish.mjs'

const REPO_ROOT = path.resolve(V1_ROOT, '../..')
const runsFlag = process.argv.indexOf('--runs')
const RUNS = runsFlag === -1 ? 5 : Number(process.argv[runsFlag + 1])

/** The three the matrix flagged, plus two it passed, as a control. */
const FAILED = ['hinglish-04', 'hinglish-06', 'hinglish-09']
const CONTROL = ['hinglish-01', 'hinglish-05']

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

async function startLlama(modelId) {
  const def = SIDECARS.llama
  const model = findModel('llama', modelId)
  // Nothing may already own the port: a survivor would answer the health check
  // and the new process would die unnoticed against a bound address.
  await killPort(def.defaultPort)
  const exe = path.join(REPO_ROOT, 'sidecars', def.exe)
  const proc = spawn(exe, def.args(path.join(REPO_ROOT, 'models', model.file), def.defaultPort), {
    cwd: path.dirname(exe),
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`${modelId} exited ${proc.exitCode}`)
    try {
      const res = await fetch(`http://127.0.0.1:${def.defaultPort}/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.status !== 503) {
        await assertLoaded(def.defaultPort, model.file)
        return proc
      }
    } catch {
      /* not up yet */
    }
    await sleep(1_000)
  }
  throw new Error(`${modelId} never became healthy`)
}

function stop(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve()
    const k = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    k.on('exit', () => setTimeout(resolve, 1_500))
    k.on('error', () => resolve())
  })
}

async function main() {
  // The transcripts the matrix already produced: same input, so the only
  // variable is the cleanup model.
  const matrix = JSON.parse(await readFile(path.join(V1_ROOT, 'fixtures', 'model-matrix.json'), 'utf8'))
  const source = matrix.grid.find((r) => r.asrModel === 'turbo' && r.llmModel === 'qwen3-4b')
  const wanted = [...FAILED, ...CONTROL]
  const inputs = source.samples
    .filter((s) => wanted.includes(s.name))
    .map((s) => ({ name: s.name, text: s.heard }))

  heading(`Re-checking ${inputs.length} samples x ${RUNS} runs on each model`)
  for (const i of inputs) {
    const a = analyseLanguage(i.text)
    console.log(`  ${i.name}  ${i.text.length} chars in, ${a.devanagari} Devanagari`)
  }
  console.log('')

  for (const modelId of ['gemma3-4b', 'qwen3-4b']) {
    let proc = null
    try {
      proc = await startLlama(modelId)
    } catch (err) {
      console.log(`  ${modelId}: ${err.message}`)
      continue
    }

    const llm = new OpenAiCompatClient({
      baseUrl: `http://127.0.0.1:${SIDECARS.llama.defaultPort}`,
      model: modelId,
    })

    console.log(`  ${modelId}`)
    for (const input of inputs) {
      const budget = cleanupBudget(input.text)
      let english = 0
      let sample = ''
      for (let i = 0; i < RUNS; i++) {
        try {
          const r = await llm.complete({
            system: DICTATION_CLEANUP_SYSTEM,
            user: input.text,
            maxTokens: budget.maxTokens,
            firstTokenTimeoutMs: budget.firstTokenTimeoutMs,
            stallTimeoutMs: budget.stallTimeoutMs,
            timeoutMs: budget.totalTimeoutMs,
          })
          const a = analyseLanguage(r.text)
          if (a.english) english++
          else sample = r.text
        } catch (err) {
          sample = `(${err.kind ?? 'failed'})`
        }
      }
      const tag = FAILED.includes(input.name) ? 'flagged' : 'control'
      console.log(
        `    ${input.name.padEnd(14)} ${tag}  English on ${english}/${RUNS}` +
          (english === RUNS ? '' : `   e.g. ${sample.replace(/\s+/g, ' ').slice(0, 60)}`)
      )
    }
    console.log('')
    await stop(proc)
    await sleep(2_000)
  }

  heading('Reading this')
  console.log('  Consistent failures across runs mean the model genuinely struggles with')
  console.log('  these inputs. Mixed results mean it is unreliable rather than incapable -')
  console.log('  which is a real difference, and not what the earlier claim said.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
