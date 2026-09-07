#!/usr/bin/env node
// Fetch model weights from Hugging Face.
//
// Why these particular repos: the official Qwen and Google GGUF repos both
// return 401 without an accepted licence and a token. unsloth republishes both
// as open re-quants, verified reachable anonymously. Using them keeps first run
// dependency-free - no HF account, no token, no browser licence click.
//
// Two LLMs are fetched on purpose. Qwen3-4B and Gemma-3-4B are both ~2.5 GB and
// the spec calls for a bake-off on real Hinglish samples rather than picking on
// reputation: Gemma had heavy Indic-language investment, Qwen is stronger on
// Chinese and code, and which wins for code-mixed Hindi/English is genuinely
// unknown. Run with `--only whisper,qwen` to skip the second.

import path from 'node:path'
import { MODEL_DIR, download, exists, sizeOf, writeManifest, heading, fmtBytes } from './lib/fetch-util.mjs'

const HF = 'https://huggingface.co'

const MODELS = {
  whisper: {
    role: 'ASR',
    file: 'ggml-large-v3-q5_0.bin',
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin`,
    approx: 1.1e9,
    note: 'large-v3, NOT turbo: turbo was distilled to 4 decoder layers and lost most on multilingual, which is exactly our workload',
  },
  qwen: {
    role: 'LLM candidate A',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    url: `${HF}/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`,
    approx: 2.5e9,
    note: 'strong instruction following, strongest on code and Chinese',
  },
  gemma: {
    role: 'LLM candidate B',
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
    url: `${HF}/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf`,
    approx: 2.6e9,
    note: 'trained across 140+ languages with real Indic investment',
  },
}

const onlyArg = process.argv.indexOf('--only')
const only = onlyArg !== -1 ? new Set(process.argv[onlyArg + 1].split(',')) : null
const FORCE = process.argv.includes('--force')

async function main() {
  const wanted = Object.entries(MODELS).filter(([k]) => !only || only.has(k))
  const totalApprox = wanted.reduce((n, [, m]) => n + m.approx, 0)

  console.log(`Fetching models into ${MODEL_DIR}`)
  console.log(`${wanted.length} model(s), roughly ${fmtBytes(totalApprox)} total\n`)

  const manifest = path.join(MODEL_DIR, 'manifest.json')
  let downloaded = 0

  for (const [key, m] of wanted) {
    heading(`${key}  (${m.role})`)
    console.log(`  ${m.note}`)
    const dest = path.join(MODEL_DIR, m.file)

    if ((await exists(dest)) && !FORCE) {
      console.log(`  already present: ${m.file}  (${fmtBytes(await sizeOf(dest))})`)
      continue
    }

    downloaded += await download(m.url, dest, key.padEnd(7))
    await writeManifest(manifest, {
      [key]: { file: m.file, url: m.url, bytes: await sizeOf(dest), role: m.role },
    })
  }

  heading('done')
  if (downloaded) console.log(`  downloaded ${fmtBytes(downloaded)}`)
  console.log(`  manifest: ${path.relative(process.cwd(), manifest)}`)
}

main().catch((err) => {
  console.error(`\nfetch-models failed: ${err.message}`)
  process.exit(1)
})
