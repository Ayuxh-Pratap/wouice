import { useEffect, useState } from 'react'
import type { EngineView } from '../../shared/ipc.js'

/**
 * What is on the GPU and whether you can dictate, from the one place that
 * knows. Asked for on mount and then pushed, like the meeting jobs, so a
 * window opened halfway through a meeting's write-up shows it straight away.
 */
export function useEngine(): EngineView | null {
  const [view, setView] = useState<EngineView | null>(null)
  useEffect(() => {
    void window.wouice.getEngine().then(setView)
    return window.wouice.onEngine(setView)
  }, [])
  return view
}

/** "about 3 min left", "under a minute left". No false precision. */
export function leftLabel(sec: number | null): string | null {
  if (sec === null) return null
  if (sec < 45) return 'under a minute left'
  if (sec < 90) return 'about a minute left'
  return `about ${Math.round(sec / 60)} min left`
}

/** When dictation should be back, on the clock: "9:23 PM". */
export function backAt(sec: number | null): string | null {
  if (sec === null) return null
  return new Date(Date.now() + sec * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** 3,952 MiB as "3.9". */
export function gib(mib: number): string {
  return (mib / 1024).toFixed(1)
}
