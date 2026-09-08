import { useEffect, useRef, useState } from 'react'
import type { HudState } from '../shared/ipc.js'
import { startMic, type MicSession } from './capture/mic.js'

/**
 * The dictation overlay.
 *
 * Contains NO interactive controls, by rule. The window is created
 * `focusable: false` so it cannot steal focus from the text field being
 * dictated into, and anything needing focus would be dead UI at best and would
 * break insertion at worst. Settings live in the main window.
 */
const PHASE_LABEL: Record<HudState['phase'], string> = {
  idle: '',
  arming: 'Starting',
  listening: 'Listening',
  thinking: 'Thinking',
  inserted: 'Inserted',
  copied: 'Copied',
  error: 'Error',
}

/** Red means recording, and nothing else in the app is red. */
const PHASE_DOT: Record<HudState['phase'], string> = {
  idle: 'bg-neutral-600',
  arming: 'bg-amber-400',
  listening: 'bg-red-500',
  thinking: 'bg-amber-400',
  inserted: 'bg-emerald-400',
  copied: 'bg-sky-400',
  error: 'bg-red-600',
}

const BAR_COUNT = 28

export function Hud(): React.JSX.Element {
  const [state, setState] = useState<HudState>({ phase: 'idle', level: 0, elapsedMs: 0 })
  const mic = useRef<MicSession | null>(null)

  useEffect(() => window.wouice.onHudState(setState), [])

  /**
   * The HUD owns microphone capture.
   *
   * It is the one window that always exists, so capture never depends on
   * whether the dashboard happens to be open. Frames go straight to main, which
   * holds the state machine and the silence policy: keeping every decision on
   * one side of the bridge is what stops the two drifting apart.
   */
  useEffect(() => {
    const stop = async (): Promise<void> => {
      const session = mic.current
      mic.current = null
      await session?.stop()
    }

    const offStart = window.wouice.onStartCapture(async (sessionId, deviceId) => {
      await stop()
      try {
        mic.current = await startMic({
          onFrame: (frame) => window.wouice.sendAudioFrame(sessionId, frame),
          // Null means the system default, and following it is the point: a
          // headset plugged in mid-session should just work.
          ...(deviceId ? { deviceId } : {}),
        })
        window.wouice.captureReady(sessionId)
      } catch (err) {
        window.wouice.captureFailed(
          sessionId,
          err instanceof Error ? err.message : 'Could not open the microphone'
        )
      }
    })

    const offStop = window.wouice.onStopCapture(() => void stop())

    // Escape cancels from anywhere the HUD can see it.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.wouice.cancelDictation()
    }
    window.addEventListener('keydown', onKey)

    return () => {
      offStart()
      offStop()
      window.removeEventListener('keydown', onKey)
      void stop()
    }
  }, [])

  const active = state.phase !== 'idle'
  const seconds = (state.elapsedMs / 1000).toFixed(1)

  return (
    <div className="hud-root flex h-full w-full items-center justify-center overflow-hidden p-2">
      <div
        className={[
          'flex w-full items-center gap-3 rounded-2xl px-4 py-3',
          'bg-neutral-900/90 backdrop-blur-xl',
          'ring-1 ring-white/10 shadow-2xl shadow-black/50',
          'transition-opacity duration-150',
          active ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      >
        <span
          className={[
            'size-2.5 shrink-0 rounded-full',
            PHASE_DOT[state.phase],
            state.phase === 'listening' ? 'animate-pulse' : '',
          ].join(' ')}
        />

        <div className="flex h-7 min-w-0 flex-1 items-center gap-[3px] overflow-hidden">
          {Array.from({ length: BAR_COUNT }, (_, i) => {
            // A fixed shape modulated by level, so the meter reads as a voice
            // rather than a random flicker. Purely cosmetic until capture lands.
            const falloff = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2)
            const height = active ? 3 + state.level * 26 * (0.35 + falloff * 0.65) : 3
            return (
              <span
                key={i}
                className="w-[3px] shrink-0 rounded-full bg-neutral-300/80 transition-[height] duration-75"
                style={{ height: `${height}px` }}
              />
            )
          })}
        </div>

        {/* max-w plus truncate: a long status like "Copied - 2182 chars" must
            shrink rather than push the meter out of a fixed-size window. */}
        <div className="max-w-[7.5rem] shrink-0 text-right">
          <div className="truncate text-[11px] font-medium leading-tight text-neutral-200">
            {state.message ?? PHASE_LABEL[state.phase]}
          </div>
          {state.phase === 'listening' && (
            <div className="font-mono text-[10px] leading-tight text-neutral-500">{seconds}s</div>
          )}
        </div>
      </div>
    </div>
  )
}
