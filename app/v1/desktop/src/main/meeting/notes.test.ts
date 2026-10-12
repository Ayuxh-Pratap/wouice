import { describe, expect, it } from 'vitest'
import {
  allFailed,
  assembleCondensed,
  chunkTranscript,
  contextAround,
  isDuplicate,
  isMine,
  jobGroups,
  keepEnds,
  linesFor,
  mergeOverlapping,
  parseNoteTasks,
  parsePlacement,
  parseWorkItems,
  parseWriteUp,
  placeByWording,
  placeInput,
  placeItem,
  resolveOwner,
  sameTitle,
  type WorkItem,
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

describe('reading work items back', () => {
  // From a real engineering call.
  const lines = [
    line(10, 'We still have not fixed the capitalization stuff in the carousel guys.'),
    line(11, 'Yeah, we are doing it right now.'),
    line(12, 'his salary is 1500 and he is also doing his masters'),
  ]

  const item = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      title: 'Fix capitalization in the carousel',
      description: 'Raised on several calls. The team said it is being fixed now.',
      type: 'bug',
      area: 'frontend',
      owner: null,
      status: 'agreed',
      lines: [10, 11],
      quote: 'fixed the capitalization stuff in the carousel',
      ...over,
    })

  it('takes an item with its story and every line it cites', () => {
    const { items, dropped } = parseWorkItems(item(), lines)
    expect(dropped).toBe(0)
    expect(items).toEqual([
      {
        title: 'Fix capitalization in the carousel',
        story: 'Raised on several calls. The team said it is being fixed now.',
        kind: 'bug',
        area: 'frontend',
        owner: null,
        status: 'agreed',
        evidence: [
          { segmentId: 10, quote: 'fixed the capitalization stuff in the carousel' },
          { segmentId: 11, quote: '' },
        ],
        atMs: 50_000,
        source: 'transcript',
      },
    ])
  })

  it('drops an item whose quote is in no line it was shown', () => {
    // A model that cannot copy words about a piece of work out of the
    // transcript is describing work nobody discussed.
    const raw = item({ title: 'Assume a salary of 1500 rupees', lines: [12], quote: 'we will assume the salary' })
    expect(parseWorkItems(raw, lines)).toEqual({ items: [], dropped: 1 })
  })

  it('cites the line its quote is in, even if the model forgot to list it', () => {
    const { items } = parseWorkItems(item({ lines: [11] }), lines)
    expect(items[0]!.evidence.map((e) => e.segmentId)).toEqual([10, 11])
  })

  it('drops cited lines it was never shown', () => {
    const { items } = parseWorkItems(item({ lines: [10, 99] }), lines)
    expect(items[0]!.evidence.map((e) => e.segmentId)).toEqual([10])
  })

  it('drops an item that does not say what', () => {
    // "Fix it" is not something anybody can pick up.
    expect(parseWorkItems(item({ title: 'Fix it' }), lines)).toEqual({ items: [], dropped: 1 })
  })

  it('reads objects fenced, pretty-printed and wrapped in prose', () => {
    const pretty = JSON.stringify(JSON.parse(item()), null, 2)
    const raw = ['Here is the work:', '```json', pretty, '```', 'That is all.'].join('\n')
    expect(parseWorkItems(raw, lines).items).toHaveLength(1)
  })

  it('never invents a type, an area or an owner', () => {
    const { items } = parseWorkItems(item({ type: 'epic', area: 'galaxy', owner: 'null', status: 'maybe' }), lines)
    expect(items[0]).toMatchObject({ kind: 'other', area: 'other', owner: null, status: 'proposed' })
  })

  it('understands the words models use for types and areas', () => {
    const { items } = parseWorkItems(item({ type: 'enhancement', area: 'UI' }), lines)
    expect(items[0]).toMatchObject({ kind: 'feature', area: 'frontend' })
  })

  it('lists the same work once, with all of its lines', () => {
    const raw = [item({ lines: [10] }), item({ lines: [11], quote: 'we are doing it right now' })].join('\n')
    const { items } = parseWorkItems(raw, lines)
    expect(items).toHaveLength(1)
    expect(items[0]!.evidence.map((e) => e.segmentId)).toEqual([10, 11])
  })

  it('finds a quote spread over two lines, and cites both', () => {
    // The transcript is cut at pauses, not at the ends of sentences.
    const split = [
      line(20, 'no i mean finchy maybe we can oh we gotta change the name of the of'),
      line(21, 'Finchy sounds transmissible.'),
    ]
    const raw = item({
      title: 'Rename the chatbot from Finchy',
      lines: [20],
      quote: 'change the name of the of Finchy sounds transmissible',
    })
    expect(parseWorkItems(raw, split).items[0]!.evidence.map((e) => e.segmentId)).toEqual([20, 21])
  })

  it('accepts a reordered quote beside the line it cited', () => {
    const naming = [line(30, 'Fincha, yes. Finally, you came right back around. Yeah, I like Fincha. Fincha.')]
    const raw = item({
      title: 'Call the chatbot Fincha',
      lines: [30],
      quote: 'I like Fincha. Finally, you came right back around',
    })
    expect(parseWorkItems(raw, naming).items).toHaveLength(1)
  })

  it('does not accept a reordered quote from lines it never cited', () => {
    const naming = [line(30, 'Fincha, yes. Finally, you came right back around. Yeah, I like Fincha. Fincha.')]
    const raw = item({
      title: 'Call the chatbot Fincha',
      lines: [],
      quote: 'I like Fincha. Finally, you came right back around',
    })
    expect(parseWorkItems(raw, naming)).toEqual({ items: [], dropped: 1 })
  })

  it('keeps only cited lines beside the quote or about the same work', () => {
    const stretch = [
      line(40, 'We still have not fixed the capitalization stuff in the carousel guys.'),
      line(41, 'Swap, can you hear me? Am I audible?'),
      line(42, 'my laptop is about to die'),
      line(43, 'okay okay okay'),
      line(44, 'anyway, how does the dashboard work'),
      line(45, 'third, the carousel capitalization is driving me crazy'),
    ]
    const raw = item({ lines: [40, 41, 42, 43, 44, 45] })
    expect(parseWorkItems(raw, stretch).items[0]!.evidence.map((e) => e.segmentId)).toEqual([
      40, 41, 42, 45,
    ])
  })

  it('reads parked work as parked', () => {
    expect(parseWorkItems(item({ status: 'parked' }), lines).items[0]!.status).toBe('parked')
  })

  it('returns nothing for nothing', () => {
    expect(parseWorkItems('', lines)).toEqual({ items: [], dropped: 0 })
    expect(parseWorkItems('No work came out of this part.', lines)).toEqual({ items: [], dropped: 0 })
  })
})

