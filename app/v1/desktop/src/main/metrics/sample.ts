import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ResourceRecord } from '@wouice/store'

const exec = promisify(execFile)

/**
 * Sample GPU and process memory.
 *
 * Spawning nvidia-smi costs ~80 ms, so this runs on a slow interval and never
 * on the dictation path. The point of the chart it feeds is whether the ~5.4 GB
 * hot set is leaving headroom on a 6144 MiB card, which changes on the scale of
 * seconds, not milliseconds.
 *
 * Never throws. A machine with no NVIDIA GPU still gets process memory, and a
 * missing tool must not turn into a broken dashboard.
 */
export async function sampleResources(): Promise<Omit<ResourceRecord, 'at'>> {
  const rssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024)
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 5_000 }
    )
    const [used, total] = stdout
      .trim()
      .split(',')
      .map((s) => Number(s.trim()))
    if (!Number.isFinite(used) || !Number.isFinite(total)) {
      return { vramUsedMiB: 0, vramTotalMiB: 0, rssMiB }
    }
    return { vramUsedMiB: used ?? 0, vramTotalMiB: total ?? 0, rssMiB }
  } catch {
    return { vramUsedMiB: 0, vramTotalMiB: 0, rssMiB }
  }
}
