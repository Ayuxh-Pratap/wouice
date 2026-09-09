import { describe, expect, it } from 'vitest'
import {
  allFailed,
  assembleCondensed,
  chunkTranscript,
  parseTasks,
  reduceInput,
  renderChunk,
  CHUNK_TOKEN_BUDGET,
  type TranscriptLine,
} from './notes.js'

/**
 * Notes and tasks, minus the model.
 *
 * The two things worth pinning here are the two that decide whether the output
 * can be trusted: a chunk that does not fit is a silently dropped middle, and a
 * task that cannot be traced back to something said is a fabrication somebody
 * will act on.
 */

const line = (id: number, text: string, over: Partial<TranscriptLine> = {}): TranscriptLine => ({
  id,
  channel: 'them',
  startMs: id * 5_000,
  text,
  echo: false,
  ...over,
})

describe('chunking', () => {
  it('leaves a short meeting in one piece', () => {
    const chunks = chunkTranscript([line(1, 'hello'), line(2, 'goodbye')])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.lines.map((l) => l.id)).toEqual([1, 2])
  })

  it('never builds a chunk the model cannot hold', () => {
    // The specified 36,000-character chunk is ~9,000 tokens of English and far
    // more with Devanagari, against a 4,096 token context. It would not fail
    // loudly - it would drop the middle.
    const long = Array.from({ length: 400 }, (_, i) =>
      line(i + 1, 'we talked about the deployment pipeline and the pricing question at length')
    )
    const chunks = chunkTranscript(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(CHUNK_TOKEN_BUDGET)
  })

  it('keeps every line exactly once, with no overlap', () => {
    // The segmenter already cuts at pauses, so a boundary is an utterance
    // boundary and overlap would only duplicate commitments.
    const lines = Array.from({ length: 300 }, (_, i) => line(i + 1, `point number ${i} discussed`))
    const seen = chunkTranscript(lines).flatMap((c) => c.lines.map((l) => l.id))
    expect(seen).toEqual(lines.map((l) => l.id))
  })

  it('drops echo rather than spending context on duplicates', () => {
    const chunks = chunkTranscript([
      line(1, 'we need SSO before rollout'),
      line(2, 'we need SSO before rollout', { channel: 'me', echo: true }),
    ])
    expect(chunks[0]!.lines.map((l) => l.id)).toEqual([1])
  })

  it('drops blank lines and an empty transcript', () => {
    expect(chunkTranscript([line(1, '   ')])).toEqual([])
    expect(chunkTranscript([])).toEqual([])
  })

  it('gives one over-long utterance a chunk of its own', () => {
    const huge = line(1, 'word '.repeat(20_000))
    const chunks = chunkTranscript([huge, line(2, 'a short reply')])
    expect(chunks[0]!.lines.map((l) => l.id)).toEqual([1])
    expect(chunks[1]!.lines.map((l) => l.id)).toEqual([2])
  })
})

describe('what the model sees', () => {
  it('numbers each line with the id a task must cite', () => {
    const [chunk] = chunkTranscript([line(42, 'send the timeline', { channel: 'me' })])
    const rendered = renderChunk(chunk!)
    expect(rendered).toContain('[42]')
    expect(rendered).toContain('You')
    expect(rendered).toContain('send the timeline')
  })

  it('labels the far side as Them', () => {
    const [chunk] = chunkTranscript([line(1, 'our side of it')])
    expect(renderChunk(chunk!)).toContain('Them')
  })
})

