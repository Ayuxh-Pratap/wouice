import { describe, expect, it } from 'vitest'
import { BARS, FRAMES_PER_BAR, emptyWaveform, heights, isSilent, pushLevel, tail } from './waveform.js'
import { holdMs, lookOf, outcomeParts, presentation, splitMessage } from './phase.js'

const feed = (levels: number[]): ReturnType<typeof emptyWaveform> =>
  levels.reduce((w, l) => pushLevel(w, l), emptyWaveform())

describe('the rolling waveform', () => {
  it('is always the same length, so the drawing never reflows', () => {
    expect(emptyWaveform().bars).toHaveLength(BARS)
    expect(feed(Array(500).fill(0.4)).bars).toHaveLength(BARS)
  })

  it('only commits a bar once it has a full window of frames', () => {
    const w = feed([0.9, 0.9])
    expect(w.bars[BARS - 1]).toBe(0)
    expect(pushLevel(w, 0.9).bars[BARS - 1]).toBeCloseTo(0.9)
  })

  it('keeps the peak within a bar, not the average', () => {
    // A consonant is one loud frame among quiet ones. Averaging would erase the
    // exact thing being looked for.
    const w = feed([0.02, 0.8, 0.02])
    expect(w.bars[BARS - 1]).toBeCloseTo(0.8)
  })

  it('puts the newest bar last and pushes the oldest off', () => {
    const w = feed([
      ...Array(FRAMES_PER_BAR).fill(0.2),
      ...Array(FRAMES_PER_BAR).fill(0.9),
    ])
    expect(w.bars[BARS - 1]).toBeCloseTo(0.9)
    expect(w.bars[BARS - 2]).toBeCloseTo(0.2)
    expect(w.bars[0]).toBe(0)
  })

  it('returns the same array while a bar is still filling', () => {
    // React re-renders at the bar rate rather than the 50Hz frame rate. This
    // overlay is drawn over whatever someone is working in.
    const w = emptyWaveform()
    expect(pushLevel(w, 0.5).bars).toBe(w.bars)
  })

  it('survives a level that is out of range or not a number', () => {
    expect(feed(Array(FRAMES_PER_BAR).fill(4)).bars[BARS - 1]).toBe(1)
    expect(feed(Array(FRAMES_PER_BAR).fill(-1)).bars[BARS - 1]).toBe(0)
    expect(feed(Array(FRAMES_PER_BAR).fill(Number.NaN)).bars[BARS - 1]).toBe(0)
  })

  it('can tell a silent stretch from a loud one', () => {
    expect(isSilent(feed(Array(200).fill(0)))).toBe(true)
    expect(isSilent(feed(Array(200).fill(0.3)))).toBe(false)
  })

  it('draws silence as a floor rather than as nothing', () => {
    // An empty region reads as "not recording"; a flat line reads as
    // "recording, heard nothing". Opposite diagnoses.
    const h = heights(feed(Array(200).fill(0)), 30)
    expect(h.every((v) => v === 2)).toBe(true)
    expect(Math.max(...heights(feed(Array(200).fill(1)), 30))).toBe(30)
  })
})

describe('what the pet is doing', () => {
  it('keeps the capsule shut only when idle', () => {
    expect(lookOf('idle').open).toBe(false)
    for (const p of ['arming', 'listening', 'thinking', 'inserted', 'copied', 'error'] as const) {
      expect(lookOf(p).open).toBe(true)
    }
  })

  it('feeds the waveform only while the microphone is open', () => {
    expect(lookOf('listening').live).toBe(true)
    expect(lookOf('thinking').live).toBe(false)
  })

  it('holds the shape through thinking, because that is the audio being worked on', () => {
    expect(lookOf('thinking').frozen).toBe(true)
    expect(lookOf('thinking').working).toBe(true)
    expect(lookOf('inserted').frozen).toBe(false)
  })

  it('gives an error longer on screen than a success', () => {
    // "Inserted" confirms something already visible. An error is the only place
    // the reason ever appears.
    expect(holdMs('error')).toBeGreaterThan(holdMs('inserted'))
  })
})

