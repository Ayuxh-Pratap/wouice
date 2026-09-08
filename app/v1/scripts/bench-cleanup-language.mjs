#!/usr/bin/env node
// Does the cleanup model actually obey "OUTPUT ENGLISH"?
//
//   npx tsx scripts/bench-cleanup-language.mjs [--runs 3]
//   LLAMA_URL=http://127.0.0.1:8179 npx tsx scripts/bench-cleanup-language.mjs
//
// The cleanup prompt says, in capitals, to render Hindi as English. Fixing the
// timeout revealed that the currently loaded model does not always do it: the
// answer came back complete, plausible, on time - and still in Hinglish.
//
// Two scripts carry Hindi and they are not the same problem. Devanagari is
// visibly not English. Romanised Hinglish is Latin text that a model can easily
// mistake for English that simply needs tidying, which is the failure worth
// separating out.

import { OpenAiCompatClient, DICTATION_CLEANUP_SYSTEM, cleanupBudget } from '../packages/llm/src/index.js'
import { heading } from './lib/fetch-util.mjs'
import { analyseLanguage } from './lib/hinglish.mjs'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://127.0.0.1:8179'
const runsFlag = process.argv.indexOf('--runs')
const RUNS = runsFlag === -1 ? 3 : Number(process.argv[runsFlag + 1])

/**
 * The real #14 transcript, which the model did NOT render as English - while
 * handling every short case below perfectly. Sliced to increasing lengths, it
 * isolates the one variable that differs: how much text the instruction has to
 * survive.
 */
const REAL_14 = `So generally, abhi tak sab kuch sahih hai. So A1 gap and A4, like 11 more samples from my rating. Okay, I'll give that. But I have said a lot of recordings before. So kya hum database mein se nahi use kar sakte? Do you really want to add 11 files? Can I just do not dictate them in the app itself and you will take this? But okay, this is one thing. And the dictionary has no way to add a term. It ships with a seed list and that's it, no UI. Okay, chunking has been never fired in real use case. What is chunking? What it is doing? And how can I fire it? Please tell me. Most settings are hand edit only. Okay, so the dictionary has no way to add a term and most settings are hand edit only. Let's do one thing. Give me the options which I can put into UI, which can be changed or edited by real users. And no feedback during this 2.6 seconds wait. Okay, this is the other thing. I can ignore this for now. So, Give me all the settings that I can show and let users change, explain me about chunking and how we can perfectly fix the A1 and A4 gap, all that.`
const W14 = REAL_14.trim().split(/\s+/)

const LENGTH_CASES = [40, 80, 120, 160, 218].map((n) => ({
  label: `#14 at ${n} words`,
  text: W14.slice(0, n).join(' '),
}))

const CASES = [
  {
    label: 'Devanagari',
    text: 'मुझे यह काम कल सुबह तक पूरा करना है, इसलिए थोड़ी जल्दी करनी पड़ेगी। दूसरे हिस्से में थोड़ा और विस्तार चाहिए।',
  },
  {
    label: 'romanised Hinglish',
    text: 'So generally, abhi tak sab kuch sahih hai. Lekin kya hum database mein se nahi use kar sakte? Mujhe lagta hai ki yeh thoda simple hona chahiye, aur baaki sab theek hai.',
  },
  {
    label: 'mixed in one sentence',
    text: 'Main abhi ek meeting mein hoon, can you send me that document in ten minutes? Yaar woh section thoda aur detail chahiye.',
  },
  {
    label: 'plain English (control)',
    text: 'So um, I think we should, you know, basically just ship the thing and, uh, see what happens after that.',
  },
]

async function modelName() {
  try {
    const body = await (await fetch(`${LLAMA_URL}/v1/models`)).json()
    const id = body.data?.[0]?.id ?? 'unknown'
    return id.split(/[\\/]/).pop()
  } catch {
    return 'unreachable'
  }
}

async function main() {
  const model = await modelName()
  heading(`Does cleanup render Hindi as English?   model: ${model}`)
  console.log(`  ${LLAMA_URL} · ${RUNS} runs per case\n`)

  const llm = new OpenAiCompatClient({ baseUrl: LLAMA_URL, model: 'local' })
  const summary = []

  for (const c of [...CASES, ...LENGTH_CASES]) {
    const budget = cleanupBudget(c.text)
    let englishRuns = 0
    let last = ''
    let markers = []

    for (let i = 0; i < RUNS; i++) {
      const r = await llm.complete({
        system: DICTATION_CLEANUP_SYSTEM,
        user: c.text,
        temperature: 0,
        maxTokens: budget.maxTokens,
        firstTokenTimeoutMs: budget.firstTokenTimeoutMs,
        stallTimeoutMs: budget.stallTimeoutMs,
        timeoutMs: budget.totalTimeoutMs,
      })
      const a = analyseLanguage(r.text)
      if (a.english) englishRuns++
      else markers = a.markers
      last = r.text
    }

    const ok = englishRuns === RUNS
    summary.push({ ...c, englishRuns, ok })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(24)} English on ${englishRuns}/${RUNS} runs`)
    if (!ok && markers.length) console.log(`        left in: ${markers.slice(0, 8).join(', ')}`)
    console.log(`        -> ${last.replace(/\s+/g, ' ').slice(0, 150)}`)
    console.log('')
  }

  heading('Verdict')
  const failed = summary.filter((s) => !s.ok)
  if (failed.length === 0) {
    console.log(`  ${model} renders every case as English.`)
  } else {
    console.log(`  ${model} FAILS on: ${failed.map((f) => f.label).join(', ')}`)
    console.log('')
    console.log('  The output is complete, on time and plausible - it is simply not')
    console.log('  English. Nothing downstream can tell, which makes this worse than a')
    console.log('  timeout: a timeout at least tags itself `degraded`.')
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
