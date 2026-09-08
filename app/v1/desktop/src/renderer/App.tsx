import { useEffect, useRef, useState } from 'react'
import type { HotkeyReport } from '../shared/ipc.js'
import type { Settings } from '../shared/settings.js'
import { DashboardPage } from './pages/DashboardPage.js'
import { DictationsPage } from './pages/DictationsPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { Sidebar } from './shell/Sidebar.js'
import { parseHash, routeById, type ParsedRoute } from './shell/routes.js'
import { clampZoom, stepZoom } from '../shared/settings.js'

/**
 * The main window: an inset layout.
 *
 * The rail has no surface of its own - it sits directly on the application
 * ground, sharing its colour - and the content is the single raised panel,
 * inset with padding all round. The separation comes from one step of
 * lightness in one place, rather than from two panels and a gap, which reads
 * as two competing documents.
 *
 * NO FIXED HEADER. The page title scrolls with its content, because a bar
 * pinned across the top costs the same height on every screen and earns it on
 * none - there is nothing in it you need while reading row forty of a table.
 *
 * Nothing lives in the chrome that is really a setting, either. An earlier
 * version put the insertion toggle and the calibration status up there; both
 * are things you touch once and then leave alone for weeks, and neither
 * deserved permanent residence. They are in Settings, where you would go
 * looking for them.
 *
 * THERE IS NO TITLE BAR. The native Windows caption sat above all of this in a
 * different colour scheme entirely, so the window read as our interface running
 * inside somebody else's frame; replacing it with a strip of our own across the
 * full width was not much better, because the app's name then belonged to the
 * strip rather than to the rail underneath it.
 *
 * So the rail runs to the top of the window and carries the wordmark itself,
 * and this column reserves the same band of height for the three buttons
 * Windows still draws on the right. Both read `--band`, which is what keeps the
 * wordmark and the top of the panel on one line. The band is a drag handle;
 * the buttons in it are native, because reimplementing them loses the Windows 11
 * snap-layouts flyout and every accessibility affordance and gains nothing.
 *
 * Routing is the hash, with no router dependency. It is about forty lines, it
 * gives back and forward for free, and the renderer was already reading the
 * hash to tell this window from the HUD.
 */

const COLLAPSE_KEY = 'wouice.sidebar.collapsed'

function useHashRoute(): ParsedRoute {
  const [route, setRoute] = useState<ParsedRoute>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function App(): React.JSX.Element {
  const { id: route, query } = useHashRoute()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [hotkeyIssue, setHotkeyIssue] = useState<HotkeyReport | null>(null)
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem(COLLAPSE_KEY) === '1'
  )

  useEffect(() => {
    void window.wouice.getSettings().then(setSettings)
    const offSettings = window.wouice.onSettingsChanged(setSettings)
    const offHotkey = window.wouice.onHotkeyFailed(setHotkeyIssue)
    return () => {
      offSettings()
      offHotkey()
    }
  }, [])

  const toggleSidebar = (): void => {
    setCollapsed((was) => {
      const next = !was
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
      } catch {
        // A private window or blocked storage. The toggle still works for now.
      }
      return next
    })
  }

  /**
   * Ctrl+= / Ctrl+- / Ctrl+0, because that is the gesture people already have.
   *
   * The keystroke writes the SETTING rather than calling a zoom API directly,
   * so the shortcut and the settings screen cannot disagree about the current
   * scale, and the choice survives a restart. Electron's own zoom accelerators
   * are deliberately not used for the same reason: they move the WebContents
   * underneath the app without telling it.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      // Shift+'=' is '+' on most layouts, and '_' is Shift+'-'.
      const step = ['=', '+'].includes(e.key) ? 1 : ['-', '_'].includes(e.key) ? -1 : 0
      const reset = e.key === '0'
      if (!step && !reset) return
      e.preventDefault()
      setSettings((current) => {
        if (!current) return current
        const zoom = reset ? 1 : clampZoom(stepZoom(current.appearance.zoom, step as 1 | -1))
        if (zoom === current.appearance.zoom) return current
        // Optimistic. Main echoes the saved settings back, but waiting for that
        // round trip makes a held-down Ctrl+= feel like it drops presses.
        void window.wouice.setSettings({ appearance: { zoom } })
        return { ...current, appearance: { ...current.appearance, zoom } }
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Back to the top on every navigation. Without this a route change lands you
  // wherever the previous page happened to be scrolled to, with the new page's
  // title somewhere above the fold.
  const scroller = useRef<HTMLElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [route])

  const def = routeById(route)
  const dev = settings?.developerMode ?? false
  const zoom = settings?.appearance.zoom ?? 1

  return (
    // No padding at the top: the band below provides it, and the rail has to
    // reach the top of the window for its header to sit in the caption row.
    <div className="flex h-screen gap-2.5 overflow-hidden bg-neutral-950 px-2.5 pb-2.5 text-neutral-200">
      <Sidebar active={route} collapsed={collapsed} onToggle={toggleSidebar} zoom={zoom} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Empty on purpose. It clears Windows' caption buttons and gives the
            window somewhere to be dragged by. */}
        <div
          className="h-[var(--band)] shrink-0"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />

        <main
          ref={scroller}
          className="lift-panel min-h-0 flex-1 overflow-y-auto rounded-2xl bg-neutral-900 ring-1 ring-white/[0.08]"
        >
          <div className="px-7 py-6">
            <header className="mb-5">
              <h1 className="text-[19px] font-semibold tracking-tight text-neutral-50">
                {def.label}
              </h1>
              <p className="mt-0.5 text-[12px] text-neutral-500">{def.blurb}</p>
            </header>

            {/*
              A hotkey that failed to bind is not a page-level problem: the app
              looks fine and simply never responds. It belongs above whatever you
              are looking at, on every route.
            */}
            {hotkeyIssue && hotkeyIssue.accelerator === null && (
              <div className="mb-4 rounded-lg bg-red-500/10 p-3 text-[13px] text-red-300 ring-1 ring-red-500/20">
                No hotkey could be registered for{' '}
                <span className="font-mono">{hotkeyIssue.name}</span>. Tried{' '}
                {[hotkeyIssue.requested, ...hotkeyIssue.rejected].join(', ')}. Every one is owned by
                another app.
              </div>
            )}
            {hotkeyIssue && hotkeyIssue.substituted && (
              <div className="mb-4 rounded-lg bg-amber-500/10 p-3 text-[13px] text-amber-200 ring-1 ring-amber-500/20">
                <span className="font-mono">{hotkeyIssue.requested}</span> is already taken, so{' '}
                <span className="font-mono">{hotkeyIssue.name}</span> is bound to{' '}
                <kbd className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px]">
                  {hotkeyIssue.accelerator}
                </kbd>{' '}
                instead.
              </div>
            )}

            {route === 'dashboard' && <DashboardPage />}
            {route === 'dictations' && <DictationsPage developerMode={dev} query={query} />}
            {route === 'settings' && <SettingsPage settings={settings} />}
          </div>
        </main>
      </div>
    </div>
  )
}
