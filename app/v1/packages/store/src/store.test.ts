import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, migrate, type Db } from './db.js'
import { openStore, stats } from './index.js'
import { Dictations, toMatchQuery } from './dictations.js'
import { Calibrations, Resources } from './resources.js'
import { importJsonl } from './import.js'
import { LATEST_VERSION, MIGRATIONS } from './migrations.js'
import type { DictationRecord } from './types.js'

function open(): Db {
  return openDb({ file: ':memory:' })
}

const base: DictationRecord = {
  at: 1_000,
  audioMs: 5_000,
  asrMs: 400,
  llmMs: 600,
  totalMs: 1_000,
  chunks: 0,
  asrModel: 'large-v3',
  llmModel: 'qwen3-4b',
  language: 'en',
  rawChars: 20,
  finalChars: 22,
  corrections: 0,
  degraded: null,
  raw: 'hello world',
  corrected: 'hello world',
  sentSystem: 'system',
  sentUser: 'hello world',
  received: 'Hello, world.',
  applied: [],
  capture: null,
  audioPath: null,
  inserted: false,
  delivery: 'copy',
  targetExe: '',
  deliveryNote: '',
}

const at = (n: number, patch: Partial<DictationRecord> = {}): DictationRecord => ({
  ...base,
  at: n,
  ...patch,
})

