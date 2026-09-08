import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './db.js'
import { Dictations } from './dictations.js'
import { A4_SAMPLE_TARGET, A4_SHIP_TARGET, Ratings } from './ratings.js'
import type { DictationRecord } from './types.js'

const base: DictationRecord = {
  at: 1_000,
  audioMs: 5_000,
  asrMs: 400,
  llmMs: 600,
  totalMs: 1_000,
  chunks: 0,
  asrModel: 'turbo',
  llmModel: 'qwen3-4b',
  language: 'english',
  rawChars: 20,
  finalChars: 22,
  corrections: 0,
  degraded: null,
  raw: 'hello world',
  corrected: 'hello world',
  sentSystem: 'system',
  sentUser: 'hello world',
  received: 'Hello, world.',
  applied: [],
  capture: null,
  audioPath: null,
  inserted: false,
  delivery: 'copy',
  targetExe: '',
  deliveryNote: '',
}

const at = (n: number, patch: Partial<DictationRecord> = {}): DictationRecord => ({
  ...base,
  at: n,
  ...patch,
})

describe('rating what the app produced', () => {
  let db: Db
  let dictations: Dictations
  let ratings: Ratings

  beforeEach(() => {
    db = openDb({ file: ':memory:' })
    dictations = new Dictations(db)
    ratings = new Ratings(db)
  })
  afterEach(() => db.close())

  it('records a verdict and reads it back', () => {
    dictations.insert(at(1))
    ratings.set(1, true, 'clean')
    expect(ratings.byDictation(1)).toMatchObject({ dictationAt: 1, ship: true, note: 'clean' })
  })

  it('replaces a verdict rather than stacking a second one', () => {
    // A sheet you cannot correct is one misclick away from a wrong number, and
    // the number is the whole point.
    dictations.insert(at(1))
    ratings.set(1, true)
    ratings.set(1, false, 'changed my mind')
    expect(ratings.all()).toHaveLength(1)
    expect(ratings.byDictation(1)).toMatchObject({ ship: false, note: 'changed my mind' })
  })

  it('forgets a verdict when asked', () => {
    dictations.insert(at(1))
    ratings.set(1, true)
    ratings.clear(1)
    expect(ratings.byDictation(1)).toBeNull()
  })

  it('goes away with the dictation it judged', () => {
    // Deleting your history has to take the opinions about it too, or the
    // scoreboard counts rows whose text no longer exists.
    dictations.insert(at(1))
    ratings.set(1, true)
    dictations.deleteAt([1])
    expect(ratings.byDictation(1)).toBeNull()
    expect(ratings.progress().rated).toBe(0)
  })
})

describe('the queue of things still to judge', () => {
  let db: Db
  let dictations: Dictations
  let ratings: Ratings

  beforeEach(() => {
    db = openDb({ file: ':memory:' })
    dictations = new Dictations(db)
    ratings = new Ratings(db)
    for (const n of [3, 1, 2]) dictations.insert(at(n))
  })
  afterEach(() => db.close())

  it('offers the oldest first, so the queue does not reshuffle as you dictate', () => {
    expect(dictations.nextUnrated().next?.at).toBe(1)
  })

  it('moves on once one is judged', () => {
    ratings.set(1, true)
    expect(dictations.nextUnrated().next?.at).toBe(2)
  })

  it('counts what is left', () => {
    expect(dictations.nextUnrated().remaining).toBe(3)
    ratings.set(1, false)
    expect(dictations.nextUnrated().remaining).toBe(2)
  })

  it('runs out cleanly rather than returning something already judged', () => {
    for (const n of [1, 2, 3]) ratings.set(n, true)
    expect(dictations.nextUnrated()).toEqual({ next: null, remaining: 0 })
  })
})

describe('progress towards A4', () => {
  let db: Db
  let dictations: Dictations
  let ratings: Ratings

  beforeEach(() => {
    db = openDb({ file: ':memory:' })
    dictations = new Dictations(db)
    ratings = new Ratings(db)
  })
  afterEach(() => db.close())

  const rate = (n: number, ship: boolean, language = 'english'): void => {
    dictations.insert(at(n, { language }))
    ratings.set(n, ship)
  }

  it('starts at nothing rather than at a pass', () => {
    const p = ratings.progress()
    expect(p).toMatchObject({ rated: 0, shipped: 0, met: false })
    expect(p.sampleTarget).toBe(A4_SAMPLE_TARGET)
    expect(p.shipTarget).toBe(A4_SHIP_TARGET)
  })

  it('will not report a pass off a handful of good ones', () => {
    // Both halves have to hold. Three out of three is not seventeen out of
    // twenty, and reporting it as met would be worse than reporting nothing.
    for (let n = 1; n <= 3; n++) rate(n, true)
    expect(ratings.progress()).toMatchObject({ rated: 3, shipped: 3, met: false })
  })

  it('meets the criterion at exactly the stated numbers', () => {
    for (let n = 1; n <= A4_SHIP_TARGET; n++) rate(n, true)
    for (let n = A4_SHIP_TARGET + 1; n <= A4_SAMPLE_TARGET; n++) rate(n, false)
    expect(ratings.progress()).toMatchObject({
      rated: A4_SAMPLE_TARGET,
      shipped: A4_SHIP_TARGET,
      met: true,
    })
  })

  it('fails one short of the ship target even with enough samples', () => {
    for (let n = 1; n <= A4_SHIP_TARGET - 1; n++) rate(n, true)
    for (let n = A4_SHIP_TARGET; n <= A4_SAMPLE_TARGET; n++) rate(n, false)
    expect(ratings.progress().met).toBe(false)
  })

  it('breaks out the Hinglish half, which is what A4 actually asks about', () => {
    rate(1, true, 'hindi')
    rate(2, false, 'hindi')
    rate(3, true, 'english')
    const p = ratings.progress()
    expect(p).toMatchObject({ rated: 3, shipped: 2, hinglishRated: 2, hinglishShipped: 1 })
  })
})
