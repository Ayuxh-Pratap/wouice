import type { LlmClient, LlmRequest, LlmResult } from '@wouice/llm'
import { describe, expect, it } from 'vitest'
import { MeetingEnglishEngine } from './english-engine.js'

/**
 * The English pass, minus the model: what it asks, and where it files the
 * answers. The failure worth guarding against is an answer filed under the
 * wrong line - on a real call, the right English sat on the wrong lines.
 */

function fakeLlm(reply: (req: LlmRequest) => string): { client: () => LlmClient; requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  const client: LlmClient = {
    async complete(req: LlmRequest): Promise<LlmResult> {
      requests.push(req)
      return { text: reply(req), latencyMs: 1, provider: 'local', model: 'test' }
    },
    async health() {
      return { ok: true }
    },
  }
  return { client: () => client, requests }
}

const lines = [
  { id: 1836, text: 'ओके सो ये मीटिंग बस इसलिए राखी है', speaker: 'Ayush Pratap Singh' },
  { id: 1837, text: 'वेरी वेरी फाइन', speaker: 'Ayush Pratap Singh' },
  { id: 1838, text: 'सर्च करना है', speaker: 'Ayush Pratap Singh' },
]

describe('the English pass', () => {
  it('asks for one line at a time, numbered from 1, and files each answer under its own line', async () => {
    const answers = ['Okay, so this meeting is just to check', 'Very very fine', 'I need to search']
    let call = 0
    const { client, requests } = fakeLlm(() => `[1] ${answers[call++]}`)
    const run = await new MeetingEnglishEngine(client).render({ lines })

    expect(requests).toHaveLength(3)
    // No long ids for the model to copy back wrong.
    for (const req of requests) expect(req.user).not.toMatch(/\[18\d\d\]/)
    expect(run.rendered).toEqual([
      { id: 1836, textEn: 'Okay, so this meeting is just to check' },
      { id: 1837, textEn: 'Very very fine' },
      { id: 1838, textEn: 'I need to search' },
    ])
  })

  it('shows what was said just before as context, never as a line to render', async () => {
    const { client, requests } = fakeLlm(() => '[1] something')
    await new MeetingEnglishEngine(client).render({ lines, people: ['Ayush Pratap Singh'] })
    const third = requests[2]!.user
    expect(third).toContain('Before this (context only):')
    expect(third).toContain('(Ayush Pratap Singh) ओके सो ये मीटिंग बस इसलिए राखी है')
    expect(third).toContain('[1] (Ayush Pratap Singh) सर्च करना है')
    expect(third).toContain('the people in this meeting: Ayush Pratap Singh')
  })

  it('keeps a line the model could not render as it was, and counts it', async () => {
    const { client } = fakeLlm((req) => (req.user.includes('वेरी वेरी फाइन') && !req.user.includes('सर्च') ? '[1]' : '[1] rendered'))
    const run = await new MeetingEnglishEngine(client).render({ lines })
    expect(run.rendered.map((r) => r.id)).toEqual([1836, 1838])
    expect(run.missed).toBe(1)
  })
})