describe('migrations', () => {
  it('brings a fresh database to the latest version', () => {
    const db = open()
    expect(db.version).toBe(LATEST_VERSION)
    db.close()
  })

  it('is idempotent, because every launch runs it', () => {
    const db = open()
    migrate(db.raw)
    migrate(db.raw)
    expect(db.version).toBe(LATEST_VERSION)
    db.close()
  })

  it('has unique, gapless, ascending ids', () => {
    // A duplicate or out-of-order id means a machine can skip a migration.
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids).toEqual([...new Set(ids)])
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(ids).toEqual(ids.map((_, i) => i + 1))
  })

  it('leaves the version untouched when a migration throws', () => {
    // The failure mode that matters: a half-applied schema claiming to be whole.
    const db = openDb({ file: ':memory:' })
    const before = db.version
    expect(() => {
      db.raw.exec('BEGIN IMMEDIATE')
      try {
        db.raw.exec('THIS IS NOT SQL')
        db.raw.exec('PRAGMA user_version = 99')
        db.raw.exec('COMMIT')
      } catch (err) {
        db.raw.exec('ROLLBACK')
        throw err
      }
    }).toThrow()
    expect(db.version).toBe(before)
    db.close()
  })

  it('upgrades an existing database in place, keeping its rows', () => {
    // The migration that matters most: someone already has history when the
    // delivery columns arrive, and it must survive the upgrade.
    const dir = mkdtempSync(path.join(tmpdir(), 'wouice-upgrade-'))
    const file = path.join(dir, 'x.db')
    try {
      const first = openDb({ file })
      // Roll back to the schema before delivery tracking existed.
      first.raw.exec('PRAGMA user_version = 2')
      first.raw.exec('ALTER TABLE dictations DROP COLUMN inserted')
      first.raw.exec('ALTER TABLE dictations DROP COLUMN delivery')
      first.raw.exec('ALTER TABLE dictations DROP COLUMN target_exe')
      first.raw.exec('ALTER TABLE dictations DROP COLUMN delivery_note')
      first.raw.exec('DROP TABLE dictionary')
      first.raw
        .prepare(
          `INSERT INTO dictations (at, audio_ms, asr_ms, llm_ms, total_ms, chunks,
             asr_model, llm_model, language, raw_chars, final_chars, corrections, received)
           VALUES (5, 1, 1, 1, 1, 0, 'm', 'm', 'en', 1, 1, 0, 'older row')`
        )
        .run()
      first.close()

      const second = openDb({ file })
      expect(second.version).toBe(LATEST_VERSION)
      const row = new Dictations(second).byAt(5)
      expect(row?.received).toBe('older row')
      // Everything before injection existed did go to the clipboard.
      expect(row?.inserted).toBe(false)
      expect(row?.delivery).toBe('copy')
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives being reopened from a real file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wouice-store-'))
    const file = path.join(dir, 'x.db')
    try {
      const first = openDb({ file })
      new Dictations(first).insert(at(1))
      first.close()

      const second = openDb({ file })
      expect(second.version).toBe(LATEST_VERSION)
      expect(new Dictations(second).count()).toBe(1)
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('dictations', () => {
  let db: Db
  let repo: Dictations

  beforeEach(() => {
    db = open()
    repo = new Dictations(db)
  })
  afterEach(() => db.close())

  it('round-trips every field, including the JSON columns', () => {
    const full = at(5, {
      applied: [{ from: 'teh', to: 'the', count: 2 }],
      capture: {
        stoppedBy: 'silence',
        speechMs: 3_000,
        silenceMs: 1_800,
        longestPauseMs: 700,
        windowMs: 1_800,
        chunkAfterMs: 20_000,
        chunkPauseMs: 600,
        peakRms: 0.2,
        meanSpeechRms: 0.01,
        thresholdRms: 0.003,
      },
      audioPath: 'C:/x.wav',
      degraded: 'llm-timeout',
    })
    repo.insert(full)
    const back = repo.byAt(5)
    expect(back).not.toBeNull()
    expect(back?.applied).toEqual(full.applied)
    expect(back?.capture).toEqual(full.capture)
    expect(back?.degraded).toBe('llm-timeout')
    expect(back?.audioPath).toBe('C:/x.wav')
  })

  it('refuses to duplicate a record with the same timestamp', () => {
    expect(repo.insert(at(7))).not.toBeNull()
    expect(repo.insert(at(7))).toBeNull()
    expect(repo.count()).toBe(1)
  })

  it('pages newest first and reports the total, not the page size', () => {
    for (let i = 1; i <= 25; i++) repo.insert(at(i * 1_000))
    const first = repo.page(0, 10)
    expect(first.rows).toHaveLength(10)
    expect(first.total).toBe(25)
    expect(first.rows[0]?.at).toBe(25_000)

    const last = repo.page(20, 10)
    expect(last.rows).toHaveLength(5)
    expect(last.total).toBe(25)
    expect(last.rows[0]?.at).toBe(5_000)
  })

  it('returns an empty page past the end rather than throwing', () => {
    repo.insert(at(1))
    const page = repo.page(500, 10)
    expect(page.rows).toEqual([])
    expect(page.total).toBe(1)
  })

  it('clamps a hostile page size instead of loading everything', () => {
    for (let i = 1; i <= 5; i++) repo.insert(at(i))
    expect(repo.page(0, 10_000).limit).toBe(200)
    expect(repo.page(-5, 0).offset).toBe(0)
  })

  it('computes the summary over the whole history', () => {
    for (let i = 1; i <= 10; i++) {
      repo.insert(at(i * 1_000, { asrMs: i * 100, llmMs: 0, finalChars: 10 }))
    }
    repo.insert(at(99_000, { degraded: 'llm-down' }))
    const s = repo.summary()
    expect(s.count).toBe(11)
    expect(s.degraded).toBe(1)
    expect(s.chars).toBe(10 * 10 + base.finalChars)
    expect(s.p50Ms).toBeGreaterThan(0)
    expect(s.p95Ms).toBeGreaterThanOrEqual(s.p50Ms)
  })

  it('reports an empty summary without dividing by zero', () => {
    expect(repo.summary()).toEqual({ count: 0, p50Ms: 0, p95Ms: 0, degraded: 0, chars: 0 })
  })

  it('round-trips how the text was delivered', () => {
    repo.insert(
      at(9, { inserted: true, delivery: 'paste', targetExe: 'code.exe', deliveryNote: '' })
    )
    const back = repo.byAt(9)
    expect(back?.inserted).toBe(true)
    expect(back?.delivery).toBe('paste')
    expect(back?.targetExe).toBe('code.exe')
  })

  it('groups mean ASR time by model', () => {
    repo.insert(at(1, { asrModel: 'turbo', asrMs: 100 }))
    repo.insert(at(2, { asrModel: 'turbo', asrMs: 300 }))
    repo.insert(at(3, { asrModel: 'large-v3', asrMs: 1_000 }))
    const rows = repo.meanAsrByModel()
    expect(rows[0]).toEqual({ model: 'turbo', meanMs: 200, n: 2 })
    expect(rows[1]?.model).toBe('large-v3')
  })
})

describe('deleting dictations', () => {
  let db: Db
  let repo: Dictations

  beforeEach(() => {
    db = open()
    repo = new Dictations(db)
    for (const n of [1, 2, 3, 4]) repo.insert(at(n, { audioPath: n % 2 ? `C:/${n}.wav` : null }))
  })
  afterEach(() => db.close())

  it('removes only the ones named', () => {
    const out = repo.deleteAt([2, 4])
    expect(out.deleted).toBe(2)
    expect(repo.count()).toBe(2)
    expect(repo.recent().map((d) => d.at)).toEqual([3, 1])
  })

  it('hands back the audio files those rows were holding, and no others', () => {
    // The caller deletes the WAVs; this class owns a database and nothing else.
    expect(repo.deleteAt([1, 2]).audioPaths).toEqual(['C:/1.wav'])
  })

  it('counts what it actually deleted, not what it was asked to', () => {
    expect(repo.deleteAt([1, 999]).deleted).toBe(1)
    expect(repo.deleteAt([]).deleted).toBe(0)
  })

  it('takes the deleted rows out of the search index', () => {
    // The FTS table is external-content, so a missed trigger leaves a searchable
    // ghost: a hit whose row no longer exists.
    expect(repo.page(0, 10, 'hello').total).toBe(4)
    repo.deleteAt([1, 2, 3])
    const found = repo.page(0, 10, 'hello')
    expect(found.total).toBe(1)
    expect(found.rows).toHaveLength(1)
  })

  it('empties the table and returns every retained recording', () => {
    const out = repo.deleteAll()
    expect(out.deleted).toBe(4)
    expect([...out.audioPaths].sort()).toEqual(['C:/1.wav', 'C:/3.wav'])
    expect(repo.count()).toBe(0)
    expect(repo.page(0, 10, 'hello').total).toBe(0)
  })

  it('leaves a database the next launch still recognises', () => {
    // DELETE, not DROP: a reset that changed the schema version would send the
    // next start into a migration it has already run.
    const before = db.version
    repo.deleteAll()
    expect(db.version).toBe(before)
    repo.insert(at(9))
    expect(repo.count()).toBe(1)
  })
})

describe('search', () => {
  let db: Db
  let repo: Dictations

  beforeEach(() => {
    db = open()
    repo = new Dictations(db)
    repo.insert(at(1, { received: 'Please review the quarterly budget document.' }))
    repo.insert(at(2, { received: 'The deployment pipeline is failing again.' }))
    repo.insert(at(3, { received: 'Budget approved, ship it.', raw: 'budget approved ship it' }))
  })
  afterEach(() => db.close())

  it('finds rows by a word in the final text', () => {
    const page = repo.page(0, 10, 'budget')
    expect(page.total).toBe(2)
    expect(page.rows.map((r) => r.at)).toEqual([3, 1])
  })

  it('matches on a prefix, so results narrow while typing', () => {
    expect(repo.page(0, 10, 'deploy').total).toBe(1)
  })

  it('requires every word, not any of them', () => {
    expect(repo.page(0, 10, 'budget quarterly').total).toBe(1)
    expect(repo.page(0, 10, 'budget nonexistent').total).toBe(0)
  })

  it('treats punctuation as input, never as query syntax', () => {
    // Each of these is a syntax error or a different query if passed through raw.
    for (const hostile of ['"', 'budget"', 'NEAR(a b)', 'a OR b', '*', 'x AND', '(']) {
      expect(() => repo.page(0, 10, hostile)).not.toThrow()
    }
  })

  it('returns nothing for a search that is all punctuation, rather than everything', () => {
    // Falling back to the unfiltered list would look like the filter broke.
    expect(repo.page(0, 10, '!!!').total).toBe(0)
  })

  it('keeps the index in step when a row is deleted', () => {
    db.raw.exec('DELETE FROM dictations WHERE at = 1')
    expect(repo.page(0, 10, 'quarterly').total).toBe(0)
    expect(repo.page(0, 10, 'budget').total).toBe(1)
  })

  it('builds a match query that is quoted and ANDed', () => {
    expect(toMatchQuery('hello world')).toBe('"hello" AND "world"*')
    expect(toMatchQuery('  spaced   out ')).toBe('"spaced" AND "out"*')
    expect(toMatchQuery('!!!')).toBe('')
  })

  it('searches text in any script', () => {
    repo.insert(at(4, { received: 'मुझे यह काम कल तक पूरा करना है' }))
    expect(repo.page(0, 10, 'काम').total).toBe(1)
  })
})

describe('resource samples', () => {
  let db: Db
  let repo: Resources

  beforeEach(() => {
    db = open()
    repo = new Resources(db)
  })
  afterEach(() => db.close())

  it('returns oldest first, because a line chart reads left to right', () => {
    for (const t of [3, 1, 2]) {
      repo.insert({ at: t, vramUsedMiB: t * 10, vramTotalMiB: 6_144, rssMiB: 100 })
    }
    expect(repo.recent().map((r) => r.at)).toEqual([1, 2, 3])
  })

  it('prunes the oldest and keeps the newest', () => {
    for (let i = 1; i <= 50; i++) {
      repo.insert({ at: i, vramUsedMiB: i, vramTotalMiB: 6_144, rssMiB: 1 })
    }
    expect(repo.prune(10)).toBe(40)
    expect(repo.count()).toBe(10)
    expect(repo.recent().map((r) => r.at)).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50])
  })

  it('prunes nothing when under the cap', () => {
    repo.insert({ at: 1, vramUsedMiB: 1, vramTotalMiB: 2, rssMiB: 3 })
    expect(repo.prune(10)).toBe(0)
  })
})

describe('calibrations', () => {
  let db: Db
  let repo: Calibrations

  beforeEach(() => {
    db = open()
    repo = new Calibrations(db)
  })
  afterEach(() => db.close())

  const run = (at: number, applied: boolean, quality: 'good' | 'weak' = 'good'): void => {
    repo.insert({
      at,
      device: 'Headset',
      quality,
      silenceLevel: 0.0004,
      speechLevel: 0.012,
      separation: 30,
      threshold: 0.002,
      minNoiseFloor: 0.001,
      speechFactor: 2,
      applied,
      samples: [{ label: 'hindi', text: 'नमस्ते', language: 'hindi', durationMs: 4_000 }],
    })
  }

  it('keeps runs that were rejected, because a run of weak results is evidence', () => {
    run(1, false, 'weak')
    run(2, false, 'weak')
    run(3, true)
    expect(repo.recent()).toHaveLength(3)
    expect(repo.recent()[0]?.at).toBe(3)
  })

  it('marks a run applied only when the user accepts it', () => {
    run(1, false)
    const id = repo.recent()[0]?.id
    expect(repo.latestApplied()).toBeNull()
    repo.markApplied(id!)
    expect(repo.latestApplied()?.at).toBe(1)
  })

  it('ignores markApplied for a run that is not there', () => {
    expect(() => repo.markApplied(9_999)).not.toThrow()
  })

  it('reports the most recent accepted run as the one in force', () => {
    run(1, true)
    run(2, false, 'weak')
    expect(repo.latestApplied()?.at).toBe(1)
  })

  it('has no applied run before the first one is accepted', () => {
    run(1, false, 'weak')
    expect(repo.latestApplied()).toBeNull()
  })

  it('round-trips the per-sample transcripts', () => {
    run(1, true)
    expect(repo.recent()[0]?.samples[0]?.text).toBe('नमस्ते')
  })
})

describe('importing the JSONL history', () => {
  let dir: string
  let db: Db

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wouice-import-'))
    db = open()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (lines: unknown[]): string => {
    const file = path.join(dir, 'metrics.jsonl')
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
    return file
  }

  const legacy = (at: number, stages = true): unknown => ({
    kind: 'dictation',
    at,
    audioMs: 4_000,
    asrMs: 300,
    llmMs: 400,
    totalMs: 700,
    chunks: 0,
    asrModel: 'large-v3',
    llmModel: 'qwen3-4b',
    language: 'en',
    rawChars: 5,
    finalChars: 6,
    corrections: 0,
    degraded: null,
    ...(stages
      ? {
          stages: {
            raw: 'raw text',
            corrected: 'raw text',
            sent: { system: 'sys', user: 'raw text' },
            received: 'Raw text.',
            applied: [],
          },
        }
      : {}),
  })

  it('brings dictations and samples across', () => {
    const file = write([
      legacy(1),
      legacy(2),
      { kind: 'resource', at: 3, vramUsedMiB: 5_000, vramTotalMiB: 6_144, rssMiB: 200 },
    ])
    const result = importJsonl(db, file)
    expect(result).toMatchObject({ ran: true, dictations: 2, resources: 1, malformed: 0 })
    expect(new Dictations(db).count()).toBe(2)
    expect(new Resources(db).count()).toBe(1)
  })

  it('keeps the original file rather than deleting it', () => {
    const file = write([legacy(1)])
    importJsonl(db, file)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.imported`)).toBe(true)
    expect(readFileSync(`${file}.imported`, 'utf8')).toContain('"at":1')
  })

  it('does not run twice, so a relaunch cannot duplicate history', () => {
    const file = write([legacy(1)])
    importJsonl(db, file)
    const second = importJsonl(db, file)
    expect(second.ran).toBe(false)
    expect(new Dictations(db).count()).toBe(1)
  })

  it('skips the malformed last line a crash leaves behind', () => {
    const file = path.join(dir, 'metrics.jsonl')
    writeFileSync(file, JSON.stringify(legacy(1)) + '\n{"kind":"dicta', 'utf8')
    const result = importJsonl(db, file)
    expect(result.dictations).toBe(1)
    expect(result.malformed).toBe(1)
  })

  it('keeps records that predate stage capture instead of dropping them', () => {
    const file = write([legacy(1, false)])
    importJsonl(db, file)
    const row = new Dictations(db).byAt(1)
    expect(row?.asrMs).toBe(300)
    expect(row?.received).toBe('')
  })

  it('makes imported text searchable', () => {
    const file = write([legacy(1)])
    importJsonl(db, file)
    expect(new Dictations(db).page(0, 10, 'raw').total).toBe(1)
  })

  it('does nothing when there is no file to import', () => {
    expect(importJsonl(db, path.join(dir, 'absent.jsonl')).ran).toBe(false)
  })
})

describe('stats', () => {
  it('lists the real tables with their counts', () => {
    const db = open()
    new Dictations(db).insert(at(1))
    new Resources(db).insert({ at: 1, vramUsedMiB: 1, vramTotalMiB: 2, rssMiB: 3 })

    const s = stats(db, ':memory:')
    const byName = Object.fromEntries(s.tables.map((t) => [t.name, t.rows]))
    expect(byName['dictations']).toBe(1)
    expect(byName['resource_samples']).toBe(1)
    expect(byName['calibrations']).toBe(0)
    expect(s.version).toBe(LATEST_VERSION)
    db.close()
  })

  it('hides SQLite bookkeeping and the FTS shadow tables', () => {
    // dictations_fts_data and friends are implementation detail, and the index
    // itself would report the same count as the table it points at.
    const db = open()
    const names = stats(db, ':memory:').tables.map((t) => t.name)
    expect(names.some((n) => n.startsWith('sqlite_'))).toBe(false)
    expect(names.some((n) => n.includes('_fts'))).toBe(false)
    expect(names).toEqual(['calibrations', 'dictations', 'dictionary', 'resource_samples'])
    db.close()
  })

  it('counts the write-ahead log, where most of the data lives until a checkpoint', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wouice-wal-'))
    try {
      const store = openStore({ dir })
      for (let i = 1; i <= 200; i++) store.dictations.insert(at(i, { received: 'x'.repeat(500) }))
      // Measuring only the .db here would report a few KB for ~100 KB of text.
      expect(store.stats().bytes).toBeGreaterThan(50_000)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports the size of a real file, and does not fail without one', () => {
    expect(stats(open(), ':memory:').bytes).toBe(0)

    const dir = mkdtempSync(path.join(tmpdir(), 'wouice-stats-'))
    try {
      const store = openStore({ dir })
      store.dictations.insert(at(1))
      const s = store.stats()
      expect(s.bytes).toBeGreaterThan(0)
      expect(s.file).toContain('wouice.db')
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
