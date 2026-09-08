import { useCallback, useEffect, useRef, useState } from 'react'
import { startMic, type MicSession } from '../capture/mic.js'

/**
 * Recording for calibration, deliberately separate from the dictation path.
 *
 * Dictation capture is driven by main: main opens the mic, main runs the state
 * machine, main decides when speech stopped. None of that applies here. A
 * calibration recording must be exactly what the user chose to record - no
 * silence gate, no auto-stop on a pause, no chunking - because the pauses ARE
 * the signal being measured. Routing these frames through the pipeline would
 * mean calibrating the gate with the gate already applied.
 *
 * So this window opens its own microphone and keeps every frame.
 */

/** Long enough that a threshold means something; three of these clears 250 frames. */
export const MIN_RECORD_MS = 3_000
/** Nobody needs more than this to say one sentence, and it bounds memory. */
export const MAX_RECORD_MS = 30_000

const FRAME_MS = 20

export interface Recording {
  pcm: Float32Array
  durationMs: number
}

export interface Recorder {
  active: boolean
  /** 0..1, smoothed, for the meter only. Never used for the calibration itself. */
  level: number
  elapsedMs: number
  error: string | null
  device: string
  start(): Promise<void>
  stop(): Recording | null
}

/** Meter only. The calibration measure lives in main, next to the live gate. */
function frameLevel(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += (frame[i] ?? 0) ** 2
  return Math.sqrt(sum / frame.length)
}

export function useRecorder(): Recorder {
  const [active, setActive] = useState(false)
  const [level, setLevel] = useState(0)
  const [elapsedMs, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [device, setDevice] = useState('')

  const mic = useRef<MicSession | null>(null)
  const frames = useRef<Float32Array[]>([])
  const smoothed = useRef(0)

  const close = useCallback(async (): Promise<void> => {
    const session = mic.current
    mic.current = null
    await session?.stop()
  }, [])

  // The mic must not stay open if this panel unmounts mid-recording.
  useEffect(() => () => void close(), [close])

  const start = useCallback(async (): Promise<void> => {
    await close()
    frames.current = []
    smoothed.current = 0
    setError(null)
    setElapsed(0)
    setLevel(0)
    try {
      mic.current = await startMic({
        onFrame: (frame) => {
          frames.current.push(frame)
          // Attack fast, decay slow: a meter that tracks rms directly reads as
          // a flicker rather than a voice.
          const v = frameLevel(frame)
          const s = smoothed.current
          smoothed.current = v > s ? v : s * 0.88 + v * 0.12
          setLevel(Math.min(1, smoothed.current * 12))
          setElapsed(frames.current.length * FRAME_MS)
        },
      })
      setDevice(mic.current.deviceLabel)
      setActive(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the microphone')
    }
  }, [close])

  const stop = useCallback((): Recording | null => {
    void close()
    setActive(false)
    setLevel(0)
    const collected = frames.current
    frames.current = []
    if (collected.length === 0) return null

    const total = collected.reduce((n, f) => n + f.length, 0)
    const pcm = new Float32Array(total)
    let at = 0
    for (const f of collected) {
      pcm.set(f, at)
      at += f.length
    }
    return { pcm, durationMs: collected.length * FRAME_MS }
  }, [close])

  return { active, level, elapsedMs, error, device, start, stop }
}
