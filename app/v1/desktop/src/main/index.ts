import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarSupervisor, type SidecarSnapshot } from './sidecars/supervisor.js'
import { sweepOrphans } from './sidecars/orphans.js'
import { SIDECARS } from '../shared/models.js'
import { SettingsStore } from './settings-store.js'
import { HotkeyManager } from './hotkeys.js'
import { createTray, destroyTray, refreshTray } from './tray.js'
import { broadcast, createHud, createMainWindow, hideHud, sendToHud, showHud } from './windows.js'
import { IPC, type CalibrationInput, type CalibrationReport, type Diagnostics, type SidecarView } from '../shared/ipc.js'
import type { SidecarId } from '../shared/models.js'
import { DictationController, FRAME_MS, SAMPLE_RATE, type DictationResult } from './dictation/controller.js'
import { sampleResources } from './metrics/sample.js'
import { importJsonl, openStore, type DictationRecord } from '@wouice/store'
import { RecordingStore } from './metrics/recordings.js'
import { Injector, type InjectionResult } from './injection/injector.js'
import { injectionAvailable, injectionUnavailableReason } from './injection/win32.js'
import { analyseCalibration, applyCalibration, describeLanguages, frameLevels } from './capture/calibrate.js'
import { WhisperCppClient } from '@wouice/asr'
import { describeCalibration, formatDiagnostic, formatSession } from './metrics/diagnostic.js'
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs'

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
/**
 * One SQLite file for dictations, telemetry and calibration history.
 *
 * Replaces an append-only JSONL log that kept its last 2000 events in memory
 * and showed the last twenty. Everything older was on disk and unreachable:
 * there was no way to page back through history, no way to search it, and the
 * headline figures silently described only the tail. `metrics.jsonl` is
 * absorbed on first launch and renamed rather than deleted.
 */
const store = openStore({
  dir: app.getPath('userData'),
  onMigrate: (id, name) => console.log(`[store] migration ${id}: ${name}`),
})
const recordings = new RecordingStore(app.getPath('userData'))

/**
 * Text injection. Falls back to clipboard-only if the native layer is missing,
 * which is what every build before this one did anyway.
 */
const injector = new Injector({
  enabled: () => settings.get().injection.enabled,
  pasteOverrides: () => settings.get().injection.pasteOverrides,
})

const dictation = new DictationController({
  supervisor,
  silence: () => settings.get().silence,
  cleanupEnabled: () => settings.get().cleanup.enabled,
  retainAudio: () => settings.get().retainAudio,
  saveAudio: async (pcm) => recordings.save(pcm),
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
  void (async () => {
    const delivery = await injector.deliver(r.final)

    try {
      store.dictations.insert(toRecord(r, delivery))
    } catch (err) {
      console.warn('[store] could not record dictation:', err)
    }
    broadcast(IPC.metric, undefined)
    broadcast(IPC.dictationResult, {
      final: r.final,
      raw: r.raw,
      language: r.language,
      asrMs: r.asrMs,
      llmMs: r.llmMs,
      degraded: r.degraded,
      delivered: delivery.delivered,
    })
    broadcast(IPC.hudState, {
      phase: delivery.delivered === 'inserted' ? 'inserted' : 'copied',
      level: 0,
      elapsedMs: 0,
      message: hudMessage(delivery, r.final.length),
    })
    setTimeout(() => dictation.send({ type: 'delivered' }), 1_400)
  })()
})

/**
 * What the HUD says about where the text went.
 *
 * "Copied" on its own is the message that wastes someone's time: they look for
 * text that never arrived and have no idea why. When insertion did not happen,
 * the reason goes in the pill.
 */
function hudMessage(delivery: InjectionResult, chars: number): string {
  if (delivery.delivered === 'inserted') {
    return delivery.clipboardReplaced ? `Inserted · clipboard replaced` : `Inserted · ${chars} chars`
  }
  return delivery.reason ? `Copied · ${delivery.reason}` : `Copied · ${chars} chars`
}

/** Controller result -> stored record. The only place the two shapes meet. */
function toRecord(r: DictationResult, delivery: InjectionResult): DictationRecord {
  return {
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
    corrections: r.applied.length,
    degraded: r.degraded,
    raw: r.raw,
    corrected: r.corrected,
    sentSystem: r.sent.system,
    sentUser: r.sent.user,
    received: r.received,
    applied: r.applied,
    capture: r.capture,
    audioPath: r.audioPath,
    inserted: delivery.delivered === 'inserted',
    delivery: delivery.method,
    targetExe: delivery.targetExe,
    deliveryNote: delivery.reason,
  }
}

