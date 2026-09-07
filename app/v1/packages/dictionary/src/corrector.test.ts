import { describe, expect, it } from 'vitest'
import { correct } from './corrector.js'
import { biasPrompt, DEFAULT_BIAS_CHARS } from './bias.js'
import { SEED_DICTIONARY } from './seed.js'
import type { DictionaryEntry } from './types.js'
import vectors from './vectors.json' with { type: 'json' }

interface VectorCase {
  name: string
  why: string
  entries: { kind: string; hear: string; write?: string; enabled?: boolean }[]
  input: string
  expected: string
  applied?: { from: string; to: string; count: number }[]
}

/**
 * vectors.json is the specification. These tests only execute it.
 *
 * If a case here fails, the question is which of the two is wrong: the
 * corrector, or the documented behaviour. Change the vector deliberately, or
 * fix the code. Never quietly relax a vector to make a build green.
 */
describe('correct() against vectors.json', () => {
  const cases = (vectors as { cases: VectorCase[] }).cases

  it('has vectors to run', () => {
    expect(cases.length).toBeGreaterThan(10)
  })

  for (const c of cases) {
    it(`${c.name} - ${c.why}`, () => {
      // `enabled` defaults to true so vectors stay readable; only the disabled
      // case has to say so explicitly.
      const entries = c.entries.map(
        (e) => ({ ...e, enabled: e.enabled ?? true }) as DictionaryEntry
      )
      const result = correct(c.input, entries)
      expect(result.text).toBe(c.expected)
      if (c.applied) {
        expect(result.applied).toEqual(c.applied)
      }
    })
  }
})

describe('correct() invariants', () => {
  const entry = (hear: string, write: string): DictionaryEntry => ({
    kind: 'correction',
    hear,
    write,
    enabled: true,
  })

  it('is idempotent: correcting twice equals correcting once', () => {
    // Load-bearing. Chunked transcription may hand overlapping text through the
    // corrector more than once, and a second pass must not compound.
    const entries = [entry('cloud code', 'Claude Code'), entry('super base', 'Supabase')]
    const once = correct('open cloud code with super base', entries).text
    const twice = correct(once, entries).text
    expect(twice).toBe(once)
  })

  it('leaves text without matches byte-identical apart from NFC', () => {
    const entries = [entry('cloud code', 'Claude Code')]
    const input = 'nothing here matches at all'
    expect(correct(input, entries).text).toBe(input)
  })

  it('reports no corrections when none fired', () => {
    expect(correct('quiet text', [entry('zzz', 'ZZZ')]).applied).toEqual([])
  })

  it('handles an empty string', () => {
    expect(correct('', [entry('a', 'b')])).toEqual({ text: '', applied: [] })
  })

  it('does not let a longer rule listed second lose to a shorter one', () => {
    // Insertion order must not matter; only trigger length does.
    const asc = [entry('cloud', 'Claude'), entry('cloud code', 'Claude Code')]
    const desc = [entry('cloud code', 'Claude Code'), entry('cloud', 'Claude')]
    expect(correct('cloud code', asc).text).toBe('Claude Code')
    expect(correct('cloud code', desc).text).toBe('Claude Code')
  })
})

describe('biasPrompt()', () => {
  it('returns empty for an empty dictionary', () => {
    expect(biasPrompt([])).toBe('')
  })

  it('never exceeds the character budget', () => {
    // The cap is the whole point: a long initial prompt makes Whisper drift and
    // invent text on quiet audio.
    const prompt = biasPrompt(SEED_DICTIONARY)
    expect(prompt.length).toBeLessThanOrEqual(DEFAULT_BIAS_CHARS)
  })

  it('biases toward the CORRECTED spelling, never the mistake', () => {
    const prompt = biasPrompt([
      { kind: 'correction', hear: 'cloud code', write: 'Claude Code', enabled: true },
    ])
    expect(prompt).toContain('Claude Code')
    expect(prompt).not.toContain('cloud code')
  })

  it('puts frequently-corrected terms first, since budget is scarce', () => {
    const prompt = biasPrompt(
      [
        { kind: 'term', hear: 'Rarely', enabled: true, hits: 0 },
        { kind: 'term', hear: 'Often', enabled: true, hits: 99 },
      ],
      { maxChars: 200 }
    )
    expect(prompt.indexOf('Often')).toBeLessThan(prompt.indexOf('Rarely'))
  })

  it('is deterministic, because a changing prompt changes the transcript', () => {
    const a = biasPrompt(SEED_DICTIONARY)
    const b = biasPrompt([...SEED_DICTIONARY].reverse())
    expect(a).toBe(b)
  })

  it('skips disabled entries and de-duplicates', () => {
    const prompt = biasPrompt([
      { kind: 'term', hear: 'Alpha', enabled: true },
      { kind: 'term', hear: 'alpha', enabled: true },
      { kind: 'term', hear: 'Hidden', enabled: false },
    ])
    expect(prompt).not.toContain('Hidden')
    expect(prompt.match(/alpha/gi)?.length).toBe(1)
  })
})

describe('SEED_DICTIONARY', () => {
  it('contains no correction that would damage a legitimate word', () => {
    // The two known traps, asserted so nobody re-adds them casually.
    const triggers = SEED_DICTIONARY.map((e) => e.hear.toLowerCase())
    expect(triggers).not.toContain('cloud') // breaks "cloud storage", "Cloudflare"
    expect(triggers).not.toContain('jason') // breaks anyone named Jason
  })

  it('every correction has a non-empty replacement', () => {
    for (const e of SEED_DICTIONARY) {
      if (e.kind === 'correction') expect(e.write.trim().length).toBeGreaterThan(0)
    }
  })

  it('survives a realistic Hinglish sentence without mangling it', () => {
    const input = 'mujhe cloud code se super base ka api integrate karna hai'
    const { text } = correct(input, SEED_DICTIONARY)
    expect(text).toBe('mujhe Claude Code se Supabase ka API integrate karna hai')
  })
})
