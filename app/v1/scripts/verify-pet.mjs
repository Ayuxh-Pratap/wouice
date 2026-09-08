import { createRequire } from 'node:module'
import {
  EnumWindows,
  GetForegroundWindow,
  INPUT_SIZE,
  IsWindowVisible,
  SendInput,
  windowProcess,
  windowTitle,
} from './lib/win32.mjs'

/**
 * Verify the desktop pet against the RUNNING app.
 *
 * WHY THIS EXISTS. Everything about the overlay - transparency, click-through,
 * the click that must not steal focus, the drag - was built and checked in a
 * browser tab with a stubbed preload bridge. A browser tab has no window
 * styles, no z-order and no foreground window, so none of the properties that
 * actually make the pet work were ever observed. Spike V7 proved the MECHANISM
 * in isolation; this checks the implementation of it, in the real window, from
 * outside the process.
 *
 * HOW IT KNOWS THINGS. Windows itself, not the app's own opinion. The extended
 * style bits on the window are the ground truth for click-through
 * (WS_EX_TRANSPARENT), non-activation (WS_EX_NOACTIVATE) and per-pixel alpha
 * (WS_EX_LAYERED). Asking the app would only tell us what it believes.
 *
 * Run: node scripts/verify-pet.mjs
 * The app must be running with the pet switched on.
 */

const require = createRequire(import.meta.url)
const koffi = require('koffi')
const user32 = koffi.load('user32.dll')

const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'int64_t', [
  'void *',
  'int',
])
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', ['void *', 'void *'])
const GetCursorPos = user32.func('__stdcall', 'GetCursorPos', 'bool', ['void *'])

const GWL_EXSTYLE = -20
const WS_EX_TOPMOST = 0x00000008
const WS_EX_TRANSPARENT = 0x00000020
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_LAYERED = 0x00080000
const WS_EX_NOACTIVATE = 0x08000000

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Move the cursor and confirm it actually got there.
 *
 * A person with their hand on the mouse will beat SendInput, and the failure
 * then looks like the app not reacting to a hover it never received. Better to
 * say the cursor was moved than to blame the code for it.
 */
async function parkCursor(x, y, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    moveTo(x, y)
    await sleep(350)
    const c = cursor()
    if (Math.abs(c.x - x) <= 2 && Math.abs(c.y - y) <= 2) return true
  }
  const c = cursor()
  console.log(
    `  SKIP  ${label}: the cursor would not stay at ${x},${y} (it is at ${c.x},${c.y}).` +
      ' Something else is moving the mouse - hands off and re-run.'
  )
  return false
}

function rectOf(hwnd) {
  const buf = Buffer.alloc(16)
  if (!GetWindowRect(hwnd, buf)) return null
  const left = buf.readInt32LE(0)
  const top = buf.readInt32LE(4)
  const right = buf.readInt32LE(8)
  const bottom = buf.readInt32LE(12)
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function cursor() {
  const buf = Buffer.alloc(8)
  GetCursorPos(buf)
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) }
}

function exStyle(hwnd) {
  return Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
}

/**
 * Find the overlay among every window on the desktop.
 *
 * Electron has four windows carrying `NOACTIVATE | LAYERED` - internal helpers
 * among them - so the style alone is not enough, and the size changes with the
 * character setting so a fixed size is no good either.
 *
 * The shape is. The stage is the character plus 344 across and plus 68 down, so
 * `width - height` is 276 whatever size she is drawn at. Nothing else on the
 * desktop is that shape by accident.
 */
const STAGE_SHAPE = 344 - 68
function findOverlay() {
  const found = []
  const cb = koffi.register((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true
    const ex = exStyle(hwnd)
    if (!(ex & WS_EX_NOACTIVATE) || !(ex & WS_EX_LAYERED)) return true
    const proc = windowProcess(hwnd)
    if (!proc || !/electron|wouice/i.test(proc.exe ?? '')) return true
    const r = rectOf(hwnd)
    if (!r || r.width - r.height !== STAGE_SHAPE) return true
    found.push({ hwnd, ex, rect: r, exe: proc.exe, title: windowTitle(hwnd) })
    return true
  }, koffi.pointer(koffi.proto('__stdcall', 'EnumProcPet', 'bool', ['void *', 'int64_t'])))

  try {
    EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }
  return found
}

/* ------------------------------------------------------------ mouse ------ */

const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_VIRTUALDESK = 0x4000

const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79
const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int'])

function mouse(flags, x = 0, y = 0) {
  const b = Buffer.alloc(INPUT_SIZE)
  b.writeUInt32LE(0, 0) // INPUT_MOUSE
  b.writeInt32LE(x, 8)
  b.writeInt32LE(y, 12)
  b.writeUInt32LE(flags, 20)
  return b
}

