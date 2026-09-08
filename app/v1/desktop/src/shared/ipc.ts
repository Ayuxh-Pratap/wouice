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

  // main -> renderer, push
  sidecarState: 'sidecars:state',
  settingsChanged: 'settings:changed',
  hudState: 'hud:state',
  hotkeyFailed: 'hotkey:failed',
} as const

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
  onSidecarState(cb: (s: SidecarView) => void): () => void
  onSettingsChanged(cb: (s: Settings) => void): () => void
  onHudState(cb: (s: HudState) => void): () => void
  onHotkeyFailed(cb: (report: HotkeyReport) => void): () => void
}
