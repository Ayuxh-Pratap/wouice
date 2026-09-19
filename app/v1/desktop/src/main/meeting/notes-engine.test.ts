import type { LlmClient, LlmRequest, LlmResult } from '@wouice/llm'
import { describe, expect, it } from 'vitest'
import { MeetingNotesEngine, NotesUnavailable } from './notes-engine.js'
import type { TranscriptLine } from './notes.js'

/**
 * The notes run, minus the model.
 *
 * The rules under test: a gap stays visible; a task is work that can be traced
 * to lines of the transcript; the same work found twice is one task; what the
 * meeting turned down is not a task; and a task carries its story.
 */

function fakeLlm(
  reply: (req: LlmRequest, call: number) => string | Promise<string>
): { client: () => LlmClient; requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  const client: LlmClient = {
    async complete(req: LlmRequest): Promise<LlmResult> {
      const index = requests.length
      requests.push(req)
      const text = await reply(req, index)
      return { text, latencyMs: 1, provider: 'local', model: 'test' }
    },
    async health() {
      return { ok: true }
    },
  }
  return { client: () => client, requests }
}

const line = (id: number, text: string, over: Partial<TranscriptLine> = {}): TranscriptLine => ({
  id,
  channel: 'them',
  startMs: id * 5_000,
  text,
  echo: false,
  ...over,
})

// From a real engineering call.
const transcript = [
  line(1, 'We still have not fixed the capitalization stuff in the carousel guys.'),
  line(2, 'Yeah, we are doing it right now.'),
  line(3, 'Swap, you choose: ask finch or finch bot or finchy spelled with a Y.'),
]

/** Which system prompt a request was for. */
const stageOf = (req: LlmRequest): string =>
  req.system.startsWith('You pick out the key points')
    ? 'points'
    : req.system.startsWith('You read part of a meeting')
      ? 'items'
      : req.system.startsWith('You are sorting work items')
        ? 'group'
        : req.system.startsWith('You write up ONE task')
          ? 'writeup'
          : req.system.startsWith('You read the notes')
            ? 'notesTasks'
            : req.system.startsWith('You write the gist')
              ? 'gist'
              : 'other'

const keyPoint = JSON.stringify({
  point: 'The carousel capitalization is still not fixed',
  lines: [1],
  quote: 'fixed the capitalization stuff in the carousel',
  mark: '',
})
const theGist = JSON.stringify({
  show: [1],
  gist: [{ text: 'The carousel capitalization is still not fixed, and it is being done now.', points: [1] }],
})

const carousel = JSON.stringify({
  title: 'Fix capitalization in the carousel',
  description: 'Raised again on this call.',
  type: 'bug',
  area: 'frontend',
  owner: null,
  status: 'agreed',
  lines: [1, 2],
  quote: 'fixed the capitalization stuff in the carousel',
})

const writeUp = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    title: 'Fix capitalization in the carousel',
    description:
      'The carousel still capitalizes its labels wrongly; it has been raised on several calls. The team said they are fixing it now.',
    type: 'bug',
    area: 'frontend',
    owner: null,
    ...over,
  })

/** A model that answers every step sensibly, with overrides per stage. */
const answering =
  (over: Record<string, string> = {}) =>
  (req: LlmRequest): string => {
    const stage = stageOf(req)
    if (stage in over) return over[stage]!
    if (stage === 'points') return keyPoint
    if (stage === 'items') return carousel
    if (stage === 'writeup') return writeUp()
    if (stage === 'notesTasks') return ''
    if (stage === 'gist') return theGist
    return ''
  }

const run = (client: () => LlmClient, over: Partial<Parameters<MeetingNotesEngine['generate']>[0]> = {}) =>
  new MeetingNotesEngine(client).generate({ lines: transcript, scratch: '', startedAt: Date.now(), ...over })

