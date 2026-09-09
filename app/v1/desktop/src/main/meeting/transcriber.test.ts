import type { AsrClient, TranscribeResult } from '@wouice/asr'
import { describe, expect, it, vi } from 'vitest'
import { MeetingTranscriber } from './transcriber.js'
import type { Segment } from './segmenter.js'
import { MEETING_SAMPLE_RATE } from './session.js'

/**
 * The live transcription path.
 *
 * The cases worth pinning are the ones that only appear over an hour: a queue
 * that grows, a chunk that fails, and the tail of a meeting arriving after the
 * stop. None of them need a model, so none of them need a GPU to test.
 */

function fakeAsr(
  reply: (pcm: Float32Array, call: number) => Partial<TranscribeResult> | Promise<Partial<TranscribeResult>>
): AsrClient & { calls: number } {
  let calls = 0
  const client = {
    get calls() {
      return calls
    },
    async transcribe(pcm: Float32Array): Promise<TranscribeResult> {
      const mine = calls++
      const partial = await reply(pcm, mine)
      return {
        text: '',
        language: 'en',
        audioMs: 0,
        latencyMs: 0,
        model: 'test',
        ...partial,
      }
    },
    async health() {
      return { ok: true, model: 'test' }
    },
  }
  return client as AsrClient & { calls: number }
}

/**
 * What whisper returns: its own segment boundaries, plus per-word timings that
 * are interpolated across them rather than measured.
 */
function said(text: string, startSec = 0): Partial<TranscribeResult> {
  const words = text.split(' ')
  const endSec = startSec + words.length * 0.3
  return {
    text,
    segments: [{ text, startSec, endSec, noSpeechProb: 0.05, avgLogprob: -0.3 }],
    tokens: words.map((word, i) => ({
      token: (i === 0 ? '' : ' ') + word,
      startSec: startSec + i * 0.3,
      endSec: startSec + i * 0.3 + 0.25,
      confidence: 0.9,
    })),
  }
}

/** Audible: below the silence gate a chunk is never sent, by design. */
const frames = (seconds: number): Float32Array =>
  new Float32Array(Math.round(seconds * MEETING_SAMPLE_RATE)).fill(0.05)

describe('chunking', () => {
  it('sends nothing until a chunk is full', async () => {
    const asr = fakeAsr(() => (said('hello')))
    const transcriber = new MeetingTranscriber({ asr, onSegments: () => {}, chunkSeconds: 25 })

    transcriber.push('me', frames(10), 0)
    await vi.waitFor(() => expect(asr.calls).toBe(0))
    expect(transcriber.stats().chunksSent).toBe(0)
  })

  it('sends one request per full chunk, per channel', async () => {
    const asr = fakeAsr(() => (said('hello')))
    const transcriber = new MeetingTranscriber({ asr, onSegments: () => {}, chunkSeconds: 5 })

    transcriber.push('me', frames(5), 0)
    transcriber.push('them', frames(5), 0)
    await vi.waitFor(() => expect(transcriber.stats().chunksSent).toBe(2))
  })

  it('transcribes the tail when the meeting stops', async () => {
    // The end of a meeting is where the decisions usually are. Dropping a
    // part-full chunk to finish quickly would be the wrong trade.
    const asr = fakeAsr(() => (said('one last thing')))
    const closed: Segment[] = []
    const transcriber = new MeetingTranscriber({
      asr,
      onSegments: (s) => closed.push(...s),
      chunkSeconds: 25,
    })

    transcriber.push('me', frames(3), 0)
    await transcriber.finish()

    expect(asr.calls).toBe(1)
    expect(closed.map((s) => s.text)).toEqual(['one last thing'])
  })

  it('places a chunk where its audio actually is', async () => {
    // Every chunk starts at zero as far as the model is concerned. Without the
    // running offset the whole meeting piles into the first 25 seconds.
    const asr = fakeAsr(() => (said('later words')))
    const closed: Segment[] = []
    const transcriber = new MeetingTranscriber({
      asr,
      onSegments: (s) => closed.push(...s),
      chunkSeconds: 5,
    })

    transcriber.push('me', frames(5), 0)
    await vi.waitFor(() => expect(transcriber.stats().chunksSent).toBe(1))
    transcriber.push('me', frames(5), 0)
    await transcriber.finish()

    // The second chunk's words sit after the first five seconds.
    expect(closed[closed.length - 1]!.startMs).toBeGreaterThanOrEqual(5_000)
  })

  it('honours a channel that started late', async () => {
    // The loopback stream comes up after the microphone, and the merged file
    // pads it. The transcript has to agree with the file.
    const asr = fakeAsr(() => (said('their first words')))
    const closed: Segment[] = []
    const transcriber = new MeetingTranscriber({
      asr,
      onSegments: (s) => closed.push(...s),
      chunkSeconds: 5,
    })

    transcriber.push('them', frames(5), 1_500)
    await transcriber.finish()
    expect(closed[0]!.startMs).toBeGreaterThanOrEqual(1_500)
  })
})

