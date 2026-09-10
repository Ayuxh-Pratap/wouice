import type { DictationRecord, MeetingDiagnostics, MeetingRecord } from '@wouice/store'
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

/**
 * One meeting, as a block of text you can paste into a message.
 *
 * WHAT THIS IS FOR. A meeting happens once and runs for an hour. When the
 * transcript is wrong the useful question is never "is it wrong" - you can see
 * that - it is WHICH STEP produced it: the microphone that was never opened,
 * the forty chunks the speech model refused, the notes run that timed out, the
 * two clocks that drifted a second apart. Each of those looks identical from
 * the outside and needs a different fix.
 *
 * Ordered by how often it is the answer.
 */
export function formatMeeting(
  meeting: MeetingRecord,
  tasksIn: (versionId: number) => number
): string {
  const d = meeting.diagnostics
  const lines: string[] = []
  const when = new Date(meeting.startedAt).toLocaleString()

  lines.push(`meeting ${meeting.id} - ${when}`)
  lines.push(`  duration      ${Math.round(meeting.durationMs / 1000)}s`)
  lines.push(`  finished      ${meeting.endedAt === null ? 'NO - never reached a clean stop' : 'yes'}`)
  lines.push(`  directory     ${meeting.dir}`)
  lines.push('')

  lines.push('capture')
  for (const channel of d.channels ?? []) {
    const seconds = Math.round(channel.samples / 16_000)
    const label = channel.channel === 'me' ? 'you (mic)   ' : 'them (system)'
    lines.push(
      `  ${label} ${String(seconds).padStart(5)}s` +
        (channel.problem ? `  PROBLEM: ${channel.problem}` : '')
    )
  }
  if ((d.channels ?? []).length === 0) lines.push('  (nothing recorded)')
  if (d.recoveredWithoutManifest) {
    lines.push('  recovered without a manifest: channel alignment is approximate')
  }
  if (d.skewMs !== undefined && d.skewMs !== null) {
    lines.push(`  clock skew    ${d.skewMs.toFixed(0)} ms between the two channels`)
  }
  if (d.driftPpm) {
    const fmt = (v: number | null): string => (v === null ? 'n/a' : `${v.toFixed(0)} ppm`)
    lines.push(`  drift         you ${fmt(d.driftPpm.me)}, them ${fmt(d.driftPpm.them)}`)
  }
  lines.push('')

  lines.push('transcription')
  lines.push(`  model         ${d.asrModel ?? 'unknown'}`)
  lines.push(`  language      ${d.language ?? 'unknown'}`)
  lines.push(`  chunks sent   ${d.chunksSent ?? 0}`)
  lines.push(`  chunks silent ${d.chunksSkipped ?? 0}  (never sent, so never hallucinated over)`)
  lines.push(
    `  chunks failed ${d.chunksFailed ?? 0}` +
      ((d.chunksFailed ?? 0) > 0 ? '  <- lost audio, one slice each' : '')
  )
  lines.push(`  segments      ${meeting.segments}`)
  lines.push('')

  lines.push('notes')
  lines.push(`  model         ${d.llmModel ?? 'unknown'}`)
  lines.push(`  your notes    ${meeting.scratchMd ? `${meeting.scratchMd.length} chars` : 'none'}`)

  // One block per transcript: each has its own English, summary and tasks, and
  // "the summary is wrong" means nothing until you know which one it was built on.
  for (const version of meeting.versions) {
    const v = version.diagnostics
    lines.push('')
    lines.push(`version ${version.source}${version.main ? '  (main)' : ''}`)
    lines.push(`  lines         ${version.segments}`)
    if (v.transcription) {
      // Which language each chunk was sent as: a wrong choice here is what
      // turned English speech into Hindi-script nonsense.
      const languages = Object.entries(v.transcription.languages ?? {})
        .map(([language, n]) => `${language} ${n}`)
        .join(', ')
      lines.push(
        `  transcribed   ${v.transcription.model}, ${v.transcription.segments} lines, ` +
          `${Math.round(v.transcription.ms / 1000)}s, ${new Date(v.transcription.at).toLocaleString()}` +
          (languages ? `, chunks sent as ${languages}` : '')
      )
    }
    if (v.english) {
      lines.push(
        v.english.ok === false
          ? `  english       FAILED - ${v.english.message ?? 'no reason recorded'}`
          : `  english       ${v.english.rendered} rendered, ${v.english.missed} missed, ` +
              `${v.english.failedBatches} failed batch(es)`
      )
    }
    lines.push(`  summary       ${version.notesMd ? `yes, ${version.notesMd.length} chars` : 'not written'}`)
    lines.push(`  tasks         ${tasksIn(version.id)}`)
    formatNotesRuns(v.notes ?? [], lines)
  }
  if (meeting.versions.length === 0) lines.push('  (no transcript versions)')

  return lines.join('\n')
}

function formatNotesRuns(runs: NonNullable<MeetingDiagnostics['notes']>, lines: string[]): void {
  for (const run of runs) {
    lines.push(
      `  run ${new Date(run.at).toLocaleTimeString()}  ` +
        (run.ok
          ? `ok - ${run.chunks} chunk(s), ${run.gaps} gap(s), ${run.tasks} task(s), ${Math.round(run.ms / 1000)}s`
          : `FAILED - ${run.message ?? 'no reason recorded'}`)
    )
    if (run.totalLines) {
      const pct = Math.round(((run.coveredLines ?? 0) / run.totalLines) * 100)
      lines.push(
        `      covered   ${run.coveredLines}/${run.totalLines} lines (${pct}%)` +
          (pct < 100 ? '  <- the summary did NOT read the whole meeting' : '')
      )
    }
    for (const gap of run.gapsAt ?? []) {
      lines.push(`      not read  ${Math.round(gap.fromMs / 60_000)}-${Math.round(gap.toMs / 60_000)} min`)
    }
    if (run.candidates !== undefined) {
      lines.push(
        `      tasks     ${run.candidates} proposed, ${run.filtered ?? 0} filtered as refusal/maybe,` +
          (run.merged !== undefined ? ` ${run.merged} merged as said twice,` : '') +
          ` ${run.rejected ?? 0} refused on checking, ${run.tasks} kept`
      )
    }
  }
  if (runs.length === 0) lines.push('  (never run)')
}
