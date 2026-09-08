import { useEffect, useState } from 'react'
import type { Diagnostics, HotkeyReport, SidecarView, StoreStats } from '../shared/ipc.js'
import type { Settings } from '../shared/settings.js'
import { SIDECARS, type SidecarId } from '../shared/models.js'
import { Metrics } from './Metrics.js'
import { Calibration } from './calibration/Calibration.js'

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  starting: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  restarting: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  failed: 'bg-red-500/15 text-red-300 ring-red-500/30',
  stopped: 'bg-neutral-500/15 text-neutral-400 ring-neutral-500/30',
}

function Pill({ status }: { status: string }): React.JSX.Element {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
        STATUS_STYLE[status] ?? STATUS_STYLE.stopped
      }`}
    >
      {status}
    </span>
  )
}

function SidecarCard({
  view,
  onSwitch,
  onRestart,
}: {
  view: SidecarView
  onSwitch: (modelId: string) => void
  onRestart: () => void
}): React.JSX.Element {
  const def = SIDECARS[view.id]
  const title = view.id === 'whisper' ? 'Speech recognition' : 'Language model'

  return (
    <section className="rounded-xl bg-neutral-900 p-4 ring-1 ring-white/10">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
          <p className="font-mono text-[11px] text-neutral-500">
            127.0.0.1:{view.port}
            {view.pid ? ` · pid ${view.pid}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill status={view.status} />
          <button
            onClick={onRestart}
            className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200"
          >
            Restart
          </button>
        </div>
      </header>

      <div className="space-y-1.5">
        {def.models.map((m) => {
          const isActive = m.id === view.modelId
          const isQueued = m.id === view.pendingModelId
          return (
            <button
              key={m.id}
              onClick={() => onSwitch(m.id)}
              className={[
                'flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition',
                isActive ? 'bg-white/10 ring-1 ring-white/20' : 'hover:bg-white/5',
              ].join(' ')}
            >
              <span
                className={[
                  'mt-1 size-2 shrink-0 rounded-full',
                  isActive ? 'bg-emerald-400' : isQueued ? 'bg-amber-400' : 'bg-neutral-700',
                ].join(' ')}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium text-neutral-100">{m.label}</span>
                  <span className="font-mono text-[10px] text-neutral-500">{m.vramMiB} MiB</span>
                  {isQueued && (
                    <span className="text-[10px] text-amber-400">switching when idle</span>
                  )}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">
                  {m.note}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {view.lastError && (
        <p className="mt-3 rounded-md bg-red-500/10 p-2 font-mono text-[11px] leading-snug text-red-300">
          {view.lastError}
        </p>
      )}
    </section>
  )
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * What is actually inside the database.
 *
 * There is no server to look at and no admin console: the app IS the deployment,
 * so "how much of my voice is on this disk, in what, and is the schema where it
 * should be" has to be answerable from here. The reveal button opens the folder,
 * for anyone who wants to point a SQLite browser at the file.
 */
function Storage(): React.JSX.Element | null {
  const [stats, setStats] = useState<StoreStats | null>(null)

  useEffect(() => {
    void window.wouice.getStorage().then(setStats).catch(() => setStats(null))
  }, [])

  if (!stats) return null

  return (
    <div className="mt-4 border-t border-white/5 pt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-neutral-400">Storage</span>
        <button
          onClick={() => window.wouice.revealMetrics()}
          className="rounded-md px-2 py-0.5 text-[11px] text-neutral-500 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-300"
        >
          Show in folder
        </button>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 font-mono text-[11px] sm:grid-cols-[auto_1fr]">
        <dt className="text-neutral-500">database</dt>
        <dd className="truncate text-neutral-300">{stats.file}</dd>
        <dt className="text-neutral-500">schema</dt>
        <dd className="text-neutral-300">
          v{stats.version} · {bytes(stats.bytes)} on disk
        </dd>
        {stats.tables.map((t) => (
          <div key={t.name} className="contents">
            <dt className="text-neutral-500">{t.name}</dt>
            <dd className="text-neutral-300 tabular-nums">{t.rows.toLocaleString()} rows</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function Dashboard(): React.JSX.Element {
  const [sidecars, setSidecars] = useState<SidecarView[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [hotkeyIssue, setHotkeyIssue] = useState<HotkeyReport | null>(null)

  useEffect(() => {
    void window.wouice.getSidecars().then(setSidecars)
    void window.wouice.getSettings().then(setSettings)
    void window.wouice.getDiagnostics().then(setDiag)

    const offState = window.wouice.onSidecarState((next) =>
      setSidecars((prev) => {
        const i = prev.findIndex((s) => s.id === next.id)
        if (i === -1) return [...prev, next]
        const copy = [...prev]
        copy[i] = next
        return copy
      })
    )
    const offSettings = window.wouice.onSettingsChanged(setSettings)
    const offHotkey = window.wouice.onHotkeyFailed(setHotkeyIssue)
    return () => {
      offState()
      offSettings()
      offHotkey()
    }
  }, [])

  const switchModel = (id: SidecarId, modelId: string): void => {
    void window.wouice.switchModel(id, modelId)
  }

  return (
    <div className="min-h-full bg-neutral-950 p-6 text-neutral-200">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-neutral-50">Wouice</h1>
          <p className="text-[13px] text-neutral-500">
            Press{' '}
            <kbd className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300">
              {settings?.hotkeys.dictate ?? 'Control+Alt+W'}
            </kbd>{' '}
            anywhere to dictate.
          </p>
        </div>
        <Calibration settings={settings} />
      </header>

      {hotkeyIssue && hotkeyIssue.accelerator === null && (
        <div className="mb-4 rounded-lg bg-red-500/10 p-3 text-[13px] text-red-300 ring-1 ring-red-500/20">
          No hotkey could be registered for <span className="font-mono">{hotkeyIssue.name}</span>.
          Tried {[hotkeyIssue.requested, ...hotkeyIssue.rejected].join(', ')}. Every one is owned by
          another app. Pick a different combination in settings.
        </div>
      )}
      {hotkeyIssue && hotkeyIssue.substituted && (
        <div className="mb-4 rounded-lg bg-amber-500/10 p-3 text-[13px] text-amber-200 ring-1 ring-amber-500/20">
          <span className="font-mono">{hotkeyIssue.requested}</span> is already taken by another
          app, so <span className="font-mono">{hotkeyIssue.name}</span> is bound to{' '}
          <kbd className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px]">
            {hotkeyIssue.accelerator}
          </kbd>{' '}
          instead.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {sidecars.map((s) => (
          <SidecarCard
            key={s.id}
            view={s}
            onSwitch={(modelId) => switchModel(s.id, modelId)}
            onRestart={() => void window.wouice.restartSidecar(s.id)}
          />
        ))}
      </div>

      <div className="mt-6">
        <Metrics developerMode={settings?.developerMode ?? true} />
      </div>

      {diag && (
        <details className="mt-6 rounded-xl bg-neutral-900 p-4 ring-1 ring-white/10">
          <summary className="cursor-pointer text-sm font-medium text-neutral-300">
            Diagnostics
          </summary>
          <dl className="mt-3 grid gap-x-4 gap-y-1.5 font-mono text-[11px] sm:grid-cols-[auto_1fr]">
            {[
              ['sidecars', diag.sidecarRoot],
              ['models', diag.modelRoot],
              ['user data', diag.userData],
              ['platform', diag.platform],
              ['electron', diag.electron],
              [
                'hotkeys',
                Object.entries(diag.hotkeyRegistered)
                  .map(([k, v]) => `${k}=${v ? 'ok' : 'FAILED'}`)
                  .join('  ') || 'none',
              ],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-neutral-500">{k}</dt>
                <dd className="truncate text-neutral-300">{v}</dd>
              </div>
            ))}
          </dl>

          <Storage />
        </details>
      )}
    </div>
  )
}