describe('the status line', () => {
  it('splits the headline from the reason', () => {
    const { title, detail } = splitMessage('Copied · 2182 chars', 'Copied')
    expect(title).toBe('Copied')
    expect(detail).toBe('2182 chars')
  })

  it('keeps a long reason whole instead of truncating it', () => {
    const reason = 'that window runs as administrator, and Windows blocks input from apps that do not'
    const { detail } = splitMessage(`Copied · ${reason}`, 'Copied')
    expect(detail).toBe(reason)
  })

  it('falls back to the phase label when main sent no message', () => {
    expect(splitMessage(undefined, 'Listening')).toEqual({ title: 'Listening', detail: null })
  })

  it('leaves a message with no separator alone', () => {
    expect(splitMessage('Starting', 'x')).toEqual({ title: 'Starting', detail: null })
  })
})

describe('the compact bubble', () => {
  it('shows a shorter slice than the buffer keeps', () => {
    // How much history is worth keeping and how much fits beside an 88px
    // character are different questions with different answers.
    const w = feed(Array(400).fill(0.5))
    expect(tail(w, 20).bars).toHaveLength(20)
    expect(w.bars).toHaveLength(BARS)
  })

  it('takes the newest bars, not the oldest', () => {
    const w = feed([...Array(120).fill(0.1), ...Array(30).fill(0.9)])
    expect(tail(w, 4).bars.every((b) => b > 0.5)).toBe(true)
  })

  it('copes with being asked for more than it has', () => {
    expect(tail(emptyWaveform(), 500).bars).toHaveLength(BARS)
  })

  it('keeps the character count, as a figure rather than a sentence', () => {
    // An earlier version threw this away to keep the bubble short, and lost the
    // one number worth reporting: how much text just landed.
    expect(outcomeParts('2182 chars')).toEqual({ size: '2182 chars', reason: null })
    expect(outcomeParts('1,204 chars')).toEqual({ size: '1,204 chars', reason: null })
  })

  it('keeps the reason a paste was refused, as a sentence rather than a figure', () => {
    const why = 'that window runs as administrator, and Windows blocks input from apps that do not'
    expect(outcomeParts(why)).toEqual({ size: null, reason: why })
    expect(outcomeParts('clipboard replaced')).toEqual({ size: null, reason: 'clipboard replaced' })
  })

  it('never returns both, because a message only ever carries one', () => {
    for (const d of ['10 chars', 'focus moved to chrome.exe', null]) {
      const { size, reason } = outcomeParts(d)
      expect(size === null || reason === null).toBe(true)
    }
  })

  it('has nothing to say when there was no detail', () => {
    expect(outcomeParts(null)).toEqual({ size: null, reason: null })
  })
})

describe('what gets drawn, with and without a pet', () => {
  const PHASES = ['arming', 'listening', 'thinking', 'inserted', 'copied', 'error'] as const

  it('draws SOMETHING for every busy phase when the pet is off', () => {
    // The bug this exists to prevent: "thought" assumes a character to hang the
    // thought off, and honouring that with no pet left listening and thinking
    // rendering nothing at all - an overlay that looked broken for the whole
    // length of a dictation.
    for (const p of PHASES) {
      expect(presentation(lookOf(p), false)).not.toBe('none')
    }
  })

  it('gives the standalone pill everything, because nothing else is on screen', () => {
    for (const p of PHASES) {
      expect(presentation(lookOf(p), false)).toBe('pill')
    }
  })

  it('uses one shape the whole way through, whichever mode it is in', () => {
    for (const p of PHASES) {
      expect(presentation(lookOf(p), true)).toBe('thought')
      expect(presentation(lookOf(p), false)).toBe('pill')
    }
  })

  it('puts the outcome in her bubble too, not in a second shape beside her', () => {
    // A dictation used to finish by swapping the thought for a pill in a
    // different place on screen. One readout, in one position, all the way
    // through.
    for (const p of ['inserted', 'copied', 'error'] as const) {
      expect(presentation(lookOf(p), true)).toBe('thought')
    }
  })

  it('carries the waveform from waking through to thinking', () => {
    // Three states, one object: flat and breathing, then moving, then frozen
    // with a light travelling through it.
    for (const p of ['arming', 'listening', 'thinking'] as const) {
      expect(lookOf(p).content).toBe('wave')
    }
    for (const p of ['inserted', 'copied', 'error'] as const) {
      expect(lookOf(p).content).toBe('word')
    }
  })

  it('says Done rather than reciting the character count', () => {
    expect(lookOf('inserted').label).toBe('Done')
  })

  it('draws nothing at all when idle, either way', () => {
    expect(presentation(lookOf('idle'), true)).toBe('none')
    expect(presentation(lookOf('idle'), false)).toBe('none')
  })
})
