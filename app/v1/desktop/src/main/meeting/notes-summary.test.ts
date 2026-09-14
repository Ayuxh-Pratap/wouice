import { describe, expect, it } from 'vitest'
import {
  buildSummary,
  dedupePoints,
  gistInput,
  parsePoints,
  summaryMarkdown,
  type KeyPoint,
  type TranscriptLine,
} from './notes.js'

/** The summary checked against what was said. See docs/design/11-checked-summary.md. */

const line = (id: number, text: string, over: Partial<TranscriptLine> = {}): TranscriptLine => ({
  id,
  channel: 'them',
  startMs: id * 10_000,
  text,
  echo: false,
  speaker: 'Himanshu',
  ...over,
})

// Meeting 18, as its English came out.
const lines = [
  line(1, 'Weather today is model this casting about 21000'),
  line(2, 'We will not have to make answers for all things, we will have to calculate vectors and words'),
  line(3, 'in this AI feature we need to include follow up questions and information'),
  line(4, 'Questions should come with the answer'),
  line(5, "Okay, let's ship the search change that way"),
  line(8, "It's done, the song type is done, okay"),
  line(6, 'Why will the navigation and highlighting work?', { channel: 'me', speaker: null }),
  line(7, 'ठीक है, ऐसे ही करते हैं, रजिस्ट्री कल भेज दूंगा'),
  line(9, 'those who are listening say the captions are fine'),
]
const said = (o: Record<string, unknown>): string => JSON.stringify(o)

describe('key points, checked against their lines', () => {
  it('keeps a point whose quote is in the lines it names, and which says what they say', () => {
    const found = parsePoints(said({ point: 'Costing is about 21,000 on today’s model', lines: [1], quote: 'casting about 21000', mark: '' }), lines)
    expect(found).toEqual({
      points: [
        { text: 'Costing is about 21,000 on today’s model', mark: null, segmentIds: [1], quote: 'casting about 21000', atMs: 10_000, who: 'Himanshu' },
      ],
      found: 1,
      badQuote: 0,
      offTopic: 0,
    })
  })

  it('drops a point whose quote is not in its lines, and one its lines do not say', () => {
    const raw = [
      said({ point: 'Answers will come from embeddings', lines: [2], quote: 'we will compute embeddings for every user' }),
      // A real quote carrying a claim nobody made.
      said({ point: 'The price will be optimized next week', lines: [4], quote: 'Questions should come with the answer' }),
      'not json',
    ].join('\n')
    expect(parsePoints(raw, lines)).toMatchObject({ points: [], found: 2, badQuote: 1, offTopic: 1 })
  })

  it('keeps "agreed" only when a line agrees and "open" only when one asks, in English and in Hindi', () => {
    const raw = [
      said({ point: 'Ship the search change that way', lines: [5], quote: 'ship the search change that way', mark: 'agreed' }),
      said({ point: 'Answers are calculated from vectors, not written for all things', lines: [2], quote: 'we will have to calculate vectors', mark: 'agreed' }),
      said({ point: 'Why the navigation and highlighting will work', lines: [6], quote: 'Why will the navigation and highlighting work', mark: 'open' }),
      said({ point: 'रजिस्ट्री ऐसे ही कल भेजी जाएगी', lines: [7], quote: 'ऐसे ही करते हैं, रजिस्ट्री कल', mark: 'agreed' }),
      // Meeting 17: "done" and "okay" are filler, not agreement.
      said({ point: 'The song type is done', lines: [8], quote: 'the song type is done, okay', mark: 'agreed' }),
      // "those who are listening" is not a question.
      said({ point: 'Those listening say the captions are fine', lines: [9], quote: 'who are listening say the captions', mark: 'open' }),
    ].join('\n')
    expect(parsePoints(raw, lines).points.map((p) => [p.mark, p.who])).toEqual([
      ['agreed', 'Himanshu'],
      [null, 'Himanshu'],
      ['open', 'You'],
      ['agreed', 'Himanshu'],
      [null, 'Himanshu'],
      [null, 'Himanshu'],
    ])
  })

  it('keeps a point said twice once, the earliest', () => {
    const p = (text: string, atMs: number): KeyPoint => ({ text, mark: null, segmentIds: [1], quote: '', atMs, who: 'Them' })
    expect(dedupePoints([p('Follow-up questions come with every answer', 90), p('Costing is about 21,000', 10), p('follow up questions come with every answer', 50)]).map((k) => k.atMs)).toEqual([10, 50])
  })
})

const point = (text: string, atMs: number, mark: KeyPoint['mark'] = null): KeyPoint => ({
  text,
  mark,
  segmentIds: [atMs / 10_000],
  quote: text.slice(0, 20),
  atMs,
  who: 'Himanshu',
})
const three = [
  point('Costing is about 21,000 on today model', 10_000),
  point('Answers come from vectors and embeddings', 20_000),
  point('Follow-up questions come with every answer, through the intent router', 30_000, 'agreed'),
]

