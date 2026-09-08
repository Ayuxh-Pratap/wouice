import { app, clipboard, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  VK,
  chord,
  findWindow,
  forceForeground,
  foregroundTarget,
  typeUnicodePaced,
  windowTitle,
} from './lib/win32.mjs'

/**
 * Spike V6b: does Unicode typing survive contact with the applications people
 * actually dictate into?
 *
 * V6 proved SendInput reaches another process, against one WinForms text box.
 * That is not enough to make typing the default. Synthetic Unicode is handled
 * inconsistently: a console host, a browser and an Electron editor each drain
 * the input queue differently, and the known failure is silent - characters
 * dropped or reordered when they arrive faster than the target consumes them.
 *
 * So each target here reports back what it ACTUALLY received, by a route that
 * cannot be fudged:
 *
 *   Chrome            a page that hashes its textarea into document.title,
 *                     which we read straight off the window
 *   Windows Terminal   PowerShell Read-Host writing the line to a file
 *   VS Code            type, Ctrl+S, read the saved file
 *
 * Every send is guarded: nothing is typed unless the window in front is still
 * the one we launched. That guard is the product's real protection against
 * pasting into the wrong window, so exercising it here is part of the point.
 *
 * Run: npx electron scripts/spike-injection-targets.mjs
 */

const SHORT = 'V6b ✓ नमस्ते hello 42'
/** ~600 chars: a long dictation, and the length where dropping starts. */
const LONG = (
  'The quick brown fox jumps over the lazy dog while मैं यह देख रहा हूँ and the ' +
  'meeting continues without interruption. '
).repeat(5).slice(0, 600)

const results = []
function report(id, ok, detail) {
  results.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(34)} ${detail}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** djb2 over UTF-16 code units. Mirrored in the page so both sides agree. */
function hash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const work = mkdtempSync(path.join(tmpdir(), 'wouice-v6b-'))

/**
 * Wait for a window, pull it forward, and confirm it got there.
 *
 * Returns the target only if it is genuinely in the foreground, so a caller
 * that gets null must not send input.
 */
async function focusWindow(match, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let found = null
  while (Date.now() < deadline) {
    found = findWindow(match)
    if (found) break
    await sleep(250)
  }
  if (!found) {
    report(`${label} window appeared`, false, 'never found within timeout')
    return null
  }

  for (let i = 0; i < 15; i++) {
    forceForeground(found.hwnd)
    await sleep(220)
    const fg = foregroundTarget()
    if (fg && match(fg.title)) {
      report(`${label} focused`, true, `${fg.exe} pid ${fg.pid}`)
      return { ...found, match }
    }
  }
  const fg = foregroundTarget()
  report(`${label} focused`, false, `front is ${fg?.exe} "${fg?.title?.slice(0, 40)}"`)
  return null
}

/**
 * The pace measured as reliable against Chrome: 100 characters per SendInput
 * call, 4 ms apart. One call for the whole string was exact on only 2 runs in 5
 * and lost up to 73 characters, so this is not a tuning preference - it is the
 * difference between working and silently truncating someone's dictation.
 */
const PACE = { batch: 200, gapMs: 4 }

/** Type only if the intended window is still in front. This is the A2 guard. */
async function guardedType(target, text, opts = PACE) {
  const fg = foregroundTarget()
  if (!fg || !target.match(fg.title)) {
    return { refused: true, front: `${fg?.exe} "${fg?.title?.slice(0, 30)}"` }
  }
  const r = await typeUnicodePaced(text, opts)
  return { ...r, refused: false }
}

/**
 * Put the text on the clipboard and press the paste key.
 *
 * The write is AWAITED. Electron 44's clipboard is asynchronous, and pasting
 * from an unawaited write is a race that delivers the previous dictation.
 */
