import { BrowserWindow, screen, shell } from 'electron'
import { appIcon } from './brand.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hideFromAltTab } from './injection/win32.js'
import {
  DEFAULT_PET_SIZE,
  STAGE_OVERHANG,
  petPixels,
  petSide,
  placementFromPet,
  snap,
  stageBounds,
  stageSize,
  type PetPlacement,
  type PetSize,
} from '../shared/pet.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(here, '../preload/index.mjs')

/** Where the overlay sits when the pet is switched off: centred, above a taskbar. */
const PARKED_BOTTOM_MARGIN = 96

let hud: BrowserWindow | null = null
let main: BrowserWindow | null = null

/**
 * The pet's placement, held here because the window is derived from it.
 *
 * Main owns this and settings persists it. The renderer never positions
 * anything: it reports gestures, and the window moves.
 */
let placement: PetPlacement = { x: 0.97, y: 0.82 }
let petEnabled = true
let petSize: PetSize = DEFAULT_PET_SIZE

/** The character's edge length in pixels, for the size currently chosen. */
function px(): number {
  return petPixels(petSize)
}

/**
 * ONE DISPLAY, DELIBERATELY, FOR NOW.
 *
 * A fraction of a work area only means something once you say whose work area.
 * Storing a display id alongside it would let the pet live on the second
 * monitor, and would also put a stale id in the settings file the first time
 * someone unplugs that monitor - at which point the pet is nowhere. The primary
 * display is used consistently on save and on restore, so the pet is always
 * somewhere findable. Multi-monitor placement is a later problem with a
 * different answer.
 */
function petArea(): Electron.Rectangle {
  return screen.getPrimaryDisplay().workArea
}

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

  const bounds = stageBounds(placement, petArea(), px())
  hud = new BrowserWindow({
    ...bounds,
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
  // Out of Alt+Tab as well as out of the taskbar. `skipTaskbar` only does the
  // latter - Electron implements it through ITaskbarList - and measuring the
  // running app showed the overlay was the one window of Electron's four
  // missing WS_EX_TOOLWINDOW, which is what Alt+Tab keys off.
  hideFromAltTab(hud.getNativeWindowHandle())
  // Click-through by DEFAULT, not always: the stage is 432px wide and almost
  // entirely empty, so a window that swallowed clicks everywhere would be a
  // dead patch of desktop. `forward: true` keeps mouse-move messages coming so
  // the cursor can still be tracked while clicks pass through, which is what
  // lets it become clickable at the moment the cursor is over the pet.
  hud.setIgnoreMouseEvents(true, { forward: true })
  hovering = false

  load(hud, '/hud')
  hud.on('closed', () => {
    hud = null
    hovering = false
  })
  return hud
}

export function showHud(): void {
  const win = createHud()
  // showInactive, never show(): show() would activate the window and defeat
  // focusable:false on some Windows configurations.
  win.showInactive()
}

/**
 * Back to idle.
 *
 * With the pet on, this is not a hide at all: the character stays where it was
 * put and the capsule closes. Hiding it would mean the app vanished off the
 * desktop every time a dictation finished.
 */
export function restHud(): void {
  if (petEnabled) return
  hideHud()
}

export function hideHud(): void {
  if (hud && !hud.isDestroyed()) hud.hide()
}

/** The pet's own square within the stage, in screen coordinates. */
function currentPetRect(): Electron.Rectangle {
  const b = hud!.getBounds()
  const size = px()
  const left = petSide(placement) === 'left' ? b.x : b.x + b.width - size
  return { x: left, y: b.y + STAGE_OVERHANG, width: size, height: size }
}

/**
 * Whether the window accepts clicks, decided by where the cursor actually is.
 *
 * MEASURED IN MAIN RATHER THAN REPORTED BY THE RENDERER. The obvious version
 * has the page send mouseenter and mouseleave, and it fails the moment one of
 * them is missed - a pointer that jumps, a window shown under a stationary
 * cursor - leaving a 432x128 invisible rectangle eating clicks on the desktop
 * with no way for anyone to work out why. Asking Windows where the cursor is
 * cannot get stuck in the wrong state, because it is not a state.
 */
/**
 * Whether the cursor was over the pet last time we looked. RENDERER STATE ONLY.
 *
 * The window is told what it should be on every tick rather than only when this
 * changes; this exists solely to avoid re-sending an event the renderer already
 * has. That is fewer moving parts than caching the window's state and keeping
 * the cache honest, not more.
 */
let hovering = false
let hoverTimer: ReturnType<typeof setInterval> | null = null

function setInteractive(on: boolean): void {
  if (!hud || hud.isDestroyed()) return
  // Unconditional. This is the line that makes the state real rather than
  // remembered.
  if (on) hud.setIgnoreMouseEvents(false)
  else hud.setIgnoreMouseEvents(true, { forward: true })
  if (on !== hovering) {
    hovering = on
    hud.webContents.send('hud:hover', on)
  }
}

function inside(point: Electron.Point, rect: Electron.Rectangle): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  )
}

