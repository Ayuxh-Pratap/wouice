import { app, clipboard, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarSupervisor, type SidecarSnapshot } from './sidecars/supervisor.js'
import { sweepOrphans } from './sidecars/orphans.js'
import { SIDECARS } from '../shared/models.js'
import { SettingsStore } from './settings-store.js'
import { HotkeyManager } from './hotkeys.js'
import { createTray, destroyTray, refreshTray } from './tray.js'
import { broadcast, createHud, createMainWindow, hideHud, sendToHud, showHud } from './windows.js'
import { IPC, type Diagnostics, type SidecarView } from '../shared/ipc.js'
import type { SidecarId } from '../shared/models.js'
import { DictationController } from './dictation/controller.js'
import { MetricsStore, sampleResources } from './metrics/store.js'

// MUST come before any app.getPath('userData') call, and those happen at module
// scope below. Unpackaged, Electron otherwise names itself "Electron" and puts
// our settings and metrics in a shared directory alongside every other Electron
// app run from source, which is both wrong and confusing to find.
app.setName('Wouice')

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Sidecar binaries and model weights live at the REPO root, outside app/v1/,
 * because they are large, gitignored, and shared across app versions. In a
 * packaged build these would move next to the executable; for now the layout is
 * out/main -> desktop -> app/v1 -> app -> <repo>.
 */
const REPO_ROOT = path.resolve(here, '../../../../..')
const SIDECAR_ROOT = path.join(REPO_ROOT, 'sidecars')
const MODEL_ROOT = path.join(REPO_ROOT, 'models')

const settings = new SettingsStore()
const supervisor = new SidecarSupervisor(SIDECAR_ROOT, MODEL_ROOT)
const hotkeys = new HotkeyManager()
const metrics = new MetricsStore(app.getPath('userData'))

const dictation = new DictationController({
  supervisor,
  silence: settings.get().silence as never,
  cleanupEnabled: () => settings.get().cleanup.enabled,
  cleanupTimeoutMs: () => settings.get().cleanup.timeoutMs,
})

/** Phase names the HUD understands; the machine has one more than it shows. */
const HUD_PHASE: Record<string, string> = {
  idle: 'idle',
  arming: 'arming',
  listening: 'listening',
  transcribing: 'thinking',
  delivering: 'thinking',
  error: 'error',
}

dictation.on('phase', ({ phase, message }: { phase: string; message: string | null }) => {
  broadcast(IPC.hudState, {
    phase: HUD_PHASE[phase] ?? 'idle',
    level: dictation.level,
    elapsedMs: dictation.elapsedMs,
    ...(message ? { message } : {}),
  })
  if (phase === 'idle') hideHud()
  else showHud()
})

dictation.on('level', ({ level, elapsedMs }: { level: number; elapsedMs: number }) => {
  sendToHud(IPC.hudState, { phase: 'listening', level, elapsedMs })
})

dictation.on('startCapture', (sessionId: number) => sendToHud(IPC.startCapture, sessionId))
dictation.on('stopCapture', (sessionId: number) => sendToHud(IPC.stopCapture, sessionId))

dictation.on('result', (r) => {
  // Delivery is clipboard-only until injection lands in step 5. Copying still
  // makes the tool usable today: one Ctrl+V and the text is placed.
  clipboard.writeText(r.final)
  metrics.recordDictation(r)
  broadcast(IPC.metric, undefined)
  broadcast(IPC.dictationResult, {
    final: r.final,
    raw: r.raw,
    language: r.language,
    asrMs: r.asrMs,
    llmMs: r.llmMs,
    degraded: r.degraded,
    delivered: 'copied',
  })
  broadcast(IPC.hudState, {
    phase: 'copied',
    level: 0,
    elapsedMs: 0,
    message: `Copied · ${r.final.length} chars`,
  })
  setTimeout(() => dictation.send({ type: 'delivered' }), 1_400)
})

function toView(s: SidecarSnapshot): SidecarView {
  return {
    id: s.id,
    status: s.status,
    modelId: s.modelId,
    pendingModelId: s.pendingModelId,
    port: s.port,
    pid: s.pid,
    lastError: s.lastError,
  }
}

const trayDeps = {
  supervisor,
  settings,
  onOpenWindow: () => createMainWindow(),
  onSwitchModel: (id: SidecarId, modelId: string) => {
    // Persist first so the choice survives a crash during the restart.
    settings.set({ models: { ...settings.get().models, [id]: modelId } })
    void supervisor.switchModel(id, modelId)
  },
  onRestart: (id: SidecarId) => {
    void supervisor.stop(id).then(() => supervisor.start(id))
  },
}

supervisor.on('state', (snap: SidecarSnapshot) => {
  broadcast(IPC.sidecarState, toView(snap))
  refreshTray(trayDeps)
})