describe('the gist', () => {
  it('is written from the numbered points, with time, speaker and mark', () => {
    const input = gistInput(three, 'ask about pricing', new Date('2026-09-14'))
    expect(input).toContain('Meeting date: 2026-09-14')
    expect(input).toContain('1. [0:10] Himanshu: Costing is about 21,000 on today model')
    expect(input).toContain('3. [0:30] Himanshu: Follow-up questions come with every answer, through the intent router (agreed)')
    expect(input).toContain("The person's own notes, typed during the meeting:\nask about pricing")
  })

  it('shows points in the order said, ignores numbers it was not given, and keeps only sentences resting on them', () => {
    const raw = JSON.stringify({
      show: [3, 1, 9],
      gist: [
        { text: 'A call on the assistant: costing is about 21,000, and follow-up questions come with every answer.', points: [1, 3] },
        { text: 'The price will be optimized next week.', points: [1] },
        { text: 'Nothing cited here.', points: [] },
      ],
    })
    const { summary, gistWritten } = buildSummary(three, raw)
    // Fewer than five picked: the rest are added, still in the order said.
    expect(summary.points.map((p) => p.atMs)).toEqual([10_000, 20_000, 30_000])
    expect(summary.gist).toEqual([
      { text: 'A call on the assistant: costing is about 21,000, and follow-up questions come with every answer.', points: [0, 2] },
    ])
    expect(gistWritten).toBe(3)
  })

  it('reads a gist written as one paragraph, and "[3]" as the points a sentence rests on', () => {
    // Qwen3.5 writes one string; Gemma writes the points into the sentence.
    const raw = JSON.stringify({
      show: [1, 2, 3],
      gist: 'Costing is about 21,000 on the today model. Follow-up questions come with every answer [3].',
    })
    expect(buildSummary(three, raw).summary.gist).toEqual([
      { text: 'Costing is about 21,000 on the today model.', points: [0] },
      { text: 'Follow-up questions come with every answer.', points: [2] },
    ])
  })

  it('drops a sentence with a number no point gives, or an agreement no point marks', () => {
    const raw = JSON.stringify({
      show: [1, 2, 3],
      gist: [
        { text: 'Costing came to 74,000 on today model.', points: [1] },
        // 21,000 is a point's, but not one this sentence rests on.
        { text: 'Costing is about 21,000, and answers come from vectors and embeddings.', points: [2] },
        { text: 'It was agreed that answers come from vectors and embeddings.', points: [2] },
        { text: 'It was agreed that follow-up questions come with every answer.', points: [3] },
      ],
    })
    expect(buildSummary(three, raw).summary.gist.map((s) => s.points)).toEqual([[2]])
  })

  it('drops a sentence naming somebody its points do not', () => {
    // Meeting 17: the registry goes to Himanshu; the gist sent it to Swapnil, a name another point had.
    const four = [...three, point('Tell Swapnil the details plainly', 40_000)]
    const raw = JSON.stringify({
      show: [1, 2, 3, 4],
      gist: [
        { text: 'Swapnil gets answers from vectors and embeddings.', points: [2] },
        { text: 'Answers come from vectors and embeddings, says Naman.', points: [2] },
        // It names the Swapnil point too, but shares only the name with it.
        { text: 'Swapnil hears answers come from vectors and embeddings.', points: [2, 4] },
        { text: 'Himanshu gets answers from vectors and embeddings.', points: [2] },
      ],
    })
    expect(buildSummary(four, raw).summary.gist).toEqual([{ text: 'Himanshu gets answers from vectors and embeddings.', points: [1] }])
  })

  it('shows a spread of the points picked when more are picked than can show', () => {
    const many = Array.from({ length: 12 }, (_, i) => point(`Point number ${i} about the registry format`, (i + 1) * 10_000))
    const { summary } = buildSummary(many, JSON.stringify({ show: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], gist: [] }))
    expect(summary.points.map((p) => (p.atMs ?? 0) / 10_000)).toEqual([1, 2, 4, 5, 6, 7, 9, 10])
  })

  it('shows a point the gist rests on, room allowing', () => {
    const many = Array.from({ length: 12 }, (_, i) => point(`Point number ${i} about the registry format`, (i + 1) * 10_000))
    const raw = JSON.stringify({ show: [1, 2, 3, 4, 5], gist: [{ text: 'Point number 8 settles the registry format.', points: [9] }] })
    const { summary } = buildSummary(many, raw)
    expect(summary.points.map((p) => p.atMs)).toEqual([10_000, 20_000, 30_000, 40_000, 50_000, 90_000])
    expect(summary.gist).toEqual([{ text: 'Point number 8 settles the registry format.', points: [5] }])
  })

  it('still shows the key points when the gist could not be written', () => {
    const { summary, gistWritten } = buildSummary(three, null)
    expect(summary.gist).toEqual([])
    expect(summary.points).toHaveLength(3)
    expect(gistWritten).toBe(0)
  })

  it('shows at most eight, and at least five of a longer list', () => {
    const many = Array.from({ length: 12 }, (_, i) => point(`Point number ${i} about the registry format`, (i + 1) * 10_000))
    expect(buildSummary(many, JSON.stringify({ show: [2], gist: [] })).summary.points).toHaveLength(5)
    expect(buildSummary(many, JSON.stringify({ show: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], gist: [] })).summary.points).toHaveLength(8)
  })
})

describe('the summary written out', () => {
  it('gives the gist, the key points with their times and marks, and the tasks as next steps', () => {
    const { summary } = buildSummary(three, JSON.stringify({ show: [1, 2, 3], gist: [{ text: 'Costing is about 21,000 on today model.', points: [1] }] }))
    const md = summaryMarkdown(summary, [{ text: 'Add search to navigation and highlighting', owner: 'Himanshu' }])
    expect(md).toBe(
      [
        '## In short',
        'Costing is about 21,000 on today model.',
        '',
        '## Key points',
        '- [0:10] Costing is about 21,000 on today model',
        '- [0:20] Answers come from vectors and embeddings',
        '- [0:30] (agreed) Follow-up questions come with every answer, through the intent router',
        '',
        '## Next steps',
        '- Add search to navigation and highlighting (Himanshu)',
      ].join('\n')
    )
  })

  it('says so when nothing held up, and when there is no gist', () => {
    expect(summaryMarkdown({ gist: [], points: [] }, [])).toBe('## In short\nNothing in this meeting held up as a key point.')
    expect(summaryMarkdown(buildSummary(three, null).summary, [])).toContain('_The gist could not be written; the key points below are checked._')
  })
})