describe('reading tasks back', () => {
  const lines = [
    line(10, 'okay I will book the follow-up for next week'),
    line(11, 'yes I will send Priya the SSO timeline on Monday'),
    line(12, 'his salary is 1500 and he is also doing his masters'),
  ]

  const task = (over: Record<string, unknown>): string =>
    JSON.stringify({ text: 'do it', owner: null, due: null, line: 11, quote: 'I will send Priya', ...over })

  it('takes a well-formed, quoted task', () => {
    const raw = task({ text: 'send Priya the SSO timeline', owner: 'You', due: '2026-09-15' })
    expect(parseTasks(raw, lines)).toEqual([
      { text: 'send Priya the SSO timeline', owner: 'You', due: '2026-09-15', segmentId: 11 },
    ])
  })

  it('drops a task whose quote is not in the line it cites', () => {
    // The guard that matters. A model handed a chat about salaries will cite a
    // real line and report "assume salary of fifteen hundred rupees" as a task;
    // it cannot quote a commitment out of a sentence that contains none.
    const raw = task({
      text: 'assume salary of fifteen hundred rupees',
      line: 12,
      quote: 'I will assume the salary',
    })
    expect(parseTasks(raw, lines)).toEqual([])
  })

  it('drops a task with no quote at all', () => {
    expect(parseTasks(task({ quote: undefined }), lines)).toEqual([])
    expect(parseTasks(task({ quote: '' }), lines)).toEqual([])
  })

  it('refuses a quote too short to prove anything', () => {
    // Two words appear in half the transcript. A citation has to be specific
    // enough that it could have been wrong.
    expect(parseTasks(task({ quote: 'I will' }), lines)).toEqual([])
  })

  it('ignores punctuation and case when checking the quote', () => {
    const raw = task({ quote: 'i will send priya,' })
    expect(parseTasks(raw, lines)).toHaveLength(1)
  })

  it('drops a task citing a line that was never shown', () => {
    expect(parseTasks(task({ line: 99 }), lines)).toEqual([])
  })

  it('drops a task with no citation at all', () => {
    expect(parseTasks(task({ line: undefined }), lines)).toEqual([])
  })

  it('survives a fence and prose around the JSON', () => {
    const raw = [
      'Here are the tasks:',
      '```json',
      task({ text: 'book the follow-up', line: 10, quote: 'I will book the follow-up' }),
      '```',
      'Let me know if you need more.',
    ].join('\n')
    expect(parseTasks(raw, lines).map((t) => t.text)).toEqual(['book the follow-up'])
  })

  it('never guesses an owner or a date', () => {
    const raw = task({ owner: 'null', due: 'next Friday' })
    const [only] = parseTasks(raw, lines)
    expect(only!.owner).toBeNull()
    expect(only!.due).toBeNull()
  })

  it('drops empty and absurdly long text', () => {
    expect(parseTasks(task({ text: '   ' }), lines)).toEqual([])
    expect(parseTasks(task({ text: 'x'.repeat(500) }), lines)).toEqual([])
  })

  it('does not emit the same commitment twice', () => {
    const raw = [task({ text: 'send the deck' }), task({ text: 'Send the deck' })].join('\n')
    expect(parseTasks(raw, lines)).toHaveLength(1)
  })

  it('keeps two different commitments from one line', () => {
    const raw = [task({ text: 'send the deck' }), task({ text: 'book the room' })].join('\n')
    expect(parseTasks(raw, lines)).toHaveLength(2)
  })

  it('returns nothing for nothing, which is the usual answer', () => {
    // Most conversations contain no commitments at all.
    expect(parseTasks('', lines)).toEqual([])
    expect(parseTasks('No commitments were made.', lines)).toEqual([])
  })
})

describe('assembling the condensed notes', () => {
  const chunk = chunkTranscript([line(1, 'one'), line(2, 'two')])[0]!

  it('marks a failed chunk rather than closing the gap over it', () => {
    // Joining what survived produces notes that look complete and are not,
    // which is the worst outcome: you would act on them.
    const text = assembleCondensed([
      { chunk, text: '- first part' },
      { chunk, text: null },
      { chunk, text: '- third part' },
    ])
    expect(text).toContain('first part')
    expect(text).toContain('could not be summarised')
    expect(text).toContain('third part')
  })

  it('skips a chunk that had nothing in it, without marking a gap', () => {
    const text = assembleCondensed([
      { chunk, text: '- something' },
      { chunk, text: '   ' },
    ])
    expect(text).not.toContain('could not be summarised')
  })

  it('knows the difference between a gappy run and a failed one', () => {
    expect(allFailed([{ chunk, text: null }, { chunk, text: '- ok' }])).toBe(false)
    expect(allFailed([{ chunk, text: null }, { chunk, text: null }])).toBe(true)
    expect(allFailed([])).toBe(false)
  })
})

describe('the reduce input', () => {
  it('carries the meeting date, because "next Friday" needs one', () => {
    const input = reduceInput('- a point', '', new Date('2026-09-09T10:00:00Z'))
    expect(input).toContain('2026-09-09')
  })

  it('labels your own notes as yours, and puts them last', () => {
    const input = reduceInput('- a point', 'priya = decision maker', new Date())
    expect(input.indexOf('priya')).toBeGreaterThan(input.indexOf('a point'))
    expect(input).toContain("person's own notes")
  })

  it('says nothing about notes when there are none', () => {
    expect(reduceInput('- a point', '   ', new Date())).not.toContain("person's own notes")
  })
})
