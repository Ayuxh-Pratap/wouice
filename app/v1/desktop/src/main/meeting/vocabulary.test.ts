import type { VocabularyEntry } from '@wouice/store'
import { describe, expect, it } from 'vitest'
import {
  appears,
  asDictionary,
  entriesFor,
  glossaryFor,
  mentionedIn,
  parseKinds,
  parseVocabularyList,
  referenceLine,
  trackedGlossary,
  vocabularyUse,
} from './vocabulary.js'

let next = 1
const entry = (term: string, over: Partial<VocabularyEntry> = {}): VocabularyEntry => ({
  id: next++,
  term,
  kind: 'term',
  aliases: [],
  meaning: '',
  source: 'you',
  state: 'active',
  pinned: false,
  hits: 0,
  meetings: 0,
  lastSeenAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const claude = entry('Claude', { kind: 'tool', aliases: [{ text: 'Lord', rewrite: false }, { text: 'लॉर्ड', rewrite: false }], meaning: 'the AI we build with' })
const bump = entry('Finch', { kind: 'product' })
const bible = entry('Bible', { meaning: "the team's knowledge-base document", meetings: 5 })
const himanshu = entry('Himanshu', { kind: 'person' })
const ajay = entry('Ajay', { state: 'rejected' })
const pinned = entry('Wouice', { pinned: true })

describe('finding an entry in the text', () => {
  it('matches whole words in Latin script, and runs of characters in Devanagari', () => {
    expect(appears('Finch', 'the finch bot and Finchy')).toBe(true)
    expect(appears('Finch', 'we called it Finchy')).toBe(false)
    expect(appears('Phase 1', 'according to Phase 1, then')).toBe(true)
    expect(appears('लॉर्ड', 'कैप्शंस तू गिव तू मी लॉर्ड')).toBe(true)
  })

  it('finds an entry by any of its sound-alikes, never a rejected one', () => {
    expect(mentionedIn('captions to give to me Lord', [claude, bump, ajay]).map((e) => e.term)).toEqual(['Claude'])
    expect(mentionedIn('Ajay Ajay Ajay', [ajay])).toEqual([])
  })

  it('finds it by sound across scripts: a Latin sound-alike in Hindi captions, a name written in Devanagari', () => {
    const qwen = entry('Qwen', { kind: 'tool', aliases: [{ text: 'coin', rewrite: false }] })
    const onlyLatin = entry('Claude', { aliases: [{ text: 'Lord', rewrite: false }] })
    expect(mentionedIn('कैप्शंस तू गिव तू मी लॉर्ड', [onlyLatin, qwen]).map((e) => e.term)).toEqual(['Claude'])
    expect(mentionedIn('ये वाला क्वेन मॉडल', [onlyLatin, qwen]).map((e) => e.term)).toEqual(['Qwen'])
    expect(mentionedIn('we can do it', [qwen])).toEqual([])
  })

  it('ranks what was said lately above what has gone quiet', () => {
    const recent = entry('Atlas', { lastSeenAt: Date.now() - 86_400_000, meetings: 1 })
    const old = entry('Nirvana', { lastSeenAt: Date.now() - 200 * 86_400_000, meetings: 9 })
    expect(entriesFor('Nirvana and Atlas', [old, recent], { cap: 1 }).map((e) => e.term)).toEqual(['Atlas'])
  })

  it('sends nothing the text does not call for, however much is in the vocabulary', () => {
    const atlas = entry('Atlas', { meetings: 12 })
    const gemini = entry('Gemini', { meetings: 30 })
    const pinned = entry('Wouice', { pinned: true })
    expect(entriesFor('ऑल्टो भी आ जाएगी, how is it', [atlas, gemini, pinned]).map((e) => e.term)).toEqual(['Wouice'])
  })
})

describe('what a request gets', () => {
  it('puts what the text mentions first, then pinned entries and the people in the meeting - and nothing else', () => {
    const all = [bible, claude, bump, himanshu, ajay, pinned]
    const picked = entriesFor('I will give it to Lord', all, { people: ['Himanshu'], cap: 4 }).map((e) => e.term)
    expect(picked).toEqual(['Claude', 'Himanshu', 'Wouice'])
  })

  it('shows each entry with what it is heard as, and its meaning only for the notes', () => {
    expect(referenceLine(claude)).toBe('Claude (heard as: Lord, लॉर्ड)')
    expect(referenceLine(claude, true)).toBe('Claude (heard as: Lord, लॉर्ड; means: the AI we build with)')
    expect(referenceLine(bump, true)).toBe('Finch')
    expect(glossaryFor([bible], { meanings: true })('the bible')).toEqual(["Bible (means: the team's knowledge-base document)"])
  })

  it('gives a meaning only to an entry the text mentions, so it is never read as the topic', () => {
    const alwaysBible = { ...bible, pinned: true }
    expect(glossaryFor([alwaysBible, claude], { meanings: true })('give it to Lord')).toEqual([
      'Claude (heard as: Lord, लॉर्ड; means: the AI we build with)',
      'Bible',
    ])
  })
})

describe('the record of a run', () => {
  it('keeps every entry a request was given', () => {
    const tracked = trackedGlossary([claude, bump, pinned])
    tracked.glossary('give it to Lord')
    tracked.glossary('the finch bot')
    expect(tracked.used().map((e) => e.term).sort()).toEqual(['Claude', 'Finch', 'Wouice'])
  })

  it('says where each entry was said and written, and which lines wrote it unheard', () => {
    const atlas = entry('Atlas')
    const lines = [
      { startMs: 0, text: 'कैप्शंस तू गिव तू मी लॉर्ड', textEn: 'captions to give to Claude' },
      { startMs: 60_000, text: 'ऑल्टो भी आ जाएगी', textEn: 'Atlas will also come' },
      { startMs: 120_000, text: 'फिंच के लिए', textEn: 'for the Finch' },
    ]
    const use = vocabularyUse(lines, [claude, atlas, bump], [claude, atlas, bump, himanshu], 7)
    expect(use).toEqual({
      at: 7,
      sent: 3,
      entries: [
        { term: 'Atlas', said: 0, written: 1, as: [], unheard: 1, check: [{ atMs: 60_000, said: 'ऑल्टो भी आ जाएगी', written: 'Atlas will also come' }] },
        // "Lord" and "लॉर्ड" are one sound, so both were heard.
        { term: 'Claude', said: 1, written: 1, as: ['Lord', 'लॉर्ड'], unheard: 0, check: [] },
        { term: 'Finch', said: 1, written: 1, as: [], unheard: 0, check: [] },
      ],
    })
  })

  it('counts a name said a line or two before as heard', () => {
    const lines = [
      { startMs: 0, text: 'give it to Lord', textEn: 'give it to Claude' },
      { startMs: 1000, text: 'and then', textEn: 'and then Claude will answer' },
    ]
    expect(vocabularyUse(lines, [claude], [claude]).entries[0]).toMatchObject({ said: 1, written: 2, unheard: 0 })
  })
})

describe('a pasted list', () => {
  it('reads words a line, comma-separated lines, and a meaning after a dash or colon', () => {
    expect(
      parseVocabularyList(
        [
          'Ayush, Himanshu, Jeremy,',
          'Bible - the team\'s knowledge-base document',
          '- Showcase: where a release goes live',
          'Solana, devnet',
          'himanshu',
        ].join('\n')
      )
    ).toEqual([
      { term: 'Ayush', meaning: '' },
      { term: 'Himanshu', meaning: '' },
      { term: 'Jeremy', meaning: '' },
      { term: 'Bible', meaning: "the team's knowledge-base document" },
      { term: 'Showcase', meaning: 'where a release goes live' },
      { term: 'Solana', meaning: '' },
      { term: 'devnet', meaning: '' },
    ])
  })

  it('keeps a hyphenated name whole', () => {
    expect(parseVocabularyList('auto-buy, ping/pong')).toEqual([
      { term: 'auto-buy', meaning: '' },
      { term: 'ping/pong', meaning: '' },
    ])
  })

  it('takes the kinds the model gave, and nothing it made up', () => {
    const raw = '{"term":"Himanshu","kind":"person"}\n{"term":"Solana","kind":"tool"}\n{"term":"Mars","kind":"planet"}\nnot json'
    expect([...parseKinds(raw, ['Himanshu', 'Solana', 'Bible'])]).toEqual([
      ['Himanshu', 'person'],
      ['Solana', 'tool'],
    ])
  })
})

describe('the vocabulary in dictation', () => {
  it('hints every entry, and rewrites only sound-alikes marked for it', () => {
    const qwen = entry('Qwen', { aliases: [{ text: 'coin', rewrite: false }] })
    const code = entry('Claude Code', { aliases: [{ text: 'cloud code', rewrite: true }], hits: 2 })
    expect(asDictionary([qwen, code, ajay])).toEqual([
      { kind: 'term', hear: 'Qwen', enabled: true, hits: 0 },
      { kind: 'correction', hear: 'cloud code', write: 'Claude Code', enabled: true, hits: 2 },
      { kind: 'term', hear: 'Claude Code', enabled: true, hits: 2 },
    ])
  })
})
