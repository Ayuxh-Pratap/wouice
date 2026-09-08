import { app } from 'electron'
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
 * Spike V6d: at what length does Unicode typing stop being safe?
 *
 * The shipped policy caps typing at 120 characters, and that number was a guess
 * - chosen far below the shortest measured failure (585) precisely because the
 * boundary had never been measured. A guess in this position is not harmless:
 * too high and someone's dictation is silently truncated, too low and their
 * clipboard is needlessly destroyed.
 *
 * So bisect it. Chrome is the fast harness (it hashes its own contents into the
 * window title); VS Code is the harsh one, and gets a confirmation run at
 * whatever length Chrome says is safe, because V6b measured VS Code losing ALL
 * 585 characters where Chrome lost only a third.
 *
 * Run: npx electron scripts/spike-typing-length.mjs
 */

/** Production pacing: 100 characters per SendInput call, 4 ms apart. */
const PACE = { batch: 200, gapMs: 4 }
const LENGTHS = [40, 80, 120, 160, 200, 260, 320, 400, 500, 585]
const REPEATS = 5

/** Mixed script, because Devanagari is two bytes of nothing special to SendInput. */
const CORPUS = (
  'The quick brown fox jumps over the lazy dog while मैं यह देख रहा हूँ and the ' +
  'meeting continues without interruption. '
).repeat(6)

const sample = (n) => CORPUS.slice(0, n)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function hash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const work = mkdtempSync(path.join(tmpdir(), 'wouice-len-'))
const isChrome = (t) => t.startsWith('WOUICE-LEN')

async function focusMatching(match) {
  for (let i = 0; i < 15; i++) {
    const w = findWindow(match)
    if (w) forceForeground(w.hwnd)
    await sleep(200)
    const fg = foregroundTarget()
    if (fg && match(fg.title)) return true
  }
  return false
}

/** Type into Chrome and read back the length and hash from its own title. */
async function chromeRun(text) {
  chord(0x41, [VK.CONTROL])
  await sleep(120)
  const r = await typeUnicodePaced(text, PACE)
  await sleep(600)
  const m = /WOUICE-LEN:(\d+):(\w+)/.exec(windowTitle(findWindow(isChrome)?.hwnd))
  return {
    ok: m !== null && Number(m[1]) === text.length && m[2] === hash(text),
    landed: m ? Number(m[1]) : -1,
    ms: r.ms,
  }
}

