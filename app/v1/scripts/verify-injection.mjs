import { app, clipboard, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { VK, chord, findWindow, forceForeground, foregroundTarget, windowTitle } from './lib/win32.mjs'
import { Injector } from './build/injector.mjs'

/**
 * Acceptance test for the real injection module, not the spike.
 *
 * The spikes proved the mechanism. This exercises `Injector` itself - the code
 * that ships - against a live window, and checks the two acceptance criteria
 * that injection exists to satisfy:
 *
 *   A2  Zero wrong-window insertions. Capture a target, move focus, and confirm
 *       it refuses rather than typing into whatever is now in front.
 *   A3  The clipboard is always restored. Put something on it, dictate, and
 *       confirm it comes back.
 *
 * Build the module first:
 *   npx esbuild desktop/src/main/injection/injector.ts --bundle --platform=node \
 *     --format=esm --external:electron --external:koffi --outfile=scripts/build/injector.mjs
 *
 * Run: npx electron scripts/verify-injection.mjs
 */

const LONG = (
  'The quick brown fox jumps over the lazy dog while मैं यह देख रहा हूँ and the ' +
  'meeting continues without interruption. '
).repeat(5).slice(0, 600)
const SHORT = 'wouice ✓ नमस्ते 42'

const results = []
function report(id, ok, detail) {
  results.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(38)} ${detail}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function hash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const work = mkdtempSync(path.join(tmpdir(), 'wouice-verify-'))
const isTarget = (t) => t.startsWith('WOUICE-VERIFY')

/** What the page currently holds, read out of its own window title. */
function pageState() {
  const m = /WOUICE-VERIFY:(\d+):(\w+)/.exec(windowTitle(findWindow(isTarget)?.hwnd))
  return m ? { length: Number(m[1]), hash: m[2] } : null
}

function matches(text) {
  const s = pageState()
  return s !== null && s.length === text.length && s.hash === hash(text)
}

async function focusTarget() {
  for (let i = 0; i < 15; i++) {
    const w = findWindow(isTarget)
    if (w) forceForeground(w.hwnd)
    await sleep(220)
    const fg = foregroundTarget()
    if (fg && isTarget(fg.title)) return true
  }
  return false
}

async function main() {
  console.log(`electron ${process.versions.electron}\n`)
  console.log('A window will be opened and typed into. Do not touch the keyboard.\n')

  // Electron 44's clipboard needs a window to exist before it answers.
  const holder = new BrowserWindow({ show: false })
  await holder.loadURL('data:text/html,<html></html>')
  const held = await clipboard.readText()

  const page = path.join(work, 'verify.html')
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><title>WOUICE-VERIFY-READY</title>
<body style="font:14px system-ui;padding:16px">
<p>Wouice injection acceptance test. Closes itself.</p>
<textarea id="t" autofocus style="width:96%;height:200px"></textarea>
<script>
function h(s){let x=5381;for(let i=0;i<s.length;i++)x=((x<<5)+x+s.charCodeAt(i))>>>0;return x.toString(36)}
const t=document.getElementById('t')
const set=()=>{document.title='WOUICE-VERIFY:'+t.value.length+':'+h(t.value)}
t.addEventListener('input',set); t.focus(); set()
</script>`,
    'utf8'
  )

  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  if (!existsSync(chrome)) {
    report('chrome available', false, chrome)
    return finish(holder, held)
  }
  spawn(chrome, ['--new-window', `file:///${page.replace(/\\/g, '/')}`], { stdio: 'ignore' })

  const deadline = Date.now() + 25_000
  while (Date.now() < deadline && !findWindow(isTarget)) await sleep(250)
  if (!(await focusTarget())) {
    report('target focused', false, `front is ${foregroundTarget()?.exe}`)
    return finish(holder, held)
  }
  report('target focused', true, `${foregroundTarget()?.exe}`)

  let enabled = true
  const injector = new Injector({
    enabled: () => enabled,
    pasteOverrides: () => ({}),
  })

  // --- the ordinary case: long text, clipboard restored ------------------
  {
    const sentinel = 'SENTINEL-' + Date.now()
    await clipboard.writeText(sentinel)
    injector.captureTarget()
    const r = await injector.deliver(LONG)
    await sleep(800)

    report(
      'long text inserted',
      r.delivered === 'inserted' && matches(LONG),
      r.delivered === 'inserted'
        ? `${LONG.length} chars via ${r.method} in ${r.ms.toFixed(0)}ms, hash ${matches(LONG) ? 'matches' : 'DIFFERS'}`
        : `delivered ${r.delivered}: ${r.reason}`
    )
    report(
      'A3 clipboard restored',
      (await clipboard.readText()) === sentinel,
      `expected the sentinel back, got ${JSON.stringify((await clipboard.readText()).slice(0, 30))}`
    )
    report('clipboard not reported replaced', r.clipboardReplaced === false, `${r.clipboardReplaced}`)
  }

  // --- A2: focus moves after capture -------------------------------------
  {
    await focusTarget()
    const before = pageState()
    injector.captureTarget()

    // Move the foreground somewhere else, exactly as an alt-tab would.
    holder.show()
    holder.focus()
    await sleep(600)

    const sentinel = 'A2-' + Date.now()
    await clipboard.writeText(sentinel)
    const r = await injector.deliver(SHORT)
    await sleep(500)

    report(
      'A2 refuses when focus moved',
      r.delivered === 'copied',
      r.delivered === 'copied' ? `copied instead: "${r.reason}"` : `INSERTED into ${r.targetExe}`
    )
    const after = pageState()
    report(
      'A2 target was left untouched',
      after !== null && before !== null && after.hash === before.hash,
      after && before ? `hash ${after.hash === before.hash ? 'unchanged' : 'CHANGED'}` : 'unreadable'
    )
    report(
      'refusal leaves text on the clipboard',
      (await clipboard.readText()) === SHORT,
      `so it can still be pasted by hand`
    )
    holder.hide()
  }

  // --- the setting is honoured -------------------------------------------
  {
    await focusTarget()
    const before = pageState()
    enabled = false
    injector.captureTarget()
    const r = await injector.deliver(SHORT)
    await sleep(400)
    enabled = true

    report(
      'copy-only setting is honoured',
      r.delivered === 'copied' && r.method === 'copy',
      `"${r.reason}"`
    )
    const after = pageState()
    report(
      'nothing was inserted while off',
      after !== null && before !== null && after.hash === before.hash,
      'target unchanged'
    )
  }

  // --- repeat, because a race that passes once proves nothing ------------
  {
    await focusTarget()
    let exact = 0
    const runs = 5
    for (let i = 0; i < runs; i++) {
      const fg = foregroundTarget()
      if (!fg || !isTarget(fg.title)) break
      // Replace rather than append: the textarea keeps what the last run put
      // there, and a doubled string is a harness artefact, not a defect.
      chord(0x41, [VK.CONTROL])
      await sleep(150)
      await clipboard.writeText('keep-' + i)
      injector.captureTarget()
      await injector.deliver(LONG)
      await sleep(700)
      if (matches(LONG) && (await clipboard.readText()) === 'keep-' + i) exact++
      await sleep(200)
    }
    report(`stable over ${runs} consecutive dictations`, exact === runs, `${exact}/${runs} exact with clipboard restored`)
  }

  const w = findWindow(isTarget)
  if (w) {
    forceForeground(w.hwnd)
    await sleep(300)
  }
  await finish(holder, held)
}

async function finish(holder, held) {
  await clipboard.writeText(held ?? '')
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) console.log(failed.map((f) => `  - ${f.id}: ${f.detail}`).join('\n'))
  rmSync(work, { recursive: true, force: true })
  holder.destroy()
  app.quit()
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('verify threw:', err)
    app.quit()
  })
)