describe('a normal run', () => {
  it('picks out the key points, finds the work, writes each task up, then the gist', async () => {
    const { client, requests } = fakeLlm(answering())
    const result = await run(client)

    // One item needs no grouping call.
    expect(requests.map(stageOf)).toEqual(['points', 'items', 'writeup', 'gist'])
    expect(result.notesMd).toContain('## In short')
    expect(result.summary.points.map((p) => [p.text, p.segmentIds])).toEqual([['The carousel capitalization is still not fixed', [1]]])
    expect(result.summary.gist).toHaveLength(1)
    expect(result.summaryStats).toMatchObject({ found: 1, kept: 1, shown: 1, gistKept: 1, gistWritten: 1 })
    expect(result.tasks).toEqual([
      {
        text: 'Fix capitalization in the carousel',
        description:
          'The carousel still capitalizes its labels wrongly; it has been raised on several calls. The team said they are fixing it now.',
        owner: null,
        due: null,
        segmentId: 1,
        evidence: [
          { segmentId: 1, quote: 'fixed the capitalization stuff in the carousel' },
          { segmentId: 2, quote: '' },
        ],
        status: 'agreed',
        kind: 'bug',
        area: 'frontend',
        source: 'transcript',
        noteQuote: null,
        reason: '',
        mine: false,
      },
    ])
    expect(result.coveredLines).toBe(result.totalLines)
  })

  it('writes each task up from the lines themselves', async () => {
    const { client, requests } = fakeLlm(answering())
    await run(client)
    const writeup = requests.find((r) => stageOf(r) === 'writeup')!
    expect(writeup.user).toContain('[1] Them')
    expect(writeup.user).toContain('capitalization stuff in the carousel')
    // The answer after the request is how you know where it landed.
    expect(writeup.user).toContain('we are doing it right now')
  })

  it('asks for the same answer every time', async () => {
    const { client, requests } = fakeLlm(answering())
    await run(client)
    expect(requests.every((r) => r.temperature === 0)).toBe(true)
  })

  it('reports each step, so a long run is not a frozen window', async () => {
    const { client } = fakeLlm(answering())
    const stages: string[] = []
    await run(client, { onProgress: (p) => stages.push(p.stage) })
    expect(stages).toEqual(['condensing', 'extracting', 'checking', 'checking', 'writing'])
  })

  it('hands your notes to the gist and the task finder, never to the point finder', async () => {
    const { client, requests } = fakeLlm(answering())
    await run(client, { scratch: 'priya = decision maker' })
    const having = (stage: string): boolean =>
      requests.filter((r) => stageOf(r) === stage).some((r) => r.user.includes('priya'))
    expect(having('gist')).toBe(true)
    expect(having('notesTasks')).toBe(true)
    expect(having('points')).toBe(false)
    expect(having('items')).toBe(false)
  })
})

