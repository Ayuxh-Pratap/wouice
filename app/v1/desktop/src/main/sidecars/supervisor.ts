import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { SIDECARS, findModel, type SidecarDef, type SidecarId } from '../../shared/models.js'
import {
  answeredReady,
  canServe,
  initialState,
  markBusy,
  markIdle,
  onHealthy,
  onStarting,
  onStopped,
  onUnexpectedExit,
  requestSwitch,
  type SidecarState,
  type SupervisorAction,
} from './policy.js'

export interface SidecarSnapshot extends SidecarState {
  id: SidecarId
  port: number
  pid: number | null
}

interface Managed {
  def: SidecarDef
  state: SidecarState
  proc: ChildProcess | null
  port: number
  /** Last few stderr lines, kept so a failure can be surfaced verbatim. */
  stderr: string[]
  respawnTimer: NodeJS.Timeout | null
  healthTimer: NodeJS.Timeout | null
}

const HEALTH_INTERVAL_MS = 2_000
const STDERR_KEEP = 40

/**
 * Owns the lifecycle of the whisper and llama sidecars.
 *
 * All decisions live in `policy.ts`; this is the part that actually spawns
 * processes, polls health and runs timers. The split exists so restart storms,
 * backoff and the switch-queueing rule can be tested without a GPU.
 *
 * Crash isolation is the reason these are separate processes at all: a CUDA
 * out-of-memory or a native fault in ggml kills a sidecar, not the app. The app
 * notices, respawns it, and the user sees a degraded dictation rather than a
 * dead tray icon.
 */
export class SidecarSupervisor extends EventEmitter {
  private readonly managed = new Map<SidecarId, Managed>()

  constructor(
    private readonly sidecarRoot: string,
    private readonly modelRoot: string
  ) {
    super()
  }

  register(id: SidecarId, modelId: string, port?: number): void {
    const def = SIDECARS[id]
    this.managed.set(id, {
      def,
      state: initialState(modelId),
      proc: null,
      port: port ?? def.defaultPort,
      stderr: [],
      respawnTimer: null,
      healthTimer: null,
    })
  }

  snapshot(id: SidecarId): SidecarSnapshot {
    const m = this.require(id)
    return { ...m.state, id, port: m.port, pid: m.proc?.pid ?? null }
  }

  snapshotAll(): SidecarSnapshot[] {
    return [...this.managed.keys()].map((id) => this.snapshot(id))
  }

  /**
   * Resolve true once this sidecar answers; false if it has stopped or failed,
   * or has not answered within `timeoutMs`.
   *
   * STARTED IS NOT READY. `start` and `switchModel` return once the process
   * exists, and the model then spends seconds reading its weights. The careful
   * pass restarted the language model and asked it for the English and the
   * summary fifty milliseconds later; both failed against a server that was
   * still loading, and the improved meeting was left with neither.
   */
  async whenReady(id: SidecarId, timeoutMs = 120_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { status } = this.snapshot(id)
      if (status === 'ready') return true
      // Nothing is bringing it up, so there is nothing to wait for.
      if (status === 'failed' || status === 'stopped') return false
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return false
  }

  /**
   * Resolve true once this sidecar is running `modelId`, with no switch still
   * queued behind a dictation, and answering. False if it fails, or after
   * `timeoutMs`.
   *
   * A SWITCH ASKED FOR DURING A DICTATION IS QUEUED, NOT DONE, and
   * `switchModel` returns either way. The careful pass once took that return
   * as done: the restore it asked for afterwards was of whatever happened to
   * be loaded, the large model stayed on the card, and the next meeting was
   * transcribed live by it without anybody choosing that. Anything that needs
   * a particular model loaded checks here instead of trusting the call.
   */
  async whenModel(id: SidecarId, modelId: string, timeoutMs = 180_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const s = this.snapshot(id)
      if (s.modelId === modelId && s.pendingModelId === null && s.status === 'ready') return true
      if (s.status === 'failed') return false
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return false
  }

  /** Resolve true once no dictation is holding this sidecar; false after `timeoutMs`. */
  async whenIdle(id: SidecarId, timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.snapshot(id).busy) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  canServe(id: SidecarId): boolean {
    return canServe(this.require(id).state)
  }

  baseUrl(id: SidecarId): string {
    return `http://127.0.0.1:${this.require(id).port}`
  }

  /** The pipeline is mid-utterance: do not restart this sidecar underneath it. */
  setBusy(id: SidecarId, busy: boolean): void {
    const m = this.require(id)
    if (busy) {
      m.state = markBusy(m.state)
      this.emitState(id)
      return
    }
    const { state, action } = markIdle(m.state)
    m.state = state
    this.emitState(id)
    void this.perform(id, action)
  }

  async start(id: SidecarId): Promise<void> {
    const m = this.require(id)
    if (m.proc) return
    await this.spawnProcess(id, m.state.modelId)
  }

  async stop(id: SidecarId): Promise<void> {
    const m = this.require(id)
    this.clearTimers(m)
    await this.killAndWait(m)
    m.state = onStopped(m.state)
    this.emitState(id)
  }

