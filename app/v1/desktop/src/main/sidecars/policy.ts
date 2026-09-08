/**
 * Pure supervisor decisions. No spawning, no timers, no Electron.
 *
 * Everything here is a function of (state, event) with no side effects, which
 * is what makes restart storms, backoff and the switch-queueing rule testable
 * without a GPU or a 1.7 GB model load.
 */

export type SidecarStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'failed'

export interface SidecarState {
  status: SidecarStatus
  modelId: string
  /** Consecutive unexpected exits. Reset by a successful health check. */
  failures: number
  /** A model switch requested while the pipeline was busy, applied when idle. */
  pendingModelId: string | null
  /** True while a dictation is mid-flight and the sidecar must not be touched. */
  busy: boolean
  lastError: string | null
}

export function initialState(modelId: string): SidecarState {
  return {
    status: 'stopped',
    modelId,
    failures: 0,
    pendingModelId: null,
    busy: false,
    lastError: null,
  }
}

/**
 * Exponential backoff, capped.
 *
 * A sidecar that cannot start (a corrupt model, a port permanently taken, CUDA
 * gone) must not be respawned in a tight loop: that pins a CPU core and floods
 * the log until nobody can read it. The cap keeps retrying forever without the
 * storm, because the cause is often transient (a GPU busy with another app).
 */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const
export const BACKOFF_CAP_MS = 30_000

export function backoffFor(failures: number): number {
  if (failures <= 0) return 0
  return BACKOFF_MS[failures - 1] ?? BACKOFF_CAP_MS
}

/** Give up announcing "restarting" and call it failed after this many tries. */
export const FAILURE_THRESHOLD = 5

export type SupervisorAction =
  | { type: 'none' }
  | { type: 'spawn'; modelId: string }
  | { type: 'kill' }
  /** Stop, then spawn with the new model. */
  | { type: 'restart'; modelId: string }
  | { type: 'scheduleRespawn'; delayMs: number }

/**
 * A model switch requested by the user.
 *
 * RULE: never switch mid-utterance. A flip during recording is queued and
 * applied when the pipeline goes idle, so an in-flight transcription always
 * completes on the model that started it. Switching underneath a running
 * request would either kill the utterance the user already spoke, or return
 * text from a model they did not choose, and both are worse than a short wait.
 */
export function requestSwitch(
  state: SidecarState,
  modelId: string
): { state: SidecarState; action: SupervisorAction } {
  if (modelId === state.modelId && state.pendingModelId === null) {
    return { state, action: { type: 'none' } }
  }
  if (state.busy) {
    return { state: { ...state, pendingModelId: modelId }, action: { type: 'none' } }
  }
  return {
    state: { ...state, modelId, pendingModelId: null, failures: 0, lastError: null, status: 'restarting' },
    action: { type: 'restart', modelId },
  }
}

/** The pipeline finished, so any queued switch can now be applied. */
export function markIdle(state: SidecarState): {
  state: SidecarState
  action: SupervisorAction
} {
  const idle = { ...state, busy: false }
  if (idle.pendingModelId === null) return { state: idle, action: { type: 'none' } }
  return requestSwitch(idle, idle.pendingModelId)
}

export function markBusy(state: SidecarState): SidecarState {
  return { ...state, busy: true }
}

/** The process exited when we did not ask it to. */
export function onUnexpectedExit(
  state: SidecarState,
  detail: string
): { state: SidecarState; action: SupervisorAction } {
  const failures = state.failures + 1
  const next: SidecarState = {
    ...state,
    failures,
    lastError: detail,
    busy: false,
    status: failures >= FAILURE_THRESHOLD ? 'failed' : 'restarting',
  }
  return { state: next, action: { type: 'scheduleRespawn', delayMs: backoffFor(failures) } }
}

/** Health check passed: the sidecar is genuinely serving. */
export function onHealthy(state: SidecarState): SidecarState {
  return { ...state, status: 'ready', failures: 0, lastError: null }
}

export function onStarting(state: SidecarState): SidecarState {
  return { ...state, status: 'starting', lastError: null }
}

export function onStopped(state: SidecarState): SidecarState {
  return { ...state, status: 'stopped', busy: false, failures: 0, lastError: null }
}

/**
 * Whether a request may be sent right now.
 *
 * Deliberately excludes 'starting': a model load takes seconds and an HTTP call
 * during it fails in a confusing way. Callers wait for 'ready'.
 */
export function canServe(state: SidecarState): boolean {
  return state.status === 'ready'
}
