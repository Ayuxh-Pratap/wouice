import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type Diagnostics,
  type DictationOutcome,
  type HotkeyReport,
  type HudState,
  type MetricsSnapshot,
  type SidecarView,
  type WouiceApi,
} from '../shared/ipc.js'
import type { Settings } from '../shared/settings.js'
import type { SidecarId } from '../shared/models.js'

/**
 * The only bridge between renderer and main.
 *
 * Context isolation is on and nodeIntegration off, so the renderer gets exactly
 * these functions and nothing else. Every subscription returns its own
 * unsubscribe, because a React effect that cannot clean up leaks a listener per
 * remount and those are invisible until the app is slow.
 */
function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: unknown, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: WouiceApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.setSettings, patch),
  getSidecars: () => ipcRenderer.invoke(IPC.getSidecars),
  switchModel: (id: SidecarId, modelId: string) => ipcRenderer.invoke(IPC.switchModel, id, modelId),
  restartSidecar: (id: SidecarId) => ipcRenderer.invoke(IPC.restartSidecar, id),
  getDiagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke(IPC.getDiagnostics),
  hideHud: () => ipcRenderer.send(IPC.hideHud),
  getMetrics: (): Promise<MetricsSnapshot> => ipcRenderer.invoke(IPC.getMetrics),
  getDictationPage: (offset, limit, query) =>
    ipcRenderer.invoke(IPC.getDictationPage, offset, limit, query),
  deleteDictations: (ats: number[]) => ipcRenderer.invoke(IPC.deleteDictations, ats),
  clearDictations: () => ipcRenderer.invoke(IPC.clearDictations),
  getStorage: () => ipcRenderer.invoke(IPC.getStorage),
  getDictionary: () => ipcRenderer.invoke(IPC.getDictionary),
  addDictionaryEntry: (entry) => ipcRenderer.invoke(IPC.addDictionaryEntry, entry),
  updateDictionaryEntry: (id, patch) => ipcRenderer.invoke(IPC.updateDictionaryEntry, id, patch),
  removeDictionaryEntry: (id) => ipcRenderer.invoke(IPC.removeDictionaryEntry, id),
  getRecordings: () => ipcRenderer.invoke(IPC.getRecordings),
  deleteRecording: (file) => ipcRenderer.invoke(IPC.deleteRecording, file),
  clearRecordings: () => ipcRenderer.invoke(IPC.clearRecordings),
  copyDiagnostic: (at: number): Promise<boolean> => ipcRenderer.invoke(IPC.copyDiagnostic, at),
  exportDiagnostics: (withAudio: boolean): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportDiagnostics, withAudio),
  revealMetrics: () => ipcRenderer.send(IPC.revealMetrics),
  calibrate: (samples, device) => ipcRenderer.invoke(IPC.calibrate, samples, device),
  calibrateApply: (report) => ipcRenderer.invoke(IPC.calibrateApply, report),
  // Float32Array crosses the bridge as a structured clone. At 16 kHz that is
  // ~64 KB/s, which is nothing, and it keeps ALL decision logic in main where
  // the state machine lives rather than splitting it across the bridge.
  sendAudioFrame: (sessionId: number, frame: Float32Array) =>
    ipcRenderer.send(IPC.audioFrame, sessionId, frame),
  captureReady: (sessionId: number) => ipcRenderer.send(IPC.captureReady, sessionId),
  captureFailed: (sessionId: number, reason: string) =>
    ipcRenderer.send(IPC.captureFailed, sessionId, reason),
  cancelDictation: () => ipcRenderer.send(IPC.cancelDictation),
  onStartCapture: (cb) => {
    // Two arguments, so this cannot use `subscribe`: the microphone travels
    // with the message rather than being fetched separately, which is what
    // guarantees the device in force is the one settings named.
    const handler = (_e: unknown, sessionId: number, deviceId: string | null): void =>
      cb(sessionId, deviceId)
    ipcRenderer.on(IPC.startCapture, handler)
    return () => ipcRenderer.removeListener(IPC.startCapture, handler)
  },
  onStopCapture: (cb) => subscribe<number>(IPC.stopCapture, cb),
  onMetric: (cb) => subscribe<void>(IPC.metric, cb),
  onDictationResult: (cb) => subscribe<DictationOutcome>(IPC.dictationResult, cb),
  onSidecarState: (cb) => subscribe<SidecarView>(IPC.sidecarState, cb),
  onSettingsChanged: (cb) => subscribe<Settings>(IPC.settingsChanged, cb),
  onHudState: (cb) => subscribe<HudState>(IPC.hudState, cb),
  onHotkeyFailed: (cb) => subscribe<HotkeyReport>(IPC.hotkeyFailed, cb),
}

contextBridge.exposeInMainWorld('wouice', api)