function toAbsolute(x, y) {
  const vx = GetSystemMetrics(SM_XVIRTUALSCREEN)
  const vy = GetSystemMetrics(SM_YVIRTUALSCREEN)
  const vw = GetSystemMetrics(SM_CXVIRTUALSCREEN)
  const vh = GetSystemMetrics(SM_CYVIRTUALSCREEN)
  return {
    x: Math.round(((x - vx) * 65535) / (vw - 1)),
    y: Math.round(((y - vy) * 65535) / (vh - 1)),
  }
}

function moveTo(x, y) {
  const a = toAbsolute(x, y)
  SendInput(
    1,
    mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, a.x, a.y),
    INPUT_SIZE
  )
}

function clickAt(x, y) {
  const a = toAbsolute(x, y)
  const f = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
  SendInput(
    3,
    Buffer.concat([
      mouse(MOUSEEVENTF_MOVE | f, a.x, a.y),
      mouse(MOUSEEVENTF_LEFTDOWN | f, a.x, a.y),
      mouse(MOUSEEVENTF_LEFTUP | f, a.x, a.y),
    ]),
    INPUT_SIZE
  )
}

/* -------------------------------------------------------------- run ------ */

console.log('\nVerifying the pet against the running app\n')

const windows = findOverlay()
if (windows.length === 0) {
  console.log('  No overlay window found.')
  console.log('  Start the app (npm start in desktop/) with the pet switched on, then re-run.')
  process.exit(2)
}
if (windows.length > 1) {
  console.log(`  ${windows.length} candidate windows; using the first.`)
}

const pet = windows[0]
const r = pet.rect
console.log(`  overlay at ${r.left},${r.top} ${r.width}x${r.height} (${pet.exe})\n`)

// The pet sits at one end of the stage. Which end depends on where it is
// parked; the character is the square, and the stage extends inward from it.
const onRight = r.left + r.width / 2 > GetSystemMetrics(0) / 2
const petBox = {
  x: onRight ? r.right - r.height + 34 : r.left,
  y: r.top + 34,
  size: r.height - 68,
}
const centre = {
  x: Math.round((onRight ? r.right - (r.height - 68) / 2 - 34 : r.left + (r.height - 68) / 2)),
  y: Math.round(r.top + r.height / 2),
}

report('the overlay does not take focus (WS_EX_NOACTIVATE)', Boolean(pet.ex & WS_EX_NOACTIVATE))
report('the overlay is layered, so it can be transparent (WS_EX_LAYERED)', Boolean(pet.ex & WS_EX_LAYERED))
report('the overlay floats above other windows (WS_EX_TOPMOST)', Boolean(pet.ex & WS_EX_TOPMOST))
// Alt+Tab shows every visible top-level window with no owner that lacks this
// bit. `skipTaskbar` does not set it - that is a different list.
report('the overlay stays out of Alt+Tab (WS_EX_TOOLWINDOW)', Boolean(pet.ex & WS_EX_TOOLWINDOW))

// Park the cursor well away, then confirm the window is click-through.
const away = { x: r.left - 300 > 20 ? r.left - 300 : r.right + 200, y: r.top }
if (!(await parkCursor(away.x, away.y, 'click-through check'))) process.exit(2)
report(
  'click-through while the cursor is elsewhere (WS_EX_TRANSPARENT set)',
  Boolean(exStyle(pet.hwnd) & WS_EX_TRANSPARENT),
  `cursor at ${cursor().x},${cursor().y}`
)

// Now onto the character. Main polls the cursor about twelve times a second and
// makes the window clickable only while it is genuinely inside her square.
if (!(await parkCursor(centre.x, centre.y, 'hover check'))) process.exit(2)
// The poll runs about twelve times a second; give it a couple of ticks.
await sleep(300)
const hoverEx = exStyle(pet.hwnd)
report(
  'becomes clickable when the cursor is over the character',
  !(hoverEx & WS_EX_TRANSPARENT),
  `pet square ~${petBox.size}px at ${petBox.x},${petBox.y}`
)

// The claim the whole concept rests on: clicking must not move the foreground.
const before = String(GetForegroundWindow())
const beforeTitle = windowTitle(GetForegroundWindow())
clickAt(centre.x, centre.y)
await sleep(700)
const after = String(GetForegroundWindow())
report(
  'clicking the pet does not steal the foreground window',
  before === after,
  before === after ? `still ${beforeTitle || before}` : `${beforeTitle} -> ${windowTitle(GetForegroundWindow())}`
)

// And back to click-through once the cursor leaves.
await parkCursor(away.x, away.y, 'leave check')
await sleep(300)
report(
  'goes back to click-through when the cursor leaves',
  Boolean(exStyle(pet.hwnd) & WS_EX_TRANSPARENT)
)

const failed = results.filter((x) => !x.ok)
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\nFAILED: ${failed.map((f) => f.name).join(', ')}` : '')
)
process.exit(failed.length ? 1 : 0)
