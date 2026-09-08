import type { DictationMetric } from './store.js'

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

function explainChunks(d: DictationMetric): string {
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

export function formatDiagnostic(d: DictationMetric, index: number): string {
  const when = new Date(d.at).toLocaleString()
  const c = d.capture
  const s = d.stages

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
  lines.push(`chunking   ${explainChunks(d)}`)
  lines.push(`degraded   ${d.degraded ?? 'no'}`)
  lines.push('```')
  lines.push('')

  if (!s) {
    lines.push('_Recorded before stage capture existed, so no text stages are available._')
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

  stage('1 · Heard', s.raw, 'straight out of Whisper')
  stage(
    '2 · After dictionary',
    s.corrected,
    s.applied.length
      ? `rules fired: ${s.applied.map((a) => `${a.from} -> ${a.to}`).join(', ')}`
      : 'no rules fired, identical to above'
  )
  stage('3a · System prompt sent', s.sent.system)
  stage('3b · User message sent', s.sent.user)
  stage(
    '4 · Received',
    s.received,
    s.received === s.sent.user ? 'model returned the input unchanged' : undefined
  )

  return lines.join('\n')
}

export function formatSession(dictations: DictationMetric[], meta: Record<string, string>): string {
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
      .map((d, i) => formatDiagnostic(d, dictations.length - i))
      .join('\n\n---\n\n')
  )
}
