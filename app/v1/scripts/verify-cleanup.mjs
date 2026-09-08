#!/usr/bin/env node
// Does the length-aware budget actually rescue the dictation that failed?
//
//   npx tsx scripts/verify-cleanup.mjs
//
// Replays the exact transcript from dictation #14 - 218 words that needed
// 7048 ms and were given 4000 ms - through the real client, and checks the two
// things that matter: it completes, and it comes back in English rather than
// the Hinglish the fallback delivered.

import { OpenAiCompatClient, DICTATION_CLEANUP_SYSTEM, cleanupBudget, isPlausibleCleanup } from '../packages/llm/src/index.js'
import { heading } from './lib/fetch-util.mjs'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://127.0.0.1:8179'

const REAL_14 = `So generally, abhi tak sab kuch sahih hai. So A1 gap and A4, like 11 more samples from my rating. Okay, I'll give that. But I have said a lot of recordings before. So kya hum database mein se nahi use kar sakte? Do you really want to add 11 files? Can I just do not dictate them in the app itself and you will take this? But okay, this is one thing. And the dictionary has no way to add a term. It ships with a seed list and that's it, no UI. Okay, chunking has been never fired in real use case. What is chunking? What it is doing? And how can I fire it? Please tell me. Most settings are hand edit only. Okay, so the dictionary has no way to add a term and most settings are hand edit only. Let's do one thing. Give me the options which I can put into UI, which can be changed or edited by real users. And no feedback during this 2.6 seconds wait. Okay, this is the other thing. I can ignore this for now. So, Give me all the settings that I can show and let users change, explain me about chunking and how we can perfectly fix the A1 and A4 gap, all that.`

const results = []
function report(id, ok, detail) {
  results.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(38)} ${detail}`)
}

/** Devanagari, or the giveaway romanised Hindi words the raw transcript keeps. */
function looksHinglish(text) {
  if (/[ऀ-ॿ]/.test(text)) return true
  return /\b(abhi|kuch|sahih|kya|hum|nahi|sakte|mein|karo|yaar|matlab)\b/i.test(text)
}

async function run(label, text, budget) {
  const llm = new OpenAiCompatClient({
    baseUrl: LLAMA_URL,
    model: 'local',
    timeoutMs: budget.totalTimeoutMs,
  })
  const started = performance.now()
  try {
    const r = await llm.complete({
      system: DICTATION_CLEANUP_SYSTEM,
      user: text,
      temperature: 0,
      maxTokens: budget.maxTokens,
      firstTokenTimeoutMs: budget.firstTokenTimeoutMs,
      stallTimeoutMs: budget.stallTimeoutMs,
    })
    return { ok: true, ...r, ms: performance.now() - started }
  } catch (err) {
    return { ok: false, error: err.message, kind: err.kind, ms: performance.now() - started }
  }
}

async function main() {
  const words = REAL_14.trim().split(/\s+/).length
  const budget = cleanupBudget(REAL_14)

  heading(`Replaying dictation #14  (${words} words)`)
  console.log(`  old settings   timeout 4000ms, maxTokens 1024`)
  console.log(
    `  new budget     total ${budget.totalTimeoutMs}ms, first token ${budget.firstTokenTimeoutMs}ms, ` +
      `stall ${budget.stallTimeoutMs}ms, maxTokens ${budget.maxTokens}\n`
  )

  const r = await run('#14', REAL_14, budget)
  report('completes without timing out', r.ok, r.ok ? `${Math.round(r.ms)}ms` : `${r.kind}: ${r.error}`)
  if (!r.ok) return finish()

  report(
    'took longer than the old 4000ms limit',
    r.ms > 4_000,
    `${Math.round(r.ms)}ms - which is exactly why the constant failed`
  )
  report('was not cut off by the token cap', r.finishReason !== 'length', `finish_reason=${r.finishReason}`)
  report('first token separated from generation', typeof r.firstTokenMs === 'number', `${r.firstTokenMs}ms`)

  const verdict = isPlausibleCleanup(REAL_14, r.text)
  report('passes the plausibility guard', verdict.ok, verdict.ok ? 'accepted' : verdict.reason)
  report(
    'came back as English, not Hinglish',
    !looksHinglish(r.text),
    looksHinglish(r.text) ? 'still contains Hindi words' : 'no Devanagari, no romanised Hindi'
  )

  console.log('\n--- what the user would now get ---\n')
  console.log(r.text.slice(0, 700) + (r.text.length > 700 ? '\n[...]' : ''))

  // A stalled model must still be caught quickly. Ask for something enormous
  // with an absurd first-token allowance to prove the stall path still fires.
  heading('A stopped model is still caught quickly')
  const tiny = await run(
    'stall',
    'hello',
    { totalTimeoutMs: 30_000, firstTokenTimeoutMs: 1, stallTimeoutMs: 1, maxTokens: 64 }
  )
  report(
    'gives up fast when nothing arrives',
    !tiny.ok && tiny.kind === 'timeout' && tiny.ms < 3_000,
    tiny.ok ? 'it answered anyway' : `${tiny.kind} after ${Math.round(tiny.ms)}ms: ${tiny.error}`
  )

  finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
