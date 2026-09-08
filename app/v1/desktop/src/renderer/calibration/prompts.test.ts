import { describe, expect, it } from 'vitest'
import { PROMPTS, ago, languageNotes, pretty, verdictFor } from './prompts.js'

/**
 * These are the words a person reads during setup. They are tested for the same
 * reason the algorithm is: a sentence that leaks a decimal, or tells someone
 * their Hindi failed when it did not, is a defect with a user on the other end
 * of it.
 */

const NUMERIC = /\d/

describe('the prompts themselves', () => {
  it('covers the three languages, in order', () => {
    expect(PROMPTS.map((p) => p.label)).toEqual(['english', 'hindi', 'mixed'])
  })

  it('gives the Hindi prompt a transliteration, so it can be read either way', () => {
    const hindi = PROMPTS.find((p) => p.label === 'hindi')
    expect(hindi?.example).toMatch(/[ऀ-ॿ]/)
    expect(hindi?.romanised).toBeTruthy()
  })

  it('never puts a number in front of the user', () => {
    for (const p of PROMPTS) {
      expect(p.title, p.label).not.toMatch(NUMERIC)
      expect(p.ask, p.label).not.toMatch(NUMERIC)
    }
  })
})

describe('verdicts', () => {
  it('reads a clean separation as excellent', () => {
    // The measurement from the real 60-second recording was about 31x.
    const v = verdictFor('good', 31.4)
    expect(v.ok).toBe(true)
    expect(v.bars).toBe(4)
    expect(v.advice).toBe('')
  })

  it('passes a merely adequate separation, but says what would improve it', () => {
    const v = verdictFor('good', 5)
    expect(v.ok).toBe(true)
    expect(v.bars).toBe(2)
    expect(v.advice).toMatch(/headset/i)
  })

  it('fails a noisy room with something to actually do about it', () => {
    const v = verdictFor('weak', 2)
    expect(v.ok).toBe(false)
    expect(v.advice).toMatch(/quieter|headset/i)
  })

  it('tells someone with a dead microphone to check the microphone', () => {
    const v = verdictFor('unusable', 0)
    expect(v.ok).toBe(false)
    expect(v.advice).toMatch(/microphone/i)
  })

  it('never fails a result the analysis called good on separation alone', () => {
    for (const s of [4, 8, 15, 100]) expect(verdictFor('good', s).ok).toBe(true)
  })

  it('rejects a low separation even when the analysis called it good', () => {
    // Defence in depth: the band boundary lives in both places and must agree.
    expect(verdictFor('good', 3.9).ok).toBe(false)
  })

  it('shows no numbers anywhere in what the user reads', () => {
    for (const q of ['good', 'weak', 'unusable']) {
      for (const s of [0, 2, 5, 12, 31.4]) {
        const v = verdictFor(q, s)
        expect(v.headline, `${q}/${s}`).not.toMatch(NUMERIC)
        expect(v.advice, `${q}/${s}`).not.toMatch(NUMERIC)
        expect(v.grade, `${q}/${s}`).not.toMatch(NUMERIC)
      }
    }
  })

  it('gives more bars for more separation, never fewer', () => {
    const bars = [2, 5, 9, 20, 60].map((s) => verdictFor('good', s).bars)
    expect(bars).toEqual([...bars].sort((a, b) => a - b))
  })
})

describe('language notes', () => {
  const t = (label: 'english' | 'hindi' | 'mixed', language: string, text = 'something') => ({
    label,
    language,
    text,
  })

  it('confirms it plainly when Hindi was recognised as Hindi', () => {
    const notes = languageNotes([t('hindi', 'hi')])
    expect(notes.join(' ')).toMatch(/recognised as Hindi/i)
    expect(notes.join(' ')).not.toMatch(/rather than Hindi/i)
  })

  it('accepts the full name as well as the code', () => {
    expect(languageNotes([t('hindi', 'hindi')]).join(' ')).toMatch(/recognised as Hindi/i)
  })

  it('says what it heard instead, by name rather than by code', () => {
    const notes = languageNotes([t('hindi', 'ur')])
    expect(notes.join(' ')).toMatch(/Urdu/)
    expect(notes.join(' ')).not.toMatch(/\bur\b/)
  })

  it('explains the mixed-sentence behaviour, which is the recurring confusion', () => {
    expect(languageNotes([t('mixed', 'en')]).join(' ')).toMatch(/only one of them is recognised/i)
  })

  it('says nothing about a sample that produced no text', () => {
    expect(languageNotes([t('hindi', 'hi', ''), t('mixed', 'en', '')])).toEqual([])
  })

  it('reassures rather than alarms: every note ends up saying you get English', () => {
    for (const note of languageNotes([t('hindi', 'ur'), t('mixed', 'en')])) {
      expect(note).toMatch(/English/)
    }
  })
})

describe('language names', () => {
  it('translates the codes that actually turn up', () => {
    expect(pretty('en')).toBe('English')
    expect(pretty('hi')).toBe('Hindi')
    expect(pretty('HI')).toBe('Hindi')
  })

  it('falls back to something readable for a code it does not know', () => {
    expect(pretty('xx')).toBe('Xx')
    expect(pretty('')).toBe('something unclear')
  })
})

describe('ago', () => {
  const day = 86_400_000
  const now = 1_000 * day

  it('reads as a person would say it', () => {
    expect(ago(now, now)).toBe('today')
    expect(ago(now - day, now)).toBe('yesterday')
    expect(ago(now - 5 * day, now)).toBe('5 days ago')
    expect(ago(now - 45 * day, now)).toBe('a month ago')
    expect(ago(now - 200 * day, now)).toBe('6 months ago')
  })

  it('does not say "-1 days ago" when the clock has drifted forward', () => {
    expect(ago(now + day, now)).toBe('today')
  })
})
