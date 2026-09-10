import type { LlmClient, LlmRequest, LlmResult } from '@wouice/llm'
import { describe, expect, it } from 'vitest'
import { MeetingNotesEngine, NotesUnavailable } from './notes-engine.js'
import type { TranscriptLine } from './notes.js'

/**
 * The notes run, minus the model.
 *
 * Most cases here are failure modes, because the happy path is one call after
 * another and the interesting question is what survives when one of them does
 * not. The rules under test: a gap stays visible, and a task survives only if
 * something other than the extractor agreed it is one.
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
      : req.system.startsWith('You check ONE')
        ? 'verify'
        : req.system.startsWith('You read the notes')
          ? 'notesTasks'
          : 'notes'

const yes = (area = 'frontend', kind = 'feature', owner: string | null = null): string =>
  JSON.stringify({ task: true, reason: 'somebody agreed to do it', area, kind, owner })
const no = JSON.stringify({ task: false, reason: 'a description of a deal, not an action' })

/** A candidate for line 2, quoting words that really are in it. */
const candidate =
  '{"text":"send the SSO timeline","owner":"You","due":"2026-09-14","line":2,"quote":"I will send the timeline"}'

describe('a normal run', () => {
  it('condenses, extracts, checks and writes, in that order', async () => {
    const { client, requests } = fakeLlm((req) => {
      switch (stageOf(req)) {
        case 'condense':
          return '- SSO must be done before rollout'
        case 'tasks':
          return candidate
        case 'verify':
          return yes()
        default:
          return '## Summary\nSSO blocks rollout.'
      }
    })

    const run = await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
    })

    expect(requests.map(stageOf)).toEqual(['condense', 'tasks', 'verify', 'notes'])
    expect(run.notesMd).toContain('## Summary')
    expect(run.tasks).toEqual([
      {
        text: 'send the SSO timeline',
        owner: 'You',
        due: '2026-09-14',
        segmentId: 2,
        area: 'frontend',
        kind: 'feature',
        reason: 'somebody agreed to do it',
        source: 'transcript',
        mine: true,
      },
    ])
    expect(run.failedChunks).toBe(0)
    expect(run.coveredLines).toBe(run.totalLines)
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

  it('hands your notes to the summary and the task finder, never to the condenser', async () => {
    const { client, requests } = fakeLlm((req) => (stageOf(req) === 'notesTasks' ? '' : '- something'))
    await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: 'priya = decision maker',
      startedAt: Date.now(),
    })
    const having = (stage: string): boolean =>
      requests.filter((r) => stageOf(r) === stage).some((r) => r.user.includes('priya'))
    expect(having('notes')).toBe(true)
    expect(having('notesTasks')).toBe(true)
    // What was said is condensed on its own; your notes are a signal about
    // what mattered, not part of the record of what was said.
    expect(having('condense')).toBe(false)
    expect(having('tasks')).toBe(false)
  })

  it('reports each step, including checking, so a long run is not a frozen window', async () => {
    const { client } = fakeLlm((req) =>
      stageOf(req) === 'tasks' ? candidate : stageOf(req) === 'verify' ? yes() : '- something'
    )
    const stages: string[] = []
    await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
      onProgress: (p) => stages.push(p.stage),
    })
    expect(stages).toEqual(['condensing', 'extracting', 'checking', 'writing'])
  })
})

