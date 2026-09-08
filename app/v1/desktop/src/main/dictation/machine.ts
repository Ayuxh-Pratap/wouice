/**
 * The dictation state machine. Pure.
 *
 * Owns the answer to "what happens when the hotkey fires right now", which is
 * different in every state and is exactly the kind of logic that rots into
 * scattered booleans if it is not written down once.
 *
 *   Idle ──hotkey──> Arming ──mic ready──> Listening
 *                      │                      │
 *                      │ mic fail             ├── hotkey ────────> Transcribing
 *                      ▼                      ├── silence* ──────> Transcribing
 *                    Error                    ├── 5 min cap ─────> Transcribing
 *                      │ 3s                   └── Escape ────────> Idle (discard)
 *                      ▼
 *                    Idle        Transcribing ──ok──> Delivering ──> Idle
 *                                     │ Escape ───────────────────> Idle (discard)
 *                                     │ fail ─────────────────────> Error
 *
 * `*` The silence window is adaptive, see capture/silence-policy.ts.
 */

export type Phase =
  | 'idle'
  | 'arming'
  | 'listening'
  | 'transcribing'
  | 'delivering'
  | 'error'

export interface DictationState {
  phase: Phase
  /** Monotonically increasing; stamps every async result so late ones can be dropped. */
  sessionId: number
  startedAt: number | null
  /** Chunks already sent for transcription during this session. */
  chunksSent: number
  message: string | null
}

export function initialDictationState(): DictationState {
  return { phase: 'idle', sessionId: 0, startedAt: null, chunksSent: 0, message: null }
}

export type DictationEvent =
  | { type: 'hotkey'; now: number }
  | { type: 'micReady' }
  | { type: 'micFailed'; reason: string }
  | { type: 'silenceStop' }
  | { type: 'capStop' }
  | { type: 'chunkEmitted' }
  | { type: 'escape' }
  | { type: 'transcribed' }
  | { type: 'delivered' }
  | { type: 'failed'; reason: string }
  | { type: 'errorTimeout' }

export type DictationAction =
  | { type: 'none' }
  | { type: 'startCapture'; sessionId: number }
  | { type: 'stopCapture'; sessionId: number }
  /** Stop capture and throw away everything: the user cancelled. */
  | { type: 'discard'; sessionId: number }
  | { type: 'flushChunk'; sessionId: number }
  /** Everything recorded is in; run the tail and the LLM pass. */
  | { type: 'finish'; sessionId: number }
  | { type: 'scheduleErrorClear'; delayMs: number }

export const ERROR_VISIBLE_MS = 3_000

export function reduce(
  state: DictationState,
  event: DictationEvent
): { state: DictationState; action: DictationAction } {
  switch (state.phase) {
    case 'idle':
      if (event.type === 'hotkey') {
        const sessionId = state.sessionId + 1
        return {
          state: { phase: 'arming', sessionId, startedAt: event.now, chunksSent: 0, message: null },
          action: { type: 'startCapture', sessionId },
        }
      }
      return { state, action: { type: 'none' } }

    case 'arming':
      if (event.type === 'micReady') {
        return { state: { ...state, phase: 'listening' }, action: { type: 'none' } }
      }
      if (event.type === 'micFailed') {
        return {
          state: { ...state, phase: 'error', message: event.reason },
          action: { type: 'scheduleErrorClear', delayMs: ERROR_VISIBLE_MS },
        }
      }
      // A second hotkey press while the mic is still opening cancels, rather
      // than queueing a session the user has already changed their mind about.
      if (event.type === 'hotkey' || event.type === 'escape') {
        return {
          state: { ...initialDictationState(), sessionId: state.sessionId },
          action: { type: 'discard', sessionId: state.sessionId },
        }
      }
      return { state, action: { type: 'none' } }

    case 'listening':
      if (event.type === 'hotkey' || event.type === 'silenceStop' || event.type === 'capStop') {
        return {
          state: { ...state, phase: 'transcribing' },
          action: { type: 'finish', sessionId: state.sessionId },
        }
      }
      if (event.type === 'chunkEmitted') {
        return {
          state: { ...state, chunksSent: state.chunksSent + 1 },
          action: { type: 'flushChunk', sessionId: state.sessionId },
        }
      }
      if (event.type === 'escape') {
        return {
          state: { ...initialDictationState(), sessionId: state.sessionId },
          action: { type: 'discard', sessionId: state.sessionId },
        }
      }
      return { state, action: { type: 'none' } }

    case 'transcribing':
      if (event.type === 'transcribed') {
        return { state: { ...state, phase: 'delivering' }, action: { type: 'none' } }
      }
      if (event.type === 'failed') {
        return {
          state: { ...state, phase: 'error', message: event.reason },
          action: { type: 'scheduleErrorClear', delayMs: ERROR_VISIBLE_MS },
        }
      }
      if (event.type === 'escape') {
        // Bumping sessionId is what makes cancellation actually work: an
        // in-flight ASR or LLM result arriving later carries the old id and is
        // dropped rather than pasted into whatever is focused by then.
        return {
          state: { ...initialDictationState(), sessionId: state.sessionId + 1 },
          action: { type: 'discard', sessionId: state.sessionId },
        }
      }
      // A hotkey press while already transcribing is ignored, NOT queued. The
      // user pressing again usually means "hurry up", and starting a second
      // session on top of the first is never what they wanted.
      return { state, action: { type: 'none' } }

    case 'delivering':
      if (event.type === 'delivered') {
        return {
          state: { ...initialDictationState(), sessionId: state.sessionId },
          action: { type: 'none' },
        }
      }
      if (event.type === 'failed') {
        return {
          state: { ...state, phase: 'error', message: event.reason },
          action: { type: 'scheduleErrorClear', delayMs: ERROR_VISIBLE_MS },
        }
      }
      return { state, action: { type: 'none' } }

    case 'error':
      if (event.type === 'errorTimeout' || event.type === 'escape') {
        return {
          state: { ...initialDictationState(), sessionId: state.sessionId },
          action: { type: 'none' },
        }
      }
      // Pressing the hotkey while an error is showing starts fresh immediately,
      // rather than making the user wait out the message.
      if (event.type === 'hotkey') {
        const sessionId = state.sessionId + 1
        return {
          state: { phase: 'arming', sessionId, startedAt: event.now, chunksSent: 0, message: null },
          action: { type: 'startCapture', sessionId },
        }
      }
      return { state, action: { type: 'none' } }
  }
}

/** Whether audio frames should currently be accepted. */
export function isCapturing(state: DictationState): boolean {
  return state.phase === 'arming' || state.phase === 'listening'
}

/** Whether a sidecar restart must wait, per decision A8c. */
export function isBusy(state: DictationState): boolean {
  return state.phase !== 'idle' && state.phase !== 'error'
}