  /**
   * Kill the current process and WAIT for it to actually exit.
   *
   * Waiting is not politeness, it is required. These processes hold 1-3 GB of
   * VRAM on a 6 GB card; spawning the replacement before the old one has died
   * means both models are resident at once, which either fails to allocate or
   * silently thrashes. A model switch measured 31s per dictation instead of
   * 1.3s because of exactly this.
   *
   * `taskkill /T` on Windows so any grandchild goes too, with process.kill as
   * the fallback and a bounded wait so a wedged process cannot hang startup.
   */
  private async killAndWait(m: Managed, timeoutMs = 5_000): Promise<void> {
    const proc = m.proc
    if (!proc) return
    // Clear the reference FIRST: the exit handler keys off identity, so from
    // this moment its exit is recognised as ours rather than as a crash.
    m.proc = null

    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      proc.once('exit', () => resolve())
    })

    if (proc.pid) {
      try {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        proc.kill()
      }
    } else {
      proc.kill()
    }

    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.managed.keys()].map((id) => this.stop(id)))
  }

  /** Switch model. Queued automatically if a dictation is in flight. */
  async switchModel(id: SidecarId, modelId: string): Promise<void> {
    const m = this.require(id)
    if (!findModel(id, modelId)) throw new Error(`unknown ${id} model: ${modelId}`)
    const { state, action } = requestSwitch(m.state, modelId)
    m.state = state
    this.emitState(id)
    await this.perform(id, action)
  }

  private async perform(id: SidecarId, action: SupervisorAction): Promise<void> {
    switch (action.type) {
      case 'none':
        return
      case 'kill':
        return this.stop(id)
      case 'spawn':
        return this.spawnProcess(id, action.modelId)
      case 'restart': {
        const m = this.require(id)
        this.clearTimers(m)
        // Await the old model's VRAM being released before loading the new one.
        await this.killAndWait(m)
        return this.spawnProcess(id, action.modelId)
      }
      case 'scheduleRespawn': {
        const m = this.require(id)
        m.respawnTimer = setTimeout(() => {
          m.respawnTimer = null
          void this.spawnProcess(id, m.state.modelId)
        }, action.delayMs)
        return
      }
    }
  }

  private async spawnProcess(id: SidecarId, modelId: string): Promise<void> {
    const m = this.require(id)
    const model = findModel(id, modelId)
    if (!model) throw new Error(`unknown ${id} model: ${modelId}`)

    const exe = path.join(this.sidecarRoot, m.def.exe)
    const modelPath = path.join(this.modelRoot, model.file)

    // Fail loudly and specifically here rather than letting the process die
    // with an inscrutable error: a missing binary means the fetch script has
    // not run, and a missing model means the same for models.
    for (const [what, p] of [['sidecar binary', exe], ['model', modelPath]] as const) {
      if (!existsSync(p)) {
        m.state = { ...m.state, status: 'failed', lastError: `${what} not found: ${p}` }
        this.emitState(id)
        return
      }
    }

    m.state = onStarting({ ...m.state, modelId })
    m.stderr = []
    this.emitState(id)

    const proc = spawn(exe, m.def.args(modelPath, m.port, model), {
      // Working directory matters: these binaries load sibling DLLs.
      cwd: path.dirname(exe),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    m.proc = proc

    const keep = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) m.stderr.push(line.trim())
      }
      if (m.stderr.length > STDERR_KEEP) m.stderr.splice(0, m.stderr.length - STDERR_KEEP)
    }
    proc.stdout?.on('data', keep)
    proc.stderr?.on('data', keep)

    proc.on('error', (err) => {
      m.state = { ...m.state, status: 'failed', lastError: err.message }
      this.emitState(id)
    })

    proc.on('exit', (code, signal) => {
      // IDENTITY, not a shared flag. The previous version read a mutable
      // `intentionalStop` that the replacement had already reset by the time
      // this fired, so every model switch logged a phantom crash and respawned
      // a THIRD process. Three whisper and five llama servers accumulated that
      // way, pinning VRAM at 5.9 of 6.1 GB.
      if (m.proc !== proc) return
      m.proc = null
      this.clearTimers(m)
      const tail = m.stderr.slice(-3).join(' | ')
      const detail = `exited ${signal ?? code}${tail ? `: ${tail}` : ''}`
      const { state, action } = onUnexpectedExit(m.state, detail)
      m.state = state
      this.emitState(id)
      void this.perform(id, action)
    })

    this.beginHealthPolling(id)
  }

  /**
   * Poll until the process is ready, then keep watching.
   *
   * What "ready" means depends on the server - see `answeredReady`.
   * whisper-server has no health endpoint and answers the root path with
   * whatever it feels like, so any HTTP response proves it loaded. llama-server
   * answers /health with 503 while it is still loading, so only a 200 does.
   * Treating that 503 as ready is what made the English and the summary fail
   * two seconds after the careful pass restarted the language model.
   */
  private beginHealthPolling(id: SidecarId): void {
    const m = this.require(id)
    this.clearHealthTimer(m)

    const poll = async () => {
      if (!m.proc) return
      try {
        const res = await fetch(`${this.baseUrl(id)}${m.def.healthPath}`, {
          signal: AbortSignal.timeout(1_500),
        })
        if (!answeredReady(m.def.readyWhen, res.status)) return
        if (m.state.status !== 'ready') {
          m.state = onHealthy(m.state)
          this.emitState(id)
        }
      } catch {
        // Still loading, or gone. The exit handler owns the "gone" case.
      }
    }

    m.healthTimer = setInterval(poll, HEALTH_INTERVAL_MS)
    void poll()
  }

  private clearTimers(m: Managed): void {
    if (m.respawnTimer) {
      clearTimeout(m.respawnTimer)
      m.respawnTimer = null
    }
    this.clearHealthTimer(m)
  }

  private clearHealthTimer(m: Managed): void {
    if (m.healthTimer) {
      clearInterval(m.healthTimer)
      m.healthTimer = null
    }
  }

  private emitState(id: SidecarId): void {
    this.emit('state', this.snapshot(id))
  }

  private require(id: SidecarId): Managed {
    const m = this.managed.get(id)
    if (!m) throw new Error(`sidecar not registered: ${id}`)
    return m
  }
}
