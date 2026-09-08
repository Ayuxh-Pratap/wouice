import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const exec = promisify(execFile)

/**
 * Kill leftover sidecar processes before claiming the GPU.
 *
 * WHAT THIS IS NOT FOR. Electron's own children are cleaned up correctly: a
 * force-kill of the parent was tested and both sidecars died with it, VRAM
 * returning to baseline. `before-quit` covers the clean-exit path. So this is
 * not patching a leak in the app.
 *
 * WHAT IT IS FOR. Anything else that left a sidecar running: a `whisper-server`
 * started by hand while benchmarking, a debug launch from a terminal, a
 * previous build still resident. On a 6 GB card where the hot set already needs
 * ~5.4 GB, ONE stray sidecar is the difference between starting and a CUDA
 * out-of-memory that reads as a mysterious failure rather than "something else
 * is using the GPU". That happened during development and cost real time to
 * work out.
 *
 * The ~300 ms this costs at startup buys a deterministic starting state, which
 * on a card this tight is worth more than the milliseconds.
 *
 * SAFETY: only processes running OUR executables are killed, matched on the
 * full resolved path. Another copy of whisper-server elsewhere on the machine
 * belongs to somebody else and is left strictly alone.
 */
export interface OrphanSweepResult {
  killed: { pid: number; exe: string }[]
  skipped: number
}

interface WmicRow {
  pid: number
  exePath: string
}

/** Running processes matching a set of image names, with full paths. */
async function listProcesses(imageNames: string[]): Promise<WmicRow[]> {
  // PowerShell rather than wmic: wmic is deprecated and absent on newer builds.
  const filter = imageNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')
  const script = `
    $names = @(${filter})
    Get-CimInstance Win32_Process -Filter "Name='${imageNames[0]}'" -ErrorAction SilentlyContinue |
      Where-Object { $names -contains $_.Name } |
      Select-Object ProcessId, ExecutablePath |
      ConvertTo-Json -Compress
  `.trim()

  // One query per name keeps the WQL simple and avoids quoting pain.
  const rows: WmicRow[] = []
  for (const name of imageNames) {
    try {
      const { stdout } = await exec(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='${name}'" -ErrorAction SilentlyContinue | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, timeout: 10_000 }
      )
      const trimmed = stdout.trim()
      if (!trimmed) continue
      const parsed = JSON.parse(trimmed) as
        | { ProcessId: number; ExecutablePath: string | null }
        | { ProcessId: number; ExecutablePath: string | null }[]
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        if (row?.ProcessId && row.ExecutablePath) {
          rows.push({ pid: row.ProcessId, exePath: row.ExecutablePath })
        }
      }
    } catch {
      // A missing process, a JSON hiccup, or PowerShell being slow must never
      // stop the app from starting. Worst case we skip the sweep.
    }
  }
  return rows
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

/**
 * @param ourExes absolute paths to the sidecar binaries this install owns
 * @param exceptPids pids we just spawned and want to keep
 */
export async function sweepOrphans(
  ourExes: string[],
  exceptPids: number[] = []
): Promise<OrphanSweepResult> {
  const names = [...new Set(ourExes.map((p) => path.basename(p)))]
  const running = await listProcesses(names)

  const killed: { pid: number; exe: string }[] = []
  let skipped = 0

  for (const proc of running) {
    if (exceptPids.includes(proc.pid)) continue
    if (proc.pid === process.pid) continue
    // Only ours. A whisper-server somewhere else is somebody else's business.
    if (!ourExes.some((exe) => samePath(exe, proc.exePath))) {
      skipped++
      continue
    }
    try {
      process.kill(proc.pid, 'SIGKILL')
      killed.push({ pid: proc.pid, exe: path.basename(proc.exePath) })
    } catch {
      // Already gone, or not ours to kill. Either way, nothing to do.
    }
  }

  return { killed, skipped }
}