async function guardedPaste(target, text, pasteKey = { vk: VK.V, mods: [VK.CONTROL] }) {
  const fg = foregroundTarget()
  if (!fg || !target.match(fg.title)) {
    return { refused: true, front: `${fg?.exe} "${fg?.title?.slice(0, 30)}"` }
  }
  await clipboard.writeText(text)
  const t0 = performance.now()
  const r = chord(pasteKey.vk, pasteKey.mods)
  return { ...r, ms: performance.now() - t0, refused: false, batches: 1 }
}

function guardedChord(target, vk, mods) {
  const fg = foregroundTarget()
  if (!fg || !target.match(fg.title)) return { refused: true }
  return { ...chord(vk, mods), refused: false }
}

function verdict(label, expected, got, sendResult) {
  if (sendResult.refused) {
    report(label, false, `refused: front was ${sendResult.front}`)
    return
  }
  const ok = got === expected
  const detail = ok
    ? `${expected.length} chars exact, ${sendResult.ms.toFixed(0)}ms, ${sendResult.batches ?? 1} batch(es)`
    : `expected ${expected.length} chars, got ${got.length} (SendInput ${sendResult.sent}/${sendResult.expected}): ${JSON.stringify(got.slice(0, 50))}`
  report(label, ok, detail)
}

// ------------------------------------------------------------------ Chrome

async function chromeTest() {
  const page = path.join(work, 'target.html')
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><title>WOUICE-CHROME-READY</title>
<body style="font:14px system-ui;padding:16px">
<p>Wouice injection spike. This window closes itself.</p>
<textarea id="t" autofocus style="width:96%;height:180px"></textarea>
<script>
// The page cannot write a file, but it can put a checksum in the title, and
// the title is readable from outside with GetWindowTextW. Length plus hash
// proves an exact match without depending on the title surviving intact.
function h(s){let x=5381;for(let i=0;i<s.length;i++)x=((x<<5)+x+s.charCodeAt(i))>>>0;return x.toString(36)}
const t=document.getElementById('t')
t.addEventListener('input',()=>{document.title='WOUICE-CHROME:'+t.value.length+':'+h(t.value)})
t.focus()
</script>`,
    'utf8'
  )

  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  if (!existsSync(chrome)) {
    report('Chrome available', false, chrome)
    return
  }
  spawn(chrome, ['--new-window', `file:///${page.replace(/\\/g, '/')}`], { stdio: 'ignore' })

  const isChrome = (t) => t.startsWith('WOUICE-CHROME')
  const target = await focusWindow(isChrome, 'Chrome')
  if (!target) return

  for (const [label, text, how] of [
    ['Chrome type short', SHORT, 'type'],
    ['Chrome type long (600)', LONG, 'type'],
    ['Chrome paste long (600)', LONG, 'paste'],
  ]) {
    // Clear anything already there, so the runs do not accumulate.
    guardedChord(target, 0x41, [VK.CONTROL]) // Ctrl+A
    await sleep(150)
    const r = how === 'paste' ? await guardedPaste(target, text) : await guardedType(target, text)
    await sleep(700)
    const title = windowTitle(findWindow(isChrome)?.hwnd)
    const m = /WOUICE-CHROME:(\d+):(\w+)/.exec(title)
    if (r.refused) {
      report(label, false, `refused: front was ${r.front}`)
    } else if (!m) {
      report(label, false, `title never updated: ${JSON.stringify(title.slice(0, 50))}`)
    } else {
      const ok = Number(m[1]) === text.length && m[2] === hash(text)
      report(
        label,
        ok,
        ok
          ? `${text.length} chars, hash matches, ${r.ms.toFixed(0)}ms`
          : `got ${m[1]} chars hash ${m[2]}, wanted ${text.length}/${hash(text)}`
      )
    }
  }

  const t = findWindow(isChrome)
  if (t) {
    forceForeground(t.hwnd)
    await sleep(300)
    guardedChord({ match: isChrome }, VK.W, [VK.CONTROL])
  }
}