function registerHotkeys(): void {
  const { hotkeys: keys } = settings.get()
  const results = hotkeys.register([
    {
      name: 'dictate',
      accelerator: keys.dictate,
      handler: () => dictation.send({ type: 'hotkey', now: Date.now() }),
    },
  ])

  // Registration fails silently at the OS level, so an app that assumes success
  // just does nothing forever and looks broken. Report exactly what happened.
  for (const r of results) {
    if (r.accelerator === null) {
      console.error(`[hotkey] ${r.name}: NOTHING available. tried ${[r.requested, ...r.rejected].join(', ')}`)
      broadcast(IPC.hotkeyFailed, { name: r.name, requested: r.requested, accelerator: null, rejected: r.rejected })
    } else if (r.substituted) {
      console.warn(`[hotkey] ${r.name}: ${r.requested} taken, using ${r.accelerator}`)
      broadcast(IPC.hotkeyFailed, r)
    } else {
      console.log(`[hotkey] ${r.name}: ${r.accelerator}`)
    }
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => settings.get())
  ipcMain.handle(IPC.setSettings, (_e, patch) => {
    const next = settings.set(patch)
    registerHotkeys()
    broadcast(IPC.settingsChanged, next)
    return next
  })
  ipcMain.handle(IPC.getSidecars, () => supervisor.snapshotAll().map(toView))
  ipcMain.handle(IPC.switchModel, (_e, id: SidecarId, modelId: string) => {
    trayDeps.onSwitchModel(id, modelId)
  })
  ipcMain.handle(IPC.restartSidecar, (_e, id: SidecarId) => trayDeps.onRestart(id))
  ipcMain.handle(IPC.getDiagnostics, (): Diagnostics => ({
    sidecarRoot: SIDECAR_ROOT,
    modelRoot: MODEL_ROOT,
    userData: app.getPath('userData'),
    hotkeyRegistered: hotkeys.liveStatus(),
    hotkeys: hotkeys.status(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron,
  }))
  ipcMain.on(IPC.hideHud, () => hideHud())
  ipcMain.handle(IPC.getMetrics, () => ({
    dictations: metrics.dictations(),
    resources: metrics.resources(),
  }))
  ipcMain.on(IPC.audioFrame, (_e, sessionId: number, frame: Float32Array) =>
    dictation.pushFrame(sessionId, frame)
  )
  ipcMain.on(IPC.captureReady, (_e, sessionId: number) => {
    if (sessionId === dictation.sessionId) dictation.send({ type: 'micReady' })
  })
  ipcMain.on(IPC.captureFailed, (_e, sessionId: number, reason: string) => {
    if (sessionId === dictation.sessionId) dictation.send({ type: 'micFailed', reason })
  })
  ipcMain.on(IPC.cancelDictation, () => dictation.send({ type: 'escape' }))
}

// A second instance would fight over the hotkey and the sidecar ports.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createMainWindow())

  app.whenReady().then(async () => {
    // On a 6 GB card whose hot set needs ~5.4 GB, one stray sidecar left by a
    // manual benchmark or debug launch is the difference between starting and a
    // CUDA out-of-memory. Guarantee a deterministic starting state.
    const ourExes = Object.values(SIDECARS).map((d) => path.join(SIDECAR_ROOT, d.exe))
    const sweep = await sweepOrphans(ourExes)
    if (sweep.killed.length) {
      console.warn(
        `[orphans] killed ${sweep.killed.length} leftover sidecar(s): ` +
          sweep.killed.map((k) => `${k.exe}#${k.pid}`).join(', ')
      )
    }

    const { models } = settings.get()
    supervisor.register('whisper', models.whisper)
    supervisor.register('llama', models.llama)

    registerIpc()
    createHud()
    createTray(trayDeps)
    registerHotkeys()
    createMainWindow()

    // Start both sidecars. They load multi-GB models, so this takes seconds;
    // the UI is usable throughout and reports status as it changes.
    void supervisor.start('whisper')
    void supervisor.start('llama')

    // Slow on purpose: spawning nvidia-smi costs ~80ms and the headroom this
    // watches changes on the scale of seconds, never milliseconds. It is never
    // called on the dictation path.
    const sample = async (): Promise<void> => {
      const r = await sampleResources()
      if (r) metrics.record({ kind: 'resource', at: Date.now(), ...r })
    }
    void sample()
    setInterval(() => void sample(), 15_000)
  })

  // Tray app: closing the window must not quit.
  app.on('window-all-closed', () => {})

  app.on('before-quit', async () => {
    hotkeys.unregisterAll()
    destroyTray()
    // Sidecars are children, but killing them explicitly avoids orphaned
    // processes holding the GPU if Electron exits uncleanly.
    await supervisor.stopAll()
  })
}
