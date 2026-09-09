import { useEffect, useRef } from 'react'
import type { MeetingState } from '../../shared/ipc.js'
import { startMic, type MicSession } from '../capture/mic.js'
import { startSystemAudio, type SystemAudioSession } from '../capture/system.js'

/**
 * Open and close the two audio streams to match whatever main says the phase is.
 *
 * THE WINDOW FOLLOWS, IT DOES NOT DECIDE. Main owns whether a meeting is
 * running; this reacts. That is what lets automatic detection start a meeting
 * later without a second capture path - the mic-watcher will set the same phase
 * this is already watching, and nothing here changes.
 *
 * ONE CHANNEL FAILING IS NOT THE MEETING FAILING. A refused microphone still
 * leaves the far side recorded and a machine with no loopback still records
 * you, so each stream is opened independently and its own failure is reported
 * against its own channel. `Promise.all` would throw away the good half.
 */
export function useMeetingCapture(state: MeetingState | null): void {
  const mic = useRef<MicSession | null>(null)
  const system = useRef<SystemAudioSession | null>(null)
  /** Session ids already acted on, so a re-render cannot double-open. */
  const opened = useRef(0)
  const closed = useRef(0)

  useEffect(() => {
    if (!state) return
    const { phase, sessionId } = state

    if (phase === 'starting' && opened.current !== sessionId) {
      opened.current = sessionId
      void open(sessionId)
    }
    if ((phase === 'stopping' || phase === 'idle') && opened.current === sessionId) {
      if (closed.current === sessionId) return
      closed.current = sessionId
      void close(sessionId)
    }

    async function open(id: number): Promise<void> {
      const [micResult, systemResult] = await Promise.allSettled([
        startMic({ onFrame: (frame) => window.wouice.sendMeetingFrame(id, 'me', frame) }),
        startSystemAudio((frame) => window.wouice.sendMeetingFrame(id, 'them', frame)),
      ])

      if (micResult.status === 'fulfilled') mic.current = micResult.value
      else window.wouice.meetingFailed(id, 'me', reasonOf(micResult.reason))

      if (systemResult.status === 'fulfilled') system.current = systemResult.value
      else window.wouice.meetingFailed(id, 'them', reasonOf(systemResult.reason))

      window.wouice.meetingReady(id)
    }

    async function close(id: number): Promise<void> {
      // Both are stopped even if one throws: a stream left open holds the
      // microphone indicator on and keeps Windows in communications mode.
      await Promise.allSettled([mic.current?.stop(), system.current?.stop()])
      mic.current = null
      system.current = null
      window.wouice.meetingClosed(id)
    }
  }, [state])

  // Leaving the page, or closing the window, must not leave a stream running.
  useEffect(() => {
    return () => {
      void mic.current?.stop()
      void system.current?.stop()
      mic.current = null
      system.current = null
    }
  }, [])
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) {
    // `NotAllowedError` on its own tells the person nothing about which of the
    // two things they refused, and the message usually does.
    return err.message || err.name
  }
  return String(err)
}
