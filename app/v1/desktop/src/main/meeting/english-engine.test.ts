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

  it('with several slots, runs lines side by side and still files each answer under its own line', async () => {
    let inFlight = 0
    let most = 0
    const requests: LlmRequest[] = []
    const client: LlmClient = {
      async complete(req: LlmRequest): Promise<LlmResult> {
        requests.push(req)
        inFlight++
        most = Math.max(most, inFlight)
        // The first line asked for answers last, so answers come back out of order.
        const line = lines.find((l) => req.user.includes(`[1] (${l.speaker}) ${l.text}`))!
        await new Promise((resolve) => setTimeout(resolve, 30 - lines.indexOf(line) * 10))
        inFlight--
        return { text: `[1] english of ${line.id}`, latencyMs: 1, provider: 'local', model: 'test' }
      },
      async health() {
        return { ok: true }
      },
    }
    const run = await new MeetingEnglishEngine(() => client).render({ lines, concurrency: 2 })

    expect(most).toBe(2)
    expect(run.rendered).toEqual(lines.map((l) => ({ id: l.id, textEn: `english of ${l.id}` })))
    // The context is still what was said before each line, not what came back.
    expect(requests.find((r) => r.user.includes('सर्च करना है'))!.user).toContain(
      '(Ayush Pratap Singh) वेरी वेरी फाइन'
    )
  })

  it('offers the glossary as a spelling reference, never as a line to render', async () => {
    const { client, requests } = fakeLlm(() => '[1] something')
    await new MeetingEnglishEngine(client).render({ lines: lines.slice(0, 1), glossary: ['Claude (heard as: Lord, लॉर्ड)', 'Finch Bot'] })
    expect(requests[0]!.user).toContain(
      'Reference only - names and words these meetings use, spelled right, with what each is often misheard as:\n- Claude (heard as: Lord, लॉर्ड)\n- Finch Bot'
    )
    // The line to render is still the only numbered one.
    expect(requests[0]!.user.match(/^\[\d+\]/gm)).toEqual(['[1]'])
  })

  it('asks the vocabulary for what each line and its context call for', async () => {
    const { client, requests } = fakeLlm(() => '[1] something')
    const asked: string[] = []
    await new MeetingEnglishEngine(client).render({
      lines,
      glossary: (text) => {
        asked.push(text)
        return text.includes('वेरी') ? ['Very'] : []
      },
    })
    // The second line's request carries its own entry; the first line's has none.
    expect(requests[0]!.user).not.toContain('- Very')
    expect(requests[1]!.user).toContain('- Very')
    // Asked with the line and the lines before it.
    expect(asked[1]).toContain('ओके सो ये मीटिंग')
  })

  it('keeps a line the model could not render as it was, and counts it', async () => {
    const { client } = fakeLlm((req) => (req.user.includes('वेरी वेरी फाइन') && !req.user.includes('सर्च') ? '[1]' : '[1] rendered'))
    const run = await new MeetingEnglishEngine(client).render({ lines })
    expect(run.rendered.map((r) => r.id)).toEqual([1836, 1838])
    expect(run.missed).toBe(1)
  })
})
