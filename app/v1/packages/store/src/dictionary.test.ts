import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './db.js'
import { Dictionary, validateEntry } from './dictionary.js'

describe('validating an entry', () => {
  const correction = (hear: string, write: string) =>
    validateEntry({ kind: 'correction', hear, write })

  it('accepts a specific phrase', () => {
    expect(correction('cloud code', 'Claude Code').ok).toBe(true)
  })

  it('refuses a short single word, which appears inside other words', () => {
    // The rule the seed dictionary documents by leaving these out: "cloud" ->
    // "Claude" breaks "cloud storage" and "Cloudflare".
    const r = correction('teh', 'the')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/inside other words|term instead/i)
  })

  it('accepts a short word once it is part of a phrase', () => {
    expect(correction('teh api', 'the API').ok).toBe(true)
  })

  it('accepts a long single word, which is specific enough to be safe', () => {
    expect(correction('kubernetis', 'Kubernetes').ok).toBe(true)
  })

  it('refuses a rewrite to itself', () => {
    expect(correction('hello there', 'hello there').ok).toBe(false)
  })

  it('allows a change of capitalisation only', () => {
    // "json file" -> "JSON file" is the single most useful kind of correction.
    expect(correction('json file', 'JSON file').ok).toBe(true)
  })

  it('needs both halves of a correction', () => {
    expect(correction('something', '').ok).toBe(false)
    expect(correction('', 'something').ok).toBe(false)
  })

  it('lets a term be a single short word, since it rewrites nothing', () => {
    // A term only biases the recogniser, so it cannot damage anything.
    expect(validateEntry({ kind: 'term', hear: 'Raj', write: '' }).ok).toBe(true)
  })

  it('refuses a trigger too long to match reliably', () => {
    expect(correction('x'.repeat(200), 'y').ok).toBe(false)
  })

  it('ignores surrounding whitespace when judging', () => {
    expect(correction('  teh  ', ' the ').ok).toBe(false)
  })
})

describe('storing entries', () => {
  let db: Db
  let dict: Dictionary

  beforeEach(() => {
    db = openDb({ file: ':memory:' })
    dict = new Dictionary(db)
  })
  afterEach(() => db.close())

  const entry = (patch = {}) => ({
    kind: 'correction',
    hear: 'cloud code',
    write: 'Claude Code',
    enabled: true,
    ...patch,
  })

  it('round-trips an entry', () => {
    const id = dict.add(entry())
    expect(id).not.toBeNull()
    const back = dict.byId(id)
    expect(back).toMatchObject({ kind: 'correction', hear: 'cloud code', write: 'Claude Code' })
    expect(back?.hits).toBe(0)
  })

  it('refuses a duplicate trigger without overwriting the first', () => {
    dict.add(entry())
    expect(dict.add(entry({ write: 'Something Else' }))).toBeNull()
    expect(dict.all()[0]?.write).toBe('Claude Code')
  })

  it('treats a term and a correction with the same trigger as different rules', () => {
    dict.add(entry({ kind: 'term', write: '' }))
    expect(dict.add(entry())).not.toBeNull()
    expect(dict.count()).toBe(2)
  })

  it('lists newest first, so a rule just added is visible', () => {
    dict.add(entry({ hear: 'first phrase' }))
    dict.add(entry({ hear: 'second phrase' }))
    expect(dict.all()[0]?.hear).toBe('second phrase')
  })

  it('applies longer triggers first, so a phrase beats a word inside it', () => {
    // Ordering matters: "cloud code" must win over "cloud" wherever both exist.
    dict.add(entry({ hear: 'cloud' }))
    dict.add(entry({ hear: 'cloud code editor' }))
    dict.add(entry({ hear: 'cloud code' }))
    expect(dict.active().map((e) => e.hear)).toEqual(['cloud code editor', 'cloud code', 'cloud'])
  })

  it('leaves a disabled rule out of what the pipeline applies', () => {
    dict.add(entry({ enabled: false }))
    expect(dict.all()).toHaveLength(1)
    expect(dict.active()).toHaveLength(0)
  })

  it('updates without disturbing the fields not named', () => {
    const id = dict.add(entry())
    dict.update(id, { enabled: false })
    expect(dict.byId(id)).toMatchObject({ hear: 'cloud code', write: 'Claude Code', enabled: false })
  })

  it('keeps a term free of a replacement even if one is supplied', () => {
    const id = dict.add(entry({ kind: 'term', write: '' }))
    dict.update(id, { write: 'sneaky' })
    expect(dict.byId(id)?.write).toBe('')
  })

  it('removes an entry', () => {
    const id = dict.add(entry())
    dict.remove(id)
    expect(dict.byId(id)).toBeNull()
  })

  it('ignores an update or removal of something that is not there', () => {
    expect(() => dict.update(999, { enabled: false })).not.toThrow()
    expect(() => dict.remove(999)).not.toThrow()
  })

  it('counts hits so a rule that never fires is visible', () => {
    dict.add(entry())
    dict.add(entry({ hear: 'other phrase' }))
    dict.recordHits([{ hear: 'cloud code', count: 3 }])
    dict.recordHits([{ hear: 'cloud code', count: 1 }])
    const all = dict.all()
    expect(all.find((e) => e.hear === 'cloud code')?.hits).toBe(4)
    expect(all.find((e) => e.hear === 'other phrase')?.hits).toBe(0)
  })

  it('never throws when counting hits for a rule that was deleted mid-dictation', () => {
    expect(() => dict.recordHits([{ hear: 'gone', count: 1 }])).not.toThrow()
  })
})
