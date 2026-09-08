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
  isProcessElevated,
  typeUnicodePaced,
} from './lib/win32.mjs'

/**
 * Spike V6c: what happens when the target window runs elevated?
 *
 * Windows refuses synthetic input crossing from a lower integrity level to a
 * higher one - User Interface Privilege Isolation. `SendInput` reports success
 * and the keystrokes go nowhere, which is the worst shape a failure can take:
 * the transcript is gone and nothing anywhere says so.
 *
 * The shipped policy has a stand-in for this. It refuses when the target
 * executable cannot be read, on the theory that a failed `OpenProcess` means a
 * higher integrity level. That theory is untested, and if
 * `PROCESS_QUERY_LIMITED_INFORMATION` succeeds across elevation - which is what
 * "limited" exists for - the guard never fires and elevated windows fail
 * silently.
 *
 * So this measures three things:
 *   1. Can we read the executable of an elevated process at all?
 *   2. Can we read its token, i.e. is elevation directly detectable?
 *   3. Does paste actually fail, or does Windows allow it?
 *
 * REQUIRES a UAC prompt to be approved. Nothing here runs elevated itself; it
 * launches an elevated target and then tries, from outside, to type into it.
 *
 * Run: npx electron scripts/spike-injection-elevated.mjs
 */

const TITLE = 'WOUICE-ELEVATED-TARGET'
const PAYLOAD = 'wouice elevated probe ✓ नमस्ते 42'

const results = []
function report(id, ok, detail) {
  results.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(40)} ${detail}`)
}
function note(id, detail) {
  console.log(`      ${id.padEnd(40)} ${detail}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const work = mkdtempSync(path.join(tmpdir(), 'wouice-elev-'))
const isTarget = (t) => t.includes(TITLE)

async function main() {
  console.log(`electron ${process.versions.electron}\n`)

  const holder = new BrowserWindow({ show: false })
  await holder.loadURL('data:text/html,<html></html>')
  const held = await clipboard.readText()

  const selfElevated = isProcessElevated(0)
  note('this process elevated', String(selfElevated))
  if (selfElevated) {
    console.log('\nThis process is already elevated, so there is no privilege boundary to test.')
    console.log('Run it from a normal, non-elevated shell.')
    return finish(holder, held)
  }

  const outFile = path.join(work, 'elevated.txt')
  const psFile = path.join(work, 'elevated.ps1')
  writeFileSync(
    psFile,
    `Add-Type -AssemblyName System.Windows.Forms
$out = '${outFile.replace(/\\/g, '\\\\')}'
Set-Content -LiteralPath $out -Value '' -Encoding UTF8
$f = New-Object Windows.Forms.Form
$f.Text = '${TITLE}'
$f.TopMost = $true
$f.Width = 620
$f.Height = 220
$t = New-Object Windows.Forms.TextBox
$t.Multiline = $true
$t.Dock = 'Fill'
$f.Controls.Add($t)
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 30000
$timer.Add_Tick({ Set-Content -LiteralPath $out -Value $t.Text -Encoding UTF8 -NoNewline; $f.Close() })
$f.Add_Shown({ $f.Activate(); $t.Focus(); $timer.Start() })
[void]$f.ShowDialog()
`,
    'utf8'
  )

  console.log('\n>>> A UAC prompt is about to appear. Approve it to run the test. <<<\n')

  // Start-Process -Verb RunAs is what raises the prompt. The outer shell exits
  // immediately; the elevated one owns the window.
  spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-STA','-File','${psFile}'`,
    ],
    { stdio: 'ignore' }
  )

  // Generous: someone has to read and click the prompt.
  const deadline = Date.now() + 90_000
  let win = null
  while (Date.now() < deadline && !win) {
    win = findWindow(isTarget)
    if (!win) await sleep(500)
  }
  if (!win) {
    report('elevated target appeared', false, 'no window within 90s (prompt declined?)')
    return finish(holder, held)
  }
  report('elevated target appeared', true, 'window found')

  for (let i = 0; i < 20; i++) {
    forceForeground(win.hwnd)
    await sleep(250)
    const fg = foregroundTarget()
    if (fg && isTarget(fg.title)) break
  }
  const fg = foregroundTarget()
  if (!fg || !isTarget(fg.title)) {
    report('elevated target focused', false, `front is ${fg?.exe}; click the window and re-run`)
    return finish(holder, held)
  }
  report('elevated target focused', true, `pid ${fg.pid}`)

  // --- 1. can we identify it? -------------------------------------------
  report(
    'exe readable across elevation',
    fg.exe !== '',
    fg.exe
      ? `"${fg.exe}" - so the shipped "unreadable means elevated" guard does NOT fire`
      : 'empty, so the shipped guard would refuse correctly'
  )

  // --- 2. is elevation directly detectable? ------------------------------
  const elevated = isProcessElevated(fg.pid)
  report(
    'elevation detectable from outside',
    elevated === true,
    elevated === null
      ? 'token query denied - cannot tell, must assume it might be'
      : `TokenElevation reports ${elevated}`
  )

  // --- 3. does input actually get through? -------------------------------
  await clipboard.writeText(PAYLOAD)
  const paste = chord(VK.V, [VK.CONTROL])
  await sleep(600)
  const typed = await typeUnicodePaced('|TYPED', { batch: 200, gapMs: 4 })
  await sleep(600)

  note('SendInput return (paste)', `${paste.sent}/${paste.expected}, lastError ${paste.lastError}`)
  note('SendInput return (typing)', `${typed.sent}/${typed.expected}`)

  console.log('\n  waiting for the target to report what it received...')
  const readDeadline = Date.now() + 40_000
  let got = ''
  while (Date.now() < readDeadline) {
    if (existsSync(outFile)) {
      got = readFileSync(outFile, 'utf8').replace(/^﻿/, '')
      if (got.length > 0) break
    }
    await sleep(500)
  }

  const landed = got.includes(PAYLOAD)
  report(
    'input reached the elevated window',
    false,
    landed
      ? `IT DID: ${JSON.stringify(got.slice(0, 60))} - UIPI did not block it here`
      : `it did not, as expected: target holds ${JSON.stringify(got.slice(0, 40))}`
  )

  console.log('\n--- what this means for the policy ---')
  if (elevated === true) {
    console.log('Elevation IS detectable. The policy should query the token and refuse')
    console.log('outright, instead of relying on the executable being unreadable.')
  } else if (elevated === null) {
    console.log('Elevation is NOT detectable from here: the token query was denied.')
    console.log('Denial is itself the signal - a refused token query on a readable')
    console.log('process means higher integrity, so the policy can use that.')
  }
  if (!landed) {
    console.log('Input was silently dropped, confirming the failure mode: SendInput')
    console.log('reports success and nothing arrives. Refusing up front is the only fix.')
  }

  await finish(holder, held)
}

async function finish(holder, held) {
  await clipboard.writeText(held ?? '')
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks as expected`)
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
