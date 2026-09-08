import { describe, expect, it } from 'vitest'
import { cleanupBudget, estimateCleanupMs, estimateTokens } from './budget.js'
import { consumeSse } from './stream.js'

/**
 * The failure these guard against is specific and happened: dictation #14, 218
 * words, needed 7048 ms, was allowed 4000 ms, and the user got raw Hinglish
 * with a `degraded` tag instead of English.
 */

/** The real transcript from #14, trimmed to its shape rather than its content. */
const WORDS_218 = 'word '.repeat(218).trim()
const CHARS_218 = WORDS_218.length

describe('the budget scales with the input', () => {
  it('gives a short dictation a modest allowance', () => {
    const b = cleanupBudget('Please send me the draft by tomorrow.')
    expect(b.maxTokens).toBe(256)
    expect(b.totalTimeoutMs).toBeGreaterThan(3_000)
  })

  it('gives dictation #14 more than the 7 seconds it actually needed', () => {
    // The whole point. 4000ms was the bug; this must clear the measurement with
    // room for a slower machine than the one it was measured on.
    const b = cleanupBudget(WORDS_218)
    expect(b.totalTimeoutMs).toBeGreaterThan(7_048)
  })

  it('grows monotonically with length', () => {
    const lengths = [50, 200, 800, 3_000, 5_000].map((n) => cleanupBudget('x'.repeat(n)))
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]!.totalTimeoutMs).toBeGreaterThanOrEqual(lengths[i - 1]!.totalTimeoutMs)
      expect(lengths[i]!.maxTokens).toBeGreaterThanOrEqual(lengths[i - 1]!.maxTokens)
    }
  })

  it('never lets maxTokens truncate a dictation that fits the recording cap', () => {
    // Five minutes at 150 wpm is about 750 words, ~4500 characters. The old
    // 1024-token cap sat just above that: a latent cliff nobody had hit yet.
    const longest = cleanupBudget('x'.repeat(4_500))
    expect(longest.maxTokens).toBeGreaterThan(1_024)
  })

  it('uses the real token count when the caller has one', () => {
    const estimated = cleanupBudget(WORDS_218)
    const measured = cleanupBudget(WORDS_218, 275) // what the tokeniser reported
    expect(measured.maxTokens).not.toBe(estimated.maxTokens)
    expect(measured.totalTimeoutMs).toBeGreaterThan(7_048)
  })

  it('survives empty input without dividing by zero', () => {
    const b = cleanupBudget('')
    expect(b.maxTokens).toBeGreaterThan(0)
    expect(Number.isFinite(b.totalTimeoutMs)).toBe(true)
  })
})

describe('stall is not slowness', () => {
  it('keeps the stall window fixed, however long the dictation', () => {
    // A stalled model must be caught quickly whatever the length; only the
    // total allowance grows. Conflating the two is what produced the bug.
    const short = cleanupBudget('hello')
    const long = cleanupBudget('x'.repeat(5_000))
    expect(short.stallTimeoutMs).toBe(long.stallTimeoutMs)
    expect(short.stallTimeoutMs).toBeLessThanOrEqual(5_000)
  })

  it('allows longer for the first token, which pays for prompt processing', () => {
    const short = cleanupBudget('hello')
    const long = cleanupBudget('x'.repeat(5_000))
    expect(long.firstTokenTimeoutMs).toBeGreaterThan(short.firstTokenTimeoutMs)
    expect(short.firstTokenTimeoutMs).toBeGreaterThan(short.stallTimeoutMs / 2)
  })

  it('leaves the total above the first-token allowance', () => {
    const b = cleanupBudget('x'.repeat(2_000))
    expect(b.totalTimeoutMs).toBeGreaterThan(b.firstTokenTimeoutMs)
  })
})

