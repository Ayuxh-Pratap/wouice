import { describe, expect, it } from 'vitest'
import { AFTER_CALL_CANDIDATES, type SidecarId } from '../../shared/models.js'
import {
  AfterCall,
  describeNotesStep,
  landing,
  roomFor,
  secondsLeft,
  type AfterCallDeps,
  type AfterCallRecord,
  type Sidecars,
} from './after-call.js'
import type { GpuReading } from './gpu.js'

/**
 * The after-call swap, against a pretend card: sidecars that start and stop
 * at once, and a GPU whose memory is whatever is loaded on it. The thing worth
 * guarding is that dictation always comes back, and that no model is ever put
 * on the card without room for it.
 */

const FOOTPRINT: Record<string, number> = {
  turbo: 865,
  'qwen3-4b': 3124,
  'gemma4-e4b': 4180,
  'gemma4-e4b-notes': 4085,
  'qwen35-9b': 4800,
}

function card(opts: { baseMiB?: number; actual?: Record<string, number>; broken?: string[] } = {}) {
  const state: Record<SidecarId, { status: string; modelId: string; lastError: string | null; busy: boolean }> = {
    whisper: { status: 'ready', modelId: 'turbo', lastError: null, busy: false },
    llama: { status: 'ready', modelId: 'qwen3-4b', lastError: null, busy: false },
  }
  const calls: string[] = []
  const up = (id: SidecarId): void => {
    const broken = opts.broken?.includes(state[id].modelId)
    state[id].status = broken ? 'failed' : 'ready'
    state[id].lastError = broken ? 'CUDA out of memory' : null
  }
  const sidecars: Sidecars = {
    async stop(id) {
      calls.push(`stop ${id}`)
      state[id].status = 'stopped'
    },
    async start(id) {
      calls.push(`start ${id} ${state[id].modelId}`)
      up(id)
    },
    async switchModel(id, modelId) {
      calls.push(`switch ${id} ${modelId}`)
      state[id].modelId = modelId
      up(id)
    },
    async whenModel(id, modelId) {
      return state[id].modelId === modelId && state[id].status === 'ready'
    },
    async whenIdle(id) {
      while (state[id].busy) await new Promise((resolve) => setTimeout(resolve, 2))
      return true
    },
    snapshot: (id) => ({ status: state[id].status, modelId: state[id].modelId, lastError: state[id].lastError }),
  }
  // Memory is what is loaded: the desktop, plus every model that is serving.
  const gpu = async (): Promise<GpuReading> => {
    let used = opts.baseMiB ?? 700
    for (const s of Object.values(state)) {
      if (s.status === 'ready') used += opts.actual?.[s.modelId] ?? FOOTPRINT[s.modelId] ?? 0
    }
    return { usedMiB: used, totalMiB: 6144, tempC: 70, smMHz: 1500 }
  }
  return { state, calls, sidecars, gpu }
}

function afterCall(c: ReturnType<typeof card>, over: Partial<AfterCallDeps> = {}) {
  const records: AfterCallRecord[] = []
  const engine = new AfterCall({
    sidecars: c.sidecars,
    gpu: c.gpu,
    dictationModels: () => ({ whisper: 'turbo', llama: 'qwen3-4b' }),
    enabled: () => true,
    candidates: AFTER_CALL_CANDIDATES,
    onRecord: (_id, record) => records.push(record),
    timing: { pollMs: 1, releaseMs: 50, sampleMs: 60_000 },
    ...over,
  })
  return { engine, records }
}

const dictationBack = (c: ReturnType<typeof card>): void => {
  expect(c.state.whisper).toMatchObject({ status: 'ready', modelId: 'turbo' })
  expect(c.state.llama).toMatchObject({ status: 'ready', modelId: 'qwen3-4b' })
}

