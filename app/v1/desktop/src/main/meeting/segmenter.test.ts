import type { AsrSegment, TokenTiming } from '@wouice/asr'
import { describe, expect, it } from 'vitest'
import {
  isHallucination,
  wordsFromTokens,
  DEFAULT_SEGMENTER,
  Segmenter,
  type AsrChunk,
} from './segmenter.js'

/**
 * What a meeting transcript reads like.
 *
 * Every case here comes from a real meeting that came out badly: 46% of its
 * segments were one word, "Thank" appeared five times over silence, and the
 * word timings it was all built from were interpolated rather than measured.
 */

function seg(text: string, startSec: number, endSec: number, over: Partial<AsrSegment> = {}): AsrSegment {
  return { text, startSec, endSec, noSpeechProb: 0.05, avgLogprob: -0.3, ...over }
}

/**
 * Word timings as whisper.cpp actually returns them: evenly interpolated
 * across the segment, with `t_dtw: -1` meaning nothing was measured.
 */
function interpolate(text: string, startSec: number, endSec: number): TokenTiming[] {
  const words = text.split(' ')
  const step = (endSec - startSec) / Math.max(1, words.length)
  return words.map((w, i) => ({
    token: (i === 0 ? '' : ' ') + w,
    startSec: startSec + i * step,
    endSec: startSec + (i + 1) * step,
    confidence: 0.5,
  }))
}

const chunk = (segments: AsrSegment[]): AsrChunk => ({
  segments,
  words: segments.flatMap((s) => interpolate(s.text, s.startSec, s.endSec)),
})

describe('where a segment ends', () => {
  it('keeps one utterance as one line', () => {
    // The bug this replaces cut on interpolated word gaps and produced four
    // fragments from a sentence like this.
    const s = new Segmenter()
    s.push('me', chunk([seg('what are the things that are going on', 0, 6)]), 0)
    const [out] = s.flush()
    expect(out!.text).toBe('what are the things that are going on')
  })

  it('joins whisper segments that run together', () => {
    const s = new Segmenter()
    s.push('me', chunk([seg('okay so the demo', 0, 3), seg('environment is down', 3.2, 6)]), 0)
    expect(s.flush()[0]!.text).toBe('okay so the demo environment is down')
  })

  it('splits on a real pause between utterances', () => {
    const s = new Segmenter()
    const closed = s.push(
      'me',
      chunk([seg('so many failures', 0, 3), seg('anyway lets move on', 8, 11)]),
      0
    )
    expect(closed).toHaveLength(1)
    expect(closed[0]!.text).toBe('so many failures')
  })

  it('cuts a monologue at the maximum length', () => {
    const s = new Segmenter()
    const parts = Array.from({ length: 12 }, (_, i) => seg(`part ${i}`, i * 2, i * 2 + 1.9))
    const closed = s.push('them', chunk(parts), 0)
    expect(closed.length).toBeGreaterThan(0)
    for (const out of [...closed, ...s.flush()]) {
      expect(out.endMs - out.startMs).toBeLessThanOrEqual(DEFAULT_SEGMENTER.maxSegmentSec * 1000 + 2_000)
    }
  })

  it('keeps a sentence together across an ASR chunk boundary', () => {
    const s = new Segmenter()
    s.push('me', chunk([seg('the first half', 24, 24.9)]), 0)
    const closed = s.push('me', chunk([seg('of one sentence', 0.1, 1)]), 25_000)
    expect(closed).toHaveLength(0)
    expect(s.flush()[0]!.text).toBe('the first half of one sentence')
  })

  it('places a chunk where its audio actually is', () => {
    const s = new Segmenter()
    s.push('me', chunk([seg('later words', 0, 2)]), 60_000)
    expect(s.flush()[0]!.startMs).toBe(60_000)
  })

  it('keeps the channels apart', () => {
    const s = new Segmenter()
    s.push('me', chunk([seg('my line', 0, 2)]), 0)
    s.push('them', chunk([seg('their line', 0, 2)]), 0)
    const all = s.flush()
    expect(all.find((x) => x.channel === 'me')!.text).toBe('my line')
    expect(all.find((x) => x.channel === 'them')!.text).toBe('their line')
  })

  it('has nothing to flush when nothing was said', () => {
    expect(new Segmenter().flush()).toEqual([])
  })
})