async function main() {
  console.log(`electron ${process.versions.electron}`)
  console.log(`pacing: ${PACE.batch / 2} chars per call, ${PACE.gapMs}ms apart`)
  console.log('Do not touch the keyboard.\n')

  const page = path.join(work, 'len.html')
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><title>WOUICE-LEN-READY</title>
<body style="font:14px system-ui;padding:16px">
<p>Wouice typing-length spike. Closes itself.</p>
<textarea id="t" autofocus style="width:96%;height:220px"></textarea>
<script>
function h(s){let x=5381;for(let i=0;i<s.length;i++)x=((x<<5)+x+s.charCodeAt(i))>>>0;return x.toString(36)}
const t=document.getElementById('t')
const set=()=>{document.title='WOUICE-LEN:'+t.value.length+':'+h(t.value)}
t.addEventListener('input',set); t.focus(); set()
</script>`,
    'utf8'
  )

  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  if (!existsSync(chrome)) {
    console.log('FAIL  chrome not found')
    return app.quit()
  }
  spawn(chrome, ['--new-window', `file:///${page.replace(/\\/g, '/')}`], { stdio: 'ignore' })

  const deadline = Date.now() + 25_000
  while (Date.now() < deadline && !findWindow(isChrome)) await sleep(250)
  if (!(await focusMatching(isChrome))) {
    console.log(`FAIL  could not focus target; front is ${foregroundTarget()?.exe}`)
    return app.quit()
  }
  console.log(`chrome: pid ${foregroundTarget()?.pid}\n`)

  console.log(`  chars   exact      worst landed   mean`)
  console.log('  ' + '-'.repeat(48))

  let largestSafe = 0
  let firstFailure = null

  for (const n of LENGTHS) {
    const text = sample(n)
    let exact = 0
    let worst = n
    let total = 0
    let aborted = false

    for (let i = 0; i < REPEATS; i++) {
      let fg = foregroundTarget()
      if (!fg || !isChrome(fg.title)) {
        // A notification stole the foreground. That is the guard doing its job,
        // not a result - so take the window back and repeat the run rather than
        // recording a failure that says nothing about typing.
        if (!(await focusMatching(isChrome))) {
          console.log(`  ${String(n).padEnd(7)} refused: front is ${fg?.exe}`)
          aborted = true
          break
        }
        fg = foregroundTarget()
      }
      const r = await chromeRun(text)
      if (r.ok) exact++
      else worst = Math.min(worst, Math.max(r.landed, 0))
      total += r.ms
      await sleep(200)
    }
    if (aborted) break

    console.log(
      `  ${String(n).padEnd(7)} ${String(`${exact}/${REPEATS}`).padEnd(10)} ` +
        `${(exact === REPEATS ? '-' : String(worst)).padEnd(14)} ${(total / REPEATS).toFixed(0)}ms`
    )

    if (exact === REPEATS) largestSafe = n
    else if (firstFailure === null) firstFailure = n
  }

  console.log('')
  console.log(`largest length exact on all ${REPEATS} runs in Chrome: ${largestSafe}`)
  console.log(`first length that dropped anything:                   ${firstFailure ?? 'none'}`)

  // Close Chrome's window before VS Code takes the foreground.
  const w = findWindow(isChrome)
  if (w) {
    forceForeground(w.hwnd)
    await sleep(300)
    const fg = foregroundTarget()
    if (fg && isChrome(fg.title)) chord(VK.W, [VK.CONTROL])
  }
  await sleep(800)

  // --- confirm against the harsh target -------------------------------------
  // Chrome lost a third of 585 characters; VS Code lost all of them. A cap
  // measured only against the forgiving target would be wrong where it matters.
  if (largestSafe === 0) {
    console.log('\nNothing was safe in Chrome; skipping the VS Code confirmation.')
    return finish()
  }

  const candidate = largestSafe
  const file = path.join(work, 'len-vscode.txt')
  writeFileSync(file, '', 'utf8')
  spawn('cmd.exe', ['/c', 'code', '--new-window', '--disable-extensions', file], { stdio: 'ignore' })

  const isCode = (t) => t.startsWith('len-vscode.txt') && t.includes('Visual Studio Code')
  const found = Date.now() + 40_000
  while (Date.now() < found && !findWindow(isCode)) await sleep(300)
  if (!(await focusMatching(isCode))) {
    console.log(`\nVS Code did not focus; confirmation skipped (front ${foregroundTarget()?.exe})`)
    return finish()
  }
  await sleep(1500)

  console.log(`\nconfirming ${candidate} chars in VS Code, ${REPEATS} runs`)
  const text = sample(candidate)
  let exact = 0
  for (let i = 0; i < REPEATS; i++) {
    const fg = foregroundTarget()
    if (!fg || !isCode(fg.title)) {
      console.log(`  refused: front is ${fg?.exe}`)
      break
    }
    chord(0x41, [VK.CONTROL])
    await sleep(150)
    await typeUnicodePaced(text, PACE)
    await sleep(400)
    chord(VK.S, [VK.CONTROL])
    await sleep(800)
    if (existsSync(file) && readFileSync(file, 'utf8') === text) exact++
  }
  console.log(`  ${exact}/${REPEATS} exact in VS Code at ${candidate} chars`)

  const codeWin = findWindow(isCode)
  if (codeWin) {
    forceForeground(codeWin.hwnd)
    await sleep(300)
    const fg = foregroundTarget()
    if (fg && isCode(fg.title)) chord(VK.F4, [VK.MENU])
  }

  console.log('')
  if (exact === REPEATS) {
    console.log(`SAFE CAP: ${candidate} characters held in both targets.`)
    console.log(`Apply a margin before shipping it: this is a race, and V6b showed a`)
    console.log(`configuration passing five runs and failing the sixth under load.`)
  } else {
    console.log(`${candidate} held in Chrome but NOT in VS Code. The cap must come from`)
    console.log(`the harsh target, not the forgiving one.`)
  }
  finish()
}

function finish() {
  rmSync(work, { recursive: true, force: true })
  app.quit()
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('spike threw:', err)
    app.quit()
  })
)