describe('sorting work items into jobs, one at a time', () => {
  const found = (title: string, status: WorkItem['status'], atMs: number | null, story = ''): WorkItem => ({
    title,
    story,
    kind: 'change',
    area: 'frontend',
    owner: null,
    status,
    evidence: [],
    atMs,
    source: atMs === null ? 'notes' : 'transcript',
  })
  const items = [
    found('Rename the chatbot from Finchy', 'proposed', 218_000),
    found('Clip answers into the FAQ page', 'agreed', 843_000, 'Instead of a history tab, answers are clipped into the FAQ.'),
    found('Rename the chatbot to Finch Bot', 'agreed', 2_647_000),
  ]
  const jobs = (...members: number[][]) => members.map((m) => ({ members: m, replaced: false }))

  it('shows the jobs so far, one short line each, then the item to place', () => {
    const { text, shown } = placeInput(jobs([0], [1]), items, 2)
    expect(shown).toEqual([0, 1])
    expect(text.split('\n')).toEqual([
      'Jobs so far:',
      'g1 [3:38] Rename the chatbot from Finchy',
      'g2 [14:03] Clip answers into the FAQ page - Instead of a history tab, answers are clipped into the FAQ.',
      '',
      'New item:',
      '[44:07] Rename the chatbot to Finch Bot',
    ])
  })

  it('shows only the closest jobs when there are too many', () => {
    expect(placeInput(jobs([0], [1]), items, 2, 1).shown).toEqual([0])
  })

  it('reads a placement back', () => {
    expect(parsePlacement('{"job":2,"relation":"same"}', 2)).toEqual({ job: 1, relation: 'same' })
    expect(parsePlacement('{"job":"g1","relation":"replaces"}', 2)).toEqual({ job: 0, relation: 'replaces' })
    expect(parsePlacement('{"job":null,"relation":"new"}', 2)).toEqual({ job: null, relation: 'new' })
  })

  it('makes a job it was not shown a new one, and an unreadable answer nothing', () => {
    expect(parsePlacement('{"job":7,"relation":"same"}', 2)).toEqual({ job: null, relation: 'new' })
    expect(parsePlacement('the model rambled', 2)).toBeNull()
  })

  it('adds the same work to its job, and starts a new one otherwise', () => {
    expect(placeItem(jobs([0], [1]), items, 2, 0, 'same').map((j) => j.members)).toEqual([[0, 2], [1]])
    expect(placeItem(jobs([0], [1]), items, 2, null, 'new').map((j) => j.members)).toEqual([[0], [1], [2]])
  })

  it('drops the job a later decision replaces', () => {
    expect(jobGroups(placeItem(jobs([0], [1]), items, 2, 0, 'replaces'), items)).toEqual([
      { members: [0], status: 'rejected' },
      { members: [1], status: 'agreed' },
      { members: [2], status: 'agreed' },
    ])
  })

  it('keeps agreed work, joining the item said to replace it', () => {
    // "Finch Bot, done" was agreed; a later name tried is the rename changing.
    expect(placeItem(jobs([2], [1]), items, 0, 0, 'replaces').map((j) => j.members)).toEqual([[2, 0], [1]])
  })

  it('leaves alone a job about something else that it was said to replace', () => {
    const placed = placeItem(jobs([0], [1]), items, 2, 1, 'replaces')
    expect(jobGroups(placed, items).map((g) => g.status)).toEqual(['proposed', 'agreed', 'agreed'])
  })

  it('takes the last word on a job as where it landed', () => {
    expect(jobGroups(jobs([0, 2], [1]), items)[0]!.status).toBe('agreed')
  })

  it('can place by wording alone when the model cannot be asked', () => {
    expect(placeByWording(jobs([0], [1]), items, 2)).toBe(0)
    expect(placeByWording(jobs([1]), items, 0)).toBeNull()
  })
})

