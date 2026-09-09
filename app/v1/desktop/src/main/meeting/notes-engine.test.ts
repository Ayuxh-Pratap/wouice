import type { LlmClient, LlmRequest, LlmResult } from '@wouice/llm'
import { describe, expect, it } from 'vitest'
import { MeetingNotesEngine, NotesUnavailable } from './notes-engine.js'
import type { TranscriptLine } from './notes.js'

/**
 * The notes run, minus the model.
 *
 * Every case here is a failure mode, because the happy path is one call after
 * another and the interesting question is what survives when one of them does
 * not. The rule under test throughout: a gap must stay visible.
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

const line = (id: number, text: string): TranscriptLine => ({
  id,
  channel: id % 2 === 0 ? 'me' : 'them',
  startMs: id * 5_000,
  text,
  echo: false,
})

const transcript = [
  line(1, 'we need the SSO work finished before rollout'),
  line(2, 'I can take that, I will send the timeline on Monday'),
  line(3, 'pricing moves to twelve dollars a seat from Q3'),
]

/** Which system prompt a request was for. */
const stageOf = (req: LlmRequest): string =>
  req.system.startsWith('You are condensing')
    ? 'condense'
    : req.system.startsWith('You extract')
      ? 'tasks'
      : 'notes'

describe('a normal run', () => {
  it('condenses, extracts and writes, in that order', async () => {
    const { client, requests } = fakeLlm((req) => {
      switch (stageOf(req)) {
        case 'condense':
          return '- SSO must be done before rollout'
        case 'tasks':
          return '{"text":"send the SSO timeline","owner":"You","due":"2026-09-14","line":2}'
        default:
          return '## Summary\nSSO blocks rollout.'
      }
    })

    const engine = new MeetingNotesEngine(client)
    const run = await engine.generate({ lines: transcript, scratch: '', startedAt: Date.now() })

    expect(requests.map(stageOf)).toEqual(['condense', 'tasks', 'notes'])
    expect(run.notesMd).toContain('## Summary')
    expect(run.tasks).toEqual([
      { text: 'send the SSO timeline', owner: 'You', due: '2026-09-14', segmentId: 2 },
    ])
    expect(run.failedChunks).toBe(0)
  })

  it('asks for the same answer every time', async () => {
    // A meeting summary that changes when you regenerate it is one you cannot
    // cite in an argument about what was agreed.
    const { client, requests } = fakeLlm(() => '- something')
    await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
    })
    expect(requests.every((r) => r.temperature === 0)).toBe(true)
  })

  it('hands the scratch notes to the writing step only', async () => {
    const { client, requests } = fakeLlm(() => '- something')
    await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: 'priya = decision maker',
      startedAt: Date.now(),
    })
    const notes = requests.find((r) => stageOf(r) === 'notes')!
    expect(notes.user).toContain('priya = decision maker')
    expect(requests.filter((r) => r.user.includes('priya'))).toHaveLength(1)
  })

  it('reports progress so half a minute is not a frozen window', async () => {
    const { client } = fakeLlm(() => '- something')
    const stages: string[] = []
    await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
      onProgress: (p) => stages.push(p.stage),
    })
    expect(stages).toContain('condensing')
    expect(stages).toContain('extracting')
    expect(stages).toContain('writing')
  })
})

describe('when a step fails', () => {
  it('marks a failed chunk and carries on', async () => {
    const long = Array.from({ length: 400 }, (_, i) =>
      line(i + 1, 'a reasonably long line about the deployment pipeline and pricing')
    )
    let condensed = 0
    const { client } = fakeLlm((req) => {
      if (stageOf(req) === 'condense') {
        condensed++
        if (condensed === 1) throw new Error('model restarting')
        return '- a point'
      }
      if (stageOf(req) === 'tasks') return ''
      return '## Summary\nok'
    })

    const run = await new MeetingNotesEngine(client).generate({
      lines: long,
      scratch: '',
      startedAt: Date.now(),
    })
    expect(run.chunks).toBeGreaterThan(1)
    expect(run.failedChunks).toBe(1)

    // The notes still get written, and the gap is in what they were built from.
    expect(run.notesMd).toContain('Summary')
  })

  it('refuses the run when nothing could be summarised', async () => {
    // Notes assembled from nothing would look like a meeting where nothing
    // happened.
    const { client } = fakeLlm((req) => {
      if (stageOf(req) === 'condense') throw new Error('down')
      return ''
    })
    await expect(
      new MeetingNotesEngine(client).generate({
        lines: transcript,
        scratch: '',
        startedAt: Date.now(),
      })
    ).rejects.toBeInstanceOf(NotesUnavailable)
  })

  it('refuses when the final write comes back empty', async () => {
    const { client } = fakeLlm((req) => (stageOf(req) === 'notes' ? '   ' : '- a point'))
    await expect(
      new MeetingNotesEngine(client).generate({
        lines: transcript,
        scratch: '',
        startedAt: Date.now(),
      })
    ).rejects.toBeInstanceOf(NotesUnavailable)
  })

  it('refuses a meeting with no transcript at all', async () => {
    const { client } = fakeLlm(() => '')
    await expect(
      new MeetingNotesEngine(client).generate({ lines: [], scratch: '', startedAt: Date.now() })
    ).rejects.toBeInstanceOf(NotesUnavailable)
  })

  it('keeps tasks from the chunks that worked when extraction fails elsewhere', async () => {
    const long = Array.from({ length: 400 }, (_, i) => line(i + 1, `point ${i} about the rollout`))
    let extracted = 0
    const { client } = fakeLlm((req) => {
      if (stageOf(req) === 'tasks') {
        extracted++
        if (extracted === 1) throw new Error('down')
        return '{"text":"do the thing","owner":null,"due":null,"line":399}'
      }
      if (stageOf(req) === 'condense') return '- a point'
      return '## Summary\nok'
    })

    const run = await new MeetingNotesEngine(client).generate({
      lines: long,
      scratch: '',
      startedAt: Date.now(),
    })
    expect(run.tasks.length).toBeGreaterThan(0)
  })
})

describe('tasks the model was not entitled to', () => {
  it('drops a task citing a line from a different chunk', async () => {
    // Each extraction call sees one chunk, so a citation from outside it is a
    // fabrication even if the line exists elsewhere in the meeting.
    const long = Array.from({ length: 400 }, (_, i) => line(i + 1, `point ${i} about the rollout`))
    const { client } = fakeLlm((req) => {
      if (stageOf(req) === 'tasks') {
        // Line 1 is only in the first chunk; every later chunk citing it is
        // pointing at something it never saw.
        return '{"text":"invented","owner":null,"due":null,"line":1}'
      }
      if (stageOf(req) === 'condense') return '- a point'
      return '## Summary\nok'
    })

    const run = await new MeetingNotesEngine(client).generate({
      lines: long,
      scratch: '',
      startedAt: Date.now(),
    })
    // Exactly one chunk was entitled to cite line 1.
    expect(run.tasks).toHaveLength(1)
  })
})
