import { describe, expect, it } from 'vitest'
import {
  channelSkewMs,
  checkpointName,
  driftOf,
  emptyRecord,
  groupCheckpoints,
  parseCheckpointName,
  planMerge,
  MEETING_SAMPLE_RATE,
  type ChannelRecord,
} from './session.js'

/**
 * Stage 1's arithmetic, which decides whether an hour of recording is usable.
 *
 * The two things worth testing here cannot be seen in a short recording: where
 * the channels sit relative to each other, and whether their clocks stayed
 * together. Both are pure, so both are checkable in milliseconds instead of in
 * hour-long meetings.
 */

const record = (channel: 'me' | 'them', over: Partial<ChannelRecord> = {}): ChannelRecord => ({
  ...emptyRecord(channel),
  ...over,
})

describe('checkpoint names', () => {
  it('round-trips', () => {
    const name = checkpointName('them', 42)
    expect(name).toBe('them-00042.f32')
    expect(parseCheckpointName(name)).toEqual({ channel: 'them', index: 42 })
  })

  it('ignores anything that is not a checkpoint', () => {
    for (const junk of ['audio.wav', 'manifest.json', 'me.f32', 'you-00001.f32', '', '.f32']) {
      expect(parseCheckpointName(junk)).toBeNull()
    }
  })

  it('orders numerically, not lexically', () => {
    // The padding makes these agree until a meeting outlasts it. Sorting on the
    // number means the audio cannot silently reorder at that point.
    const names = ['me-00002.f32', 'me-00010.f32', 'me-00001.f32', 'them-00003.f32']
    const grouped = groupCheckpoints(names)
    expect(grouped.me).toEqual(['me-00001.f32', 'me-00002.f32', 'me-00010.f32'])
    expect(grouped.them).toEqual(['them-00003.f32'])
  })

  it('keeps a stray file out of the merge', () => {
    const grouped = groupCheckpoints(['me-00000.f32', 'audio.wav', 'notes.txt'])
    expect(grouped.me).toEqual(['me-00000.f32'])
    expect(grouped.them).toEqual([])
  })
})

describe('planMerge', () => {
  it('pads the later channel by the difference between the two starts', () => {
    // The microphone is up 500 ms before the loopback stream, every time: the
    // display-media request has to be answered first.
    const plan = planMerge(
      [
        record('me', { firstFrameEpochMs: 1_000_000, samples: 16_000 }),
        record('them', { firstFrameEpochMs: 1_000_500, samples: 16_000 }),
      ],
      { me: 16_000, them: 16_000 }
    )
    expect(plan.offsets.me).toBe(0)
    expect(plan.offsets.them).toBe(8_000) // 500 ms at 16 kHz
    expect(plan.startEpochMs).toBe(1_000_000)
  })

  it('sizes the file to whichever channel ends last', () => {
    const plan = planMerge(
      [
        record('me', { firstFrameEpochMs: 1_000_000, samples: 16_000 }),
        record('them', { firstFrameEpochMs: 1_000_500, samples: 32_000 }),
      ],
      { me: 16_000, them: 32_000 }
    )
    // them starts 8000 late and runs 32000 → ends at 40000, past me's 16000.
    expect(plan.frames).toBe(40_000)
  })

  it('anchors on the earlier channel whichever one it is', () => {
    const plan = planMerge(
      [
        record('me', { firstFrameEpochMs: 2_000_400, samples: 8_000 }),
        record('them', { firstFrameEpochMs: 2_000_000, samples: 8_000 }),
      ],
      { me: 8_000, them: 8_000 }
    )
    expect(plan.offsets.them).toBe(0)
    expect(plan.offsets.me).toBe(6_400)
    expect(plan.startEpochMs).toBe(2_000_000)
  })

  it('produces a lopsided file rather than refusing a one-sided meeting', () => {
    // A call on headphones with the mic muted is a real session, not an error.
    const plan = planMerge(
      [
        record('me', { firstFrameEpochMs: null, samples: 0 }),
        record('them', { firstFrameEpochMs: 5_000_000, samples: 48_000 }),
      ],
      { me: 0, them: 48_000 }
    )
    expect(plan.offsets.them).toBe(0)
    expect(plan.frames).toBe(48_000)
    expect(plan.startEpochMs).toBe(5_000_000)
  })

  it('gives an empty session an empty plan instead of throwing', () => {
    const plan = planMerge([record('me'), record('them')], { me: 0, them: 0 })
    expect(plan.frames).toBe(0)
    expect(plan.startEpochMs).toBe(0)
  })
})

describe('driftOf', () => {
  it('reads zero for a channel that kept perfect time', () => {
    const drift = driftOf(
      record('me', {
        firstFrameEpochMs: 0,
        lastFrameEpochMs: 3_600_000,
        samples: MEETING_SAMPLE_RATE * 3600,
      })
    )
    expect(drift?.effectiveRate).toBeCloseTo(MEETING_SAMPLE_RATE, 3)
    expect(drift?.ppm).toBeCloseTo(0, 3)
    expect(drift?.driftMs).toBeCloseTo(0, 3)
  })

  it('catches a slow clock over an hour', () => {
    // 100 ppm is a perfectly ordinary crystal, and it is 360 ms across an hour.
    const samples = Math.round(MEETING_SAMPLE_RATE * 3600 * 0.9999)
    const drift = driftOf(
      record('them', { firstFrameEpochMs: 0, lastFrameEpochMs: 3_600_000, samples })
    )
    expect(drift!.ppm).toBeLessThan(0)
    expect(drift!.driftMs).toBeCloseTo(-360, 0)
  })

  it('refuses to guess from too short a span', () => {
    // Under a second, the one-frame correction is the size of the measurement.
    expect(
      driftOf(record('me', { firstFrameEpochMs: 0, lastFrameEpochMs: 400, samples: 6_400 }))
    ).toBeNull()
  })

  it('says nothing about a channel that never delivered', () => {
    expect(driftOf(record('me'))).toBeNull()
    expect(driftOf(record('me', { firstFrameEpochMs: 0, lastFrameEpochMs: 5_000 }))).toBeNull()
  })
})

describe('channelSkewMs', () => {
  it('is zero when both channels drift the same way', () => {
    // What matters is the two agreeing with EACH OTHER. A shared error against
    // the wall clock leaves the transcript perfectly aligned.
    const samples = Math.round(MEETING_SAMPLE_RATE * 3600 * 1.0001)
    const skew = channelSkewMs([
      record('me', { firstFrameEpochMs: 0, lastFrameEpochMs: 3_600_000, samples }),
      record('them', { firstFrameEpochMs: 0, lastFrameEpochMs: 3_600_000, samples }),
    ])
    expect(skew).toBeCloseTo(0, 6)
  })

  it('reports the gap when they disagree', () => {
    const skew = channelSkewMs([
      record('me', {
        firstFrameEpochMs: 0,
        lastFrameEpochMs: 3_600_000,
        samples: Math.round(MEETING_SAMPLE_RATE * 3600 * 1.0001),
      }),
      record('them', {
        firstFrameEpochMs: 0,
        lastFrameEpochMs: 3_600_000,
        samples: MEETING_SAMPLE_RATE * 3600,
      }),
    ])
    // 100 ppm apart across an hour is 360 ms, which is well past B2's budget.
    expect(skew).toBeCloseTo(360, 0)
  })

  it('is null when either channel has too little to say', () => {
    expect(
      channelSkewMs([
        record('me', { firstFrameEpochMs: 0, lastFrameEpochMs: 3_600_000, samples: 57_600_000 }),
        record('them'),
      ])
    ).toBeNull()
  })
})
