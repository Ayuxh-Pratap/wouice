import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { encodeWav } from '@wouice/asr'

/**
 * Retains the audio of recent dictations so a bad transcription can be
 * reproduced rather than reasoned about.
 *
 * WHY THIS EXISTS. When output is wrong the first question is whether Whisper
 * misheard or the pipeline mishandled it, and a transcript alone cannot answer
 * that. With the audio, the exact clip can be run through both models and the
 * question is settled in seconds.
 *
 * BOUNDED ON PURPOSE. Only the last N are kept, pruned oldest-first on every
 * write, because this is a person's voice accumulating on their own disk and an
 * unbounded log of it is not something to leave lying around by accident. At
 * 16 kHz mono, ~30s costs about 1 MB, so 20 recordings is roughly 25 MB.
 */
const KEEP = 20

export class RecordingStore {
  private readonly dir: string

  constructor(userData: string) {
    this.dir = path.join(userData, 'recordings')
    mkdirSync(this.dir, { recursive: true })
  }

  get path(): string {
    return this.dir
  }

  /** @returns the file path, or null if there was nothing to save. */
  save(pcm: Float32Array, at = Date.now()): string | null {
    if (pcm.length === 0) return null
    const file = path.join(this.dir, `${at}.wav`)
    try {
      writeFileSync(file, encodeWav(pcm))
      this.prune()
      return file
    } catch {
      // Diagnostics must never break dictation. Losing a recording is nothing;
      // throwing here would abort delivery of text already spoken.
      return null
    }
  }

  list(): { file: string; at: number; bytes: number }[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => {
          const full = path.join(this.dir, f)
          return {
            file: full,
            at: Number(path.basename(f, '.wav')) || 0,
            bytes: statSync(full).size,
          }
        })
        .sort((a, b) => a.at - b.at)
    } catch {
      return []
    }
  }

  totalBytes(): number {
    return this.list().reduce((n, r) => n + r.bytes, 0)
  }

  /**
   * Delete one recording.
   *
   * The path is checked against this directory rather than trusted: it arrives
   * from the renderer, and a delete that accepts any path it is handed is a
   * delete that can be pointed anywhere.
   */
  remove(file: string): boolean {
    const resolved = path.resolve(file)
    if (path.dirname(resolved) !== path.resolve(this.dir)) return false
    if (!resolved.toLowerCase().endsWith('.wav')) return false
    try {
      unlinkSync(resolved)
      return true
    } catch {
      return false
    }
  }

  clear(): void {
    for (const r of this.list()) {
      try {
        unlinkSync(r.file)
      } catch {
        // Locked by a player, or already gone. Nothing useful to do.
      }
    }
  }

  private prune(): void {
    const all = this.list()
    for (const r of all.slice(0, Math.max(0, all.length - KEEP))) {
      try {
        unlinkSync(r.file)
      } catch {
        // Skip; the next prune will retry.
      }
    }
  }
}