describe('what makes a task', () => {
  it('merges the same work found twice into one task with both lines', async () => {
    const renamed = JSON.stringify({
      title: 'Rename the chatbot to Finch Bot',
      description: 'The name is being changed.',
      type: 'change',
      area: 'frontend',
      status: 'proposed',
      lines: [3],
      quote: 'ask finch or finch bot',
    })
    const again = JSON.stringify({
      title: 'Choose between Ask Finch and Finch Bot',
      description: 'Swap decides.',
      type: 'change',
      area: 'frontend',
      status: 'agreed',
      lines: [3],
      quote: 'Swap, you choose',
    })
    const { client, requests } = fakeLlm((req) =>
      stageOf(req) === 'writeup' && req.user.includes('Rename the chatbot')
        ? writeUp({ title: 'Rename the chatbot to Finch Bot', type: 'change' })
        : stageOf(req) === 'group'
          ? req.user.includes('Choose between')
            ? '{"job":2,"relation":"same"}'
            : '{"job":null,"relation":"new"}'
          : answering({ items: [carousel, renamed, again].join('\n') })(req)
    )
    const result = await run(client)
    // One placement for each item after the first.
    expect(requests.filter((r) => stageOf(r) === 'group')).toHaveLength(2)
    expect(requests.filter((r) => stageOf(r) === 'writeup')).toHaveLength(2)
    expect(result.tasks).toHaveLength(2)
    expect(result.candidates).toBe(3)
    expect(result.merged).toBe(1)
  })

  it('folds groups the write-up names as one job, with the lines of both', async () => {
    // A rename argued at minute four and again at minute seventeen, grouped
    // apart: once written up, the two are plainly the same task.
    const restated = JSON.stringify({
      title: 'Get the carousel capitalization fixed',
      description: 'Swap is on it.',
      type: 'bug',
      area: 'frontend',
      status: 'proposed',
      lines: [3],
      quote: 'ask finch or finch bot',
    })
    const { client } = fakeLlm(
      answering({
        items: [carousel, restated].join('\n'),
        group: '{"job":null,"relation":"new"}',
      })
    )
    const result = await run(client)
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0]?.evidence?.map((e) => e.segmentId)).toEqual([1, 2, 3])
    expect(result.tasks[0]?.status).toBe('agreed')
    expect(result.merged).toBe(1)
  })

  it('drops work the meeting replaced', async () => {
    const lines = [...transcript, line(4, 'Instead of history, just clip the answers into the FAQ.')]
    const history = JSON.stringify({
      title: 'Add chat history to the bot',
      description: 'Users could go back to past conversations.',
      type: 'feature',
      area: 'frontend',
      status: 'proposed',
      lines: [3],
      quote: 'finch bot or finchy',
    })
    const clip = JSON.stringify({
      title: 'Clip bot answers into the FAQ instead of history',
      description: 'Replaces the history idea.',
      type: 'feature',
      area: 'frontend',
      status: 'agreed',
      lines: [4],
      quote: 'clip the answers into the FAQ',
    })
    const { client, requests } = fakeLlm((req) =>
      stageOf(req) === 'group'
        ? req.user.includes('Clip bot answers')
          ? '{"job":2,"relation":"replaces"}'
          : '{"job":null,"relation":"new"}'
        : stageOf(req) === 'writeup' && req.user.includes('Clip bot answers')
          ? writeUp({ title: 'Clip bot answers into the FAQ', type: 'feature' })
          : answering({ items: [carousel, history, clip].join('\n') })(req)
    )
    const result = await run(client, { lines })
    expect(result.tasks.map((t) => t.text)).toEqual([
      'Fix capitalization in the carousel',
      'Clip bot answers into the FAQ',
    ])
    expect(result.rejected).toBe(1)
    // Nobody writes up a task that is not going to exist.
    expect(requests.filter((r) => stageOf(r) === 'writeup')).toHaveLength(2)
  })

  it('drops an item it cannot trace to a line, and one that does not say what', async () => {
    const invented = JSON.stringify({
      title: 'Assume a salary of 1500 rupees',
      lines: [1],
      quote: 'we will assume the salary',
    })
    const vague = JSON.stringify({ title: 'Fix it', lines: [1], quote: 'fixed the capitalization stuff' })
    const { client } = fakeLlm(answering({ items: [carousel, invented, vague].join('\n') }))
    const result = await run(client)
    expect(result.tasks).toHaveLength(1)
    expect(result.filtered).toBe(2)
    expect(result.candidates).toBe(3)
  })

  it('falls back to what was found when the write-up is unreadable', async () => {
    const { client } = fakeLlm(answering({ writeup: 'I could not do this.' }))
    const [task] = (await run(client)).tasks
    expect(task).toMatchObject({
      text: 'Fix capitalization in the carousel',
      description: 'Raised again on this call.',
      kind: 'bug',
    })
  })

  it('drops a task its own lines show was set aside', async () => {
    const { client } = fakeLlm(answering({ writeup: writeUp({ status: 'parked' }) }))
    const result = await run(client)
    expect(result.tasks).toEqual([])
    expect(result.rejected).toBe(1)
  })

  it('groups by wording when the grouping step fails', async () => {
    const twice = [carousel, carousel.replace('Raised again on this call.', 'Still broken.').replace('"lines":[1,2]', '"lines":[2]')]
    const { client } = fakeLlm(
      answering({
        items: [twice[0], JSON.stringify({ ...JSON.parse(twice[1]!), title: 'Fix the capitalization in the carousel' })].join('\n'),
        group: 'the model rambled instead',
      })
    )
    expect((await run(client)).tasks).toHaveLength(1)
  })

  it('makes the same work found in the transcript and in your notes one task', async () => {
    const { client } = fakeLlm(
      answering({
        notesTasks:
          '{"text":"fix the carousel capitalization","owner":null,"due":null,"quote":"carousel caps still wrong"}',
        group: '{"job":1,"relation":"same"}',
      })
    )
    const result = await run(client, { scratch: 'carousel caps still wrong' })
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0]!.noteQuote).toBe('carousel caps still wrong')
    expect(result.tasks[0]!.source).toBe('transcript')
  })

  it('keeps an owner only when the lines name them, and marks yours', async () => {
    const { client } = fakeLlm(answering({ writeup: writeUp({ owner: 'Swap' }) }))
    const lines = [...transcript.slice(0, 2), line(4, 'Swap is on it.')]
    const items = JSON.stringify({ ...JSON.parse(carousel), lines: [1, 2, 4] })
    const named = fakeLlm(answering({ items, writeup: writeUp({ owner: 'Swap' }) }))
    expect((await run(named.client, { lines })).tasks[0]!.owner).toBe('Swap')

    // Nobody in these lines is called Zhaal.
    const invented = fakeLlm(answering({ writeup: writeUp({ owner: 'Zhaal' }) }))
    expect((await run(invented.client)).tasks[0]!.owner).toBeNull()

    const mine = fakeLlm(answering({ items, writeup: writeUp({ owner: 'Swap' }) }))
    expect((await run(mine.client, { lines, me: { name: 'Swap' } })).tasks[0]!.mine).toBe(true)
    void client
  })
})

