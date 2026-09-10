import type { MeetingRecord } from '@wouice/store'

/**
 * Whether what is on a meeting's page came from the careful pass.
 *
 * WHY IT IS WORKED OUT, NOT STORED AS A FLAG. "Improved" is three separate
 * facts: the transcript was re-done, the English was rebuilt from it, and the
 * summary and tasks were rebuilt from it. The last two can fail on their own -
 * the model was busy, a chunk timed out - and a single flag would call a
 * summary of the old transcript improved. Each is read from the run that
 * produced it.
 *
 * THE LINE IS WHEN THE PASS BEGAN, NOT WHEN IT WAS RECORDED. The careful pass
 * writes its record after it has rebuilt the English and the summary, so its
 * timestamp is later than both. Nothing else can run on a meeting while its
 * pass does, so anything built after the pass began was built from its
 * transcript.
 */

export type Provenance = 'improved' | 'stale' | 'none'

export interface Enhancement {
  model: string
  at: number
  /** The English rendering: rebuilt from the improved transcript, older, or never made. */
  english: Provenance
  /** The summary and tasks, likewise. */
  summary: Provenance
}

export function enhancementOf(meeting: Pick<MeetingRecord, 'diagnostics'>): Enhancement | null {
  const repass = meeting.diagnostics.repass
  // A pass that produced nothing left the first transcript in place.
  if (!repass || repass.segments <= 0) return null

  const began = repass.at - repass.ms
  const english = meeting.diagnostics.english
  const notes = (meeting.diagnostics.notes ?? []).filter((run) => run.ok).at(-1)
  const since = (at: number | undefined): Provenance =>
    at === undefined ? 'none' : at >= began ? 'improved' : 'stale'

  return {
    model: repass.model,
    at: repass.at,
    english: since(english?.at),
    summary: since(notes?.at),
  }
}
