import { useCallback, useEffect, useRef, useState } from 'react'
import type { HudPlacement, HudState } from '../../shared/ipc.js'
import type { Settings } from '../../shared/settings.js'
import { DEFAULT_CHARACTER, DEFAULT_PET_SIZE } from '../../shared/pet.js'
import { startMic, type MicSession } from '../capture/mic.js'
import { Bubble } from './Bubble.js'
import { ThoughtBubble } from './ThoughtBubble.js'
import { Pet } from './Pet.js'
import { holdMs, lookOf, outcomeParts, presentation, splitMessage } from './phase.js'
import { emptyWaveform, pushLevel, type Waveform } from './waveform.js'

/**
 * The dictation overlay: a pet on the desktop, and what it opens while working.
 *
 * CONTAINS NO FOCUSABLE CONTROLS, still. The window is created
 * `focusable: false` so it cannot take focus from the text field being dictated
 * into - that property is the reason the app works at all - and anything
 * needing focus would break insertion. It IS clickable now, which is a
 * different thing: spike V7 measured a click and a drag on this window leaving
 * both the foreground window and the caret untouched. Settings still live in
 * the main window.
 *
 * TWO SHAPES, AND THE PET DECIDES WHICH. With the character on screen, she
 * carries the state and the words beside her are only ever an outcome. With her
 * switched off, the readout has to stand on its own again - a single pill along
 * the bottom of the screen with the waveform, the state and the clock in it,
 * which is what this was before there was a pet. Someone who turned the
 * character off did not ask for a smaller character; they asked for none.
 *
 * MAIN DECIDES WHERE IT IS. This component reports a press, a move and a
 * release; it never positions anything and does not know where on the desktop
 * it sits. Keeping placement on one side of the bridge is what stops the window
 * and the drawing disagreeing about where the pet is.
 */

const DRAG_THRESHOLD = 4