describe('measuring before sending', () => {
  it('sizes chunks by the real count it is given', async () => {
    // A real hour was chunked by an estimate that was out by 1.8x; three of four
    // chunks overflowed. Given the model's own count, the chunks come out the
    // size they actually are.
    const lines = Array.from({ length: 10 }, (_, i) => line(i + 1, `point ${i}`))
    const count = async (text: string): Promise<number> => (text.startsWith('[') ? 900 : 300)
    const { client } = fakeLlm(() => '- something')

    const measured = await new MeetingNotesEngine(client, count).generate({
      lines,
      scratch: '',
      startedAt: Date.now(),
    })
    const estimated = await new MeetingNotesEngine(client).generate({
      lines,
      scratch: '',
      startedAt: Date.now(),
    })
    // 4096 - (300 + 24 + 1100) - 150 leaves 2522: two lines of 901 each.
    expect(measured.chunks).toBe(5)
    expect(estimated.chunks).toBe(1)
  })

  it('falls back to a padded estimate when the tokenizer cannot be asked', async () => {
    const { client } = fakeLlm(() => '- something')
    const result = await new MeetingNotesEngine(client, async () => null).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
    })
    expect(result.chunks).toBe(1)
  })
})

describe('when a step fails', () => {
  it('marks a failed chunk, carries on, and says which minutes were not read', async () => {
    const long = Array.from({ length: 400 }, (_, i) =>
      line(i + 1, 'a reasonably long line about the deployment pipeline and pricing')
    )
    let condensed = 0
    const { client } = fakeLlm((req) => {
      if (stageOf(req) === 'points') {
        condensed++
        if (condensed === 1) throw new Error('model restarting')
        return '- a point'
      }
      if (stageOf(req) === 'items') return ''
      return '## Summary\nok'
    })

    const result = await new MeetingNotesEngine(client).generate({
      lines: long,
      scratch: '',
      startedAt: Date.now(),
    })
    expect(result.chunks).toBeGreaterThan(1)
    expect(result.failedChunks).toBe(1)
    expect(result.gapsAt).toHaveLength(1)
    expect(result.gapsAt[0]!.fromMs).toBe(5_000)
    expect(result.coveredLines).toBeLessThan(result.totalLines)
    expect(result.notesMd).toContain('In short')
  })

  it('says which minutes gave no tasks when the tasks step fails on a part', async () => {
    const long = Array.from({ length: 400 }, (_, i) =>
      line(i + 1, 'a reasonably long line about the deployment pipeline and pricing')
    )
    let asked = 0
    const { client } = fakeLlm((req) => {
      if (stageOf(req) === 'items') {
        asked++
        if (asked === 1) throw new Error('model restarting')
      }
      return ''
    })
    const result = await new MeetingNotesEngine(client).generate({ lines: long, scratch: '', startedAt: Date.now() })
    expect(result.chunks).toBeGreaterThan(1)
    // The key points were read everywhere; the first part's tasks were not.
    expect(result.failedChunks).toBe(0)
    expect(result.tasksGapsAt).toHaveLength(1)
    expect(result.tasksGapsAt[0]!.fromMs).toBe(5_000)
  })

  it('refuses the run when nothing could be summarised, and says why', async () => {
    const { client } = fakeLlm((req) => {
      if (stageOf(req) === 'points') throw new Error('503 Loading model')
      return ''
    })
    const failure = run(client)
    await expect(failure).rejects.toBeInstanceOf(NotesUnavailable)
    await expect(failure).rejects.toThrow('503 Loading model')
  })

  it('still shows the key points when the gist comes back empty', async () => {
    // No gist is not a failure: never an unchecked sentence, and the points stand.
    const { client } = fakeLlm(answering({ gist: '   ' }))
    const result = await run(client)
    expect(result.summary.gist).toEqual([])
    expect(result.summary.points).toHaveLength(1)
    expect(result.notesMd).toContain('The gist could not be written')
  })

  it('refuses a meeting with no transcript at all', async () => {
    const { client } = fakeLlm(() => '')
    await expect(run(client, { lines: [] })).rejects.toBeInstanceOf(NotesUnavailable)
  })
})

describe('tasks the model was not entitled to', () => {
  it('drops an item quoting a line from a different chunk', async () => {
    // Each extraction call sees one chunk, so a quote from outside it is a
    // fabrication even if the words exist elsewhere in the meeting.
    // Lines with something in them: a task needs lines that say something.
    const long = Array.from({ length: 400 }, (_, i) =>
      line(i + 1, `point ${i} about the rollout plan for the payments service in the new region`)
    )
    const { client } = fakeLlm((req) => {
      if (stageOf(req) === 'items') {
        return '{"title":"Write the rollout plan","lines":[1],"quote":"point 0 about the rollout plan"}'
      }
      if (stageOf(req) === 'writeup') return '{"title":"Write the rollout plan","description":"x"}'
      if (stageOf(req) === 'group') return '{"items":["c1"],"status":"proposed"}'
      if (stageOf(req) === 'points') return '- a point'
      return '## Summary\nok'
    })

    const result = await new MeetingNotesEngine(client).generate({
      lines: long,
      scratch: '',
      startedAt: Date.now(),
    })
    // Exactly one chunk was entitled to cite line 1.
    expect(result.tasks).toHaveLength(1)
  })
})
