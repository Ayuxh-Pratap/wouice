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
      // The HUD is hidden most of the time and owns the microphone. Chromium
      // throttles timers and audio in hidden windows, which would stall the
      // capture worklet exactly when it matters.
      backgroundThrottling: false,
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

export function sendToHud(channel: string, ...payload: unknown[]): void {
  if (hud && !hud.isDestroyed()) hud.webContents.send(channel, ...payload)
}

/**
 * The application ground, in main as well as in the renderer.
 *
 * The window is painted before the renderer has loaded anything, so this has to
 * match `bg-neutral-950` exactly or every launch opens on a flash of a slightly
 * different dark grey.
 */
const GROUND = '#0a0a0a'

/**
 * The caption row, in WINDOW pixels, and deliberately NOT scaled by the zoom.
 *
 * Windows draws the minimise, maximise and close glyphs to fill the overlay it
 * is given, so a height that grows with the interface scale grows the buttons
 * with it: at 125% they came out half again as large as the native ones on
 * every other window on the desktop, which is exactly what a caption button
 * must not do. Fixed here, they stay the size Windows draws everywhere else.
 *
 * The renderer reads the region back through `env(titlebar-area-height)`, which
 * reports it in CSS pixels - so this shrinks from the layout's point of view as
 * the scale rises, which is correct: it is a constant amount of screen, not a
 * constant amount of interface.
 */
const TITLE_BAR_HEIGHT = 34

/**
 * The window controls, coloured to disappear into the app.
 *
 * `titleBarStyle: 'hidden'` with an overlay rather than `frame: false`. The
 * native minimise, maximise and close keep working exactly as Windows users
 * expect - including the Windows 11 snap-layouts flyout that appears on hover
 * over maximise, which a hand-drawn set of buttons silently loses - while the
 * strip they sit in becomes ours to draw.
 */
function overlay(): Parameters<BrowserWindow['setTitleBarOverlay']>[0] {
  return { color: GROUND, symbolColor: '#a3a3a3', height: TITLE_BAR_HEIGHT }
}

/** History, dictionary, settings, diagnostics. An ordinary window. */
export function createMainWindow(zoom = 1): BrowserWindow {
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
    backgroundColor: GROUND,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      zoomFactor: zoom,
    },
  })

  main.on('ready-to-show', () => main?.show())
  // Re-stated after every load. `zoomFactor` in webPreferences applies to the
  // first document only, and a reload would otherwise fall back to whatever
  // Chromium remembered for the origin.
  main.webContents.on('did-finish-load', () => main?.webContents.setZoomFactor(zoom))
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

/**
 * Interface scale.
 *
 * WHY THIS IS A SETTING. On a 32-inch monitor the window at 100% is a postage
 * stamp of 11px labels: the pixels are there, the reading distance is not.
 * Windows' own display scaling is system-wide, and someone who wants this app
 * larger does not necessarily want every app larger.
 *
 * APPLIED TO THE MAIN WINDOW ONLY. The HUD is a fixed-size overlay positioned
 * from here in window pixels; zooming its contents would leave the pill drawn
 * at one size inside a window sized for another.
 */
export function applyZoom(zoom: number): void {
  if (!main || main.isDestroyed()) return
  // Only the document scales. The caption row is left alone on purpose - see
  // TITLE_BAR_HEIGHT.
  main.webContents.setZoomFactor(zoom)
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
