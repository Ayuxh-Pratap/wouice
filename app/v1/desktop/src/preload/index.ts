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
  // Float32Array crosses the bridge as a structured clone. At 16 kHz that is
  // ~64 KB/s, which is nothing, and it keeps ALL decision logic in main where
  // the state machine lives rather than splitting it across the bridge.
  sendAudioFrame: (sessionId: number, frame: Float32Array) =>
    ipcRenderer.send(IPC.audioFrame, sessionId, frame),
  captureReady: (sessionId: number) => ipcRenderer.send(IPC.captureReady, sessionId),
  captureFailed: (sessionId: number, reason: string) =>
    ipcRenderer.send(IPC.captureFailed, sessionId, reason),
  cancelDictation: () => ipcRenderer.send(IPC.cancelDictation),
  onStartCapture: (cb) => subscribe<number>(IPC.startCapture, cb),
  onStopCapture: (cb) => subscribe<number>(IPC.stopCapture, cb),
  onMetric: (cb) => subscribe<void>(IPC.metric, cb),
  onDictationResult: (cb) => subscribe<DictationOutcome>(IPC.dictationResult, cb),
  onSidecarState: (cb) => subscribe<SidecarView>(IPC.sidecarState, cb),
  onSettingsChanged: (cb) => subscribe<Settings>(IPC.settingsChanged, cb),
  onHudState: (cb) => subscribe<HudState>(IPC.hudState, cb),
  onHotkeyFailed: (cb) => subscribe<HotkeyReport>(IPC.hotkeyFailed, cb),
}

contextBridge.exposeInMainWorld('wouice', api)
