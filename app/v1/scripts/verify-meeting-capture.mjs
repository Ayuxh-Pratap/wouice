import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MeetingRecorder } from '../desktop/src/main/meeting/recorder.ts'
import { mergeSession, abandonedSessions } from '../desktop/src/main/meeting/merge.ts'
import { CHECKPOINT_SAMPLES, MEETING_SAMPLE_RATE } from '../desktop/src/main/meeting/session.ts'

/**
 * Verify meeting capture the way the unit tests cannot.
 *
 * WHY THIS EXISTS. `recorder.test.ts` simulates a crash by simply not calling
 * `stop()`, which is an honest test of the merge but not of the claim. The
 * claim is that a session survives the PROCESS DYING - buffers unflushed, file
 * handles never closed, the manifest whatever it happened to be at the moment
 * the kernel took the process away. Nothing short of killing a real process
 * tests that, so this kills one.
 *
 * It also checks the two properties that only appear at scale: that the merge
 * does not buffer an hour of audio in memory, and that the channel alignment
 * holds over a long file rather than only at the start.
 *
 * Run: npx tsx scripts/verify-meeting-capture.mjs
 *
 * Disruptive by design - it spawns and force-kills a child process, and writes
 * a few hundred megabytes to the temp directory before removing it again.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRAME = 320 // 20 ms, the same granularity the worklet delivers

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function note(text) {
  console.log(`  ....  ${text}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------ the child ---- */

/**
 * Record continuously into `dir` and never stop.
 *
 * Timestamps advance at 20 ms per frame regardless of how fast this actually
 * runs, so the manifest describes a plausible meeting rather than the few
 * hundred milliseconds of wall clock it took to write. The audio is a constant
 * per channel so the merged file can be checked by value.
 */
async function runChild(dir) {
  const recorder = new MeetingRecorder(dir, 1_700_000_000_000)
  let stamp = 1_700_000_000_000
  let rotations = 0

  for (;;) {
    recorder.write('me', new Float32Array(FRAME).fill(0.5), stamp)
    // The far side starts a second late, which is what the alignment check
    // downstream is looking for.
    if (stamp >= 1_700_000_001_000) {
      recorder.write('them', new Float32Array(FRAME).fill(-0.25), stamp)
    }
    stamp += 20

    const written = recorder.snapshot().find((r) => r.channel === 'me')?.checkpoints ?? 0
    if (written > rotations) {
      rotations = written
      console.log(`rotated ${rotations}`)
    }
    // Yield often enough that stdout actually flushes to the parent.
    if (stamp % 2000 === 0) await sleep(0)
  }
}

if (process.argv[2] === '--record') {
  await runChild(process.argv[3])
  process.exit(0)
}

/* ------------------------------------------------- 1. surviving a kill ---- */

console.log('\nVerifying meeting capture\n')

const root = mkdtempSync(path.join(os.tmpdir(), 'wouice-verify-meeting-'))

