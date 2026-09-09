import type { TokenTiming } from '@wouice/asr'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SEGMENTER, Segmenter, wordsFromTokens } from './segmenter.js'

/**
 * The two rules that decide whether a meeting transcript is readable: where an
 * utterance ends, and which of your lines are really the far side coming back
 * through your own microphone.
 */

/** Tokens as whisper emits them: subwords, a leading space starting a word. */
function speak(text: string, startSec: number, secPerWord = 0.3): TokenTiming[] {
  return text.split(' ').map((word, i) => ({
    token: (i === 0 ? '' : ' ') + word,
    startSec: startSec + i * secPerWord,
    endSec: startSec + i * secPerWord + secPerWord * 0.9,
    confidence: 0.9,
  }))
}

describe('tokens to words', () => {
  it('joins subwords into the word they spell', () => {
    // Concatenation has to reproduce the text exactly, which is the whole
    // reason the leading space is the delimiter rather than anything cleverer.
    const tokens: TokenTiming[] = [
      { token: ' deploy', startSec: 0, endSec: 0.3, confidence: 0.9 },
      { token: 'ment', startSec: 0.3, endSec: 0.5, confidence: 0.9 },
      { token: ' pipeline', startSec: 0.6, endSec: 1.0, confidence: 0.9 },
    ]
    const words = wordsFromTokens(tokens)
    expect(words.map((w) => w.text)).toEqual(['deployment', 'pipeline'])
    expect(words[0]!.endMs).toBe(500)
  })

  it('offsets into the meeting, not the chunk', () => {
    // Every chunk starts at zero as far as the model is concerned. Without the
    // offset every segment in a two hour meeting sits in the first 25 seconds.
    const words = wordsFromTokens(speak('hello there', 0), 60_000)
    expect(words[0]!.startMs).toBe(60_000)
  })

  it('drops empty and whitespace-only tokens', () => {
    const words = wordsFromTokens([
      { token: ' ', startSec: 0, endSec: 0.1, confidence: 0.5 },
      { token: '', startSec: 0.1, endSec: 0.2, confidence: 0.5 },
      { token: ' ok', startSec: 0.2, endSec: 0.4, confidence: 0.9 },
    ])
    expect(words.map((w) => w.text)).toEqual(['ok'])
  })
})

describe('where a segment ends', () => {
  it('closes on a pause', () => {
    const seg = new Segmenter()
    expect(seg.push('me', speak('can you take the api', 0), 0)).toHaveLength(0)
    // Two seconds later is a new utterance, not the same sentence.
    const closed = seg.push('me', speak('yes I can', 3.5), 0)
    expect(closed).toHaveLength(1)
    expect(closed[0]!.text).toBe('can you take the api')
  })

  it('keeps a sentence together across an ASR chunk boundary', () => {
    // Chunks arrive on a 25 second schedule that has nothing to do with speech.
    // Cutting there would chop the transcript arbitrarily.
    const seg = new Segmenter()
    seg.push('me', speak('the first half', 24.0), 0)
    const closed = seg.push('me', speak('of one sentence', 0.1), 25_000)
    expect(closed).toHaveLength(0)
    expect(seg.flush()[0]!.text).toBe('the first half of one sentence')
  })

  it('cuts a monologue at the maximum length', () => {
    const seg = new Segmenter()
    // Twenty seconds of unbroken speech, well past the 15s cap.
    const closed = seg.push('them', speak(Array(40).fill('and').join(' '), 0, 0.5), 0)
    expect(closed.length).toBeGreaterThan(0)
    const spans = closed.map((s) => s.endMs - s.startMs)
    expect(Math.max(...spans)).toBeLessThanOrEqual(DEFAULT_SEGMENTER.maxSegmentSec * 1000 + 500)
  })

  it('keeps the channels apart', () => {
    const seg = new Segmenter()
    seg.push('me', speak('my line', 0), 0)
    seg.push('them', speak('their line', 0), 0)
    const all = seg.flush()
    expect(all.find((s) => s.channel === 'me')!.text).toBe('my line')
    expect(all.find((s) => s.channel === 'them')!.text).toBe('their line')
  })

  it('has nothing to flush when nothing was said', () => {
    expect(new Segmenter().flush()).toEqual([])
  })
})

describe('echo', () => {
  it('flags the far side arriving through your microphone', () => {
    const seg = new Segmenter()
    // They speak; a moment later the same words come back off the speakers.
    seg.push('them', speak('we need SSO before rollout', 10), 0)
    seg.push('me', speak('we need SSO before rollout', 10.4), 0)
    const [segment] = seg.flush().filter((s) => s.channel === 'me')
    expect(segment!.echo).toBe(true)
  })

  it('does not flag you genuinely repeating them', () => {
    // The premise the whole rule rests on: a real repeat does not land three
    // consecutive words inside two seconds of the original.
    const seg = new Segmenter()
    seg.push('them', speak('we need SSO before rollout', 10), 0)
    seg.push('me', speak('SSO before rollout, got it', 30), 0)
    const [segment] = seg.flush().filter((s) => s.channel === 'me')
    expect(segment!.echo).toBe(false)
  })

  it('does not flag a short agreement that shares a word', () => {
    const seg = new Segmenter()
    seg.push('them', speak('the pricing needs another look', 5), 0)
    seg.push('me', speak('the same', 5.2), 0)
    const [segment] = seg.flush().filter((s) => s.channel === 'me')
    expect(segment!.echo).toBe(false)
  })

  it('never flags the system channel', () => {
    // A digital tap of what was played cannot contain you. Spike V4 measured
    // its floor between sounds at exactly zero.
    const seg = new Segmenter()
    seg.push('them', speak('one two three four five', 0), 0)
    seg.push('them', speak('one two three four five', 0.5), 0)
    expect(seg.flush().every((s) => s.channel !== 'them' || !s.echo)).toBe(true)
  })

  it('ignores punctuation and case when matching', () => {
    const seg = new Segmenter()
    seg.push('them', speak('ship it on Friday please', 2), 0)
    seg.push('me', speak('Ship it, on friday. Please', 2.3), 0)
    const [segment] = seg.flush().filter((s) => s.channel === 'me')
    expect(segment!.echo).toBe(true)
  })

  it('forgets system audio older than its memory window', () => {
    const seg = new Segmenter()
    seg.push('them', speak('quarterly revenue is up', 0), 0)
    // Three minutes later, past the 120s window. Saying the same thing now is
    // you, not a speaker.
    seg.push('them', speak('anything else', 180), 0)
    seg.push('me', speak('quarterly revenue is up', 181), 0)
    const mine = seg.flush().filter((s) => s.channel === 'me')
    expect(mine[0]!.echo).toBe(false)
  })

  it('flags nothing when only one channel ever spoke', () => {
    const seg = new Segmenter()
    seg.push('me', speak('talking to myself here', 0), 0)
    expect(seg.flush()[0]!.echo).toBe(false)
  })
})
