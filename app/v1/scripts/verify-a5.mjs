import { execFileSync } from 'node:child_process'

/**
 * Acceptance criterion A5: killing either sidecar mid-session leaves the app
 * alive, respawns the sidecar, and the next dictation works.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. The supervisor's restart policy - the
 * backoff, the storm limit, the queued model switch - is pure and covered by
 * unit tests. What those cannot tell you is whether a real `whisper-server.exe`
 * dying takes the Electron process with it, whether the respawn actually
 * happens on this machine, and how long the app is unusable for. That needs a
 * running app and a real kill.
 *
 * WHAT IT DOES. Finds the process listening on a sidecar's port, kills it
 * outright - not a graceful stop, a crash - and then polls the port until it
 * answers again. It also checks the Electron process is still alive afterwards,
 * because "the app survives" is half the criterion and the easier half to
 * forget to check.
 *
 * IT IS DISRUPTIVE BY DESIGN. Run it when nothing is mid-dictation.
 *
 * Run: node scripts/verify-a5.mjs [whisper|llama|both]
 */

const SIDECARS = {
  whisper: { port: 8178, health: '/', exe: 'whisper-server.exe' },
  llama: { port: 8179, health: '/health', exe: 'llama-server.exe' },
}

/** How long a respawn is allowed to take. Model load dominates this. */
const RECOVER_TIMEOUT_MS = 180_000
const POLL_MS = 1_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ps(command) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return ''
  }
}

/** The pid listening on a port, or null. */
function listenerPid(port) {
  const out = ps(
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue |` +
      ` Select-Object -First 1).OwningProcess`
  )
  const pid = Number(out)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

function alive(pid) {
  return ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id`) === String(pid)
}

function electronPids() {
  return ps(`(Get-Process electron -ErrorAction SilentlyContinue).Id`)
    .split(/\s+/)
    .filter(Boolean)
}

async function healthy(port, path) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(2_000),
    })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

async function check(name) {
  const s = SIDECARS[name]
  console.log(`\n--- ${name} (port ${s.port}) ---`)

  const before = electronPids()
  if (before.length === 0) {
    console.log('  SKIP  no electron process found. Start the app first.')
    return null
  }

  if (!(await healthy(s.port, s.health))) {
    console.log(`  SKIP  nothing healthy on ${s.port}. It may still be loading its model.`)
    return null
  }

  const pid = listenerPid(s.port)
  if (!pid) {
    console.log(`  FAIL  could not find the process listening on ${s.port}`)
    return false
  }
  console.log(`  killing pid ${pid}`)
  ps(`Stop-Process -Id ${pid} -Force`)

  await sleep(1_500)
  const gone = !alive(pid)
  console.log(`  ${gone ? 'PASS' : 'FAIL'}  the sidecar actually died`)

  // The half of A5 that is easy to forget: the app itself.
  const after = electronPids()
  const survived = after.length > 0
  console.log(
    `  ${survived ? 'PASS' : 'FAIL'}  the app survived ` +
      `(${before.length} electron processes before, ${after.length} after)`
  )

  const started = Date.now()
  let back = false
  while (Date.now() - started < RECOVER_TIMEOUT_MS) {
    if (await healthy(s.port, s.health)) {
      back = true
      break
    }
    await sleep(POLL_MS)
  }
  const took = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `  ${back ? 'PASS' : 'FAIL'}  respawned and answering again` + (back ? ` after ${took}s` : '')
  )

  if (back) {
    const newPid = listenerPid(s.port)
    console.log(`  now served by pid ${newPid}${newPid === pid ? ' (UNCHANGED - suspicious)' : ''}`)
  }

  return gone && survived && back
}

const which = process.argv[2] ?? 'both'
const names = which === 'both' ? Object.keys(SIDECARS) : [which]

console.log('A5: killing a sidecar mid-session')
console.log('This kills a real process. Do not run it mid-dictation.')

const results = []
for (const name of names) results.push(await check(name))

const ran = results.filter((r) => r !== null)
const failed = ran.filter((r) => r === false).length
console.log(
  `\n${ran.length - failed}/${ran.length} checked` +
    (failed ? ` - ${failed} FAILED` : ran.length ? ' - A5 holds for these' : '')
)
process.exit(failed ? 1 : 0)