describe('token estimation', () => {
  it('is close to what the model reported for a real transcript', () => {
    // Measured: 218 words of Hinglish tokenised to 275 tokens.
    const estimate = estimateTokens('x'.repeat(CHARS_218))
    expect(estimate).toBeGreaterThan(200)
  })

  it('never under-counts Devanagari, which is the expensive script', () => {
    // 0.23 tokens/char measured; the constant must sit above that.
    const devanagari = 'मुझे यह काम कल सुबह तक पूरा करना है'
    expect(estimateTokens(devanagari)).toBeGreaterThanOrEqual(devanagari.length * 0.23)
  })
})

describe('predicting how long it will take', () => {
  it('is separate from the giving-up point, and smaller', () => {
    // One answers "how long will this take", the other "when do I give up".
    // The old code had a single number quietly serving as both.
    const text = 'x'.repeat(1_200)
    expect(estimateCleanupMs(text)).toBeLessThan(cleanupBudget(text).totalTimeoutMs)
  })

  it('lands near the measurements it came from', () => {
    // 100 words measured 3418ms; 218 words measured 7048ms.
    const hundred = estimateCleanupMs('word '.repeat(100).trim())
    expect(hundred).toBeGreaterThan(1_000)
    expect(hundred).toBeLessThan(8_000)
  })
})

describe('parsing the token stream', () => {
  const frame = (content: string): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`

  it('reads deltas in order', () => {
    const r = consumeSse('', frame('Hello') + frame(' world'))
    expect(r.deltas).toEqual(['Hello', ' world'])
    expect(r.done).toBe(false)
  })

  it('holds back a frame split across two reads', () => {
    // The case that silently drops text: a chunk boundary mid-JSON.
    const whole = frame('Hello')
    const cut = Math.floor(whole.length / 2)
    const first = consumeSse('', whole.slice(0, cut))
    expect(first.deltas).toEqual([])
    const second = consumeSse(first.rest, whole.slice(cut))
    expect(second.deltas).toEqual(['Hello'])
  })

  it('reassembles a delta split across three reads', () => {
    const whole = frame('नमस्ते')
    let buffer = ''
    const out: string[] = []
    for (const piece of [whole.slice(0, 10), whole.slice(10, 25), whole.slice(25)]) {
      const r = consumeSse(buffer, piece)
      buffer = r.rest
      out.push(...r.deltas)
    }
    expect(out.join('')).toBe('नमस्ते')
  })

  it('treats the end sentinel as an end, not as JSON', () => {
    const r = consumeSse('', frame('hi') + 'data: [DONE]\n')
    expect(r.deltas).toEqual(['hi'])
    expect(r.done).toBe(true)
  })

  it('reports the finish reason, so truncation is visible', () => {
    const r = consumeSse(
      '',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n`
    )
    expect(r.finishReason).toBe('length')
    expect(r.done).toBe(true)
  })

  it('skips keep-alive and comment lines', () => {
    const r = consumeSse('', `: ping\n\n${frame('x')}`)
    expect(r.deltas).toEqual(['x'])
  })

  it('keeps good frames when one is unreadable', () => {
    const r = consumeSse('', frame('a') + 'data: {not json}\n' + frame('b'))
    expect(r.deltas).toEqual(['a', 'b'])
  })

  it('yields a final frame that arrived without a trailing newline', () => {
    // Some servers end the stream mid-line. Held-back text is normally half a
    // frame in flight, but at end of stream nothing more is coming and the last
    // delta would simply vanish.
    const partial = consumeSse('', frame('start') + 'data: {"choices":[{"delta":{"content":"end"}}]}')
    expect(partial.deltas).toEqual(['start'])
    const flushed = consumeSse(partial.rest, '\n')
    expect(flushed.deltas).toEqual(['end'])
  })

  it('raises an error the server reported', () => {
    expect(() =>
      consumeSse('', `data: ${JSON.stringify({ error: { message: 'context exceeded' } })}\n`)
    ).toThrow(/context exceeded/)
  })

  it('ignores empty deltas, which arrive as role-only frames', () => {
    const r = consumeSse('', `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n`)
    expect(r.deltas).toEqual([])
  })
})
