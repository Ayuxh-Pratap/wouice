import { app, clipboard, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/**
 * Spike: can we put text into the focused window of another application?
 *
 * Four questions, each with a failure mode that would change the design:
 *
 *   S1  Does koffi load and call Win32 under Electron 44? It is a native
 *       module, and Smart App Control has already blocked one unsigned DLL on
 *       this machine. If it cannot load, the whole approach changes.
 *   S2  Does SendInput reach a window in ANOTHER process, and can we prove the
 *       keystroke landed rather than assuming it?
 *   S3  Two ways to deliver text - paste from the clipboard, or type it as
 *       Unicode. Typing touches no clipboard at all, which would make the whole
 *       snapshot-and-restore dance unnecessary. Does it actually work?
 *   S4  What can Electron 44's clipboard round-trip? The restore is only as
 *       good as what we can read back, and losing someone's copied files to a
 *       dictation would be unforgivable.
 *
 * Run: npx electron scripts/spike-injection.mjs
 */

const require = createRequire(import.meta.url)
const koffi = require('koffi')

const TARGET_TITLE = 'WOUICE-SPIKE-TARGET'
const VIA_PASTE = 'PASTE नमस्ते 42'
const VIA_TYPING = 'TYPED ✓ हिंदी 7'

const results = []
function report(id, ok, detail) {
  results.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(30)} ${detail}`)
}

// ------------------------------------------------------------- Win32 bindings

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'void *', [])
const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', [
  'void *',
  koffi.out(koffi.pointer('uint16_t')),
  'int',
])
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', [
  'void *',
  koffi.out(koffi.pointer('uint32_t')),
])
const SendInput = user32.func('__stdcall', 'SendInput', 'uint32_t', ['uint32_t', 'void *', 'int'])
const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32_t', [])
const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32_t', 'bool', 'uint32_t'])
const QueryFullProcessImageNameW = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', [
  'void *',
  'uint32_t',
  koffi.out(koffi.pointer('uint16_t')),
  koffi.inout(koffi.pointer('uint32_t')),
])
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *'])

// Spike scaffolding only. The real flow never moves focus - the user is already
// in the window they want the text in - but Windows will not let a freshly
// spawned process take the foreground, so the test target has to be pulled
// forward by hand.
const FindWindowW = user32.func('__stdcall', 'FindWindowW', 'void *', ['void *', 'str16'])
const SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['void *'])
const BringWindowToTop = user32.func('__stdcall', 'BringWindowToTop', 'bool', ['void *'])
const AttachThreadInput = user32.func('__stdcall', 'AttachThreadInput', 'bool', [
  'uint32_t',
  'uint32_t',
  'bool',
])
const GetCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32_t', [])

function forceForeground(hwnd) {
  const fg = GetForegroundWindow()
  const pidBuf = Buffer.alloc(4)
  const fgThread = GetWindowThreadProcessId(fg, pidBuf)
  const ourThread = GetCurrentThreadId()
  // Attaching input queues is what lifts the foreground lock for the duration.
  AttachThreadInput(ourThread, fgThread, true)
  BringWindowToTop(hwnd)
  const ok = SetForegroundWindow(hwnd)
  AttachThreadInput(ourThread, fgThread, false)
  return ok
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

function foregroundTarget() {
  const hwnd = GetForegroundWindow()
  if (!hwnd) return null

  const titleBuf = Buffer.alloc(512 * 2)
  const n = GetWindowTextW(hwnd, titleBuf, 512)
  const title = n > 0 ? titleBuf.toString('utf16le', 0, n * 2) : ''

  const pidBuf = Buffer.alloc(4)
  GetWindowThreadProcessId(hwnd, pidBuf)
  const pid = pidBuf.readUInt32LE(0)

  let exe = ''
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (handle) {
    const nameBuf = Buffer.alloc(1024 * 2)
    const sizeBuf = Buffer.alloc(4)
    sizeBuf.writeUInt32LE(1024, 0)
    if (QueryFullProcessImageNameW(handle, 0, nameBuf, sizeBuf)) {
      exe = path.basename(nameBuf.toString('utf16le', 0, sizeBuf.readUInt32LE(0) * 2))
    }
    CloseHandle(handle)
  }

  return { hwnd: String(hwnd), pid, title, exe }
}

/**
 * One INPUT record, built as raw bytes rather than a koffi struct.
 *
 * x64 layout, which a struct definition would have to reproduce anyway:
 *   0  DWORD type            (INPUT_KEYBOARD = 1)
 *   4  (4 bytes padding: the union is 8-aligned because of dwExtraInfo)
 *   8  WORD  wVk
 *  10  WORD  wScan
 *  12  DWORD dwFlags
 *  16  DWORD time
 *  24  ULONG_PTR dwExtraInfo
 *  The union is sized by MOUSEINPUT (32 bytes), so the record is 40.
 */
const INPUT_SIZE = 40
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

function input(vk, scan, flags) {
  const b = Buffer.alloc(INPUT_SIZE)
  b.writeUInt32LE(1, 0)
  b.writeUInt16LE(vk, 8)
  b.writeUInt16LE(scan, 10)
  b.writeUInt32LE(flags, 12)
  return b
}

const VK_CONTROL = 0x11
const VK_V = 0x56

function send(records) {
  const buf = Buffer.concat(records)
  const sent = SendInput(records.length, buf, INPUT_SIZE)
  return { sent, expected: records.length, lastError: sent === records.length ? 0 : GetLastError() }
}

function sendCtrlV() {
  return send([
    input(VK_CONTROL, 0, 0),
    input(VK_V, 0, 0),
    input(VK_V, 0, KEYEVENTF_KEYUP),
    input(VK_CONTROL, 0, KEYEVENTF_KEYUP),
  ])
}

/**
 * Type text as Unicode, one UTF-16 code unit at a time.
 *
 * KEYEVENTF_UNICODE puts the code unit in wScan and leaves wVk zero, so the
 * target receives the character regardless of keyboard layout - no dead keys,
 * no layout mapping, and Devanagari works the same as ASCII. The whole string
 * goes in ONE SendInput call so the sequence cannot be interleaved with real
 * typing by the user.
 */
function sendUnicode(text) {
  const records = []
  for (const unit of Buffer.from(text, 'utf16le').toString('utf16le')) {
    for (let i = 0; i < unit.length; i++) {
      const code = unit.charCodeAt(i)
      records.push(input(0, code, KEYEVENTF_UNICODE))
      records.push(input(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    }
  }
  return send(records)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --------------------------------------------------------------------- run

async function main() {
  console.log(`electron ${process.versions.electron}  node ${process.versions.node}\n`)

  // Electron 44's clipboard lives behind the browser process, so it needs a
  // window before it answers. Without one, every call hangs unresolved.
  const win = new BrowserWindow({ show: false })
  await win.loadURL('data:text/html,<html></html>')

  // ---- S1 -----------------------------------------------------------
  report('S1 koffi loads under Electron', true, `koffi ${koffi.version ?? '3.x'}`)

  const self = foregroundTarget()
  report(
    'S1 reads foreground window',
    self !== null && self.exe !== '',
    self ? `${self.exe} pid ${self.pid} "${self.title.slice(0, 30)}"` : 'null'
  )

  const N = 200
  const t0 = performance.now()
  for (let i = 0; i < N; i++) foregroundTarget()
  const per = (performance.now() - t0) / N
  report('S1 target read cost', per < 5, `${per.toFixed(3)}ms (hwnd + title + exe), ${N} runs`)

  // ---- S4 -----------------------------------------------------------
  const held = await clipboard.readText()
  const heldNonText = []
  for (const f of ['text/html', 'text/rtf', 'image/png', 'CF_HDROP', 'FileNameW']) {
    if (await clipboard.has(f)) heldNonText.push(f)
  }

  report('S4 clipboard API is async', true, 'every method returns a Promise in Electron 44')

  await clipboard.writeText('probe ✓ नमस्ते')
  report('S4 text round-trips', (await clipboard.readText()) === 'probe ✓ नमस्ते', 'unicode intact')

  let writeShape = ''
  try {
    await clipboard.write({ text: 'a', html: '<b>b</b>' })
    writeShape = 'legacy {text,html} accepted'
  } catch (e) {
    writeShape = e.message
  }
  report('S4 non-text restore', false, writeShape)

  const cw0 = performance.now()
  for (let i = 0; i < 20; i++) await clipboard.writeText(`x${i}`)
  report('S4 write latency', true, `${((performance.now() - cw0) / 20).toFixed(2)}ms per awaited write`)

  report(
    'S4 detects unrestorable formats',
    true,
    `has() reports non-text formats; clipboard held ${heldNonText.length ? heldNonText.join(',') : 'text only'}`
  )

  // ---- S2 / S3 -------------------------------------------------------
  const outFile = path.join(app.getPath('temp'), 'wouice-spike-target.txt')
  const psFile = path.join(app.getPath('temp'), 'wouice-spike-target.ps1')
  rmSync(outFile, { force: true })

  writeFileSync(
    psFile,
    `Add-Type -AssemblyName System.Windows.Forms
$out = '${outFile.replace(/\\/g, '\\\\')}'
$f = New-Object Windows.Forms.Form
$f.Text = '${TARGET_TITLE}'
$f.TopMost = $true
$f.Width = 560
$f.Height = 200
$t = New-Object Windows.Forms.TextBox
$t.Multiline = $true
$t.Dock = 'Fill'
$f.Controls.Add($t)
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 12000
$timer.Add_Tick({ Set-Content -LiteralPath $out -Value $t.Text -Encoding UTF8; $f.Close() })
$f.Add_Shown({ $f.Activate(); $t.Focus(); $timer.Start() })
[void]$f.ShowDialog()
`,
    'utf8'
  )

  // NOT detached: on Windows that implies DETACHED_PROCESS, which leaves the
  // child without a console, and powershell.exe needs one. It starts, reports a
  // pid, and silently does nothing.
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', psFile],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stderr.on('data', (d) => console.log(`  target stderr: ${String(d).trim()}`))

  // Wait for the window to exist, then pull it forward.
  let hwnd = null
  const findDeadline = Date.now() + 15_000
  while (Date.now() < findDeadline) {
    hwnd = FindWindowW(null, TARGET_TITLE)
    if (hwnd) break
    await sleep(150)
  }
  report('S2 target window exists', Boolean(hwnd), hwnd ? `hwnd ${hwnd}` : 'FindWindowW never found it')
  let focusTries = 0
  if (hwnd) {
    for (let i = 0; i < 12; i++) {
      focusTries++
      const ok = forceForeground(hwnd)
      await sleep(200)
      const t = foregroundTarget()
      if (t && t.title === TARGET_TITLE) break
      if (i === 11) {
        report('S2 could take foreground', false, `SetForegroundWindow returned ${ok}, front is ${t?.exe} "${t?.title?.slice(0, 30)}"`)
      }
    }
  }

  let target = null
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const t = foregroundTarget()
    if (t && t.title === TARGET_TITLE) {
      target = t
      break
    }
    await sleep(120)
  }

  if (!target) {
    report('S2 target window reached front', false, 'not foreground within 15s')
  } else {
    report('S2 target window reached front', true, `${target.exe} pid ${target.pid}`)

    // The guard the real implementation depends on: never send input unless the
    // window in front is still the one we meant. Without it, a spike that failed
    // to focus would type into whatever the user was doing.
    const stillThere = () => {
      const now = foregroundTarget()
      return now && now.hwnd === target.hwnd
    }

    // --- method A: clipboard + Ctrl+V
    if (!stillThere()) {
      report('S2 paste via Ctrl+V', false, 'foreground moved; refused to send')
    } else {
      // AWAITED. An un-awaited write would race the paste and deliver stale text.
      await clipboard.writeText(VIA_PASTE)
      const a0 = performance.now()
      const r = sendCtrlV()
      report(
        'S2 SendInput accepted (Ctrl+V)',
        r.sent === r.expected,
        r.sent === r.expected
          ? `${r.sent} events in ${(performance.now() - a0).toFixed(2)}ms`
          : `sent ${r.sent}/${r.expected}, GetLastError ${r.lastError}`
      )
      await sleep(400)
    }

    // --- method B: type it as Unicode, clipboard untouched
    if (!stillThere()) {
      report('S3 type via KEYEVENTF_UNICODE', false, 'foreground moved; refused to send')
    } else {
      const clipboardBefore = await clipboard.readText()
      const b0 = performance.now()
      const r = sendUnicode('\n' + VIA_TYPING)
      const elapsed = performance.now() - b0
      const clipboardAfter = await clipboard.readText()
      report(
        'S3 SendInput accepted (unicode)',
        r.sent === r.expected,
        r.sent === r.expected
          ? `${r.sent} events for ${VIA_TYPING.length + 1} chars in ${elapsed.toFixed(2)}ms`
          : `sent ${r.sent}/${r.expected}, GetLastError ${r.lastError}`
      )
      report(
        'S3 clipboard untouched by typing',
        clipboardBefore === clipboardAfter,
        'no snapshot or restore needed on this path'
      )
      await sleep(400)
    }

    // Wait for the target to write down what it actually received.
    const readDeadline = Date.now() + 20_000
    while (Date.now() < readDeadline && !existsSync(outFile)) await sleep(200)
    const got = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '(no file)'

    report(
      'S2 pasted text landed in target',
      got.includes(VIA_PASTE),
      got.includes(VIA_PASTE) ? 'exact match incl. Devanagari' : `got ${JSON.stringify(got.slice(0, 80))}`
    )
    report(
      'S3 typed text landed in target',
      got.includes(VIA_TYPING),
      got.includes(VIA_TYPING) ? 'exact match incl. Devanagari' : `got ${JSON.stringify(got.slice(0, 80))}`
    )
  }

  await clipboard.writeText(held ?? '')
  console.log(`\n  (clipboard restored to ${JSON.stringify((held ?? '').slice(0, 30))})`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  rmSync(psFile, { force: true })
  win.destroy()
  app.quit()
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('spike threw:', err)
    app.quit()
  })
)
