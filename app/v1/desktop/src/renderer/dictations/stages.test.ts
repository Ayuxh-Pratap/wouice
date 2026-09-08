import { describe, expect, it } from 'vitest'
import type { DictationRecord } from '../../shared/ipc.js'
import { describeDelivery, explainChunks, finalText, hasStages, stagesOf } from './stages.js'

const base: DictationRecord = {
  id: 1,
  at: 1_000,
  audioMs: 5_000,
  asrMs: 400,
  llmMs: 600,
  totalMs: 1_000,
  chunks: 0,
  asrModel: 'turbo',
  llmModel: 'qwen3-4b',
  language: 'english',
  rawChars: 20,
  finalChars: 22,
  corrections: 0,
  degraded: null,
  raw: 'hello world',
  corrected: 'hello world',
  sentSystem: 'You clean up raw speech-to-text output.',
  sentUser: 'hello world',
  received: 'Hello, world.',
  applied: [],
  capture: null,
  audioPath: null,
  inserted: true,
  delivery: 'paste',
  targetExe: 'code.exe',
  deliveryNote: '',
}

const rec = (patch: Partial<DictationRecord> = {}): DictationRecord => ({ ...base, ...patch })

describe('pipeline stages', () => {
  it('marks only the stages that altered the text', () => {
    const changed = stagesOf(rec()).filter((s) => s.changed).map((s) => s.name)
    // The dictionary left it alone and the text sent matched the corrected text,
    // so only the source and the model's answer count as changes.
    expect(changed).toEqual(['raw', 'received'])
  })

  it('notices the dictionary rewriting something', () => {
    const stages = stagesOf(rec({ corrected: 'Hello world' }))
    expect(stages.find((s) => s.name === 'corrected')?.changed).toBe(true)
  })

  it('reports a cleanup that returned the text untouched as unchanged', () => {
    // Not a failure, and worth being able to see at a glance: the model read it
    // and had nothing to add.
    const stages = stagesOf(rec({ received: 'hello world' }))
    expect(stages.find((s) => s.name === 'received')?.changed).toBe(false)
  })

  it('flags the system prompt as bulky, and nothing else', () => {
    expect(stagesOf(rec()).filter((s) => s.bulky).map((s) => s.name)).toEqual(['system'])
  })

  it('knows a row imported before stage capture has nothing to show', () => {
    expect(hasStages(rec({ raw: '', received: '' }))).toBe(false)
    expect(hasStages(rec({ raw: '', received: 'something' }))).toBe(true)
  })
})

describe('the text a person actually got', () => {
  it('prefers the cleaned text', () => {
    expect(finalText(rec())).toBe('Hello, world.')
  })

  it('falls back through the pipeline when a later stage is missing', () => {
    // A degraded dictation never reached the model, so the corrected text IS
    // what was delivered.
    expect(finalText(rec({ received: '' }))).toBe('hello world')
    expect(finalText(rec({ received: '', corrected: '' }))).toBe('hello world')
    expect(finalText(rec({ received: '', corrected: '', raw: '' }))).toBe('')
  })
})

describe('explaining the chunk count', () => {
  const capture: NonNullable<DictationRecord['capture']> = {
    stoppedBy: 'silence',
    speechMs: 9_000,
    silenceMs: 1_800,
    longestPauseMs: 700,
    windowMs: 1_800,
    chunkAfterMs: 20_000,
    chunkPauseMs: 600,
    peakRms: 0.1,
    meanSpeechRms: 0.02,
    thresholdRms: 0.003,
  }

  it('says nothing when there is no capture diagnostic to explain', () => {
    expect(explainChunks(rec())).toBeNull()
  })

  it('distinguishes "too short to chunk" from "chunking is broken"', () => {
    expect(explainChunks(rec({ capture }))).toContain('chunking starts at')
    const longEnough = { ...capture, speechMs: 30_000, longestPauseMs: 300 }
    expect(explainChunks(rec({ capture: longEnough }))).toContain('longest pause')
    const shouldHave = { ...capture, speechMs: 30_000, longestPauseMs: 900 }
    expect(explainChunks(rec({ capture: shouldHave }))).toContain('unexpectedly')
  })

  it('reports chunks that did happen', () => {
    expect(explainChunks(rec({ capture, chunks: 2 }))).toContain('2 chunk(s)')
  })
})

describe('where the text went', () => {
  it('names the window and the method', () => {
    expect(describeDelivery(rec())).toBe('Inserted into code.exe by pasting')
    expect(describeDelivery(rec({ delivery: 'type' }))).toContain('by typing')
  })

  it('gives the reason when insertion did not happen', () => {
    const copied = rec({ inserted: false, deliveryNote: 'that window runs as administrator' })
    expect(describeDelivery(copied)).toContain('that window runs as administrator')
  })

  it('does not claim a build without insertion refused for a reason', () => {
    expect(describeDelivery(rec({ inserted: false }))).toContain('predates insertion')
  })
})
