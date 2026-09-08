import { app, BrowserWindow, screen } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  FindWindowW,
  GetForegroundWindow,
  INPUT_SIZE,
  VK,
  chord,
  forceForeground,
  foregroundTarget,
  send,
} from './lib/win32.mjs'

/**
 * Spike V7: can a window you can CLICK still leave the caret alone?
 *
 * WHY THIS DECIDES THE WHOLE THING. The dictation overlay is created
 * `focusable: false` and `setIgnoreMouseEvents(true)`, and both are
 * load-bearing: if it takes focus, the text field being dictated into loses it
 * and there is nothing left to insert into. A desktop pet you park somewhere,
 * drag around and click to start talking needs the exact opposite of the second
 * property - it has to receive mouse input - and the concept only works if it
 * can do that WITHOUT the first one giving way.
 *
 * The claim being tested is that `focusable: false` sets WS_EX_NOACTIVATE on
 * Windows, which means the window still receives mouse messages but clicking it
 * does not activate it. If that holds, a clickable pet is free. If it does not,
 * the pet can only ever be a hotkey target with decoration, and the whole
 * premise changes.
 *
 * A FOREGROUND HANDLE THAT DID NOT CHANGE IS NOT ENOUGH. Focus and the caret
 * are different things, and a window can stay foreground while the control
 * inside it loses its selection. So every check here ends by actually pasting
 * into the target and reading back what arrived, which is the only evidence
 * that matters.
 *
 *   P1  the renderer receives mousedown at all, with clicks not ignored
 *   P2  clicking the pet leaves GetForegroundWindow unchanged
 *   P3  injection still lands in the target AFTER the pet has been clicked
 *   P4  the pet can be dragged - window follows the cursor, foreground unchanged
 *   P5  hover still reaches the renderer while clicks are ignored
 *       (setIgnoreMouseEvents(true, { forward: true }), which is what lets the
 *       pet be click-through everywhere except over itself)
 *
 * Run: npx electron scripts/spike-pet-window.mjs
 */

const TARGET_TITLE = 'Wouice V7 target'
const PET = { width: 96, height: 96 }

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------------------------------------------------------- mouse ---- */

const INPUT_MOUSE = 0
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_VIRTUALDESK = 0x4000

/**
 * One MOUSEINPUT record.
 *
 * Absolute coordinates are 0..65535 across the WHOLE virtual desktop, not the
 * primary display, so the divisor has to be the virtual bounds or a click aimed
 * at a second monitor lands somewhere else entirely.
 */
function mouse(flags, x = 0, y = 0) {
  const b = Buffer.alloc(INPUT_SIZE)
  b.writeUInt32LE(INPUT_MOUSE, 0)
  b.writeInt32LE(x, 8)
  b.writeInt32LE(y, 12)
  b.writeUInt32LE(0, 16) // mouseData
  b.writeUInt32LE(flags, 20)
  return b
}

function virtualBounds() {
  const all = screen.getAllDisplays().map((d) => d.bounds)
  const left = Math.min(...all.map((b) => b.x))
  const top = Math.min(...all.map((b) => b.y))
  const right = Math.max(...all.map((b) => b.x + b.width))
  const bottom = Math.max(...all.map((b) => b.y + b.height))
  return { left, top, width: right - left, height: bottom - top }
}

function toAbsolute(x, y) {
  const v = virtualBounds()
  return {
    x: Math.round(((x - v.left) * 65535) / (v.width - 1)),
    y: Math.round(((y - v.top) * 65535) / (v.height - 1)),
  }
}

function moveTo(x, y) {
  const a = toAbsolute(x, y)
  return send([mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, a.x, a.y)])
}

function clickAt(x, y) {
  const a = toAbsolute(x, y)
  const flags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
  return send([
    mouse(MOUSEEVENTF_MOVE | flags, a.x, a.y),
    mouse(MOUSEEVENTF_LEFTDOWN | flags, a.x, a.y),
    mouse(MOUSEEVENTF_LEFTUP | flags, a.x, a.y),
  ])
}

/* ------------------------------------------------------------------ pet ---- */

/**
 * The pet, as a bare window with no build step.
 *
 * Everything the real one would have is left out except the two properties
 * under test: it does not take focus, and it can be clicked. It reports every
 * mouse event it sees back through the page title, which main can read without
 * any IPC plumbing.
 */