describe('when things go wrong', () => {
  it('loses the slice, not the meeting', async () => {
    const asr = fakeAsr((_pcm, call) => {
      if (call === 0) throw new Error('whisper is restarting')
      return said('this one worked')
    })
    const closed: Segment[] = []
    const transcriber = new MeetingTranscriber({
      asr,
      onSegments: (s) => closed.push(...s),
      chunkSeconds: 5,
    })

    transcriber.push('me', frames(5), 0)
    await vi.waitFor(() => expect(transcriber.stats().chunksFailed).toBe(1))
    transcriber.push('me', frames(5), 0)
    await transcriber.finish()

    expect(transcriber.stats().chunksFailed).toBe(1)
    expect(closed.map((s) => s.text)).toContain('this one worked')
  })

  it('carries on when a chunk comes back with no timings', async () => {
    // A server build that does not emit them leaves the segmenter nothing to
    // work with, which is a quiet loss rather than a crash.
    const asr = fakeAsr(() => ({ text: 'words but no times' }))
    const transcriber = new MeetingTranscriber({ asr, onSegments: () => {}, chunkSeconds: 5 })
    transcriber.push('me', frames(5), 0)
    await transcriber.finish()
    expect(transcriber.stats().chunksSent).toBe(1)
    expect(transcriber.stats().segments).toBe(0)
  })

  it('ignores audio pushed after the meeting ended', async () => {
    const asr = fakeAsr(() => said('done'))
    const transcriber = new MeetingTranscriber({ asr, onSegments: () => {}, chunkSeconds: 5 })
    await transcriber.finish()
    transcriber.push('me', frames(10), 0)
    expect(transcriber.stats().chunksSent).toBe(0)
  })
})

describe('the queue, which is what B4 watches', () => {
  it('runs one request at a time and reports the backlog', async () => {
    // whisper-server serialises anyway, so what matters is being able to SEE a
    // backlog: one that grows by a little per chunk is invisible for five
    // minutes and fatal at sixty.
    let concurrent = 0
    let peak = 0
    const asr = fakeAsr(async () => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await new Promise((r) => setTimeout(r, 20))
      concurrent--
      return said('word')
    })
    const transcriber = new MeetingTranscriber({ asr, onSegments: () => {}, chunkSeconds: 1 })

    for (let i = 0; i < 5; i++) transcriber.push('me', frames(1), 0)
    expect(transcriber.stats().queued).toBeGreaterThan(1)

    await transcriber.finish()
    expect(peak).toBe(1)
    expect(transcriber.stats().queued).toBe(0)
  })

  it('empties by the time the meeting is finished', async () => {
    const asr = fakeAsr(() => (said('word')))
    const transcriber = new MeetingTranscriber({ asr, onSegments: () => {}, chunkSeconds: 1 })
    for (let i = 0; i < 4; i++) transcriber.push('me', frames(1), 0)
    await transcriber.finish()
    expect(transcriber.stats().queued).toBe(0)
    expect(transcriber.stats().chunksSent).toBe(4)
  })
})

describe('what never reaches the model', () => {
  it('does not ask about silence', () => {
    // Whisper does not answer "nothing was said" - it answers "Thank you.",
    // confidently. One real meeting collected five of those, and the system
    // channel is a digital tap, so an empty stretch is exactly zero.
    const asr = fakeAsr(() => said('Thank you.'))
    const transcriber = new MeetingTranscriber({ asr, onSegments: () => {}, chunkSeconds: 1 })
    transcriber.push('me', new Float32Array(MEETING_SAMPLE_RATE), 0)
    expect(asr.calls).toBe(0)
    expect(transcriber.stats().chunksSkipped).toBe(1)
  })

  it('still asks about quiet speech', async () => {
    const asr = fakeAsr(() => said('barely audible'))
    const transcriber = new MeetingTranscriber({ asr, onSegments: () => {}, chunkSeconds: 1 })
    // Well under ordinary speech, well over an empty channel.
    transcriber.push('me', new Float32Array(MEETING_SAMPLE_RATE).fill(0.003), 0)
    await vi.waitFor(() => expect(transcriber.stats().chunksSent).toBe(1))
  })
})

describe('language', () => {
  it('pins whatever the first chunk detected', async () => {
    // Detection runs per request. One measured meeting came back as Icelandic,
    // Japanese, Spanish and English in turn, from one conversation.
    const asked: (string | undefined)[] = []
    const asr = fakeAsr(() => ({ ...said('कुछ तो है'), language: 'hindi' }))
    const original = asr.transcribe.bind(asr)
    asr.transcribe = (pcm, options) => {
      asked.push(options?.language)
      return original(pcm, options)
    }

    const transcriber = new MeetingTranscriber({ asr, onSegments: () => {}, chunkSeconds: 1 })
    transcriber.push('me', frames(1), 0)
    await vi.waitFor(() => expect(transcriber.stats().chunksSent).toBe(1))
    transcriber.push('me', frames(1), 0)
    await transcriber.finish()

    expect(asked[0]).toBe('auto')
    expect(asked.slice(1).every((l) => l === 'hindi')).toBe(true)
    expect(transcriber.stats().language).toBe('hindi')
  })

  it('never asks for auto when told the language', async () => {
    const asked: (string | undefined)[] = []
    const asr = fakeAsr(() => said('कुछ तो है'))
    const original = asr.transcribe.bind(asr)
    asr.transcribe = (pcm, options) => {
      asked.push(options?.language)
      return original(pcm, options)
    }

    const transcriber = new MeetingTranscriber({
      asr,
      onSegments: () => {},
      chunkSeconds: 1,
      language: 'hi',
    })
    transcriber.push('me', frames(1), 0)
    await transcriber.finish()
    expect(asked.every((l) => l === 'hi')).toBe(true)
  })
})
