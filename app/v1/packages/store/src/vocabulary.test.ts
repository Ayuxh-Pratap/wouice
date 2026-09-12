import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from './db.js'
import { LATEST_VERSION } from './migrations.js'
import type { VocabularyInput } from './types.js'
import { Vocabulary } from './vocabulary.js'

/** In memory: nothing to clean up, and nothing Windows can hold open. */
function fresh(): { vocabulary: Vocabulary } {
  return { vocabulary: new Vocabulary(openDb({ file: ':memory:' })) }
}

// The one test that needs a real file, to reopen it at a new version.
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A file Windows still holds for a moment is the temp folder's to clear.
    }
  }
})

const entry = (term: string, over: Partial<VocabularyInput> = {}): VocabularyInput => ({
  term,
  kind: 'term',
  aliases: [],
  meaning: '',
  pinned: false,
  source: 'you',
  state: 'active',
  ...over,
})

describe('the vocabulary', () => {
  it('keeps a term with its sound-alikes and meaning', () => {
    const { vocabulary } = fresh()
    const id = vocabulary.add(
      entry('Claude', { kind: 'tool', aliases: [{ text: 'Lord', rewrite: false }, { text: 'लॉर्ड', rewrite: false }], meaning: 'the AI we build with' })
    )!
    expect(vocabulary.byId(id)).toMatchObject({
      term: 'Claude',
      kind: 'tool',
      aliases: [{ text: 'Lord', rewrite: false }, { text: 'लॉर्ड', rewrite: false }],
      meaning: 'the AI we build with',
      source: 'you',
      state: 'active',
      meetings: 0,
      lastSeenAt: null,
    })
  })

  it('has each term once, whatever its capitals, and each sound-alike once', () => {
    const { vocabulary } = fresh()
    expect(vocabulary.add(entry('Finch Bot'))).not.toBeNull()
    expect(vocabulary.add(entry('finch bot'))).toBeNull()
    const id = vocabulary.add(entry('Qwen', { aliases: [{ text: 'coin', rewrite: false }, { text: 'Coin', rewrite: true }, { text: 'qwen', rewrite: false }] }))!
    expect(vocabulary.byId(id)!.aliases).toEqual([{ text: 'coin', rewrite: false }])
  })

  it('will not rename an entry onto another one', () => {
    const { vocabulary } = fresh()
    vocabulary.add(entry('Bible'))
    const id = vocabulary.add(entry('Bibel'))!
    expect(vocabulary.update(id, { term: 'bible' })).toBe(false)
    expect(vocabulary.update(id, { term: 'Bible doc', meaning: 'the knowledge base' })).toBe(true)
    expect(vocabulary.byId(id)).toMatchObject({ term: 'Bible doc', meaning: 'the knowledge base' })
  })

  it('adds the people on a call, but never over one you changed or said is not a word', () => {
    const { vocabulary } = fresh()
    vocabulary.add(entry('Himanshu', { kind: 'person', meaning: 'engineer' }))
    vocabulary.add(entry('Ajay', { state: 'rejected' }))
    const added = vocabulary.addPeople(['Himanshu', 'Ajay', 'Jeremy Shapiro', '  ', 'Jeremy Shapiro'])
    expect(added).toHaveLength(1)
    expect(vocabulary.byTerm('Jeremy Shapiro')).toMatchObject({ kind: 'person', source: 'roster', state: 'active' })
    expect(vocabulary.byTerm('Himanshu')).toMatchObject({ source: 'you', meaning: 'engineer' })
    expect(vocabulary.byTerm('Ajay')!.state).toBe('rejected')
    expect(vocabulary.active().map((e) => e.term)).toEqual(['Himanshu', 'Jeremy Shapiro'])
  })

  it('counts the meetings an entry came up in, once each', () => {
    const { vocabulary } = fresh()
    const id = vocabulary.add(entry('Showcase'))!
    vocabulary.markSeen([id], 10, 1000)
    vocabulary.markSeen([id], 10, 2000)
    vocabulary.markSeen([id], 11, 3000)
    expect(vocabulary.byId(id)).toMatchObject({ meetings: 2, lastSeenAt: 3000 })
    vocabulary.remove(id)
    expect(vocabulary.count()).toBe(0)
  })

  it('counts a dictation rewrite on the entry whose sound-alike fired', () => {
    const { vocabulary } = fresh()
    const id = vocabulary.add(entry('Claude Code', { aliases: [{ text: 'cloud code', rewrite: true }] }))!
    vocabulary.recordHits([{ text: 'Cloud Code', count: 3 }, { text: 'unknown', count: 9 }])
    expect(vocabulary.byId(id)!.hits).toBe(3)
  })

  it('keeps a new word quietly until a second meeting, and counts one meeting once', () => {
    const { vocabulary } = fresh()
    const found = { type: 'new' as const, term: 'Rahul', kind: 'person' as const, quote: 'the Rahul branch' }
    expect(vocabulary.propose({ ...found, meetingId: 10 })).toBe('candidate')
    expect(vocabulary.propose({ ...found, meetingId: 10, quote: 'again' })).toBe('candidate')
    expect(vocabulary.suggestions()).toEqual([])
    expect(vocabulary.propose({ ...found, meetingId: 14 })).toBe('suggested')
    expect(vocabulary.suggestions()).toMatchObject([{ term: 'Rahul', kind: 'person', meetings: 2 }])
  })

  it('shows a new word backed by something outside the transcript at once', () => {
    const { vocabulary } = fresh()
    expect(vocabulary.propose({ type: 'new', term: 'Omar', meetingId: 11, quote: 'Omar will send it', corroborated: true })).toBe('suggested')
  })

  it('shows a mishearing of an entry you have at once, and takes it as a sound-alike', () => {
    const { vocabulary } = fresh()
    const claude = vocabulary.add(entry('Claude', { kind: 'tool' }))!
    expect(vocabulary.propose({ type: 'heard', term: 'claude', heard: 'Lord', meetingId: 16, quote: 'give to me Lord' })).toBe('suggested')
    const [s] = vocabulary.suggestions()
    expect(s).toMatchObject({ type: 'heard', term: 'Claude', heard: 'Lord' })
    expect(vocabulary.accept(s!.id)).toBe(claude)
    expect(vocabulary.byId(claude)!.aliases).toEqual([{ text: 'Lord', rewrite: false }])
    // Now a sound-alike it has, it is not suggested again.
    expect(vocabulary.propose({ type: 'heard', term: 'Claude', heard: 'Lord', meetingId: 17, quote: 'Lord again' })).toBeNull()
  })

  it('never suggests again what you said is not a word, or what is already an entry', () => {
    const { vocabulary } = fresh()
    vocabulary.add(entry('Bible'))
    expect(vocabulary.propose({ type: 'new', term: 'bible', meetingId: 1, quote: 'the bible' })).toBeNull()
    vocabulary.propose({ type: 'new', term: 'Ajay', meetingId: 1, quote: 'Ajay Ajay', corroborated: true })
    vocabulary.reject(vocabulary.suggestions()[0]!.id)
    expect(vocabulary.propose({ type: 'new', term: 'Ajay', meetingId: 2, quote: 'Ajay', corroborated: true })).toBe('rejected')
    expect(vocabulary.suggestions()).toEqual([])
    expect(vocabulary.suggestions(['rejected'])).toHaveLength(1)
  })

  it('adds an accepted new word as learned', () => {
    const { vocabulary } = fresh()
    vocabulary.propose({ type: 'new', term: 'Solana', kind: 'tool', meetingId: 1, quote: 'Solana mainnet', corroborated: true })
    const id = vocabulary.accept(vocabulary.suggestions()[0]!.id)!
    expect(vocabulary.byId(id)).toMatchObject({ term: 'Solana', kind: 'tool', source: 'learned', state: 'active' })
    expect(vocabulary.suggestions()).toEqual([])
  })

  it('takes in the old dictation dictionary when the database moves to this version', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wouice-vocab-'))
    dirs.push(dir)
    const file = path.join(dir, 'wouice.db')
    const first = openDb({ file })
    // As a database at the version before this one, with a dictionary in it.
    first.raw.exec('DROP TABLE vocabulary_suggestions; DROP TABLE vocabulary_seen; DROP TABLE vocabulary; PRAGMA user_version = 11')
    const add = first.raw.prepare('INSERT INTO dictionary (kind, hear, write, enabled, hits, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    add.run('correction', 'cloud code', 'Claude Code', 1, 4, 100)
    add.run('correction', 'claud code', 'Claude Code', 1, 1, 200)
    add.run('term', 'Himanshu', null, 1, 0, 300)
    add.run('term', 'Switched off', null, 0, 0, 400)
    first.close()

    const second = openDb({ file })
    expect(second.version).toBe(LATEST_VERSION)
    const vocabulary = new Vocabulary(second)
    // SQLite does not promise the order it groups in, so the sound-alikes are compared as a set.
    const moved = vocabulary.all().map((e) => [e.term, [...e.aliases].sort((a, b) => a.text.localeCompare(b.text)), e.hits])
    expect(moved).toEqual([
      ['Claude Code', [{ text: 'claud code', rewrite: true }, { text: 'cloud code', rewrite: true }], 5],
      ['Himanshu', [], 0],
    ])
    second.close()
  })
})