/** ~12 times a second. A cursor position is a syscall; this is not a cost. */
const HOVER_POLL_MS = 80

function startHoverWatch(): void {
  if (hoverTimer) return
  hoverTimer = setInterval(() => {
    if (!hud || hud.isDestroyed() || !hud.isVisible()) return
    // Mid-drag the pet is under the cursor by definition, and re-testing would
    // fight the drag every tick.
    if (dragging) return
    setInteractive(inside(screen.getCursorScreenPoint(), currentPetRect()))
  }, HOVER_POLL_MS)
}

function stopHoverWatch(): void {
  if (hoverTimer) clearInterval(hoverTimer)
  hoverTimer = null
  setInteractive(false)
}


/**
 * Dragging, done by following the cursor from here.
 *
 * NOT `-webkit-app-region: drag`, which asks Windows for a caption drag and can
 * activate the window - and an overlay that activates is an overlay that has
 * just taken focus away from the text field the whole app exists to type into.
 * Spike V7 measured this route leaving both the foreground window and the caret
 * untouched across a click and a drag.
 */
let dragging = false
let dragOffset = { dx: 0, dy: 0 }
let dragSide: 'left' | 'right' = 'right'
let dragTimer: ReturnType<typeof setInterval> | null = null

export function startPetDrag(): void {
  if (!hud || hud.isDestroyed() || dragging) return
  const cursor = screen.getCursorScreenPoint()
  const pet = currentPetRect()
  dragOffset = { dx: cursor.x - pet.x, dy: cursor.y - pet.y }
  // Frozen for the duration. Recomputing the side mid-drag would slide the pet
  // 356px sideways inside the stage the instant the cursor crossed the middle
  // of the screen, which looks like the drag broke.
  dragSide = petSide(placement)
  dragging = true
  hud.webContents.send('hud:dragging', true)

  dragTimer = setInterval(() => {
    if (!hud || hud.isDestroyed()) return
    const c = screen.getCursorScreenPoint()
    const petX = c.x - dragOffset.dx
    const petY = c.y - dragOffset.dy
    const stage = stageSize(px())
    hud.setBounds({
      x: dragSide === 'left' ? petX : petX + px() - stage.width,
      y: petY - STAGE_OVERHANG,
      width: stage.width,
      height: stage.height,
    })
  }, 16)
}

/** @returns the placement to persist, or null if no drag was running. */
export function endPetDrag(): PetPlacement | null {
  if (!dragging) return null
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = null
  dragging = false

  const pet = currentPetRect()
  const next = snap(placementFromPet(pet.x, pet.y, petArea(), px()))
  placement = next
  placeHud()
  hud?.webContents.send('hud:dragging', false)
  return next
}

/** Move the window to wherever the placement now says, and tell the renderer. */
function placeHud(): void {
  if (!hud || hud.isDestroyed()) return
  if (petEnabled) {
    hud.setBounds(stageBounds(placement, petArea(), px()))
  } else {
    // Parked: centred along the bottom, the way the overlay behaved before
    // there was a pet to put anywhere.
    const area = petArea()
    const stage = stageSize(px())
    hud.setBounds({
      x: Math.round(area.x + (area.width - stage.width) / 2),
      y: Math.round(area.y + area.height - stage.height - PARKED_BOTTOM_MARGIN),
      width: stage.width,
      height: stage.height,
    })
  }
  hud.webContents.send('hud:placement', { side: petSide(placement), pet: petEnabled })
}

/**
 * Apply the stored settings.
 *
 * SWITCHING OFF works immediately. SWITCHING ON DOES NOT: the pet appears but
 * does not take clicks or drags until the app is restarted, and the cause has
 * not been found. Two attempts at it - resetting the cached interactivity flag,
 * then tearing the whole overlay down on every change - both failed, so both
 * have been removed rather than left in as machinery that fixes nothing. The
 * settings screen says a restart is needed instead, which is at least true.
 */
export function applyPetSettings(next: {
  enabled: boolean
  placement: PetPlacement
  size: PetSize
}): void {
  placement = next.placement
  petEnabled = next.enabled
  // Changing the size changes the window, because the stage is derived from
  // the character. `placeHud` below does the resizing.
  petSize = next.size
  placeHud()

  if (!petEnabled) {
    stopHoverWatch()
    hideHud()
    return
  }
  showHud()
  startHoverWatch()
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
    // The same mark the rail draws, rasterised. Without this the window corner,
    // Alt+Tab and the taskbar all show Electron's own default.
    icon: appIcon(),
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