describe('work found in the same lines', () => {
  const at = (
    title: string,
    status: WorkItem['status'],
    ids: number[],
    atMs = ids[0]! * 5_000
  ): WorkItem => ({
    title,
    story: '',
    kind: 'feature',
    area: 'frontend',
    owner: null,
    status,
    evidence: ids.map((segmentId) => ({ segmentId, quote: '' })),
    atMs,
    source: 'transcript',
  })
  const apart = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ members: [i], status: 'agreed' as const }))

  it('merges a feature with its plumbing when one sits inside the other', () => {
    const items = [
      at('Add follow-up question chips under each reply', 'agreed', [70, 72, 76, 77, 78]),
      at('Add a backend call that pulls questions out of replies', 'agreed', [76, 77, 78]),
    ]
    expect(mergeOverlapping(apart(2), items)).toEqual([{ members: [0, 1], status: 'agreed' }])
  })

  it('keeps work apart that only shares a line or two', () => {
    const items = [
      at('Let the bot change settings that do not touch money', 'agreed', [40, 41, 42, 45]),
      at('Let the bot read back past bets and results', 'agreed', [42, 43, 44, 45]),
    ]
    expect(mergeOverlapping(apart(2), items)).toHaveLength(2)
  })

  it('never merges on one line', () => {
    const items = [at('Fix carousel capitalization', 'agreed', [10]), at('Add a glossary', 'agreed', [10, 11])]
    expect(mergeOverlapping(apart(2), items)).toHaveLength(2)
  })

  it('takes the later word on what it merges', () => {
    const items = [
      at('Let the bot make playlists', 'proposed', [50, 51, 52]),
      at('Have the bot build playlists', 'parked', [50, 51, 52, 53], 290_000),
    ]
    const groups = [
      { members: [0], status: 'proposed' as const },
      { members: [1], status: 'parked' as const },
    ]
    expect(mergeOverlapping(groups, items)).toEqual([{ members: [0, 1], status: 'parked' }])
  })
})

describe('reading a write-up', () => {
  it('reads the task with its story', () => {
    const raw =
      '{"title":"Add follow-up question chips under each bot reply","description":"After each answer, a backend call pulls follow-up questions out of the reply and shows them as chips.","type":"feature","area":"frontend","owner":null}'
    expect(parseWriteUp(raw)).toEqual({
      title: 'Add follow-up question chips under each bot reply',
      description:
        'After each answer, a backend call pulls follow-up questions out of the reply and shows them as chips.',
      kind: 'feature',
      area: 'frontend',
      owner: null,
      status: null,
    })
  })

  it('reads where the lines left it', () => {
    expect(parseWriteUp('{"title":"Gate artist data behind tiers","status":"Parked"}')?.status).toBe('parked')
  })

  it('reads a pretty-printed answer inside prose', () => {
    const raw = 'Sure:\n{\n  "title": "Make the tutorial videos",\n  "description": "x",\n  "type": "content"\n}'
    expect(parseWriteUp(raw)?.kind).toBe('content')
  })

  it('refuses one that does not say what', () => {
    expect(parseWriteUp('{"title":"Do it"}')).toBeNull()
    expect(parseWriteUp('I could not write this up.')).toBeNull()
  })
})

