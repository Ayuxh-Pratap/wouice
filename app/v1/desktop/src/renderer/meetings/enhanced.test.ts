import type { MeetingDiagnostics } from '@wouice/store'
import { describe, expect, it } from 'vitest'
import { enhancementOf } from './enhanced.js'

/**
 * What the page is allowed to call improved.
 *
 * The order below is the real one: the careful pass replaces the transcript,
 * rebuilds the English and the summary, and only then writes its own record.
 */

const began = 1_000_000
const finished = began + 600_000
const repass = { at: finished, model: 'large-v3', segments: 68, ms: 600_000 }
const notesRun = (at: number, ok = true) => ({ at, ok, chunks: 1, gaps: 0, tasks: 2, ms: 1 })
const englishRun = (at: number) => ({ at, rendered: 60, missed: 0, failedBatches: 0, ms: 1 })
const of = (diagnostics: MeetingDiagnostics) => enhancementOf({ diagnostics })

describe('an improved meeting', () => {
  it('is not improved until the careful pass has run', () => {
    expect(of({ notes: [notesRun(began)] })).toBeNull()
  })

  it('is not improved when the pass produced nothing', () => {
    expect(of({ repass: { ...repass, segments: 0 } })).toBeNull()
  })

  it('counts the English and summary rebuilt by the pass, though they predate its record', () => {
    const e = of({
      repass,
      english: englishRun(began + 400_000),
      notes: [notesRun(began - 5_000), notesRun(began + 550_000)],
    })
    expect(e).toMatchObject({ model: 'large-v3', english: 'improved', summary: 'improved' })
  })

  it('calls a summary of the first transcript stale when the rebuild failed', () => {
    const e = of({
      repass,
      notes: [notesRun(began - 5_000), notesRun(began + 550_000, false)],
    })
    expect(e?.summary).toBe('stale')
  })

  it('says none for what was never made', () => {
    expect(of({ repass })).toMatchObject({ english: 'none', summary: 'none' })
  })

  it('counts a summary redone later as improved', () => {
    expect(of({ repass, notes: [notesRun(finished + 86_400_000)] })?.summary).toBe('improved')
  })
})
