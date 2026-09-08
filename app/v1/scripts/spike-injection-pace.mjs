import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
 * Spike V6b, part two: how fast can Unicode typing actually be delivered?
 *
 * Part one established that one SendInput call for a 585-character string loses
 * text - a third of it in Chrome, all of it in VS Code. The events reach the
 * target; the target drops them when they arrive faster than it drains its
 * input queue. So the question is not "does typing work" but "at what pace",
 * and the answer has to come from measurement rather than a guessed constant.
 *
 * Chrome is the harness because it can hash its own contents into the window
 * title, which makes each configuration verifiable in under a second without
 * touching the filesystem.
 *
 * Run: npx electron scripts/spike-injection-pace.mjs
 */

const LONG = (
  'The quick brown fox jumps over the lazy dog while मैं यह देख रहा हूँ and the ' +
  'meeting continues without interruption. '
).repeat(5).slice(0, 600)

/** Records per SendInput call, and the pause after each. Two records per char. */
const CONFIGS = [
  { batch: 0, gapMs: 0, label: 'one call, no pause' },
  { batch: 200, gapMs: 4, label: '100 chars, 4ms' },
  { batch: 100, gapMs: 8, label: '50 chars, 8ms' },
  { batch: 40, gapMs: 8, label: '20 chars, 8ms' },
  { batch: 40, gapMs: 15, label: '20 chars, 15ms' },
  { batch: 20, gapMs: 10, label: '10 chars, 10ms' },
]

/**
 * Every configuration runs this many times.
 *
 * A single pass measured 100-chars-at-4ms exact and 50-chars-at-4ms losing three
 * characters - a smaller batch doing worse than a larger one. That is not a
 * threshold, it is a race, and a race cannot be characterised by one sample. A
 * configuration that drops three characters one run in five is unusable for
 * dictation and looks perfect if you only run it once.
 */
const REPEATS = 5

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function hash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const work = mkdtempSync(path.join(tmpdir(), 'wouice-pace-'))
const isChrome = (t) => t.startsWith('WOUICE-PACE')

async function main() {
  console.log(`electron ${process.versions.electron}`)
  console.log(`typing ${LONG.length} characters per run. Do not touch the keyboard.\n`)

  const page = path.join(work, 'pace.html')
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><title>WOUICE-PACE-READY</title>
<body style="font:14px system-ui;padding:16px">
<p>Wouice pacing spike. Closes itself.</p>
<textarea id="t" autofocus style="width:96%;height:200px"></textarea>
<script>
function h(s){let x=5381;for(let i=0;i<s.length;i++)x=((x<<5)+x+s.charCodeAt(i))>>>0;return x.toString(36)}
const t=document.getElementById('t')
const set=()=>{document.title='WOUICE-PACE:'+t.value.length+':'+h(t.value)}
t.addEventListener('input',set); t.focus(); set()
</script>`,
    'utf8'
  )

  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  if (!existsSync(chrome)) {
    console.log(`FAIL  chrome not found at ${chrome}`)
    return app.quit()
  }
  spawn(chrome, ['--new-window', `file:///${page.replace(/\\/g, '/')}`], { stdio: 'ignore' })

  // Wait for it, then pull it forward.
  let win = null
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline && !win) {
    win = findWindow(isChrome)
    if (!win) await sleep(250)
  }
  if (!win) {
    console.log('FAIL  target window never appeared')
    return app.quit()
  }
  for (let i = 0; i < 15; i++) {
    forceForeground(win.hwnd)
    await sleep(220)
    const fg = foregroundTarget()
    if (fg && isChrome(fg.title)) break
  }
  const fg = foregroundTarget()
  if (!fg || !isChrome(fg.title)) {
    console.log(`FAIL  could not focus target; front is ${fg?.exe}`)
    return app.quit()
  }
  console.log(`target: ${fg.exe} pid ${fg.pid}\n`)

  const want = hash(LONG)
  console.log(`  each config runs ${REPEATS} times
`)
  console.log('  config                  exact       worst    chars/s   time')
  console.log('  ' + '-'.repeat(62))

  const rows = []
  let aborted = false
  for (const cfg of CONFIGS) {
    let exact = 0
    let worstLoss = 0
    let totalMs = 0

    for (let run = 0; run < REPEATS; run++) {
      // Guard before every send. If focus moved, stop rather than type into
      // whatever is now in front.
      const front = foregroundTarget()
      if (!front || !isChrome(front.title)) {
        console.log(`  ${cfg.label.padEnd(22)} refused: front is ${front?.exe}`)
        aborted = true
        break
      }

      chord(0x41, [VK.CONTROL]) // Ctrl+A, so each run replaces the last
      await sleep(120)

      const r = await typeUnicodePaced(LONG, cfg)
      await sleep(900) // let the renderer settle before reading the title

      const m = /WOUICE-PACE:(\d+):(\w+)/.exec(windowTitle(findWindow(isChrome)?.hwnd))
      const landed = m ? Number(m[1]) : -1
      if (m !== null && landed === LONG.length && m[2] === want) exact++
      else worstLoss = Math.max(worstLoss, LONG.length - Math.max(landed, 0))
      totalMs += r.ms
      await sleep(300)
    }
    if (aborted) break

    const meanMs = totalMs / REPEATS
    rows.push({ ...cfg, exact, worstLoss, meanMs, rate: Math.round(LONG.length / (meanMs / 1000)) })
    console.log(
      `  ${cfg.label.padEnd(22)} ${String(`${exact}/${REPEATS}`).padEnd(11)} ` +
        `${String(worstLoss || '-').padEnd(8)} ${String(Math.round(LONG.length / (meanMs / 1000))).padEnd(9)} ` +
        `${meanMs.toFixed(0)}ms mean`
    )
  }

  const reliable = rows.filter((r) => r.exact === REPEATS)
  console.log('')
  if (reliable.length === 0) {
    console.log('Nothing was exact on every run. Typing cannot be the default path.')
  } else {
    const best = reliable.reduce((a, b) => (a.meanMs <= b.meanMs ? a : b))
    console.log(
      `Exact on all ${REPEATS} runs: ${reliable.map((g) => g.label).join(' | ')}`
    )
    console.log(
      `Fastest of those: ${best.label} - ${LONG.length} chars in ${best.meanMs.toFixed(0)}ms (${best.rate} chars/s)`
    )
  }

  const t = findWindow(isChrome)
  if (t) {
    forceForeground(t.hwnd)
    await sleep(300)
    const f2 = foregroundTarget()
    if (f2 && isChrome(f2.title)) chord(VK.W, [VK.CONTROL])
  }
  rmSync(work, { recursive: true, force: true })
  app.quit()
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('spike threw:', err)
    app.quit()
  })
)