describe('what whisper made up', () => {
  it('drops a line the model itself calls silence', () => {
    // "Thank you." over a quiet stretch, five times in one real meeting. The
    // model knew, and nothing was reading it.
    const s = new Segmenter()
    s.push('me', chunk([seg('Thank you.', 0, 2, { noSpeechProb: 0.94 })]), 0)
    expect(s.flush()).toEqual([])
  })

  it('drops a short line the model was guessing at', () => {
    const s = new Segmenter()
    s.push('me', chunk([seg('you.', 0, 1, { avgLogprob: -1.8 })]), 0)
    expect(s.flush()).toEqual([])
  })

  it('keeps a long line even at a poor score', () => {
    // Accented or code-mixed speech scores badly and is still real. Length is
    // what separates "hard to hear" from "nothing was there".
    const long = 'so the payment alignment on the demo environment is still not right'
    const s = new Segmenter()
    s.push('me', chunk([seg(long, 0, 6, { avgLogprob: -1.5 })]), 0)
    expect(s.flush()[0]!.text).toBe(long)
  })

  it('drops punctuation-only lines', () => {
    // Six segments of "." came out of one real meeting.
    const s = new Segmenter()
    s.push('me', chunk([seg('.', 0, 1), seg('...', 2, 3)]), 0)
    expect(s.flush()).toEqual([])
  })

  it('is decided by the model, not by a keyword list', () => {
    for (const text of ['Thank you.', 'Subscribe to my channel', 'you']) {
      expect(isHallucination(seg(text, 0, 1, { noSpeechProb: 0.95 }), DEFAULT_SEGMENTER)).toBe(true)
      expect(isHallucination(seg(text, 0, 4, { noSpeechProb: 0.1 }), DEFAULT_SEGMENTER)).toBe(false)
    }
  })
})

describe('echo', () => {
  it('flags the far side arriving through your microphone', () => {
    const s = new Segmenter()
    s.push('them', chunk([seg('we need SSO before rollout', 10, 13)]), 0)
    s.push('me', chunk([seg('we need SSO before rollout', 10.4, 13.4)]), 0)
    const mine = s.flush().filter((x) => x.channel === 'me')
    expect(mine[0]!.echo).toBe(true)
  })

  it('does not flag you genuinely repeating them', () => {
    // The premise: a real repeat does not land three consecutive words inside
    // two seconds of the original.
    const s = new Segmenter()
    s.push('them', chunk([seg('we need SSO before rollout', 10, 13)]), 0)
    s.push('me', chunk([seg('SSO before rollout got it', 30, 33)]), 0)
    expect(s.flush().find((x) => x.channel === 'me')!.echo).toBe(false)
  })

  it('never flags the system channel', () => {
    const s = new Segmenter()
    s.push('them', chunk([seg('one two three four five', 0, 3)]), 0)
    s.push('them', chunk([seg('one two three four five', 3.5, 6)]), 0)
    expect(s.flush().every((x) => x.channel !== 'them' || !x.echo)).toBe(true)
  })

  it('forgets system audio older than its memory window', () => {
    const s = new Segmenter()
    s.push('them', chunk([seg('quarterly revenue is up', 0, 3)]), 0)
    s.push('them', chunk([seg('anything else', 180, 182)]), 0)
    s.push('me', chunk([seg('quarterly revenue is up', 181, 184)]), 0)
    expect(s.flush().find((x) => x.channel === 'me')!.echo).toBe(false)
  })

  it('flags nothing when only one channel ever spoke', () => {
    const s = new Segmenter()
    s.push('me', chunk([seg('talking to myself here', 0, 3)]), 0)
    expect(s.flush()[0]!.echo).toBe(false)
  })
})

describe('word assembly, which echo still needs', () => {
  it('joins subwords into the word they spell', () => {
    const words = wordsFromTokens([
      { token: ' deploy', startSec: 0, endSec: 0.3, confidence: 0.9 },
      { token: 'ment', startSec: 0.3, endSec: 0.5, confidence: 0.9 },
    ])
    expect(words.map((w) => w.text)).toEqual(['deployment'])
  })

  it('never lets a word end before it starts', () => {
    // Real output: `end` missing entirely, which used to become zero and then
    // an enormous fake gap to the next word.
    const words = wordsFromTokens([{ token: ' hello', startSec: 5, endSec: 0, confidence: 0.5 }])
    expect(words[0]!.endMs).toBeGreaterThanOrEqual(words[0]!.startMs)
  })
})
