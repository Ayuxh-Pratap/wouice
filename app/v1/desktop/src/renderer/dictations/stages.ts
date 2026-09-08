import type { DictationRecord } from '../../shared/ipc.js'

/**
 * What the pipeline did to one dictation, as a list rather than as JSX.
 *
 * SEPARATED FROM THE COMPONENT because deciding which stages are worth showing
 * is a judgement with rules, and rules deserve tests. The old panel rendered
 * all five stages identically whether they had changed anything or not, so a
 * dictation the dictionary never touched still cost the same five paragraphs of
 * near-identical grey text as one it rewrote twice.
 */

export type StageName = 'raw' | 'corrected' | 'system' | 'user' | 'received'

export interface Stage {
  name: StageName
  /** Numbered, because the order is the point: this is a sequence, not a set. */
  label: string
  hint: string
  text: string
  /** Did this stage alter the text it was handed? */
  changed: boolean
  /**
   * Long and identical on every dictation, so it starts collapsed. The system
   * prompt is worth being able to see and never worth reading twice.
   */
  bulky?: boolean
}

const HINT: Record<StageName, string> = {
  raw: 'Straight out of Whisper, chunks joined',
  corrected: 'After the deterministic dictionary pass',
  system: 'The instruction the model was given',
  user: 'The text sent alongside it',
  received: 'Exactly what came back, before the plausibility check',
}

export function stagesOf(d: DictationRecord): Stage[] {
  const stage = (name: StageName, label: string, text: string, changed: boolean): Stage => ({
    name,
    label,
    hint: HINT[name],
    text,
    changed,
  })

  return [
    // The first stage has nothing before it to differ from, so it is always
    // "changed" in the sense that matters: it is where the text came from.
    stage('raw', '1 · Heard', d.raw, true),
    stage('corrected', '2 · Dictionary', d.corrected, d.corrected !== d.raw),
    { ...stage('system', '3a · Instruction', d.sentSystem, false), bulky: true },
    stage('user', '3b · Text sent', d.sentUser, d.sentUser !== d.corrected),
    stage('received', '4 · Got back', d.received, d.received !== d.sentUser),
  ]
}

/** Whether there is any stage text at all. Rows imported from the old JSONL have none. */
export function hasStages(d: DictationRecord): boolean {
  return Boolean(d.raw || d.received)
}

/** The text a person actually got. What the row is about, before any diagnosis. */
export function finalText(d: DictationRecord): string {
  return d.received || d.corrected || d.raw || ''
}

export function seconds(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

/**
 * Explain the chunk count in words.
 *
 * "chunks 0" on a 38-second dictation is ambiguous on its own: it could mean
 * the speaker never left a long enough pause, or that chunking is broken again.
 * Those need opposite responses, so say which it was.
 */
export function explainChunks(d: DictationRecord): string | null {
  const c = d.capture
  if (!c) return null
  if (d.chunks > 0) return `${d.chunks} chunk(s) transcribed while you were still talking`
  if (c.speechMs < c.chunkAfterMs) {
    return `No chunks: ${seconds(c.speechMs)} of speech, and chunking starts at ${seconds(c.chunkAfterMs)}`
  }
  if (c.longestPauseMs < c.chunkPauseMs) {
    return `No chunks: enough speech (${seconds(c.speechMs)}) but your longest pause was ${seconds(
      c.longestPauseMs
    )}, under the ${seconds(c.chunkPauseMs)} needed to cut without splitting a word`
  }
  return `No chunks, unexpectedly: speech ${seconds(c.speechMs)} and longest pause ${seconds(
    c.longestPauseMs
  )} both clear the thresholds`
}

/**
 * Where the text ended up, in one sentence.
 *
 * Said in the panel rather than shown as a status colour, because "copied" and
 * "inserted" look the same from the outside and the difference is the whole
 * reason someone is looking at this row.
 */
export function describeDelivery(d: DictationRecord): string {
  if (d.inserted) {
    const how = d.delivery === 'type' ? 'typing' : 'pasting'
    const where = d.targetExe || 'the focused window'
    return `Inserted into ${where} by ${how}${d.deliveryNote ? ` — ${d.deliveryNote}` : ''}`
  }
  if (d.deliveryNote) return `Copied to the clipboard only — ${d.deliveryNote}`
  return 'Copied to the clipboard only (this build predates insertion)'
}
