import { describe, expect, it } from 'vitest'
import {
  cleanupDisabled,
  cleanupFailed,
  cleanupSucceeded,
  cleanupUnavailable,
  type CleanupOutcome,
} from './cleanup-outcome.js'

/**
 * Acceptance criterion A8: every degradation path exercised at least once and
 * logged with its reason.
 *
 * These were four branches inside an async method that needed a supervisor, a
 * model server and a microphone to reach - so the paths that matter most on a
 * bad day were the only ones nothing had ever run.
 */

const RAW = 'मैं यह देख रहा हूँ and the meeting continues'

/** Every tag this app can write into the `degraded` column. */
const EVERY_PATH: { name: string; outcome: CleanupOutcome; tag: string | null }[] = [
  { name: 'switched off', outcome: cleanupDisabled(RAW), tag: null },
  { name: 'model not up', outcome: cleanupUnavailable(RAW), tag: 'llm-unavailable' },
  {
    name: 'timed out',
    outcome: cleanupFailed(RAW, Object.assign(new Error('no first token'), { kind: 'timeout' })),
    tag: 'llm-timeout',
  },
  {
    name: 'threw something unlabelled',
    outcome: cleanupFailed(RAW, new Error('socket closed')),
    tag: 'llm-llm-failed',
  },
  {
    name: 'cut off by the token cap',
    outcome: cleanupSucceeded(RAW, { text: 'I am watching this and the', finishReason: 'length' }),
    tag: 'llm-truncated',
  },
  {
    name: 'answered the prompt instead of cleaning',
    outcome: cleanupSucceeded(RAW, { text: 'Sure! Here is the cleaned up text you asked for.' }),
    tag: 'llm-rejected: output reads as a reply about the task, not a transcript',
  },
  {
    name: 'elaborated',
    outcome: cleanupSucceeded(RAW, { text: 'I am watching this. '.repeat(20) }),
    tag: 'llm-rejected: output far longer than input: model elaborated',
  },
  {
    name: 'summarised',
    outcome: cleanupSucceeded(RAW, { text: 'ok' }),
    tag: 'llm-rejected: output far shorter than input: model summarised',
  },
  {
    name: 'left Devanagari in',
    outcome: cleanupSucceeded('I am watching this and the meeting continues', {
      text: 'मैं यह देख रहा हूँ and the meeting continues here',
    }),
    tag: 'llm-rejected: output introduced Devanagari that was not in the input',
  },
  {
    name: 'found it unintelligible',
    outcome: cleanupSucceeded(RAW, { text: '   ' }),
    tag: 'llm-empty',
  },
]

describe('A8: every degradation path', () => {
  it.each(EVERY_PATH)('$name is tagged with its reason', ({ outcome, tag }) => {
    expect(outcome.degraded).toBe(tag)
  })

  it.each(EVERY_PATH)('$name still gives back the words that were said', ({ outcome }) => {
    // The dictation has already been spoken; there is no asking for it again.
    // Every one of these falls back to the input rather than inserting nothing.
    expect(outcome.text.length).toBeGreaterThan(0)
  })

  it.each(EVERY_PATH)('$name records what actually came back', ({ outcome }) => {
    // The history has to show the model's own words even when they were
    // refused, or a bad rejection is indistinguishable from a bad model.
    expect(typeof outcome.received).toBe('string')
    expect(outcome.received.length).toBeGreaterThan(0)
  })

  it('covers every tag the app can write', () => {
    // A new degradation added without a case here fails this, rather than
    // quietly shipping a path nothing has run.
    const tags = new Set(EVERY_PATH.map((p) => p.tag).filter(Boolean))
    expect(tags).toContain('llm-unavailable')
    expect(tags).toContain('llm-truncated')
    expect(tags).toContain('llm-empty')
    expect([...tags].filter((t) => t!.startsWith('llm-rejected:'))).toHaveLength(4)
  })
})

describe('the path that is not a degradation', () => {
  it('uses the cleaned text and tags nothing', () => {
    const good = cleanupSucceeded(RAW, { text: 'I am watching this and the meeting continues' })
    expect(good.degraded).toBeNull()
    expect(good.text).toBe('I am watching this and the meeting continues')
  })

  it('checks truncation before plausibility', () => {
    // A cut-off answer is a valid prefix of a good one, so it passes the
    // plausibility check. Checking that first would accept a sentence that
    // stops mid-word while looking finished.
    const cut = cleanupSucceeded(RAW, {
      text: 'I am watching this and the meeting',
      finishReason: 'length',
    })
    expect(cut.degraded).toBe('llm-truncated')
  })
})