describe('the lines a write-up reads', () => {
  const lines = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => line(id, `line ${id}`))

  it('gives each cited line and the answer after it, in order', () => {
    expect(linesFor(lines, [5, 2]).map((l) => l.id)).toEqual([2, 3, 5, 6])
  })

  it('stops at the end, and at the cap', () => {
    expect(linesFor(lines, [8]).map((l) => l.id)).toEqual([8])
    expect(linesFor(lines, [1, 3, 5, 7], 3).map((l) => l.id)).toEqual([1, 2, 3])
  })

  it('keeps the latest lines too when over the cap, where the last word is', () => {
    expect(linesFor(lines, [1, 3, 5, 7], 6).map((l) => l.id)).toEqual([1, 2, 3, 4, 7, 8])
  })
})

describe('keeping the ends of a list', () => {
  it('keeps everything under the cap', () => {
    expect(keepEnds([1, 2, 3], 5)).toEqual([1, 2, 3])
  })

  it('keeps the first few and the latest over it', () => {
    expect(keepEnds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 6)).toEqual([1, 2, 3, 4, 9, 10])
    expect(keepEnds([1, 2, 3, 4, 5], 2)).toEqual([1, 2])
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

describe('chunking against real token counts', () => {
  it('uses the cost it is given, not the character estimate', () => {
    // The estimate undercounted a real meeting by up to 1.8x and three of four
    // chunks overflowed. The engine hands in the model's own count.
    const lines = Array.from({ length: 10 }, (_, i) => line(i + 1, 'short'))
    const chunks = chunkTranscript(lines, 100, () => 30)
    // 31 per line (+1 newline) against 100: three per chunk.
    expect(chunks.map((c) => c.lines.length)).toEqual([3, 3, 3, 1])
  })

  it('pads the fallback when no real count is available', () => {
    const lines = Array.from({ length: 200 }, (_, i) =>
      line(i + 1, 'we talked about the deployment pipeline and the pricing question at length')
    )
    const padded = chunkTranscript(lines)
    const naive = chunkTranscript(lines, CHUNK_TOKEN_BUDGET, (t) => Math.ceil(t.length / 4))
    // Wrong in the safe direction: more, smaller chunks.
    expect(padded.length).toBeGreaterThan(naive.length)
  })
})

describe('a line and what was said around it', () => {
  const lines = [1, 2, 3, 4, 5, 6, 7].map((id) => line(id, `line ${id}`))

  it('marks the cited line and shows two either side', () => {
    const context = contextAround(lines, 4)
    expect(context.split('\n')).toHaveLength(5)
    expect(context).toContain('>> [4]')
    expect(context).toContain('[2]')
    expect(context).toContain('[6]')
    expect(context).not.toContain('[1]')
  })

  it('stops at the edges', () => {
    expect(contextAround(lines, 1).split('\n')).toHaveLength(3)
    expect(contextAround(lines, 99)).toBe('')
  })
})


describe('whose task it is', () => {
  it('counts the person who recorded the meeting', () => {
    expect(isMine('You', '')).toBe(true)
    expect(isMine('you', 'Ayush')).toBe(true)
  })

  it('counts a task given by name', () => {
    expect(isMine('Ayush', 'Ayush')).toBe(true)
    expect(isMine('ayush', 'Ayush')).toBe(true)
    expect(isMine('Ayush & Himanshu', 'Ayush')).toBe(true)
  })

  it('does not count someone else, or nobody', () => {
    expect(isMine('Himanshu', 'Ayush')).toBe(false)
    expect(isMine(null, 'Ayush')).toBe(false)
    // With no name configured, only "You" can be yours.
    expect(isMine('Ayush', '')).toBe(false)
  })
})

describe('tasks from your own notes', () => {
  const notes =
    'he reported a issue that sign in dialog is sticking when we return back from google sign in\nthen i discussed some kyc stuff'

  it('takes a task whose quote is in the notes', () => {
    const raw =
      '{"text":"fix the sticking sign-in dialog","owner":null,"due":null,"quote":"sign in dialog is sticking"}'
    expect(parseNoteTasks(raw, notes)).toEqual([
      { text: 'fix the sticking sign-in dialog', owner: null, due: null, quote: 'sign in dialog is sticking' },
    ])
  })

  it('drops one whose quote is not in the notes', () => {
    const raw = '{"text":"ship KYC","owner":null,"due":null,"quote":"ship the kyc flow on friday"}'
    expect(parseNoteTasks(raw, notes)).toEqual([])
  })

  it('returns nothing for nothing', () => {
    expect(parseNoteTasks('', notes)).toEqual([])
  })
})

describe('who a task belongs to', () => {
  it('reads a pronoun against who spoke the line', () => {
    expect(resolveOwner('I', 'them', '')).toBe('Them')
    expect(resolveOwner('I', 'me', '')).toBe('You')
    // In your own notes, "I" is the person typing them.
    expect(resolveOwner('I', 'notes', '')).toBe('You')
    expect(resolveOwner('them', 'me', '')).toBe('Them')
    expect(resolveOwner('Them', 'them', '')).toBe('Them')
    expect(resolveOwner('you', 'them', '')).toBe('You')
  })

  it('reads "I" as the speaker by name, when the transcript names them', () => {
    // Meet's captions name every line, so "I'll check the branch" is Rahul's.
    expect(resolveOwner('I', 'them', '', 'Rahul Dhir')).toBe('Rahul Dhir')
    expect(resolveOwner('I', 'me', '', 'Ayush Pratap Singh')).toBe('You')
  })

  it('treats "we" and the team as nobody in particular', () => {
    expect(resolveOwner('we', 'me', '')).toBeNull()
    expect(resolveOwner('the team', 'them', '')).toBeNull()
  })

  it('keeps a name that was said', () => {
    const said = contextAround(
      [line(541, 'Rahul Dhir, what is the branch name? Check it once again')],
      541
    )
    expect(resolveOwner('Rahul Dhir', 'them', said)).toBe('Rahul Dhir')
    expect(resolveOwner('Rahul', 'them', said)).toBe('Rahul')
  })

  it('drops a name nobody said', () => {
    // From a real meeting: "Zhaal" was given a task, and no line says it.
    const said = contextAround([line(378, 'So, revive the call on met collection')], 378)
    expect(resolveOwner('Zhaal', 'them', said)).toBeNull()
  })

  it('is nobody when nothing was given', () => {
    expect(resolveOwner(null, 'me', 'anything')).toBeNull()
    expect(resolveOwner('   ', 'me', 'anything')).toBeNull()
  })
})

describe('the same task written up twice', () => {
  it('knows two titles for one job, however far apart', () => {
    expect(sameTitle('Rename bot to Finch Bot', 'Rename chatbot to Finch Bot')).toBe(true)
  })

  it('keeps apart titles that only share a subject', () => {
    expect(sameTitle('Replace the tutorial section with a video library', 'Make the tutorial videos')).toBe(
      false
    )
  })
})

describe('the same task said twice', () => {
  const probe = (text: string, segmentId: number | null, quote: string, atMs: number | null) => ({
    text,
    segmentId,
    quote,
    atMs,
  })

  it('catches a restatement a few seconds later', () => {
    // Both from a real meeting, twenty-five seconds apart.
    expect(
      isDuplicate(
        probe('will check on the leader board page', 603, 'leader board on vote page', 3_201_008),
        probe('will check in the leader board page', 606, 'I will check in safir', 3_226_008)
      )
    ).toBe(true)
  })

  it('catches two tasks resting on the same words of one line', () => {
    expect(
      isDuplicate(
        probe('will check in safir', 606, 'I will check in safir', 3_226_008),
        probe('check the leaderboard in Safari', 606, 'and I will check in safir', 3_226_008)
      )
    ).toBe(true)
  })

  it('keeps two different tasks from one line', () => {
    expect(
      isDuplicate(
        probe('fix the login bug', 7, "we'll fix the login bug", 0),
        probe('ship the pricing page', 7, 'ship the pricing page', 0)
      )
    ).toBe(false)
  })

  it('keeps the same words an hour apart', () => {
    expect(
      isDuplicate(
        probe('check the leader board page', 1, 'check the leader board', 0),
        probe('check the leader board page', 2, 'check the leader board', 3_600_000)
      )
    ).toBe(false)
  })

  it('compares a task from your notes on its words alone', () => {
    expect(
      isDuplicate(
        probe('send the SSO timeline', 2, 'I will send the timeline', 10_000),
        probe('send Priya the SSO timeline', null, 'send the SSO timeline', null)
      )
    ).toBe(true)
  })
})
