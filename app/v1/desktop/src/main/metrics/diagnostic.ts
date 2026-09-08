import type { DictationRecord } from '@wouice/store'
import type { Settings } from '../../shared/settings.js'

/**
 * Format one dictation as a self-contained diagnostic block.
 *
 * The point is that it can be pasted into a conversation and read on its own,
 * with no access to the machine that produced it. So it carries the models, the
 * timings, WHY the recording ended, and every stage of the text, because
 * "output was wrong" is unanswerable without knowing which stage went wrong.
 *
 * It contains your transcript verbatim. That is the entire value of it, and it
 * is also the reason it is produced only when you press the button, never
 * automatically.
 */

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
}

function explainChunks(d: DictationRecord): string {
  const c = d.capture
  if (!c) return ''
  if (d.chunks > 0) return `${d.chunks} chunk(s) flushed mid-speech`

  const speechShort = c.speechMs < c.chunkAfterMs
  if (speechShort) {
    return `0 chunks: only ${ms(c.speechMs)} of speech, threshold is ${ms(c.chunkAfterMs)}`
  }
  if (c.longestPauseMs < c.chunkPauseMs) {
    // The ambiguous case this diagnostic exists for.
    return `0 chunks: enough speech (${ms(c.speechMs)}) but the longest pause was ${ms(
      c.longestPauseMs
    )}, under the ${ms(c.chunkPauseMs)} needed to cut safely`
  }
  return `0 chunks: unexpected, speech ${ms(c.speechMs)} and longest pause ${ms(c.longestPauseMs)} both clear the thresholds`
}

/**
 * One line saying where the speech levels came from.
 *
 * Shipped defaults and a calibration that went wrong produce the same symptom -
 * a gate in the wrong place - and are indistinguishable in an export without
 * this. The device is named because a calibration is only valid for the
 * microphone it was measured on.
 */
export function describeCalibration(s: Settings): string {
  const gate = (s.silence.minNoiseFloor * s.silence.speechFactor).toFixed(5)
  const c = s.calibration
  if (!c) return `gate ${gate} (shipped defaults, never calibrated)`
  const when = new Date(c.at).toLocaleDateString()
  const langs = c.languages.map((l) => `${l.label}->${l.detected}`).join(' ')
  return `gate ${gate} (calibrated ${when} on "${c.device}", ${Math.round(
    c.separation
  )}x separation, ${c.quality}${langs ? `, ${langs}` : ''})`
}

export function formatDiagnostic(d: DictationRecord, index: number, levelsNote?: string): string {
  const when = new Date(d.at).toLocaleString()
  const c = d.capture

  const lines: string[] = []
  lines.push(`## Dictation #${index} · ${when}`)
  lines.push('')
  lines.push('```')
  lines.push(`models     ${d.asrModel} + ${d.llmModel}`)
  lines.push(`audio      ${(d.audioMs / 1000).toFixed(1)}s   detected language: ${d.language}`)
  lines.push(`timings    asr ${ms(d.asrMs)} · llm ${d.llmMs ? ms(d.llmMs) : 'not called'}`)
  if (c) {
    lines.push(
      `capture    stopped by ${c.stoppedBy} · speech ${ms(c.speechMs)} · silence ${ms(
        c.silenceMs
      )} · longest pause ${ms(c.longestPauseMs)} · window ${ms(c.windowMs)}`
    )
  }
  if (c?.thresholdRms !== undefined) {
    // Present so a mic whose levels do not suit the threshold is diagnosable
    // from the export alone, rather than by analysing a WAV by hand.
    lines.push(
      `levels     peak ${c.peakRms?.toFixed(5)} · mean speech ${c.meanSpeechRms?.toFixed(
        5
      )} · threshold ${c.thresholdRms.toFixed(5)}`
    )
    // A threshold in the wrong place looks the same whether it was inherited or
    // measured badly, and the fix differs. Say which.
    if (levelsNote) lines.push(`source     ${levelsNote}`)
  }
  lines.push(`chunking   ${explainChunks(d)}`)
  // Where the text actually went. "It did not appear" is unanswerable without
  // knowing whether we inserted, typed, or only copied - and why.
  lines.push(
    `delivery   ${d.inserted ? 'inserted' : 'clipboard only'} via ${d.delivery}` +
      (d.targetExe ? ` into ${d.targetExe}` : '') +
      (d.deliveryNote ? ` (${d.deliveryNote})` : '')
  )
  lines.push(`degraded   ${d.degraded ?? 'no'}`)
  lines.push('```')
  lines.push('')

  if (!d.raw && !d.received) {
    lines.push('_Imported from a build that predates stage capture, so no text is available._')
    return lines.join('\n')
  }

  const stage = (title: string, body: string, note?: string): void => {
    lines.push(`### ${title}${note ? `  _(${note})_` : ''}`)
    lines.push('')
    lines.push('```')
    lines.push(body || '(empty)')
    lines.push('```')
    lines.push('')
  }

  stage('1 · Heard', d.raw, 'straight out of Whisper')
  stage(
    '2 · After dictionary',
    d.corrected,
    d.applied.length
      ? `rules fired: ${d.applied.map((a) => `${a.from} -> ${a.to}`).join(', ')}`
      : 'no rules fired, identical to above'
  )
  stage('3a · System prompt sent', d.sentSystem)
  stage('3b · User message sent', d.sentUser)
  stage(
    '4 · Received',
    d.received,
    d.received === d.sentUser ? 'model returned the input unchanged' : undefined
  )

  return lines.join('\n')
}

export function formatSession(dictations: DictationRecord[], meta: Record<string, string>): string {
  const head = [
    '# Wouice diagnostic export',
    '',
    '```',
    ...Object.entries(meta).map(([k, v]) => `${k.padEnd(12)} ${v}`),
    `exported     ${new Date().toLocaleString()}`,
    `dictations   ${dictations.length}`,
    '```',
    '',
    '---',
    '',
  ].join('\n')

  return (
    head +
    dictations
      .map((d, i) => formatDiagnostic(d, dictations.length - i, meta.levels))
      .join('\n\n---\n\n')
  )
}
