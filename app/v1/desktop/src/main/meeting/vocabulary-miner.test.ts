import type { LlmClient, LlmRequest } from '@wouice/llm'
import type { VocabularyEntry } from '@wouice/store'
import { describe, expect, it } from 'vitest'
import { parseMined, soundsLike, VocabularyMiner } from './vocabulary-miner.js'

const entry = (id: number, term: string, over: Partial<VocabularyEntry> = {}): VocabularyEntry => ({
  id,
  term,
  kind: 'tool',
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
const known = [entry(1, 'Claude'), entry(2, 'Finch Bot', { kind: 'product' }), entry(3, 'Qwen')]
const lines = [
  { id: 101, text: 'I will copy the captions so that I have captions to give to me Lord', speaker: null },
  { id: 102, text: 'Rahul branch has the fix, tell Rahul to merge it', speaker: 'Ayush' },
  { id: 103, text: 'Ajay Ajay Ajay do it do it', speaker: null },
  { id: 104, text: 'tell me one thing, this model, its coin three four billion', speaker: null },
]

const answering = (text: string, requests: LlmRequest[] = []): LlmClient => ({
  async complete(req) {
    requests.push(req)
    return { text, latencyMs: 1, provider: 'local', model: 't' }
  },
  async health() {
    return { ok: true }
  },
})

describe('what a meeting suggests', () => {
  it('keeps findings whose quote is in the line they name', () => {
    const raw = [
      '{"type":"heard","entry":"Qwen","as":"coin","line":4,"quote":"its coin three four billion"}',
      '{"type":"new","term":"Rahul","kind":"person","line":2,"quote":"tell Rahul to merge it"}',
    ].join('\n')
    expect(parseMined(raw, lines, known)).toEqual([
      { type: 'heard', term: 'Qwen', heard: 'coin', kind: 'tool', lineId: 104, quote: 'its coin three four billion' },
      { type: 'new', term: 'Rahul', heard: '', kind: 'person', lineId: 102, quote: 'tell Rahul to merge it' },
    ])
  })

  it('takes a mishearing only when it sounds like its entry', () => {
    expect(soundsLike('coin', 'Qwen')).toBe(true)
    expect(soundsLike('ask finch', 'Ask Finch')).toBe(true)
    expect(soundsLike('AskFinsh', 'Ask Finch')).toBe(true)
    // What the model offered when asked for mishearings - none of them sounds like its entry.
    expect(soundsLike('Jack', 'Claude')).toBe(false)
    expect(soundsLike('eyes', 'FAQ')).toBe(false)
    expect(soundsLike('open it again', 'OpenAI')).toBe(false)
    expect(soundsLike('brunch', 'Finch')).toBe(false)
    expect(soundsLike('Web3', 'Wouice')).toBe(false)
    expect(soundsLike('bum', 'Bible')).toBe(false)
    // Two sounds apart: a real mishearing, and still left for you to add.
    const raw = '{"type":"heard","entry":"Claude","as":"Lord","line":1,"quote":"captions to give to me Lord"}'
    expect(parseMined(raw, lines, known)).toEqual([])
  })

  it('never takes a word with the entry inside it for a mishearing of it', () => {
    const named = [{ id: 9, text: 'we gotta change the name of Finchy', speaker: null }]
    const raw = '{"type":"heard","entry":"Finch Bot","as":"Finchy","line":1,"quote":"change the name of Finchy"}'
    expect(parseMined(raw, named, [...known, entry(4, 'Finch', { kind: 'product' })])).toEqual([])
    const bump = '{"type":"heard","entry":"Bump","as":"Finchy","line":1,"quote":"change the name of Finchy"}'
    expect(parseMined(bump, named, [...known, entry(4, 'Finch', { kind: 'product' })])).toEqual([])
  })

  it('keeps a new name only when the line writes it as one', () => {
    const noisy = [{ id: 7, text: 'if we put pink pong on you, the iPhone 17 and Naman will see', speaker: null }]
    const raw = [
      '{"type":"new","term":"Pink Pong","kind":"term","line":1,"quote":"if we put pink pong on you"}',
      '{"type":"new","term":"iPhone 17","kind":"product","line":1,"quote":"the iPhone 17 and Naman"}',
      '{"type":"new","term":"Naman","kind":"person","line":1,"quote":"the iPhone 17 and Naman"}',
    ].join('\n')
    expect(parseMined(raw, noisy, known).map((f) => f.term)).toEqual(['iPhone 17', 'Naman'])
  })

  it('takes a quote whose commas differ from the line', () => {
    const raw = '{"type":"heard","entry":"Qwen","as":"coin","line":4,"quote":"this model, its coin: three four billion."}'
    expect(parseMined(raw, lines, known)).toHaveLength(1)
  })

  it('drops a quote that is not in its line, a word not in it, noise, and what is already known', () => {
    const raw = [
      '{"type":"new","term":"Rahul","kind":"person","line":1,"quote":"tell Rahul to merge it"}',
      '{"type":"new","term":"Priya","kind":"person","line":2,"quote":"tell Rahul to merge it"}',
      '{"type":"new","term":"Ajay","kind":"person","line":3,"quote":"Ajay Ajay Ajay do it"}',
      '{"type":"new","term":"claude","kind":"tool","line":1,"quote":"give to me Lord"}',
      '{"type":"heard","entry":"Gemini","as":"Lord","line":1,"quote":"give to me Lord"}',
      'not json at all',
    ].join('\n')
    expect(parseMined(raw, lines, known)).toEqual([])
  })

  it('keeps every mishearing, and only the most mentioned new names', async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: 200 + i, text: `Name${i} said it to Name${i} and Clawd`, speaker: null }))
    const answer = many
      .map((l, i) => `{"type":"new","term":"Name${i}","kind":"person","line":${i + 1},"quote":"${l.text.split(' ').slice(0, 3).join(' ')}"}`)
      .concat('{"type":"heard","entry":"Claude","as":"Clawd","line":1,"quote":"said it to Name0 and Clawd"}')
      .join('\n')
    const found = await new VocabularyMiner(() => answering(answer)).mine({ lines: many, known })
    expect(found.filter((f) => f.type === 'new')).toHaveLength(10)
    expect(found.some((f) => f.type === 'heard')).toBe(true)
  })

  it('reads a meeting in parts, shows the vocabulary with each, and keeps each finding once', async () => {
    const requests: LlmRequest[] = []
    const answer = '{"type":"new","term":"Rahul","kind":"person","line":2,"quote":"tell Rahul to merge it"}'
    const found = await new VocabularyMiner(() => answering(answer, requests)).mine({ lines, known })
    expect(requests[0]!.user).toContain('Vocabulary: Claude, Finch Bot, Qwen')
    expect(requests[0]!.user).toContain('[1] I will copy the captions')
    expect(found).toHaveLength(1)
  })

  it('starts no new part once its time is up, and keeps what it found', async () => {
    const long = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, text: `${'word '.repeat(30)}line ${i}`, speaker: null }))
    const requests: LlmRequest[] = []
    await new VocabularyMiner(() => answering('', requests)).mine({ lines: long, known, budgetMs: 0 })
    expect(requests).toHaveLength(1)
  })
})
