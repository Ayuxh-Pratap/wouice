#!/usr/bin/env node
// How long can one dictation be? Measured, not estimated.
//
//   npx tsx scripts/measure-limits.mjs
//
// Four different ceilings apply to a single dictation, and they are nowhere
// near each other. Which one binds depends on the language, which is exactly
// the kind of thing that is invisible until someone hits it mid-sentence.
//
// Tokenisation is measured against the running llama-server rather than
// assumed, because the usual rule of thumb - about 0.75 words per token - is an
// English rule, and this app is not an English-only app.

import { DICTATION_CLEANUP_SYSTEM } from '../packages/llm/src/index.js'
import { DEFAULT_SETTINGS } from '../desktop/src/shared/settings.js'
import { TYPE_SAFE_MAX_CHARS } from '../desktop/src/main/injection/policy.js'
import { heading } from './lib/fetch-util.mjs'

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://127.0.0.1:8179'

/** The context llama-server is started with. Keep in step with models.ts. */
const CONTEXT_TOKENS = 4096
/** Cleanup returns roughly what it was given, so half the window must stay free. */
const RESERVED_FOR_OUTPUT = 0.5

/** Words per minute, conversational. Used only to turn seconds into words. */
const SPEAKING_WPM = 150

const SAMPLES = [
  {
    label: 'English',
    text:
      'Please review the latest draft and send me your comments by tomorrow morning. ' +
      'I think the second section needs more detail about how we handle failures, ' +
      'and the diagram on page four is out of date since we changed the storage layer.',
  },
  {
    label: 'Hindi (Devanagari)',
    text:
      'मुझे यह काम कल सुबह तक पूरा करना है, इसलिए थोड़ी जल्दी करनी पड़ेगी। ' +
      'दूसरे हिस्से में थोड़ा और विस्तार चाहिए कि हम गलतियों को कैसे संभालते हैं, ' +
      'और चौथे पन्ने का चित्र पुराना हो गया है क्योंकि हमने स्टोरेज बदल दिया था।',
  },
  {
    label: 'Hinglish (roman)',
    text:
      'Main abhi ek meeting mein hoon, can you send me that document in ten minutes? ' +
      'Yaar woh second section thoda aur detail chahiye ki hum failures kaise handle karte hain, ' +
      'aur page four ka diagram purana ho gaya hai kyunki humne storage layer change kar diya tha.',
  },
]

async function tokenCount(text) {
  const res = await fetch(`${LLAMA_URL}/tokenize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text }),
  })
  if (!res.ok) throw new Error(`tokenize failed: ${res.status}`)
  const body = await res.json()
  return body.tokens.length
}

function words(text) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

async function main() {
  heading('What limits one dictation')

  const systemTokens = await tokenCount(DICTATION_CLEANUP_SYSTEM)
  console.log(`  cleanup instruction   ${systemTokens} tokens, spent on every dictation`)
  console.log(`  context window        ${CONTEXT_TOKENS} tokens`)
  console.log('')

  console.log('  language                tokens/word   tokens/char   max words in one pass')
  console.log('  ' + '-'.repeat(72))

  const perLanguage = []
  for (const s of SAMPLES) {
    const tokens = await tokenCount(s.text)
    const w = words(s.text)
    const perWord = tokens / w
    const perChar = tokens / s.text.length

    // The transcript goes in and a similar amount comes back out, so the budget
    // is halved before anything else.
    const budget = (CONTEXT_TOKENS - systemTokens) * RESERVED_FOR_OUTPUT
    const maxWords = Math.floor(budget / perWord)
    perLanguage.push({ ...s, tokens, w, perWord, maxWords })

    console.log(
      `  ${s.label.padEnd(22)} ${perWord.toFixed(2).padStart(11)} ` +
        `${perChar.toFixed(2).padStart(13)} ${String(maxWords).padStart(21)}`
    )
  }

  const worst = perLanguage.reduce((a, b) => (a.maxWords <= b.maxWords ? a : b))
  const best = perLanguage.reduce((a, b) => (a.maxWords >= b.maxWords ? a : b))

  heading('The four ceilings, in the order they bite')

  const capMs = DEFAULT_SETTINGS.silence.maxSessionMs
  const capWords = Math.round((capMs / 60_000) * SPEAKING_WPM)
  const rows = [
    [
      'recording cap',
      `${capMs / 60_000} min`,
      `~${capWords} words at ${SPEAKING_WPM} wpm`,
      'hard stop, settings.silence.maxSessionMs',
    ],
    [
      'cleanup context',
      `${CONTEXT_TOKENS} tokens`,
      `${worst.maxWords}-${best.maxWords} words`,
      `${worst.label} is the expensive one`,
    ],
    ['paste into the app', 'no limit', 'any length', 'clipboard paste is length-independent'],
    [
      'typing fallback',
      `${TYPE_SAFE_MAX_CHARS} chars`,
      `~${Math.round(TYPE_SAFE_MAX_CHARS / 6)} words`,
      'only when the clipboard holds an image or files',
    ],
  ]
  for (const [what, limit, inWords, note] of rows) {
    console.log(`  ${what.padEnd(20)} ${limit.padEnd(12)} ${inWords.padEnd(26)} ${note}`)
  }

  heading('So')
  const binding = Math.min(capWords, worst.maxWords)
  console.log(`  In the worst case (${worst.label}) the first ceiling you meet is about`)
  console.log(`  ${binding} words - ${binding === capWords ? 'the recording cap' : 'the cleanup context'}.`)
  console.log('')
  console.log(`  For English it is about ${Math.min(capWords, best.maxWords)} words.`)
  console.log('')
  if (worst.maxWords < capWords) {
    console.log(`  The context runs out BEFORE the recording cap in ${worst.label}, so a long`)
    console.log(`  dictation in that language would be truncated by the cleanup rather than`)
    console.log(`  stopped by the recorder. That is the case worth guarding.`)
  } else {
    console.log(`  The recording cap binds first in every language measured, so the context`)
    console.log(`  window is not the constraint in normal use.`)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
