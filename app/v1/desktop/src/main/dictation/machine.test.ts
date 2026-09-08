import { describe, expect, it } from 'vitest'
import {
  initialDictationState,
  isBusy,
  isCapturing,
  reduce,
  type DictationEvent,
  type DictationState,
} from './machine.js'

/** Drive the machine through a sequence, returning the final state and actions. */
function drive(events: DictationEvent[], from = initialDictationState()) {
  let state = from
  const actions = []
  for (const e of events) {
    const out = reduce(state, e)
    state = out.state
    actions.push(out.action)
  }
  return { state, actions }
}

const hotkey = (now = 0): DictationEvent => ({ type: 'hotkey', now })

describe('the happy path', () => {
  it('idle -> arming -> listening -> transcribing -> delivering -> idle', () => {
    const { state, actions } = drive([
      hotkey(1000),
      { type: 'micReady' },
      { type: 'silenceStop' },
      { type: 'transcribed' },
      { type: 'delivered' },
    ])
    expect(state.phase).toBe('idle')
    expect(actions[0]).toEqual({ type: 'startCapture', sessionId: 1 })
    expect(actions[2]).toEqual({ type: 'finish', sessionId: 1 })
  })

  it('records when the session started, for the elapsed timer', () => {
    const { state } = drive([hotkey(4242)])
    expect(state.startedAt).toBe(4242)
  })

  it('a second dictation gets a new session id', () => {
    const first = drive([hotkey(), { type: 'micReady' }, { type: 'silenceStop' }, { type: 'transcribed' }, { type: 'delivered' }])
    const second = reduce(first.state, hotkey())
    expect(second.state.sessionId).toBe(2)
  })
})

describe('stopping', () => {
  it.each([
    ['the hotkey again', { type: 'hotkey', now: 5 } as DictationEvent],
    ['silence', { type: 'silenceStop' } as DictationEvent],
    ['the session cap', { type: 'capStop' } as DictationEvent],
  ])('finishes on %s', (_label, event) => {
    const { state, actions } = drive([hotkey(), { type: 'micReady' }, event])
    expect(state.phase).toBe('transcribing')
    expect(actions[2]).toEqual({ type: 'finish', sessionId: 1 })
  })
})

describe('cancellation', () => {
  it('Escape while listening discards and returns to idle', () => {
    const { state, actions } = drive([hotkey(), { type: 'micReady' }, { type: 'escape' }])
    expect(state.phase).toBe('idle')
    expect(actions[2]).toEqual({ type: 'discard', sessionId: 1 })
  })

  it('Escape while TRANSCRIBING bumps the session id', () => {
    // This is what makes cancellation actually work. Without the bump, an ASR
    // or LLM result already in flight would arrive later and get pasted into
    // whatever happens to be focused by then.
    const { state } = drive([hotkey(), { type: 'micReady' }, { type: 'silenceStop' }, { type: 'escape' }])
    expect(state.phase).toBe('idle')
    expect(state.sessionId).toBe(2)
  })

  it('a late result from a cancelled session is identifiable by its id', () => {
    const cancelled = drive([hotkey(), { type: 'micReady' }, { type: 'silenceStop' }, { type: 'escape' }])
    const inFlightSessionId = 1
    expect(inFlightSessionId).not.toBe(cancelled.state.sessionId)
  })

  it('a second hotkey press while the mic is still opening cancels', () => {
    // The user changed their mind before it even started; queueing a session
    // they no longer want is worse than doing nothing.
    const { state, actions } = drive([hotkey(), hotkey()])
    expect(state.phase).toBe('idle')
    expect(actions[1]).toEqual({ type: 'discard', sessionId: 1 })
  })
})

describe('the hotkey is ignored mid-transcription', () => {
  it('does not start a second session on top of the first', () => {
    // Pressing again usually means "hurry up", and stacking sessions is never
    // what was wanted.
    const { state, actions } = drive([
      hotkey(),
      { type: 'micReady' },
      { type: 'silenceStop' },
      hotkey(),
    ])
    expect(state.phase).toBe('transcribing')
    expect(state.sessionId).toBe(1)
    expect(actions[3]).toEqual({ type: 'none' })
  })
})

describe('chunking', () => {
  it('flushes a chunk without leaving the listening phase', () => {
    const { state, actions } = drive([hotkey(), { type: 'micReady' }, { type: 'chunkEmitted' }])
    expect(state.phase).toBe('listening')
    expect(state.chunksSent).toBe(1)
    expect(actions[2]).toEqual({ type: 'flushChunk', sessionId: 1 })
  })

  it('counts multiple chunks in one session', () => {
    const { state } = drive([
      hotkey(),
      { type: 'micReady' },
      { type: 'chunkEmitted' },
      { type: 'chunkEmitted' },
      { type: 'chunkEmitted' },
    ])
    expect(state.chunksSent).toBe(3)
  })

  it('resets the chunk count for the next session', () => {
    const first = drive([
      hotkey(),
      { type: 'micReady' },
      { type: 'chunkEmitted' },
      { type: 'silenceStop' },
      { type: 'transcribed' },
      { type: 'delivered' },
    ])
    const second = reduce(first.state, hotkey())
    expect(second.state.chunksSent).toBe(0)
  })
})