const PET_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>pet|none|0</title>
<style>
  html,body { margin:0; height:100%; background:transparent; overflow:hidden;
              font:12px system-ui; color:#fff; }
  #pet { position:absolute; inset:8px; border-radius:50%;
         background:radial-gradient(circle at 35% 30%, #6aa9ff, #1f3f7a);
         box-shadow:0 6px 18px rgba(0,0,0,.5); display:grid; place-items:center; }
</style></head>
<body><div id="pet">pet</div>
<script>
  let downs = 0, moves = 0, last = 'none'
  const tell = () => { document.title = 'pet|' + last + '|' + downs + '|' + moves }
  const pet = document.getElementById('pet')
  pet.addEventListener('mousedown', (e) => { downs++; last = 'down@' + e.button; tell() })
  pet.addEventListener('mouseup',   () => { last = 'up'; tell() })
  pet.addEventListener('mouseenter',() => { last = 'enter'; tell() })
  document.addEventListener('mousemove', () => { moves++; tell() })
</script></body></html>`

function readPet(win) {
  // title is "pet|<last>|<downs>|<moves>"
  const [, last = 'none', downs = '0', moves = '0'] = win.webContents.getTitle().split('|')
  return { last, downs: Number(downs), moves: Number(moves) }
}

/* --------------------------------------------------------------- target ---- */

async function startTarget(outFile) {
  const psFile = path.join(app.getPath('temp'), 'wouice-v7-target.ps1')
  rmSync(outFile, { force: true })

  writeFileSync(
    psFile,
    `Add-Type -AssemblyName System.Windows.Forms
$out = '${outFile.replace(/\\/g, '\\\\')}'
$f = New-Object Windows.Forms.Form
$f.Text = '${TARGET_TITLE}'
$f.TopMost = $false
$f.Width = 620
$f.Height = 180
$f.StartPosition = 'Manual'
$f.Left = 60
$f.Top = 60
$t = New-Object Windows.Forms.TextBox
$t.Multiline = $true
$t.Dock = 'Fill'
$f.Controls.Add($t)
# Written on every change, not on a timer. A timer means the result only exists
# if the form survives long enough to fire it, and a spike that gets cut short
# then reports nothing about the two checks that matter most.
$t.Add_TextChanged({ Set-Content -LiteralPath $out -Value $t.Text -Encoding UTF8 })
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 25000
$timer.Add_Tick({ $f.Close() })
$f.Add_Shown({ $f.Activate(); $t.Focus(); $timer.Start() })
[void]$f.ShowDialog()
`,
    'utf8'
  )

  // NOT detached: on Windows that implies DETACHED_PROCESS, which leaves the
  // child without a console, and powershell.exe needs one.
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', psFile],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stderr.on('data', (d) => console.log(`  target stderr: ${String(d).trim()}`))

  const deadline = Date.now() + 15_000
  let hwnd = null
  while (Date.now() < deadline) {
    hwnd = FindWindowW(null, TARGET_TITLE)
    if (hwnd) break
    await sleep(150)
  }
  return { child, hwnd }
}

/* ----------------------------------------------------------------- run ----- */

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const outFile = path.join(app.getPath('temp'), 'wouice-v7-target.txt')
  const { child, hwnd } = await startTarget(outFile)

  console.log('\nV7: a pet you can click, and a caret that survives it\n')
  report('target window exists', Boolean(hwnd), hwnd ? `hwnd ${hwnd}` : 'never appeared')
  if (!hwnd) return finish(child)

  // Park the pet clear of the target window, which sits at 60,60 620x180.
  const { workArea } = screen.getPrimaryDisplay()
  const petX = Math.round(workArea.x + workArea.width - PET.width - 120)
  const petY = Math.round(workArea.y + 320)

  const pet = new BrowserWindow({
    width: PET.width,
    height: PET.height,
    x: petX,
    y: petY,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // The property under test. Everything else here is scaffolding.
    focusable: false,
    hasShadow: false,
  })
  pet.setAlwaysOnTop(true, 'screen-saver')
  await pet.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PET_HTML)}`)
  pet.showInactive()
  await sleep(400)

  // ---- P5 first: hover while clicks are ignored ------------------------
  // Done before anything else because it is the state the pet spends its life
  // in - click-through everywhere, listening for the cursor arriving over it.
  pet.setIgnoreMouseEvents(true, { forward: true })
  await sleep(150)
  const beforeHover = readPet(pet)
  moveTo(petX + PET.width / 2, petY + PET.height / 2)
  await sleep(400)
  const afterHover = readPet(pet)
  report(
    'P5 hover reaches the renderer while clicks are ignored',
    afterHover.moves > beforeHover.moves,
    `moves ${beforeHover.moves} -> ${afterHover.moves}`
  )

  // Now make it clickable, the way the real pet would when the cursor is over it.
  pet.setIgnoreMouseEvents(false)
  await sleep(150)

  // ---- put the caret in the target ------------------------------------
  let focused = false
  for (let i = 0; i < 12; i++) {
    forceForeground(hwnd)
    await sleep(200)
    const t = foregroundTarget()
    if (t && t.title === TARGET_TITLE) {
      focused = true
      break
    }
  }
  report('target holds the foreground', focused, focused ? '' : 'could not focus it')
  if (!focused) {
    pet.destroy()
    return finish(child)
  }

  const fgBefore = String(GetForegroundWindow())

  // ---- P1 / P2 clicking the pet ---------------------------------------
  const before = readPet(pet)
  clickAt(petX + PET.width / 2, petY + PET.height / 2)
  await sleep(500)
  const after = readPet(pet)
  const fgAfterClick = String(GetForegroundWindow())

  report(
    'P1 the pet receives mousedown',
    after.downs > before.downs,
    `downs ${before.downs} -> ${after.downs}, last "${after.last}"`
  )
  report(
    'P2 clicking the pet does not move the foreground window',
    fgAfterClick === fgBefore,
    fgAfterClick === fgBefore ? `still ${fgBefore}` : `${fgBefore} -> ${fgAfterClick}`
  )

  // ---- P3 the caret survived, proven by injecting ----------------------
  // The only check that matters. A foreground handle can be unchanged while the
  // control inside it has lost its selection, and the difference is invisible
  // until text goes missing.
  const marker = 'V7-after-click'
  const { clipboard } = await import('electron')
  await clipboard.writeText(marker)
  await sleep(120)
  chord(VK.V, [VK.CONTROL])
  await sleep(500)

  // ---- P4 dragging -----------------------------------------------------
  const dragTo = { x: petX - 140, y: petY - 90 }
  const a0 = toAbsolute(petX + PET.width / 2, petY + PET.height / 2)
  const flags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
  send([
    mouse(MOUSEEVENTF_MOVE | flags, a0.x, a0.y),
    mouse(MOUSEEVENTF_LEFTDOWN | flags, a0.x, a0.y),
  ])
  // Main moves the window with the cursor: no app-region drag, which asks
  // Windows for a caption drag and would activate the window.
  for (let i = 1; i <= 8; i++) {
    const cx = petX + ((dragTo.x - petX) * i) / 8
    const cy = petY + ((dragTo.y - petY) * i) / 8
    moveTo(cx + PET.width / 2, cy + PET.height / 2)
    pet.setBounds({
      x: Math.round(cx),
      y: Math.round(cy),
      width: PET.width,
      height: PET.height,
    })
    await sleep(40)
  }
  const aEnd = toAbsolute(dragTo.x + PET.width / 2, dragTo.y + PET.height / 2)
  send([mouse(MOUSEEVENTF_LEFTUP | flags, aEnd.x, aEnd.y)])
  await sleep(300)

  const moved = pet.getBounds()
  const fgAfterDrag = String(GetForegroundWindow())
  report(
    'P4 the pet can be dragged',
    Math.abs(moved.x - dragTo.x) <= 2 && Math.abs(moved.y - dragTo.y) <= 2,
    `landed at ${moved.x},${moved.y} (wanted ${dragTo.x},${dragTo.y})`
  )
  report(
    'P4 dragging does not move the foreground window',
    fgAfterDrag === fgBefore,
    fgAfterDrag === fgBefore ? `still ${fgBefore}` : `${fgBefore} -> ${fgAfterDrag}`
  )

  // A second paste, after the drag, for the same reason as the first.
  await clipboard.writeText('|V7-after-drag')
  await sleep(120)
  chord(VK.V, [VK.CONTROL])
  await sleep(600)

  pet.destroy()

  // Let the target's timer fire and write what it holds.
  console.log('\n  reading what the target received…')
  let text = ''
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try {
      text = readFileSync(outFile, 'utf8')
      break
    } catch {
      await sleep(500)
    }
  }

  report(
    'P3 text still lands in the target after the pet was clicked',
    text.includes(marker),
    text ? `target holds ${JSON.stringify(text.trim().slice(0, 80))}` : 'target wrote nothing'
  )
  report(
    'P4 text still lands in the target after the pet was dragged',
    text.includes('V7-after-drag'),
    text.includes('V7-after-drag') ? '' : 'the drag cost the caret'
  )

  finish(child)
})

function finish(child) {
  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      (failed.length ? `\nFAILED: ${failed.map((f) => f.name).join(', ')}` : '')
  )
  try {
    child?.kill()
  } catch {
    // Already gone.
  }
  app.exit(failed.length ? 1 : 0)
}