export function Hud(): React.JSX.Element {
  const [state, setState] = useState<HudState>({ phase: 'idle', level: 0, elapsedMs: 0 })
  const [wave, setWave] = useState<Waveform>(emptyWaveform)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [placement, setPlacement] = useState<HudPlacement>({ side: 'right', pet: true })
  const [settings, setSettings] = useState<Settings | null>(null)
  const mic = useRef<MicSession | null>(null)

  useEffect(() => window.wouice.onHudHover(setHovered), [])
  useEffect(() => window.wouice.onHudDragging(setDragging), [])
  useEffect(() => window.wouice.onHudPlacement(setPlacement), [])
  // Which character to draw. The overlay reads settings for this one thing.
  useEffect(() => {
    void window.wouice.getSettings().then(setSettings)
    return window.wouice.onSettingsChanged(setSettings)
  }, [])

  /**
   * Levels arrive at 50 a second and fold into the waveform.
   *
   * The buffer only produces a new array once a bar is complete, so React
   * re-renders about seventeen times a second rather than fifty. This is drawn
   * on top of whatever someone is actually working in; it does not get to spend
   * three times the paints for a resolution nobody can see.
   */
  useEffect(
    () =>
      window.wouice.onHudState((next) => {
        setState(next)
        if (next.phase === 'listening') setWave((w) => pushLevel(w, next.level))
        // Cleared on the way IN to a new dictation, never on the way out: the
        // shape of what was just said stays up while it is being transcribed.
        if (next.phase === 'arming') setWave(emptyWaveform())
      }),
    []
  )

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

    // NOT the mechanism. This window is `focusable: false`, so it never has
    // keyboard focus and this can never fire; cancelling works because main
    // binds Escape globally for the length of a dictation. Kept only so the
    // key still does the right thing if the HUD ever becomes focusable.
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

  /**
   * Press, move, release - one gesture that is either a click or a drag.
   *
   * The distinction is made here because only this side knows how far the
   * pointer travelled between the two. Below the threshold it is a tap, which
   * starts a dictation exactly as the hotkey does; beyond it, main takes over
   * and follows the cursor. `setPointerCapture` keeps the events coming even
   * though the window is sliding out from under the pointer.
   */
  const origin = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)

  const onPointerDown = useCallback((e: React.PointerEvent): void => {
    if (e.button !== 0) return
    origin.current = { x: e.screenX, y: e.screenY }
    moved.current = false
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent): void => {
    const from = origin.current
    if (!from || moved.current) return
    if (Math.hypot(e.screenX - from.x, e.screenY - from.y) < DRAG_THRESHOLD) return
    moved.current = true
    window.wouice.petDragStart()
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent): void => {
    if (!origin.current) return
    origin.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // The pointer was already released, which is not a problem.
    }
    if (moved.current) window.wouice.petDragEnd()
    else window.wouice.petClick()
    moved.current = false
  }, [])

  const look = lookOf(state.phase)
  const { title, detail } = splitMessage(state.message, look.label)
  // The size and the reason are different kinds of thing and sit in different
  // places: one is a figure at the end of the line, the other a sentence.
  const { size, reason } = outcomeParts(detail)

  /**
   * The wait, counted here.
   *
   * `elapsedMs` comes with the level events, and those stop the moment
   * recording does - so the timer would vanish at exactly the point the wait
   * begins and becomes worth knowing about. This keeps counting from the phase
   * it entered.
   */
  const [waited, setWaited] = useState(0)
  useEffect(() => {
    if (!look.working) return
    const started = Date.now()
    setWaited(0)
    const t = setInterval(() => setWaited(Date.now() - started), 100)
    return () => clearInterval(t)
  }, [look.working, state.phase])

  /**
   * The clock, from the first frame of every busy state.
   *
   * It used to wait until nearly a second into thinking before appearing, so it
   * arrived out of nowhere partway through a wait. Starting at 0.0s means it is
   * simply always there while something is happening, and the eye has nothing
   * to catch on.
   */
  const seconds = look.live
    ? `${(state.elapsedMs / 1000).toFixed(1)}s`
    : look.working
      ? `${(waited / 1000).toFixed(1)}s`
      : null

  // A finished phase is on screen for a fixed hold, and the bubble is what
  // carries it; main returns the machine to idle on the same schedule.
  const hold = holdMs(state.phase)

  // The rule lives in `presentation`, with tests, because getting it wrong is
  // invisible: it renders nothing rather than something wrong.
  const shows = presentation(look, placement.pet)

  if (!placement.pet) {
    return (
      <div
        className="hud-root flex h-full w-full items-center justify-center overflow-hidden p-2"
        style={{ ['--hud-hold' as string]: `${hold}ms` }}
      >
        {shows === 'pill' && (
          <Bubble
            look={look}
            wave={wave}
            title={title}
            size={size}
            reason={reason}
            seconds={seconds}
            side={placement.side}
          />
        )}
      </div>
    )
  }

  return (
    <div
      className={[
        'hud-root flex h-full w-full items-center gap-2 overflow-hidden p-2',
        placement.side === 'left' ? 'flex-row' : 'flex-row-reverse',
      ].join(' ')}
      style={{ ['--hud-hold' as string]: `${hold}ms` }}
    >
      {/*
        Only the pet takes the pointer. The rest of this window is a transparent
        stage, and main keeps it click-through except while the cursor is
        genuinely inside the character's square.
      */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Click to dictate, drag to move"
        className={[
          'shrink-0',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        ].join(' ')}
      >
        <Pet
          character={settings?.pet.character ?? DEFAULT_CHARACTER}
          size={settings?.pet.size ?? DEFAULT_PET_SIZE}
          tone={look.tone}
          pose={look.pose}
          hovered={hovered}
          dragging={dragging}
        >
          {shows === 'thought' && (
            <ThoughtBubble look={look} wave={wave} reason={reason} side={placement.side} />
          )}
        </Pet>
      </div>

    </div>
  )
}