describe('larger models after a meeting', () => {
  it('stops dictation, loads a larger model for each step, and puts dictation back', async () => {
    const c = card()
    const { engine, records } = afterCall(c)
    const used: string[] = []
    await engine.run(1, { english: 10, notes: 10 }, async (session) => {
      used.push((await session.use('english')).id)
      used.push((await session.use('notes')).id)
    })

    expect(used).toEqual(['gemma4-e4b', 'qwen35-9b'])
    // Both dictation models off the card before anything larger goes on.
    expect(c.calls.indexOf('stop whisper')).toBeLessThan(c.calls.indexOf('switch llama gemma4-e4b'))
    dictationBack(c)
    expect(records[0]).toMatchObject({ models: { english: 'gemma4-e4b', notes: 'qwen35-9b' }, restored: true, fallbacks: [] })
    expect(engine.view().mode).toBe('ready')
  })

  it('refuses dictation only while it holds the card', async () => {
    const c = card()
    const { engine } = afterCall(c)
    expect(engine.pausesDictation()).toBe(false)
    let during = false
    let message = ''
    await engine.run(1, { english: 0, notes: 10 }, async (session) => {
      await session.use('notes')
      during = engine.pausesDictation()
      message = engine.pausedMessage()
    })
    expect(during).toBe(true)
    expect(message).toMatch(/^Dictation paused · writing the meeting notes, back in about/)
    expect(engine.pausesDictation()).toBe(false)
  })

  it('puts dictation back when the work fails', async () => {
    const c = card()
    const { engine, records } = afterCall(c)
    await expect(
      engine.run(1, { english: 10, notes: 0 }, async (session) => {
        await session.use('english')
        throw new Error('the model could not be reached')
      })
    ).rejects.toThrow('could not be reached')
    dictationBack(c)
    expect(records[0]!.restored).toBe(true)
  })

  it('stops at once when asked, and puts dictation back', async () => {
    const c = card()
    const { engine, records } = afterCall(c)
    const run = engine.run(1, { english: 10, notes: 10 }, async (session) => {
      await session.use('english')
      await new Promise((_resolve, reject) => session.signal.addEventListener('abort', () => reject(session.signal.reason)))
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    engine.abort('a recording started')
    await expect(run).rejects.toThrow('a recording started')
    dictationBack(c)
    expect(records[0]!.stopped).toBe('a recording started')
  })

  it('waits for a dictation in progress before touching anything', async () => {
    const c = card()
    c.state.whisper.busy = true
    c.state.llama.busy = true
    const { engine } = afterCall(c)
    const run = engine.run(1, { english: 0, notes: 5 }, async (session) => {
      await session.use('notes')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(c.calls).toEqual([])
    expect(engine.pausesDictation()).toBe(true)
    c.state.whisper.busy = false
    c.state.llama.busy = false
    await run
    expect(c.calls).toContain('switch llama qwen35-9b')
  })

  it('passes over a model there is no room for, even squeezed', async () => {
    // 2,500 MiB taken by other apps: Qwen3.5 needs 3,750 free even partly on
    // the processor, E4B 4,385; the dictation model's 3,424 fits.
    const c = card({ baseMiB: 2500 })
    const { engine, records } = afterCall(c)
    let model = ''
    await engine.run(1, { english: 0, notes: 5 }, async (session) => {
      model = (await session.use('notes')).id
    })
    expect(model).toBe('qwen3-4b')
    expect(records[0]!.fallbacks[0]).toMatch(/^Qwen3.5 9B: needs 3750 MiB free, 3644 were/)
    expect(records[0]!.fallbacks[1]).toMatch(/^Gemma 4 E4B: needs 4385 MiB free, 3644 were/)
    expect(c.calls).not.toContain('switch llama qwen35-9b')
    dictationBack(c)
  })

  it('runs Qwen3.5 partly on the processor when the card is only a little short', async () => {
    // Meeting 17: other apps held 1.4 GB. --fit puts what does not fit on the
    // processor; 20% slower, and the tasks E4B could not find.
    const c = card({ baseMiB: 1400, actual: { 'qwen35-9b': 3600 } })
    const { engine, records } = afterCall(c)
    let model = ''
    await engine.run(1, { english: 0, notes: 5 }, async (session) => {
      model = (await session.use('notes')).id
    })
    expect(model).toBe('qwen35-9b')
    expect(records[0]!.fallbacks).toEqual([])
    expect(records[0]!.squeezed).toEqual({ model: 'qwen35-9b', onCpuMiB: 1050 })
    dictationBack(c)
  })

  it('passes over a model that loaded partly off the GPU', async () => {
    const c = card({ actual: { 'qwen35-9b': 3000 } })
    const { engine, records } = afterCall(c)
    let model = ''
    await engine.run(1, { english: 0, notes: 5 }, async (session) => {
      model = (await session.use('notes')).id
    })
    // The English model, in its one-slot notes shape.
    expect(model).toBe('gemma4-e4b-notes')
    expect(records[0]!.fallbacks).toEqual(['Qwen3.5 9B: part of it loaded off the GPU'])
    dictationBack(c)
  })

  it('falls back to the dictation model when a larger one will not start', async () => {
    const c = card({ broken: ['gemma4-e4b'] })
    const { engine, records } = afterCall(c)
    let model = ''
    await engine.run(1, { english: 5, notes: 0 }, async (session) => {
      model = (await session.use('english')).id
    })
    expect(model).toBe('qwen3-4b')
    expect(records[0]!.fallbacks[0]).toMatch(/^Gemma 4 E4B: did not start \(CUDA out of memory\)/)
    dictationBack(c)
  })

  it('says dictation is unavailable when it could not be brought back', async () => {
    const c = card()
    const { engine, records } = afterCall(c)
    await engine.run(1, { english: 0, notes: 5 }, async (session) => {
      await session.use('notes')
      c.state.whisper.modelId = 'turbo'
      // From here, whisper will not start.
      c.sidecars.start = async (id) => {
        c.state[id].status = id === 'whisper' ? 'failed' : 'ready'
        c.state[id].lastError = id === 'whisper' ? 'model not found' : null
      }
    })
    expect(records[0]!.restored).toBe(false)
    expect(engine.view()).toMatchObject({ mode: 'problem', title: 'Dictation unavailable' })
  })

  it('starts at once when the careful pass has already cleared the card', async () => {
    const c = card()
    await c.sidecars.stop('whisper')
    await c.sidecars.stop('llama')
    const { engine, records } = afterCall(c)
    await engine.run(1, { english: 0, notes: 5 }, async (session) => {
      await session.use('notes')
    })
    // No wait for memory that was never going to come back, and so no complaint about it.
    expect(records[0]!.fallbacks).toEqual([])
    dictationBack(c)
  })

  it('brings dictation back when something left it off', async () => {
    const c = card()
    await c.sidecars.stop('whisper')
    await c.sidecars.stop('llama')
    const { engine } = afterCall(c)
    await engine.ensureDictation()
    dictationBack(c)
    // And leaves it alone when it is already running.
    c.calls.length = 0
    await engine.ensureDictation()
    expect(c.calls).toEqual([])
  })

  it('with the setting off, touches nothing', async () => {
    const c = card()
    const { engine } = afterCall(c, { enabled: () => false })
    let model = ''
    await engine.run(1, { english: 5, notes: 5 }, async (session) => {
      model = (await session.use('notes')).id
    })
    expect(model).toBe('qwen3-4b')
    expect(c.calls).toEqual([])
  })
})

describe('the time left and the percentage', () => {
  const start = { stage: 'pausing' as const, role: null, plan: { english: 800, notes: 800 }, slots: 4, fraction: 0, stageSec: 0 }

  it('counts every step still to come, from the words each will read', () => {
    // Restore 12 + unload 4 + English (load 8 + 800 x 0.035) + notes (load 8 + 20 + 800 x 0.08).
    expect(secondsLeft(start)).toBe(12 + 4 + (8 + 28) + (8 + 20 + 64))
    // An English meeting has no English step.
    expect(secondsLeft({ ...start, plan: { english: 0, notes: 800 } })).toBe(12 + 4 + (8 + 20 + 64))
  })

  it('judges a step in progress by its own rate once it has one', () => {
    // Half the English in 10 s: 10 s more, then the notes and the restore.
    expect(secondsLeft({ ...start, stage: 'working', role: 'english', fraction: 0.5, stageSec: 10 })).toBe(12 + 10 + (8 + 84))
    expect(secondsLeft({ ...start, stage: 'restoring', role: null, stageSec: 4 })).toBe(8)
  })

  it('shows the whole write-up as a percentage, and none once dictation is back', async () => {
    const c = card()
    const { engine } = afterCall(c)
    const seen: (number | null)[] = []
    await engine.run(1, { english: 100, notes: 100 }, async (session) => {
      await session.use('english')
      session.progress(50, 100, 'half')
      seen.push(engine.view().percent)
      await session.use('notes')
      seen.push(engine.view().percent)
      expect(engine.view()).toMatchObject({ mode: 'working', title: 'Dictation paused', step: 'Writing the summary and tasks' })
    })
    for (const p of seen) expect(p).toBeGreaterThanOrEqual(0)
    expect(seen[1]!).toBeGreaterThanOrEqual(seen[0]!)
    expect(engine.view().percent).toBeNull()
  })
})

describe('notes progress', () => {
  it('only ever moves forward through a whole run', () => {
    const steps = [
      { stage: 'condensing', chunk: 1, chunks: 3 },
      { stage: 'extracting', chunk: 1, chunks: 3 },
      { stage: 'condensing', chunk: 2, chunks: 3 },
      { stage: 'extracting', chunk: 2, chunks: 3 },
      { stage: 'condensing', chunk: 3, chunks: 3 },
      { stage: 'extracting', chunk: 3, chunks: 3 },
      { stage: 'writing', chunk: 0, chunks: 3 },
      { stage: 'checking', chunk: 0, chunks: 0 },
      { stage: 'checking', chunk: 1, chunks: 4 },
      { stage: 'checking', chunk: 4, chunks: 4 },
    ]
    const shares = steps.map((s) => describeNotesStep(s).share)
    for (let i = 1; i < shares.length; i++) expect(shares[i]!).toBeGreaterThanOrEqual(shares[i - 1]!)
    expect(shares.at(-1)).toBe(1)
    expect(describeNotesStep(steps[3]!).words).toBe('finding the work in part 2 of 3')
  })
})

describe('the memory checks', () => {
  const at = (usedMiB: number): GpuReading => ({ usedMiB, totalMiB: 6144, tempC: null, smMHz: null })

  it('needs the footprint and a margin free before loading', () => {
    // 5,100 MiB: Qwen3.5 fits with up to 1,044 MiB taken by everything else.
    expect(roomFor(4800, at(1000))).toBe(true)
    expect(roomFor(4800, at(1100))).toBe(false)
    // Unknown memory is not a veto; the check after loading still runs.
    expect(roomFor(4800, null)).toBe(true)
  })

  it('tells a model on the GPU from one that spilled, or left no room', () => {
    expect(landing(4800, at(600), at(5400))).toBe('ok')
    expect(landing(4800, at(600), at(3600))).toBe('spilled')
    expect(landing(4800, at(1250), at(6050))).toBe('tight')
  })

  it('accepts a model partly on the processor only within what it is allowed', () => {
    // Qwen3.5: 4,650 on the card, up to 1,200 of it allowed on the processor.
    expect(landing(4650, at(1400), at(5000), 1200)).toBe('squeezed')
    expect(landing(4650, at(600), at(3600), 1200)).toBe('spilled')
    expect(landing(4650, at(600), at(5250), 1200)).toBe('ok')
  })
})