/**
 * Keep every calibration run, accepted or not.
 *
 * A rejected run is evidence rather than noise: three weak results in a row on
 * the same microphone says the room or the hardware is the problem, not the
 * algorithm, and that is only visible if the misses are kept alongside the hits.
 */
function recordCalibration(report: Omit<CalibrationReport, 'runId'>): number {
  try {
    return store.calibrations.insert({
      at: Date.now(),
      device: report.device,
      quality: report.quality,
      silenceLevel: report.observed.silenceLevel,
      speechLevel: report.observed.speechLevel,
      separation: report.observed.separation,
      threshold: report.threshold,
      minNoiseFloor: report.minNoiseFloor,
      speechFactor: report.speechFactor,
      applied: false,
      samples: report.transcripts.map((t) => ({
        label: t.label,
        text: t.text,
        language: t.language,
        durationMs: t.durationMs,
      })),
    })
  } catch (err) {
    console.warn('[store] could not record calibration:', err)
    return 0
  }
}

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
      handler: () => {
        // BEFORE anything else. This is key-down, and the window in front right
        // now is the one the user means. Capturing at paste time instead would
        // deliver into whatever they alt-tabbed to while transcription ran.
        injector.captureTarget()
        dictation.send({ type: 'hotkey', now: Date.now() })
      },
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
    // Oldest first for the charts; SQL returns newest first because that is
    // what every other reader wants.
    dictations: store.dictations.recent(60).reverse(),
    resources: store.resources.recent(120),
    // Over the whole history, computed in SQL. The old version averaged
    // whatever happened to be in memory, so the headline figures quietly
    // described the tail rather than the record.
    summary: store.dictations.summary(),
    byAsrModel: store.dictations.meanAsrByModel(),
  }))

  ipcMain.handle(IPC.getDictationPage, (_e, offset: number, limit: number, query?: string) =>
    store.dictations.page(offset, limit, query)
  )

  ipcMain.handle(IPC.getStorage, () => store.stats())
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

  ipcMain.handle(IPC.copyDiagnostic, async (_e, at: number) => {
    const d = store.dictations.byAt(at)
    if (!d) return false
    // Awaited: Electron 44's clipboard is asynchronous, so returning true from
    // an unawaited write claims success before the write has happened.
    await clipboard.writeText(formatDiagnostic(d, d.id ?? 0, describeCalibration(settings.get())))
    return true
  })

  ipcMain.handle(IPC.exportDiagnostics, async (_e, withAudio: boolean) => {
    // Bounded: an export is meant to be read and pasted, and the whole history
    // could be thousands of transcripts.
    const all = store.dictations.recent(200)
    if (all.length === 0) return null

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Wouice diagnostics',
      defaultPath: `wouice-diagnostics-${stamp}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (canceled || !filePath) return null

    const snap = supervisor.snapshotAll()
    const md = formatSession(all, {
      app: app.getVersion(),
      electron: process.versions.electron,
      platform: `${process.platform} ${process.arch}`,
      models: snap.map((x) => `${x.id}=${x.modelId}`).join(' '),
      // Whether the levels below were measured or inherited. Without this,
      // "why did it not stop when I stopped talking?" is unanswerable from an
      // export alone: shipped defaults and a bad calibration look identical.
      levels: describeCalibration(settings.get()),
    })
    writeFileSync(filePath, md, 'utf8')

    if (withAudio) {
      // Alongside the markdown rather than inside it: audio next to the text
      // that describes it means one folder to zip and send.
      const dir = filePath.replace(/\.md$/, '') + '-audio'
      mkdirSync(dir, { recursive: true })
      for (const d of all) {
        if (!d.audioPath) continue
        try {
          copyFileSync(d.audioPath, path.join(dir, path.basename(d.audioPath)))
        } catch {
          // Pruned since it was recorded. The markdown still stands alone.
        }
      }
    }
    shell.showItemInFolder(filePath)
    return filePath
  })

  ipcMain.on(IPC.revealMetrics, () => shell.showItemInFolder(store.file))

  /**
   * Calibration. Analyses only; nothing is written until the user accepts.
   *
   * The speech threshold cannot ship as a constant: a value derived from one
   * microphone classified 70% of speech as silence on that very machine, and
   * anyone with a different mic or a quieter voice hits the same wall. So it is
   * measured here from the user's own voice.
   */
  ipcMain.handle(IPC.calibrate, async (_e, inputs: CalibrationInput[], device: string): Promise<CalibrationReport> => {
    const samples = inputs.map((i) => ({
      label: i.label,
      rms: frameLevels(Float32Array.from(i.pcm), (SAMPLE_RATE * FRAME_MS) / 1000),
    }))
    const result = analyseCalibration(samples)

    // Transcribe each prompt as well. The numbers say whether the gate will
    // work; only the text says whether the recognition is any good, and it is
    // the only place the "was my Hindi actually heard as Hindi?" question gets
    // a straight answer.
    const transcripts: CalibrationReport['transcripts'] = []
    if (supervisor.canServe('whisper')) {
      const asr = new WhisperCppClient({
        baseUrl: supervisor.baseUrl('whisper'),
        model: supervisor.snapshot('whisper').modelId,
      })
      for (const i of inputs) {
        try {
          const r = await asr.transcribe(Float32Array.from(i.pcm), { language: 'auto' })
          transcripts.push({
            label: i.label,
            text: r.text.trim(),
            language: r.language,
            durationMs: i.durationMs,
          })
        } catch (err) {
          transcripts.push({
            label: i.label,
            text: err instanceof Error ? err.message : 'transcription failed',
            language: 'unknown',
            durationMs: i.durationMs,
          })
        }
      }
    }

    const cfg = settings.get().silence
    const report: Omit<CalibrationReport, 'runId'> = {
      ...result,
      transcripts,
      previousThreshold: cfg.minNoiseFloor * cfg.speechFactor,
      device,
      notes: describeLanguages(
        samples.map((s) => ({
          ...s,
          language: transcripts.find((t) => t.label === s.label)?.language,
        }))
      ),
    }
    // Written now, before the user has decided anything. A run they looked at
    // and walked away from is the record of a microphone or a room that did not
    // work, and that is worth more than a history of successes only.
    return { ...report, runId: recordCalibration(report) }
  })

  ipcMain.handle(IPC.calibrateApply, (_e, report: CalibrationReport) => {
    if (report.quality === 'unusable') return
    if (report.runId) store.calibrations.markApplied(report.runId)
    const next = settings.set({
      silence: applyCalibration(settings.get().silence, report),
      calibration: {
        at: Date.now(),
        device: report.device,
        quality: report.quality,
        silenceLevel: report.observed.silenceLevel,
        speechLevel: report.observed.speechLevel,
        separation: report.observed.separation,
        languages: report.transcripts.map((t) => ({ label: t.label, detected: t.language })),
      },
    })
    broadcast(IPC.settingsChanged, next)
  })
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

    // Only now, holding the single-instance lock. The import RENAMES the old
    // log, so a second launch that is about to quit must never reach it: the
    // instance still running would lose the file it is appending to.
    try {
      const imported = importJsonl(store.db, path.join(app.getPath('userData'), 'metrics.jsonl'))
      if (imported.ran) {
        console.log(
          `[store] imported ${imported.dictations} dictation(s) and ${imported.resources} sample(s)` +
            (imported.malformed ? `, skipped ${imported.malformed} malformed line(s)` : '')
        )
      }
    } catch (err) {
      // The original is untouched by any failure here, so the next launch
      // simply tries again. Never a reason to refuse to start.
      console.warn('[store] could not import metrics.jsonl:', err)
    }

    if (!injectionAvailable()) {
      console.warn(
        `[injection] unavailable, falling back to clipboard only: ${injectionUnavailableReason()}`
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
    let samples = 0
    const sample = async (): Promise<void> => {
      const r = await sampleResources()
      try {
        store.resources.insert({ at: Date.now(), ...r })
        // This is the one table that grows on its own, so it is the one table
        // that trims itself. Hourly is often enough for a row every 15s.
        if (++samples % 240 === 0) store.resources.prune()
      } catch (err) {
        console.warn('[store] could not record sample:', err)
      }
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
    store.close()
  })
}
