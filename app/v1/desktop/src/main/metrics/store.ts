import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DictationResult } from '../dictation/controller.js'

const exec = promisify(execFile)

/**
 * Metrics for the monitoring view.
 *
 * JSONL, not SQLite, deliberately. This is append-only telemetry read in bulk
 * and never queried by key, so a database buys nothing here, and `better-sqlite3`
 * is a native module needing an Electron rebuild. SQLite arrives with the
 * history and dictionary UI, which genuinely needs FTS5 for search. Splitting
 * them this way means the metrics view ships now rather than waiting on a
 * toolchain problem it does not have.
 *
 * One line per event so a partial write can only ever lose the last line, and
 * so the file can be tailed or grepped while the app runs.
 */

export interface DictationMetric {
  kind: 'dictation'
  at: number
  audioMs: number
  asrMs: number
  llmMs: number
  totalMs: number
  chunks: number
  asrModel: string
  llmModel: string
  language: string
  rawChars: number
  finalChars: number
  corrections: number
  degraded: string | null
}

export interface ResourceMetric {
  kind: 'resource'
  at: number
  vramUsedMiB: number
  vramTotalMiB: number
  rssMiB: number
}

export type Metric = DictationMetric | ResourceMetric

/** Kept in memory for the charts; the file is the durable record. */
const MEMORY_LIMIT = 2_000

export class MetricsStore {
  private readonly file: string
  private memory: Metric[] = []

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'metrics.jsonl')
    this.memory = this.readTail()
  }

  get path(): string {
    return this.file
  }

  record(metric: Metric): void {
    this.memory.push(metric)
    if (this.memory.length > MEMORY_LIMIT) this.memory.splice(0, this.memory.length - MEMORY_LIMIT)
    try {
      appendFileSync(this.file, JSON.stringify(metric) + '\n', 'utf8')
    } catch {
      // Telemetry must never break dictation. Losing a metric is nothing;
      // throwing here would abort the delivery of text the user already spoke.
    }
  }

  recordDictation(r: DictationResult): void {
    this.record({
      kind: 'dictation',
      at: Date.now(),
      audioMs: r.audioMs,
      asrMs: r.asrMs,
      llmMs: r.llmMs,
      totalMs: r.totalMs,
      chunks: r.chunks,
      asrModel: r.asrModel,
      llmModel: r.llmModel,
      language: r.language,
      rawChars: r.raw.length,
      finalChars: r.final.length,
      corrections: r.appliedCorrections,
      degraded: r.degraded,
    })
  }

  /** Newest last. */
  all(): Metric[] {
    return this.memory
  }

  dictations(): DictationMetric[] {
    return this.memory.filter((m): m is DictationMetric => m.kind === 'dictation')
  }

  resources(): ResourceMetric[] {
    return this.memory.filter((m): m is ResourceMetric => m.kind === 'resource')
  }

  private readTail(): Metric[] {
    if (!existsSync(this.file)) return []
    try {
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
      const out: Metric[] = []
      // A crash mid-write leaves one malformed line; skip it rather than
      // refusing to show any history at all.
      for (const line of lines.slice(-MEMORY_LIMIT)) {
        try {
          out.push(JSON.parse(line) as Metric)
        } catch {
          continue
        }
      }
      return out
    } catch {
      return []
    }
  }
}

/**
 * Sample GPU and process memory.
 *
 * Spawning nvidia-smi costs ~80 ms, so this is called on a slow interval and
 * never on the dictation path. The whole point of the chart is to show whether
 * the ~5.4 GB hot set is leaving headroom on a 6144 MiB card, which changes on
 * the scale of seconds, not milliseconds.
 */
export async function sampleResources(): Promise<Omit<ResourceMetric, 'kind' | 'at'> | null> {
  const rssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024)
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 5_000 }
    )
    const [used, total] = stdout.trim().split(',').map((s) => Number(s.trim()))
    if (!Number.isFinite(used) || !Number.isFinite(total)) return { vramUsedMiB: 0, vramTotalMiB: 0, rssMiB }
    return { vramUsedMiB: used ?? 0, vramTotalMiB: total ?? 0, rssMiB }
  } catch {
    // No NVIDIA GPU, or the tool is missing. Process memory is still worth having.
    return { vramUsedMiB: 0, vramTotalMiB: 0, rssMiB }
  }
}
