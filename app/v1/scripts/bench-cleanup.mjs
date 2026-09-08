#!/usr/bin/env node
// How long does the cleanup pass actually take, as the dictation gets longer?
//
//   npx tsx scripts/bench-cleanup.mjs
//
// Written to explain a real failure. Dictation #14 was 85 seconds of speech,
// about a thousand words, and came out tagged `llm-timeout` with the raw
// Hinglish transcript instead of English. The timeout it hit was 4000 ms - a
// constant, chosen when every test dictation was ten seconds long.
//
// The question is not whether 4000 ms is too short. It is what the number
// should be a function OF, and whether a single timeout can serve a pipeline
// whose work scales with what the user said.

import { DICTATION_CLEANUP_SYSTEM } from '../packages/llm/src/index.js'
import { heading } from './lib/fetch-util.mjs'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://127.0.0.1:8179'
/** What the app currently allows the model to produce. */
const CURRENT_MAX_TOKENS = 1024
/** What the app currently allows it to take. */
const CURRENT_TIMEOUT_MS = 4_000

/** The actual transcript from dictation #14, which is what failed. */
const REAL = `So generally, abhi tak sab kuch sahih hai. So A1 gap and A4, like 11 more samples from my rating. Okay, I'll give that. But I have said a lot of recordings before. So kya hum database mein se nahi use kar sakte? Do you really want to add 11 files? Can I just do not dictate them in the app itself and you will take this? But okay, this is one thing. And the dictionary has no way to add a term. It ships with a seed list and that's it, no UI. Okay, chunking has been never fired in real use case. What is chunking? What it is doing? And how can I fire it? Please tell me. Most settings are hand edit only. Okay, so the dictionary has no way to add a term and most settings are hand edit only. Let's do one thing. Give me the options which I can put into UI, which can be changed or edited by real users. And no feedback during this 2.6 seconds wait. Okay, this is the other thing. I can ignore this for now. So, Give me all the settings that I can show and let users change, explain me about chunking and how we can perfectly fix the A1 and A4 gap, all that.`

const WORDS = REAL.trim().split(/\s+/)
const LENGTHS = [25, 50, 100, 200, 400, WORDS.length]

async function tokenCount(text) {
  const res = await fetch(`${LLAMA_URL}/tokenize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text }),
  })
  return (await res.json()).tokens.length
}

async function modelName() {
  try {
    const res = await fetch(`${LLAMA_URL}/v1/models`)
    const body = await res.json()
    return body.data?.[0]?.id ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** One cleanup call, streamed, so first-token and total are separable. */
async function cleanup(text, maxTokens) {
  const started = performance.now()
  let firstTokenMs = null
  let out = ''

  const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: DICTATION_CLEANUP_SYSTEM },
        { role: 'user', content: text },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      stream: true,
    }),
  })

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finish = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const chunk = JSON.parse(payload)
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) {
          if (firstTokenMs === null) firstTokenMs = performance.now() - started
          out += delta
        }
        if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason
      } catch {
        // A partial frame; the next read completes it.
      }
    }
  }

  return { text: out, totalMs: performance.now() - started, firstTokenMs, finish }
}

async function main() {
  heading(`Cleanup latency vs dictation length  (model: ${await modelName()})`)
  console.log(`  current settings: timeout ${CURRENT_TIMEOUT_MS}ms, maxTokens ${CURRENT_MAX_TOKENS}\n`)
  console.log('  words   in tok   out tok   1st tok    total     tok/s   verdict at current settings')
  console.log('  ' + '-'.repeat(88))

  const rows = []
  for (const n of LENGTHS) {
    const text = WORDS.slice(0, n).join(' ')
    const inTok = await tokenCount(text)

    // Generous cap, so the measurement is of the model rather than of our limit.
    const r = await cleanup(text, 4096)
    const outTok = await tokenCount(r.text)
    const rate = outTok / ((r.totalMs - (r.firstTokenMs ?? 0)) / 1000)

    const wouldTimeout = r.totalMs > CURRENT_TIMEOUT_MS
    const wouldTruncate = outTok > CURRENT_MAX_TOKENS
    const verdict = [
      wouldTimeout ? 'TIMES OUT' : 'ok',
      wouldTruncate ? 'TRUNCATED' : null,
    ]
      .filter(Boolean)
      .join(' + ')

    rows.push({ n, inTok, outTok, ...r, rate, wouldTimeout, wouldTruncate })
    console.log(
      `  ${String(n).padEnd(7)} ${String(inTok).padEnd(8)} ${String(outTok).padEnd(9)} ` +
        `${(Math.round(r.firstTokenMs ?? 0) + 'ms').padEnd(10)} ` +
        `${(Math.round(r.totalMs) + 'ms').padEnd(9)} ${rate.toFixed(1).padStart(6)}   ${verdict}`
    )
  }

  heading('Where the current settings break')
  const firstBad = rows.find((r) => r.wouldTimeout)
  console.log(
    firstBad
      ? `  The ${CURRENT_TIMEOUT_MS}ms timeout starts failing at about ${firstBad.n} words.`
      : `  Nothing timed out; the ${CURRENT_TIMEOUT_MS}ms limit held for every length tested.`
  )
  const firstTrunc = rows.find((r) => r.wouldTruncate)
  console.log(
    firstTrunc
      ? `  maxTokens ${CURRENT_MAX_TOKENS} starts truncating at about ${firstTrunc.n} words.`
      : `  maxTokens ${CURRENT_MAX_TOKENS} was never reached.`
  )

  heading('What a length-aware budget would look like')
  // Generation dominates and scales with output, which tracks input closely,
  // because cleanup returns roughly what it was given.
  const rates = rows.map((r) => r.rate).filter((r) => Number.isFinite(r) && r > 0)
  const slowest = Math.min(...rates)
  const firstTok = Math.max(...rows.map((r) => r.firstTokenMs ?? 0))
  console.log(`  slowest generation observed   ${slowest.toFixed(1)} tokens/s`)
  console.log(`  worst first-token delay       ${Math.round(firstTok)}ms`)
  console.log('')
  for (const r of rows) {
    const needed = (r.firstTokenMs ?? 0) + (r.outTok / slowest) * 1000
    console.log(
      `  ${String(r.n).padStart(5)} words -> needs about ${Math.round(needed)
        .toString()
        .padStart(6)}ms   (measured ${Math.round(r.totalMs)}ms)`
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
