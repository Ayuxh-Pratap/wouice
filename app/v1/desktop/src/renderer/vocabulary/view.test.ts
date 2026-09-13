import { describe, expect, it } from 'vitest'
import type { VocabularyEntry, VocabularySuggestion } from '../../shared/ipc.js'
import {
  draftFor,
  historyLine,
  notWords,
  quoteParts,
  reviewKey,
  reviewMeta,
  seenLabel,
  shortAgo,
  summary,
  tabsFor,
  wordsIn,
} from './view.js'

const DAY = 86_400_000
const now = new Date(2026, 8, 13, 15, 0).getTime()

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

const suggestion = (over: Partial<VocabularySuggestion>): VocabularySuggestion => ({
  id: next++,
  type: 'new',
  term: 'Naman',
  heard: '',
  kind: 'person',
  evidence: [{ meetingId: 1, quote: 'Again, Naman bhai, here this is not coming', at: now - DAY }],
  meetings: 1,
  state: 'suggested',
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const claude = entry('Claude', { kind: 'tool', aliases: [{ text: 'Lord', rewrite: false }], meetings: 5, lastSeenAt: now - 2 * DAY })
const bible = entry('Bible', { meaning: "the team's knowledge-base document" })
const himanshu = entry('Himanshu', { kind: 'person', source: 'roster', pinned: true })
const gone = entry('Ajay', { kind: 'person', source: 'roster', state: 'rejected' })
const all = [claude, bible, himanshu, gone]

describe('the tabs', () => {
  it('count the words in each, show Places and Not words only when they hold something', () => {
    expect(tabsFor(all, 0).map((t) => `${t.label} ${t.badge}`)).toEqual(['All 3', 'People 1', 'Products 0', 'Tools 1', 'Terms 1'])
    const withPlace = [...all, entry('Bengaluru', { kind: 'place' })]
    expect(tabsFor(withPlace, 2).map((t) => t.id)).toEqual(['all', 'person', 'product', 'tool', 'term', 'place', 'not'])
  })
})

describe('what a tab shows', () => {
  it('finds a word by its spelling, a sound-alike or its meaning, never one that is out', () => {
    expect(wordsIn('all', all, 'lord').map((e) => e.term)).toEqual(['Claude'])
    expect(wordsIn('all', all, 'knowledge').map((e) => e.term)).toEqual(['Bible'])
    expect(wordsIn('person', all, '').map((e) => e.term)).toEqual(['Himanshu'])
  })

  it('sums the list up in one line', () => {
    expect(summary(all)).toBe('3 words · 1 from Meet · 1 always sent')
    expect(summary([bible])).toBe('1 word')
  })
})

describe('when a word was heard', () => {
  it('reads short in the column', () => {
    expect(shortAgo(now - 60_000, now)).toBe('today')
    expect(shortAgo(now - 3 * DAY, now)).toBe('3d')
    expect(shortAgo(now - 15 * DAY, now)).toBe('2w')
    expect(seenLabel(claude, now)).toBe('5 · 2d')
    expect(seenLabel(bible, now)).toBe('—')
  })

  it('reads as a sentence in the editor and under a suggestion', () => {
    expect(historyLine(bible, now)).toBe('Not in a meeting yet · added by you')
    expect(historyLine({ ...himanshu, meetings: 1, lastSeenAt: now - DAY }, now)).toBe('1 meeting, last yesterday · from a Meet call')
    expect(reviewMeta(suggestion({ meetings: 2 }), now)).toBe('2 meetings · last yesterday')
  })
})

describe('a suggestion', () => {
  it('marks its word in its quote', () => {
    expect(quoteParts(suggestion({}))).toEqual({ before: 'Again, ', word: 'Naman', after: ' bhai, here this is not coming' })
    const coin = suggestion({ type: 'heard', term: 'Qwen', heard: 'coin', evidence: [{ meetingId: 2, quote: 'this Coin three', at: now }] })
    expect(quoteParts(coin)).toEqual({ before: 'this ', word: 'Coin', after: ' three' })
  })

  it('is answered by a key only when nothing else wants the keyboard', () => {
    expect(reviewKey('y', false, false)).toBe('add')
    expect(reviewKey('N', false, false)).toBe('reject')
    expect(reviewKey('ArrowRight', false, false)).toBe('next')
    expect(reviewKey('y', false, true)).toBeNull()
    expect(reviewKey('e', true, false)).toBeNull()
    expect(reviewKey('x', false, false)).toBeNull()
  })

  it('fills the editor: a new word as found, a sound-alike added to its entry', () => {
    expect(draftFor(suggestion({}), all)).toEqual({ term: 'Naman', kind: 'person', aliases: [], meaning: '', pinned: false })
    const lord = suggestion({ type: 'heard', term: 'Claude', heard: 'Klod', kind: 'tool' })
    expect(draftFor(lord, all)).toMatchObject({ id: claude.id, aliases: [{ text: 'Lord', rewrite: false }, { text: 'Klod', rewrite: false }] })
  })
})

describe('not words', () => {
  it('say why each is out', () => {
    const turned = suggestion({ state: 'rejected', term: 'Shuld Reds' })
    const notThis = suggestion({ state: 'rejected', type: 'heard', term: 'Qwen', heard: 'coin' })
    expect(notWords(all, [turned, notThis]).map((n) => `${n.term}: ${n.why}`)).toEqual([
      'Ajay: removed from a Meet call',
      'coin: heard as → Qwen, turned down',
      'Shuld Reds: turned down',
    ])
  })
})
