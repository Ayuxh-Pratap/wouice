import { existsSync, readFileSync, renameSync } from 'node:fs'
import type { Db } from './db.js'
import { Dictations } from './dictations.js'
import { Resources } from './resources.js'
import type { DictationRecord, ResourceRecord } from './types.js'

/**
 * Carry the JSONL history into the database, once.
 *
 * The file it reads is a real user's real dictation history. Deleting it after
 * reading would be the obvious thing and the wrong one: if this mapping has a
 * bug, the original is the only way to notice and the only way to redo it. So
 * the file is renamed, never removed, and the rename is what makes this a
 * one-shot rather than something that runs on every launch.
 *
 * The rename happens last. A crash partway leaves the original in place and the
 * import runs again, which is safe because `at` is unique on dictations.
 */

interface LegacyDictation {
  kind: 'dictation'
  at: number
  audioMs: number
  asrMs: number
  llmMs: number
  totalMs?: number
  chunks: number
  asrModel: string
  llmModel: string
  language: string
  rawChars: number
  finalChars: number
  corrections: number
  degraded: string | null
  stages?: {
    raw: string
    corrected: string
    sent: { system: string; user: string }
    received: string
    applied: { from: string; to: string; count: number }[]
  }
  capture?: DictationRecord['capture']
  audioPath?: string | null
}

interface LegacyResource {
  kind: 'resource'
  at: number
  vramUsedMiB: number
  vramTotalMiB: number
  rssMiB: number
}

export interface ImportResult {
  ran: boolean
  dictations: number
  resources: number
  /** Lines that would not parse. A crash mid-write leaves exactly one. */
  malformed: number
}

export function importJsonl(db: Db, file: string): ImportResult {
  if (!existsSync(file)) return { ran: false, dictations: 0, resources: 0, malformed: 0 }

  const dictations = new Dictations(db)
  const resources = new Resources(db)

  const toImport: DictationRecord[] = []
  const samples: ResourceRecord[] = []
  let malformed = 0

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let parsed: LegacyDictation | LegacyResource
    try {
      parsed = JSON.parse(line) as LegacyDictation | LegacyResource
    } catch {
      malformed++
      continue
    }

    if (parsed.kind === 'resource') {
      samples.push({
        at: parsed.at,
        vramUsedMiB: parsed.vramUsedMiB,
        vramTotalMiB: parsed.vramTotalMiB,
        rssMiB: parsed.rssMiB,
      })
      continue
    }

    if (parsed.kind !== 'dictation') {
      malformed++
      continue
    }

    // The oldest records predate stage capture. They are still worth keeping -
    // the timings and the capture diagnostics are intact - so they import with
    // empty text rather than being dropped.
    const s = parsed.stages
    toImport.push({
      at: parsed.at,
      audioMs: parsed.audioMs,
      asrMs: parsed.asrMs,
      llmMs: parsed.llmMs,
      totalMs: parsed.totalMs ?? parsed.asrMs + parsed.llmMs,
      chunks: parsed.chunks,
      asrModel: parsed.asrModel,
      llmModel: parsed.llmModel,
      language: parsed.language,
      rawChars: parsed.rawChars,
      finalChars: parsed.finalChars,
      corrections: parsed.corrections,
      degraded: parsed.degraded,
      raw: s?.raw ?? '',
      corrected: s?.corrected ?? '',
      sentSystem: s?.sent.system ?? '',
      sentUser: s?.sent.user ?? '',
      received: s?.received ?? '',
      applied: s?.applied ?? [],
      capture: parsed.capture ?? null,
      audioPath: parsed.audioPath ?? null,
      // Everything in the JSONL era went to the clipboard and nowhere else.
      inserted: false,
      delivery: 'copy',
      targetExe: '',
      deliveryNote: '',
    })
  }

  const inserted = dictations.insertMany(toImport)

  db.raw.exec('BEGIN IMMEDIATE')
  try {
    for (const s of samples) resources.insert(s)
    db.raw.exec('COMMIT')
  } catch (err) {
    db.raw.exec('ROLLBACK')
    throw err
  }
  resources.prune()

  renameSync(file, `${file}.imported`)
  return { ran: true, dictations: inserted, resources: samples.length, malformed }
}
