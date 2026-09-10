import { describe, expect, it } from 'vitest'
import {
  BACKOFF_CAP_MS,
  FAILURE_THRESHOLD,
  answeredReady,
  backoffFor,
  canServe,
  initialState,
  markBusy,
  markIdle,
  onHealthy,
  onStarting,
  onStopped,
  onUnexpectedExit,
  requestSwitch,
} from './policy.js'

describe('backoff', () => {
  it('does not wait before the first start', () => {
    expect(backoffFor(0)).toBe(0)
  })

  it('grows exponentially', () => {
    expect([1, 2, 3, 4, 5].map(backoffFor)).toEqual([1000, 2000, 4000, 8000, 16000])
  })

  it('caps, so a permanently broken sidecar cannot become a restart storm', () => {
    // A corrupt model or a taken port would otherwise pin a core and flood the
    // log until nobody can read it.
    expect(backoffFor(6)).toBe(BACKOFF_CAP_MS)
    expect(backoffFor(99)).toBe(BACKOFF_CAP_MS)
  })
})

describe('switch queueing (the never-switch-mid-utterance rule)', () => {
  it('switches immediately when idle', () => {
    const { state, action } = requestSwitch(initialState('large-v3'), 'turbo')
    expect(action).toEqual({ type: 'restart', modelId: 'turbo' })
    expect(state.modelId).toBe('turbo')
    expect(state.status).toBe('restarting')
  })

  it('QUEUES a switch requested while busy, and does not touch the process', () => {
    // Switching underneath a running request would either kill an utterance the
    // user already spoke, or return text from a model they did not choose.
    const busy = markBusy(onHealthy(initialState('large-v3')))
    const { state, action } = requestSwitch(busy, 'turbo')
    expect(action).toEqual({ type: 'none' })
    expect(state.modelId).toBe('large-v3')
    expect(state.pendingModelId).toBe('turbo')
  })

  it('applies the queued switch the moment the pipeline goes idle', () => {
    const busy = markBusy(onHealthy(initialState('large-v3')))
    const queued = requestSwitch(busy, 'turbo').state
    const { state, action } = markIdle(queued)
    expect(action).toEqual({ type: 'restart', modelId: 'turbo' })
    expect(state.modelId).toBe('turbo')
    expect(state.pendingModelId).toBeNull()
  })

  it('going idle with nothing queued does nothing', () => {
    const busy = markBusy(onHealthy(initialState('large-v3')))
    const { state, action } = markIdle(busy)
    expect(action).toEqual({ type: 'none' })
    expect(state.busy).toBe(false)
  })

  it('keeps only the last request when the user flips twice while busy', () => {
    const busy = markBusy(onHealthy(initialState('large-v3')))
    const once = requestSwitch(busy, 'turbo').state
    const twice = requestSwitch(once, 'large-v3').state
    expect(twice.pendingModelId).toBe('large-v3')
    // And settling back on the current model still resolves cleanly.
    expect(markIdle(twice).state.modelId).toBe('large-v3')
  })

  it('selecting the model already running is a no-op', () => {
    const { action } = requestSwitch(initialState('large-v3'), 'large-v3')
    expect(action).toEqual({ type: 'none' })
  })
})

describe('crash handling', () => {
  it('schedules a respawn with growing delay', () => {
    let s = onHealthy(initialState('large-v3'))
    const first = onUnexpectedExit(s, 'exit 1')
    expect(first.action).toEqual({ type: 'scheduleRespawn', delayMs: 1000 })
    expect(first.state.status).toBe('restarting')

    const second = onUnexpectedExit(first.state, 'exit 1')
    expect(second.action).toEqual({ type: 'scheduleRespawn', delayMs: 2000 })
  })

  it('gives up on the optimistic story after enough failures', () => {
    let s = initialState('large-v3')
    for (let i = 0; i < FAILURE_THRESHOLD; i++) s = onUnexpectedExit(s, 'boom').state
    expect(s.status).toBe('failed')
    expect(s.lastError).toBe('boom')
  })

  it('keeps the failure detail so it can be surfaced verbatim', () => {
    // A generic "sidecar failed" is useless; the real stderr is what diagnoses it.
    const { state } = onUnexpectedExit(initialState('x'), 'CUDA error: out of memory')
    expect(state.lastError).toBe('CUDA error: out of memory')
  })

  it('clears busy on crash so a queued switch is not stuck forever', () => {
    const busy = markBusy(onHealthy(initialState('large-v3')))
    expect(onUnexpectedExit(busy, 'died').state.busy).toBe(false)
  })

  it('a successful health check resets the failure count', () => {
    let s = onUnexpectedExit(initialState('x'), 'boom').state
    s = onUnexpectedExit(s, 'boom').state
    expect(s.failures).toBe(2)
    expect(onHealthy(s).failures).toBe(0)
    expect(onHealthy(s).lastError).toBeNull()
  })
})

describe('what counts as ready', () => {
  it('takes any answer from a server with no health endpoint', () => {
    // whisper-server answers its root path with whatever it likes once up.
    expect(answeredReady('any', 404)).toBe(true)
    expect(answeredReady('any', 200)).toBe(true)
  })

  it('does not take "still loading" for ready', () => {
    // Measured: llama-server answered 503 "Loading model" from 0.3s to 4.2s
    // after starting, and only then 200.
    expect(answeredReady('ok', 503)).toBe(false)
    expect(answeredReady('ok', 500)).toBe(false)
    expect(answeredReady('ok', 200)).toBe(true)
  })
})

describe('canServe', () => {
  it('is true only when ready', () => {
    expect(canServe(onHealthy(initialState('x')))).toBe(true)
  })

  it('is FALSE while starting, because a model load takes seconds', () => {
    // An HTTP call during load fails in a confusing way; callers must wait.
    expect(canServe(onStarting(initialState('x')))).toBe(false)
  })

  it('is false when stopped or failed', () => {
    expect(canServe(onStopped(initialState('x')))).toBe(false)
    let s = initialState('x')
    for (let i = 0; i < FAILURE_THRESHOLD; i++) s = onUnexpectedExit(s, 'boom').state
    expect(canServe(s)).toBe(false)
  })
})