async function crashTest() {
  const child = spawn(
    process.execPath,
    [path.join(HERE, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), fileURLToPath(import.meta.url), '--record', root],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )

  let rotations = 0
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const match = /^rotated (\d+)$/.exec(line.trim())
      if (match) rotations = Number(match[1])
    }
  })

  // Wait for at least two rotations, so there is something to recover AND
  // something in flight to lose.
  const deadline = Date.now() + 30_000
  while (rotations < 2 && Date.now() < deadline) await sleep(100)

  if (rotations < 2) {
    child.kill('SIGKILL')
    report('a killed recording is recoverable', false, 'the child never rotated twice')
    return
  }

  // Not SIGTERM. The point is that nothing gets to run on the way out: no
  // flush, no manifest rewrite, no cleanup handler.
  await new Promise((resolve) => {
    child.on('exit', resolve)
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  })
  note(`killed the recorder after ${rotations} rotations`)

  const abandoned = abandonedSessions(root)
  report(
    'an unfinished session is identifiable with no flag to consult',
    abandoned.length === 1,
    `${abandoned.length} found by having checkpoints and no audio.wav`
  )
  if (abandoned.length !== 1) return

  const dir = abandoned[0]
  const before = readdirSync(path.join(dir, 'checkpoints')).length
  const result = await mergeSession(dir)

  report('it merges through the same function a clean stop uses', Boolean(result))
  if (!result) return

  const expected = (rotations * CHECKPOINT_SAMPLES) / MEETING_SAMPLE_RATE
  note(`${before} checkpoint files → ${(result.durationMs / 1000).toFixed(1)}s of audio`)
  report(
    'nothing that reached disk was lost',
    result.durationMs / 1000 >= expected - 0.01,
    `${(result.durationMs / 1000).toFixed(1)}s recovered, ${expected.toFixed(1)}s had rotated`
  )
  report(
    'the loss is bounded by one checkpoint',
    result.durationMs / 1000 <= expected + 31,
    'at most 30s of one channel was still in memory'
  )
  report('the manifest survived the kill', result.recoveredWithoutManifest === false)

  // The alignment claim, on a file long enough for it to matter.
  const wav = readWav(result.path)
  report(
    'you are on the left and them on the right, a second apart',
    wav.channels === 2 &&
      near(wav.at(0.5).left, 0.5) &&
      wav.at(0.5).right === 0 &&
      near(wav.at(2.0).right, -0.25),
    `at 0.5s left=${wav.at(0.5).left.toFixed(2)} right=${wav.at(0.5).right.toFixed(2)}, ` +
      `at 2.0s right=${wav.at(2.0).right.toFixed(2)}`
  )
  report('the checkpoints are gone once it is finished', !existsSync(path.join(dir, 'checkpoints')))
}

/* --------------------------------------------- 2. merging without RAM ---- */

async function memoryTest() {
  const minutes = 10
  // The recorder makes its own timestamped directory under the root, and that
  // is the one to merge.
  const recorder = new MeetingRecorder(path.join(root, 'long'), 1_600_000_000_000)
  const dir = recorder.dir

  let stamp = 1_600_000_000_000
  const frames = (minutes * 60 * MEETING_SAMPLE_RATE) / FRAME
  const me = new Float32Array(FRAME).fill(0.4)
  const them = new Float32Array(FRAME).fill(-0.4)
  for (let i = 0; i < frames; i++) {
    recorder.write('me', me, stamp)
    recorder.write('them', them, stamp)
    stamp += 20
  }

  const onDisk = readdirSync(path.join(dir, 'checkpoints')).reduce(
    (n, f) => n + statSync(path.join(dir, 'checkpoints', f)).size,
    0
  )
  note(`${minutes} minutes staged as ${(onDisk / 1024 / 1024).toFixed(0)} MB of checkpoints`)

  global.gc?.()
  const before = process.memoryUsage().heapUsed
  let peak = before
  const watch = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed)
  }, 20)

  const result = await mergeSession(dir)
  clearInterval(watch)

  const grewMb = (peak - before) / 1024 / 1024
  note(`heap grew ${grewMb.toFixed(1)} MB while merging`)
  report(
    'the merge streams rather than buffering the meeting',
    result !== null && grewMb < 120,
    // Buffering both channels plus the output would be ~140 MB at ten minutes
    // and over 800 MB at an hour. Streaming does not scale with length at all.
    `${grewMb.toFixed(1)} MB for ${minutes} minutes of audio`
  )
  report(
    'the merged file is the length it should be',
    result !== null && Math.abs(result.durationMs - minutes * 60_000) < 1_000,
    result ? `${(result.durationMs / 1000).toFixed(1)}s` : 'no result'
  )
}

/* ---------------------------------------------------------------- wav ---- */

function readWav(file) {
  const raw = readFileSync(file)
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const channels = view.getUint16(22, true)
  const rate = view.getUint32(24, true)
  return {
    channels,
    rate,
    at(seconds) {
      const frame = Math.round(seconds * rate)
      const offset = 44 + frame * channels * 2
      if (offset + 4 > raw.byteLength) return { left: 0, right: 0 }
      return {
        left: view.getInt16(offset, true) / 32767,
        right: channels === 2 ? view.getInt16(offset + 2, true) / 32767 : 0,
      }
    },
  }
}

const near = (value, target) => Math.abs(value - target) < 0.01

/* ---------------------------------------------------------------- run ---- */

try {
  await crashTest()
  console.log('')
  await memoryTest()
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) console.log(`FAILED: ${failed.map((f) => f.name).join(', ')}`)
process.exit(failed.length ? 1 : 0)