describe('what a task has to survive', () => {
  it('refuses what the checker says is not a task', async () => {
    // Three descriptions of a revenue split came out of a real meeting as
    // tasks. The quote check could not stop them: the words were said.
    const { client } = fakeLlm((req) =>
      stageOf(req) === 'tasks' ? candidate : stageOf(req) === 'verify' ? no : '- something'
    )
    const run = await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
    })
    expect(run.tasks).toEqual([])
    expect(run.candidates).toBe(1)
    expect(run.rejected).toBe(1)
  })

  it('treats an unreadable verdict as no', async () => {
    const { client } = fakeLlm((req) =>
      stageOf(req) === 'tasks' ? candidate : stageOf(req) === 'verify' ? 'yes, probably' : '- x'
    )
    const run = await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
    })
    expect(run.tasks).toEqual([])
  })

  it('filters a refusal without asking the checker at all', async () => {
    const refusal = [line(1, "This image issue, go to the largest platforms, I'm not doing it")]
    const { client, requests } = fakeLlm((req) =>
      stageOf(req) === 'tasks'
        ? '{"text":"go to the largest platforms","owner":null,"due":null,"line":1,"quote":"go to the largest platforms"}'
        : stageOf(req) === 'verify'
          ? yes()
          : '- something'
    )
    const run = await new MeetingNotesEngine(client).generate({
      lines: refusal,
      scratch: '',
      startedAt: Date.now(),
    })
    expect(run.tasks).toEqual([])
    expect(run.filtered).toBe(1)
    expect(requests.some((r) => stageOf(r) === 'verify')).toBe(false)
  })

  it('takes a task from your notes, checked the same way', async () => {
    // "He reported the sign-in dialog is sticking" was in the notes of a real
    // meeting, and it is exactly the task the transcript pass missed.
    const scratch = 'he reported the sign in dialog is sticking after google sign in'
    const { client } = fakeLlm((req) => {
      switch (stageOf(req)) {
        case 'notesTasks':
          return '{"text":"fix the sticking sign-in dialog","owner":null,"due":null,"quote":"sign in dialog is sticking"}'
        case 'verify':
          return yes('frontend', 'bug')
        case 'tasks':
          return ''
        default:
          return '- something'
      }
    })
    const run = await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch,
      startedAt: Date.now(),
    })
    expect(run.tasks).toEqual([
      {
        text: 'fix the sticking sign-in dialog',
        owner: null,
        due: null,
        segmentId: null,
        noteQuote: 'sign in dialog is sticking',
        area: 'frontend',
        kind: 'bug',
        reason: 'somebody agreed to do it',
        source: 'notes',
        mine: false,
      },
    ])
  })

  it('does not list the same task twice from the transcript and the notes', async () => {
    const { client } = fakeLlm((req) => {
      switch (stageOf(req)) {
        case 'tasks':
          return candidate
        case 'notesTasks':
          return '{"text":"send the SSO timeline","owner":null,"due":null,"quote":"send the SSO timeline"}'
        case 'verify':
          return yes()
        default:
          return '- something'
      }
    })
    const run = await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: 'remember to send the SSO timeline',
      startedAt: Date.now(),
    })
    expect(run.tasks.map((t) => t.source)).toEqual(['transcript'])
  })

  it('marks a task yours when it was given to you by name', async () => {
    const { client } = fakeLlm((req) =>
      stageOf(req) === 'tasks'
        ? candidate
        : stageOf(req) === 'verify'
          ? yes('frontend', 'bug', 'Ayush')
          : '- something'
    )
    const run = await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
      me: { name: 'Ayush' },
    })
    expect(run.tasks[0]!.owner).toBe('Ayush')
    expect(run.tasks[0]!.mine).toBe(true)
  })

  it('does not mark someone else’s task yours', async () => {
    const { client } = fakeLlm((req) =>
      stageOf(req) === 'tasks'
        ? candidate
        : stageOf(req) === 'verify'
          ? yes('backend', 'chore', 'Himanshu')
          : '- something'
    )
    const run = await new MeetingNotesEngine(client).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
      me: { name: 'Ayush' },
    })
    expect(run.tasks[0]!.mine).toBe(false)
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
    // 4096 - 324 - 700 - 150 leaves 2922: three lines of 901 each.
    expect(measured.chunks).toBe(4)
    expect(estimated.chunks).toBe(1)
  })

  it('falls back to a padded estimate when the tokenizer cannot be asked', async () => {
    const { client } = fakeLlm(() => '- something')
    const run = await new MeetingNotesEngine(client, async () => null).generate({
      lines: transcript,
      scratch: '',
      startedAt: Date.now(),
    })
    expect(run.chunks).toBe(1)
  })
})

describe('when a step fails', () => {
  it('marks a failed chunk, carries on, and says which minutes were not read', async () => {
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
    // The gap is named, not just counted: a summary built from part of a
    // meeting that looks whole is the worst outcome, because you would act on it.
    expect(run.gapsAt).toHaveLength(1)
    expect(run.gapsAt[0]!.fromMs).toBe(5_000)
    expect(run.coveredLines).toBeLessThan(run.totalLines)
    expect(run.notesMd).toContain('Summary')
  })

  it('refuses the run when nothing could be summarised', async () => {
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
        return '{"text":"do the thing","owner":null,"due":null,"line":399,"quote":"point 398 about the rollout"}'
      }
      if (stageOf(req) === 'verify') return yes()
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
        return '{"text":"invented","owner":null,"due":null,"line":1,"quote":"point 0 about the rollout"}'
      }
      if (stageOf(req) === 'verify') return yes()
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