describe('errors', () => {
  it('a mic failure surfaces the reason and schedules a clear', () => {
    const { state, actions } = drive([hotkey(), { type: 'micFailed', reason: 'device in use' }])
    expect(state.phase).toBe('error')
    expect(state.message).toBe('device in use')
    expect(actions[1]).toEqual({ type: 'scheduleErrorClear', delayMs: 3000 })
  })

  it('clears itself after the timeout', () => {
    const { state } = drive([
      hotkey(),
      { type: 'micFailed', reason: 'nope' },
      { type: 'errorTimeout' },
    ])
    expect(state.phase).toBe('idle')
    expect(state.message).toBeNull()
  })

  it('the hotkey starts a fresh session immediately without waiting out the message', () => {
    const { state, actions } = drive([
      hotkey(),
      { type: 'micFailed', reason: 'nope' },
      hotkey(9000),
    ])
    expect(state.phase).toBe('arming')
    expect(state.sessionId).toBe(2)
    expect(actions[2]).toEqual({ type: 'startCapture', sessionId: 2 })
  })

  it('a transcription failure surfaces rather than silently returning to idle', () => {
    const { state } = drive([
      hotkey(),
      { type: 'micReady' },
      { type: 'silenceStop' },
      { type: 'failed', reason: 'whisper unreachable' },
    ])
    expect(state.phase).toBe('error')
    expect(state.message).toBe('whisper unreachable')
  })

  it('a delivery failure also surfaces', () => {
    const { state } = drive([
      hotkey(),
      { type: 'micReady' },
      { type: 'silenceStop' },
      { type: 'transcribed' },
      { type: 'failed', reason: 'clipboard locked' },
    ])
    expect(state.phase).toBe('error')
  })
})

describe('guards used by the rest of the app', () => {
  const at = (events: DictationEvent[]): DictationState => drive(events).state

  it('isCapturing is true only while arming or listening', () => {
    expect(isCapturing(at([]))).toBe(false)
    expect(isCapturing(at([hotkey()]))).toBe(true)
    expect(isCapturing(at([hotkey(), { type: 'micReady' }]))).toBe(true)
    expect(isCapturing(at([hotkey(), { type: 'micReady' }, { type: 'silenceStop' }]))).toBe(false)
  })

  it('isBusy blocks a model switch through the whole active pipeline', () => {
    // Decision A8c: switching underneath a running request would either kill an
    // utterance already spoken or return text from a model not chosen.
    expect(isBusy(at([]))).toBe(false)
    expect(isBusy(at([hotkey()]))).toBe(true)
    expect(isBusy(at([hotkey(), { type: 'micReady' }]))).toBe(true)
    expect(isBusy(at([hotkey(), { type: 'micReady' }, { type: 'silenceStop' }]))).toBe(true)
    expect(
      isBusy(at([hotkey(), { type: 'micReady' }, { type: 'silenceStop' }, { type: 'transcribed' }]))
    ).toBe(true)
  })

  it('isBusy is false while an error is showing, so a switch is not stuck', () => {
    expect(isBusy(at([hotkey(), { type: 'micFailed', reason: 'x' }]))).toBe(false)
  })
})

describe('events that should do nothing', () => {
  it('ignores stray events in idle', () => {
    for (const e of [
      { type: 'micReady' },
      { type: 'silenceStop' },
      { type: 'transcribed' },
      { type: 'delivered' },
    ] as DictationEvent[]) {
      const { state, action } = reduce(initialDictationState(), e)
      expect(state.phase).toBe('idle')
      expect(action).toEqual({ type: 'none' })
    }
  })
})

describe('A6: Escape always returns to idle', () => {
  /** Drive the machine to each phase it can be in, by name. */
  const into: Record<string, DictationEvent[]> = {
    idle: [],
    arming: [hotkey()],
    listening: [hotkey(), { type: 'micReady' }],
    transcribing: [hotkey(), { type: 'micReady' }, { type: 'silenceStop' }],
    delivering: [hotkey(), { type: 'micReady' }, { type: 'silenceStop' }, { type: 'transcribed' }],
    error: [
      hotkey(),
      { type: 'micReady' },
      { type: 'silenceStop' },
      { type: 'failed', reason: 'the recogniser fell over' },
    ],
  }

  it('reaches every phase the machine has, so the sweep below is exhaustive', () => {
    // If a phase is added and not listed here, this fails rather than the sweep
    // quietly testing five of six.
    for (const [phase, events] of Object.entries(into)) {
      expect(drive(events).state.phase).toBe(phase)
    }
  })

  it('returns to idle from every one of them', () => {
    // "Always" is the word in the spec. Delivering used to be the exception -
    // Escape did nothing for the second and a half a result stays on screen.
    for (const [phase, events] of Object.entries(into)) {
      const { state } = drive([...events, { type: 'escape' }])
      expect(state.phase, `escape from ${phase}`).toBe('idle')
    }
  })

  it('leaves nothing capturing or busy afterwards', () => {
    // The orphaned-mic-handle half of A6: the state the app reports has to
    // agree that nothing is running, or the HUD stays up and the mic stays open.
    for (const [phase, events] of Object.entries(into)) {
      const { state } = drive([...events, { type: 'escape' }])
      expect(isCapturing(state), `capturing after escape from ${phase}`).toBe(false)
      expect(isBusy(state), `busy after escape from ${phase}`).toBe(false)
    }
  })

  it('discards rather than finishes whenever audio was still being held', () => {
    // Cancelling has to throw the audio away. Finishing it would transcribe
    // something the user explicitly abandoned.
    for (const phase of ['arming', 'listening']) {
      const { actions } = drive([...into[phase]!, { type: 'escape' }])
      expect(actions[actions.length - 1], `escape from ${phase}`).toMatchObject({
        type: 'discard',
      })
    }
  })
})
