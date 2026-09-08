import { Menu, Tray, app, nativeImage } from 'electron'
import type { SidecarSupervisor } from './sidecars/supervisor.js'
import { SIDECARS, type SidecarId } from '../shared/models.js'
import type { SettingsStore } from './settings-store.js'

let tray: Tray | null = null

/**
 * A tiny procedurally-drawn icon, so the shell has no binary asset dependency
 * yet. Real branding comes later; this only has to be visible in both light and
 * dark trays and distinguishable at 16px.
 */
function icon(): Electron.NativeImage {
  const size = 16
  const png = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // A filled circle with a soft edge.
      const dx = x - 7.5
      const dy = y - 7.5
      const d = Math.sqrt(dx * dx + dy * dy)
      const a = d < 5 ? 255 : d < 6.5 ? Math.round(255 * (6.5 - d) / 1.5) : 0
      png[i] = 226
      png[i + 1] = 232
      png[i + 2] = 240
      png[i + 3] = a
    }
  }
  return nativeImage.createFromBuffer(
    Buffer.from(png),
    { width: size, height: size }
  )
}

function statusGlyph(status: string): string {
  switch (status) {
    case 'ready': return '●'      // filled: serving
    case 'starting':
    case 'restarting': return '◌' // dotted: coming up
    case 'failed': return '✕'     // cross
    default: return '○'           // hollow: stopped
  }
}

export interface TrayDeps {
  supervisor: SidecarSupervisor
  settings: SettingsStore
  onOpenWindow: () => void
  onSwitchModel: (id: SidecarId, modelId: string) => void
  onRestart: (id: SidecarId) => void
}

/**
 * Tray menu. The model switch lives here because A8c's whole point is fast A/B
 * testing during real use: opening a settings window to flip a model would make
 * the comparison too costly to actually do.
 *
 * The active model is always visible in the menu and the tooltip. When testing
 * across days, "which one is running" must never be a guess.
 */
export function createTray(deps: TrayDeps): Tray {
  if (tray) return tray
  tray = new Tray(icon())
  refreshTray(deps)
  tray.on('click', () => deps.onOpenWindow())
  return tray
}

export function refreshTray(deps: TrayDeps): void {
  if (!tray) return
  const snaps = deps.supervisor.snapshotAll()

  const modelMenus = snaps.map((snap) => {
    const def = SIDECARS[snap.id]
    const active = def.models.find((m) => m.id === snap.modelId)
    const queued = snap.pendingModelId
      ? ` (switching to ${def.models.find((m) => m.id === snap.pendingModelId)?.label ?? snap.pendingModelId} when idle)`
      : ''

    return {
      label: `${statusGlyph(snap.status)}  ${snap.id === 'whisper' ? 'Speech' : 'Language'}: ${active?.label ?? snap.modelId}${queued}`,
      submenu: [
        ...def.models.map((m) => ({
          label: m.label,
          type: 'radio' as const,
          checked: m.id === snap.modelId,
          sublabel: `${m.vramMiB} MiB`,
          click: () => deps.onSwitchModel(snap.id, m.id),
        })),
        { type: 'separator' as const },
        {
          label: `Status: ${snap.status}${snap.pid ? ` (pid ${snap.pid})` : ''}`,
          enabled: false,
        },
        ...(snap.lastError
          ? [{ label: `Last error: ${snap.lastError.slice(0, 70)}`, enabled: false }]
          : []),
        { label: 'Restart', click: () => deps.onRestart(snap.id) },
      ],
    }
  })

  const menu = Menu.buildFromTemplate([
    { label: `Wouice ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    ...modelMenus,
    { type: 'separator' },
    { label: 'Open Wouice', click: () => deps.onOpenWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])

  tray.setContextMenu(menu)

  const summary = snaps
    .map((s) => `${s.id}: ${s.modelId} (${s.status})`)
    .join('\n')
  tray.setToolTip(`Wouice\n${summary}`)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
