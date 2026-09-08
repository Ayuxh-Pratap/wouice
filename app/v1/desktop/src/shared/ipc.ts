import type { SidecarId } from './models.js'
import type { Settings } from './settings.js'

/**
 * The IPC surface, typed in one place so main and renderer cannot drift.
 *
 * Channel names are string constants rather than inline literals precisely
 * because a typo in one of two places is a silent no-op that is miserable to
 * track down.
 */
export const IPC = {
  // renderer -> main, request/response
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  getSidecars: 'sidecars:get',
  switchModel: 'sidecars:switchModel',
  restartSidecar: 'sidecars:restart',
  getDiagnostics: 'app:diagnostics',
  hideHud: 'hud:hide',
  getMetrics: 'metrics:get',
  copyDiagnostic: 'metrics:copyDiagnostic',
  exportDiagnostics: 'metrics:export',
  revealMetrics: 'metrics:reveal',
  // renderer -> main: one 20ms frame of 16kHz mono Float32
  audioFrame: 'capture:frame',
  captureReady: 'capture:ready',
  captureFailed: 'capture:failed',
  cancelDictation: 'dictation:cancel',

  // main -> renderer, push
  sidecarState: 'sidecars:state',
  settingsChanged: 'settings:changed',
  hudState: 'hud:state',
  hotkeyFailed: 'hotkey:failed',
  // main -> renderer: open/close the mic for this session
  startCapture: 'capture:start',
  stopCapture: 'capture:stop',
  metric: 'metrics:new',
  dictationResult: 'dictation:result',
} as const

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
  /** Every stage of the text, for developer mode. Absent on older records. */
  stages?: {
    raw: string
    corrected: string
    sent: { system: string; user: string }
    received: string
    applied: { from: string; to: string; count: number }[]
  }
  capture?: CaptureDiagnostics
  audioPath?: string | null
}

/** Why the recording ended, and what the audio looked like. */
export interface CaptureDiagnostics {
  stoppedBy: 'silence' | 'hotkey' | 'cap' | 'unknown'
  speechMs: number
  silenceMs: number
  longestPauseMs: number
  windowMs: number
  chunkAfterMs: number
  chunkPauseMs: number
  peakRms?: number
  meanSpeechRms?: number
  thresholdRms?: number
}

export interface ResourceMetric {
  kind: 'resource'
  at: number
  vramUsedMiB: number
  vramTotalMiB: number
  rssMiB: number
}

export interface MetricsSnapshot {
  dictations: DictationMetric[]
  resources: ResourceMetric[]
}

export interface DictationOutcome {
  final: string
  raw: string
  language: string
  asrMs: number
  llmMs: number
  degraded: string | null
  delivered: 'copied' | 'inserted'
}

/** What the HUD is showing. Mirrors the dictation state machine in spec 6.2. */
export type HudPhase = 'idle' | 'arming' | 'listening' | 'thinking' | 'inserted' | 'copied' | 'error'

export interface HudState {
  phase: HudPhase
  /** 0..1 smoothed mic level, drives the meter. */
  level: number
  elapsedMs: number
  message?: string
}

export interface SidecarView {
  id: SidecarId
  status: string
  modelId: string
  pendingModelId: string | null
  port: number
  pid: number | null
  lastError: string | null
}

export interface HotkeyReport {
  name: string
  /** null when nothing in the chain could be claimed. */
  accelerator: string | null
  requested: string
  substituted: boolean
  rejected: string[]
}

export interface Diagnostics {
  sidecarRoot: string
  modelRoot: string
  userData: string
  hotkeyRegistered: Record<string, boolean>
  hotkeys: HotkeyReport[]
  platform: string
  electron: string
}

/** Shape exposed on `window.wouice` by the preload bridge. */
export interface WouiceApi {
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  getSidecars(): Promise<SidecarView[]>
  switchModel(id: SidecarId, modelId: string): Promise<void>
  restartSidecar(id: SidecarId): Promise<void>
  getDiagnostics(): Promise<Diagnostics>
  hideHud(): void
  getMetrics(): Promise<MetricsSnapshot>
  /** Put one dictation's full diagnostic on the clipboard, ready to paste. */
  copyDiagnostic(at: number): Promise<boolean>
  /** Write a markdown export, optionally with the retained audio. Returns the path. */
  exportDiagnostics(withAudio: boolean): Promise<string | null>
  revealMetrics(): void
  sendAudioFrame(sessionId: number, frame: Float32Array): void
  captureReady(sessionId: number): void
  captureFailed(sessionId: number, reason: string): void
  cancelDictation(): void
  onStartCapture(cb: (sessionId: number) => void): () => void
  onStopCapture(cb: (sessionId: number) => void): () => void
  onMetric(cb: () => void): () => void
  onDictationResult(cb: (r: DictationOutcome) => void): () => void
  onSidecarState(cb: (s: SidecarView) => void): () => void
  onSettingsChanged(cb: (s: Settings) => void): () => void
  onHudState(cb: (s: HudState) => void): () => void
  onHotkeyFailed(cb: (report: HotkeyReport) => void): () => void
}
