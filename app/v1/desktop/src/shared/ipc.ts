import type { SidecarId } from './models.js'
import type { Settings } from './settings.js'
import type { DictationRecord, DictionaryRecord, Page, ResourceRecord, StoreStats } from '@wouice/store'

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
  getDictationPage: 'metrics:page',
  deleteDictations: 'metrics:delete',
  clearDictations: 'metrics:clear',
  getStorage: 'storage:stats',
  getDictionary: 'dictionary:list',
  addDictionaryEntry: 'dictionary:add',
  updateDictionaryEntry: 'dictionary:update',
  removeDictionaryEntry: 'dictionary:remove',
  getRecordings: 'recordings:list',
  deleteRecording: 'recordings:delete',
  clearRecordings: 'recordings:clear',
  copyDiagnostic: 'metrics:copyDiagnostic',
  exportDiagnostics: 'metrics:export',
  revealMetrics: 'metrics:reveal',
  calibrate: 'calibrate:run',
  calibrateApply: 'calibrate:apply',
  // renderer -> main: one 20ms frame of 16kHz mono Float32
  audioFrame: 'capture:frame',
  captureReady: 'capture:ready',
  captureFailed: 'capture:failed',
  cancelDictation: 'dictation:cancel',
  // The pet reports gestures; main does the moving. The renderer never knows
  // where on the desktop it is.
  petClick: 'pet:click',
  petDragStart: 'pet:dragStart',
  petDragEnd: 'pet:dragEnd',

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
  hudHover: 'hud:hover',
  hudDragging: 'hud:dragging',
  hudPlacement: 'hud:placement',
} as const

/** Which way the capsule opens, and whether there is a pet to open it from. */
export interface HudPlacement {
  side: 'left' | 'right'
  pet: boolean
}

/**
 * Record shapes come from `@wouice/store`, which is the thing that persists
 * them. Re-exported rather than redeclared: a second copy of a shape is exactly
 * how `SilenceConfig` ended up missing three fields on one side, bridged with a
 * cast, and silently breaking speech detection at runtime.
 *
 * Type-only, so the renderer never pulls `node:sqlite` into its bundle.
 */
export type {
  AppliedRule,
  CaptureDiagnostics,
  DictationRecord,
  Page,
  ResourceRecord,
  StoreStats,
  DictionaryRecord,
  CalibrationRecord as CalibrationRun,
} from '@wouice/store'

/** What the dashboard needs for its charts and headline figures. */
export interface MetricsSnapshot {
  /** Oldest first: the charts read left to right. */
  dictations: DictationRecord[]
  resources: ResourceRecord[]
  /** Computed over the WHOLE history in SQL, not over the slice above. */
  summary: {
    count: number
    p50Ms: number
    p95Ms: number
    degraded: number
    chars: number
  }
  byAsrModel: { model: string; meanMs: number; n: number }[]
}

export type CalibrationLabel = 'english' | 'hindi' | 'mixed'

/**
 * One recorded prompt, sent whole for analysis.
 *
 * Deliberately raw audio and nothing else. Levels are measured in main with the
 * same function the live silence gate uses, so a calibration can never be
 * computed against a slightly different measure than the one it is tuning.
 */
export interface CalibrationInput {
  label: CalibrationLabel
  /** The whole recording: 16 kHz mono Float32. */
  pcm: Float32Array
  /** Wall-clock length, for display. */
  durationMs: number
}

export interface CalibrationReport {
  minNoiseFloor: number
  speechFactor: number
  threshold: number
  quality: 'good' | 'weak' | 'unusable'
  reason: string
  observed: {
    frames: number
    silenceLevel: number
    speechLevel: number
    separation: number
    speechRatio: number
  }
  /** What the ASR made of each prompt, so accuracy is visible before committing. */
  transcripts: { label: CalibrationLabel; text: string; language: string; durationMs: number }[]
  /** The threshold that was in force before this run, for comparison. */
  previousThreshold: number
  /** Which microphone this was measured on. */
  device: string
  /** Row id of this run in the calibration history. 0 if it could not be stored. */
  runId: number
  /** Plain-English notes about language handling. */
  notes: string[]
}

export interface NewDictionaryEntry {
  kind: 'term' | 'correction'
  hear: string
  write: string
  enabled: boolean
}

export type DictionaryPatch = Partial<{ hear: string; write: string; enabled: boolean }>

/** One retained WAV, for the settings screen to list and delete. */
export interface RetainedAudio {
  file: string
  at: number
  bytes: number
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
  /** One page of history, newest first, with the total so pages can be counted. */
  getDictationPage(offset: number, limit: number, query?: string): Promise<Page<DictationRecord>>
  /**
   * Delete specific dictations, by the timestamps the table already keys on.
   * Their retained audio goes too. Returns how many rows were actually removed.
   */
  deleteDictations(ats: number[]): Promise<number>
  /** Delete every dictation and every retained recording. Returns the count. */
  clearDictations(): Promise<number>
  /** What is in the database: schema version, size, and per-table row counts. */
  getStorage(): Promise<StoreStats>
  getDictionary(): Promise<DictionaryRecord[]>
  /** Returns the problem when the entry was refused, or null when it was added. */
  addDictionaryEntry(entry: NewDictionaryEntry): Promise<string | null>
  updateDictionaryEntry(id: number, patch: DictionaryPatch): Promise<void>
  removeDictionaryEntry(id: number): Promise<void>
  getRecordings(): Promise<RetainedAudio[]>
  deleteRecording(file: string): Promise<void>
  clearRecordings(): Promise<void>
  /** Put one dictation's full diagnostic on the clipboard, ready to paste. */
  copyDiagnostic(at: number): Promise<boolean>
  /** Write a markdown export, optionally with the retained audio. Returns the path. */
  exportDiagnostics(withAudio: boolean): Promise<string | null>
  revealMetrics(): void
  /** Analyse recorded prompts. Does not change settings. */
  calibrate(samples: CalibrationInput[], device: string): Promise<CalibrationReport>
  /** Commit a calibration to settings. */
  calibrateApply(report: CalibrationReport): Promise<void>
  sendAudioFrame(sessionId: number, frame: Float32Array): void
  captureReady(sessionId: number): void
  captureFailed(sessionId: number, reason: string): void
  cancelDictation(): void
  /** Tapping the pet starts or stops a dictation, exactly like the hotkey. */
  petClick(): void
  petDragStart(): void
  petDragEnd(): void
  onHudHover(cb: (over: boolean) => void): () => void
  onHudDragging(cb: (dragging: boolean) => void): () => void
  onHudPlacement(cb: (p: HudPlacement) => void): () => void
  onStartCapture(cb: (sessionId: number, deviceId: string | null) => void): () => void
  onStopCapture(cb: (sessionId: number) => void): () => void
  onMetric(cb: () => void): () => void
  onDictationResult(cb: (r: DictationOutcome) => void): () => void
  onSidecarState(cb: (s: SidecarView) => void): () => void
  onSettingsChanged(cb: (s: Settings) => void): () => void
  onHudState(cb: (s: HudState) => void): () => void
  onHotkeyFailed(cb: (report: HotkeyReport) => void): () => void
}
