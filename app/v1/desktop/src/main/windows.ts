import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(here, '../preload/index.mjs')

const HUD_WIDTH = 340
const HUD_HEIGHT = 76
/** Gap from the bottom of the work area, so it clears the taskbar. */
const HUD_BOTTOM_MARGIN = 96

let hud: BrowserWindow | null = null
let main: BrowserWindow | null = null

function rendererUrl(route: string): { url?: string; file?: string } {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) return { url: `${dev}#${route}` }
  return { file: path.join(here, `../renderer/index.html`) }
}

function load(win: BrowserWindow, route: string): void {
  const { url, file } = rendererUrl(route)
  if (url) void win.loadURL(url)
  else void win.loadFile(file!, { hash: route })
}

/**
 * The dictation overlay.
 *
 * `focusable: false` IS THE WHOLE APP. If this window can take keyboard focus,
 * the text field the user was typing into loses it the moment the HUD appears,
 * and there is nothing left to insert into when transcription finishes. Every
 * other property here is a preference; this one is load-bearing.
 *
 * The consequence is that the HUD can never hold an interactive control. Any
 * setting, button or input belongs in the main window.
 */
export function createHud(): BrowserWindow {
  if (hud && !hud.isDestroyed()) return hud

  const { workArea } = screen.getPrimaryDisplay()
  hud = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    x: Math.round(workArea.x + (workArea.width - HUD_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - HUD_HEIGHT - HUD_BOTTOM_MARGIN),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    // Do not steal focus even when shown programmatically.
    acceptFirstMouse: false,
    hasShadow: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Float above fullscreen apps too; dictation happens everywhere.
  hud.setAlwaysOnTop(true, 'screen-saver')
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Clicks pass straight through to whatever is underneath.
  hud.setIgnoreMouseEvents(true)

  load(hud, '/hud')
  hud.on('closed', () => {
    hud = null
  })
  return hud
}

export function showHud(): void {
  const win = createHud()
  // showInactive, never show(): show() would activate the window and defeat
  // focusable:false on some Windows configurations.
  win.showInactive()
}

export function hideHud(): void {
  if (hud && !hud.isDestroyed()) hud.hide()
}

export function sendToHud(channel: string, payload: unknown): void {
  if (hud && !hud.isDestroyed()) hud.webContents.send(channel, payload)
}

/** History, dictionary, settings, diagnostics. An ordinary window. */
export function createMainWindow(): BrowserWindow {
  if (main && !main.isDestroyed()) {
    main.show()
    main.focus()
    return main
  }

  main = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Wouice',
    autoHideMenuBar: true,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  main.on('ready-to-show', () => main?.show())
  main.on('closed', () => {
    main = null
  })

  // External links open in the real browser, never inside the app.
  main.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  load(main, '/')
  return main
}

export function sendToMain(channel: string, payload: unknown): void {
  if (main && !main.isDestroyed()) main.webContents.send(channel, payload)
}

export function broadcast(channel: string, payload: unknown): void {
  sendToHud(channel, payload)
  sendToMain(channel, payload)
}

export function getMainWindow(): BrowserWindow | null {
  return main
}
