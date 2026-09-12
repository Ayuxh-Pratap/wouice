import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * What the card holds right now, and how hot it is.
 *
 * The after-call swap reads this before and after every step: the card is
 * 6,144 MiB, the larger meeting model leaves about 650 of it, and a model
 * loaded into too little room either fails or - worse - quietly moves layers
 * to the processor and runs several times slower. Measuring is the only way to
 * know which.
 */
export interface GpuReading {
  usedMiB: number
  totalMiB: number
  /** Null where the driver does not report it. */
  tempC: number | null
  /** Graphics clock. A hot laptop GPU drops it to protect itself. */
  smMHz: number | null
}

/** One line of `nvidia-smi --query-gpu=memory.used,memory.total,temperature.gpu,clocks.sm`. */
export function parseGpu(stdout: string): GpuReading | null {
  const first = stdout.trim().split(/\r?\n/)[0]
  if (!first) return null
  const [used, total, temp, clock] = first.split(',').map((s) => Number(s.trim()))
  if (!Number.isFinite(used) || !Number.isFinite(total) || !total) return null
  return {
    usedMiB: used!,
    totalMiB: total!,
    // "[N/A]" parses as NaN: unknown, not zero.
    tempC: Number.isFinite(temp) ? temp! : null,
    smMHz: Number.isFinite(clock) ? clock! : null,
  }
}

/**
 * Read the first GPU. ~80 ms, so never on the dictation path.
 *
 * Null when there is no NVIDIA card or the tool is missing. Every check that
 * uses this treats null as "unknown" and lets the other checks decide, rather
 * than refusing to work on a machine it cannot measure.
 */
export async function readGpu(): Promise<GpuReading | null> {
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total,temperature.gpu,clocks.sm', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 5_000 }
    )
    return parseGpu(stdout)
  } catch {
    return null
  }
}