// -------------------------------------------------------- Windows Terminal

async function terminalTest() {
  const out = path.join(work, 'term.txt')
  rmSync(out, { force: true })
  const ps = path.join(work, 'term.ps1')
  writeFileSync(
    ps,
    `$host.UI.RawUI.WindowTitle = 'WOUICE-TERM'
$line = Read-Host
Set-Content -LiteralPath '${out.replace(/\\/g, '\\\\')}' -Value $line -Encoding UTF8 -NoNewline
`,
    'utf8'
  )

  spawn('wt.exe', ['-w', 'new', '--title', 'WOUICE-TERM', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], {
    stdio: 'ignore',
  })

  const isTerm = (t) => t.includes('WOUICE-TERM')
  const target = await focusWindow(isTerm, 'Terminal')
  if (!target) return

  // A console host echoes and edits as it receives, which makes it the slowest
  // consumer of the three. Ctrl+V is also the combination the spec expected to
  // be wrong here, so it is worth measuring rather than assuming.
  const r = await guardedPaste(target, LONG)
  await sleep(700)
  guardedChord(target, VK.RETURN)

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !existsSync(out)) await sleep(200)
  const got = existsSync(out) ? readFileSync(out, 'utf8').replace(/^\uFEFF/, '') : '(no file)'
  verdict('Terminal paste long, Ctrl+V', LONG, got, r)
}

// ----------------------------------------------------------------- VS Code

async function vscodeTest() {
  const file = path.join(work, 'spike-vscode.txt')
  writeFileSync(file, '', 'utf8')

  // A NEW window, never the user's existing one: typing into their open work
  // would be a real cost if the guard ever failed.
  spawn('cmd.exe', ['/c', 'code', '--new-window', '--disable-extensions', file], { stdio: 'ignore' })

  const isCode = (t) => t.startsWith('spike-vscode.txt') && t.includes('Visual Studio Code')
  const target = await focusWindow(isCode, 'VS Code', 40_000)
  if (!target) return

  // Give the editor a moment to actually take the caret after the window opens.
  await sleep(1500)

  for (const [label, text, how] of [
    ['VS Code type short', SHORT, 'type'],
    ['VS Code type long (600)', LONG, 'type'],
    ['VS Code paste long (600)', LONG, 'paste'],
  ]) {
    guardedChord(target, 0x41, [VK.CONTROL]) // Ctrl+A, replace previous run
    await sleep(150)
    const r = how === 'paste' ? await guardedPaste(target, text) : await guardedType(target, text)
    await sleep(500)
    guardedChord(target, VK.S, [VK.CONTROL])
    await sleep(900)
    const got = existsSync(file) ? readFileSync(file, 'utf8') : '(no file)'
    verdict(label, text, got, r)
  }

  const t = findWindow(isCode)
  if (t) {
    forceForeground(t.hwnd)
    await sleep(300)
    guardedChord({ match: isCode }, VK.F4, [VK.MENU])
  }
}

// --------------------------------------------------------------------- run

async function main() {
  console.log(`electron ${process.versions.electron}\n`)
  console.log('Windows will be opened and typed into. Do not touch the keyboard.\n')

  // Electron 44's clipboard lives behind the browser process and hangs
  // unresolved until a window exists. Snapshot first, so 600 characters of test
  // text are never left sitting on someone's clipboard.
  const holder = new BrowserWindow({ show: false })
  await holder.loadURL('data:text/html,<html></html>')
  const heldClipboard = await clipboard.readText()

  await chromeTest()
  console.log('')
  await terminalTest()
  console.log('')
  await vscodeTest()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) console.log(failed.map((f) => `  - ${f.id}: ${f.detail}`).join('\n'))
  await clipboard.writeText(heldClipboard ?? '')
  rmSync(work, { recursive: true, force: true })
  holder.destroy()
  app.quit()
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('spike threw:', err)
    app.quit()
  })
)
