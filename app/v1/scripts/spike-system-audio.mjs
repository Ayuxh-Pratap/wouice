import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Spike V4: can Electron capture system audio well enough to be the "Them"
 * channel of a meeting?
 *
 * WHY THIS GATES THE PHASE. Everything in Phase 2 assumes the system channel is
 * a CLEAN DIGITAL TAP of the far side. The echo suppressor's entire premise is
 * that bleed flows one way - the far side into your mic when you are on
 * speakers, never the reverse - and that premise is false if what we get back
 * is really a second microphone recording of the room. So it is not enough to
 * hear something in the capture; the capture has to be demonstrably digital.
 *
 * FOUR QUESTIONS, NOT ONE. "Does loopback work" is the question everyone asks
 * and the one that hides the expensive answer:
 *
 *   Q1  does it capture another process's audio at all?
 *   Q2  can we keep the audio WITHOUT a live video track? An hour of screen
 *       capture, to throw every frame away, on the machine already running two
 *       models, is a cost that would not show up until a real meeting
 *   Q3  is our own output in the mix? Barely matters in Phase 2 and decides the
 *       shape of Phase 3, where the companion speaks while listening
 *   Q4  is there a permission dialog every session? A picker on every
 *       Ctrl+Alt+M is the same as not shipping the feature
 *
 * HOW IT KNOWS IT IS A DIGITAL TAP. A 440 Hz tone is played from a SEPARATE
 * PROCESS (PowerShell's SoundPlayer, so nothing about our own audio graph is
 * involved) and the capture is scored two ways: the fraction of its energy that
 * sits exactly at 440 Hz, and the noise floor while nothing is playing. A
 * microphone in a room gives a broadband spectrum and an audible floor; a tap
 * on the render endpoint gives near-unity tone purity and a floor at the
 * quantisation level. The numbers separate the two by orders of magnitude, so
 * this does not rest on listening to it - though it writes a WAV so you can.
 *
 * THIS MAKES NOISE. Ten seconds of 440 Hz through your default output device,
 * on purpose. Silent speakers are indistinguishable from broken loopback.
 *
 * Run: npx electron scripts/spike-system-audio.mjs
 */

const TONE_HZ = 440
const CAPTURE_RATE = 16_000
const OUT_DIR = path.join(app.getPath('temp'), 'wouice-v4')

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function note(text) {
  console.log(`  ....  ${text}`)
}

/* ----------------------------------------------------------------- wav ---- */

/** 16-bit PCM mono. The one format SoundPlayer and every editor agree on. */
function encodeWav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}

function toneWav(seconds, rate = 44_100, amplitude = 0.3) {
  const n = Math.round(seconds * rate)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = amplitude * Math.sin((2 * Math.PI * TONE_HZ * i) / rate)
  return encodeWav(s, rate)
}

/* ------------------------------------------------------------ analysis ---- */

function meanSquare(x) {
  let sum = 0
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i]
  return x.length ? sum / x.length : 0
}

/**
 * Energy at exactly one frequency, by Goertzel.
 *
 * Returned as a MEAN SQUARE so it divides straight into the signal's own mean
 * square and the answer is the fraction of the energy that is the tone. A pure
 * tone through a digital path lands near 1; a microphone hearing the same tone
 * across a room lands far lower, because it also brings the room.
 */
function tonePurity(x, rate, hz) {
  const n = x.length
  if (n < 64) return 0
  const k = Math.round((n * hz) / rate)
  const w = (2 * Math.PI * k) / n
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const s0 = x[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2
  const toneMeanSquare = (2 * power) / (n * n)
  const total = meanSquare(x)
  return total > 0 ? Math.min(1, toneMeanSquare / total) : 0
}

const dbfs = (ms) => (ms > 0 ? 20 * Math.log10(Math.sqrt(ms)) : -Infinity)
const fmtDb = (ms) => (ms > 0 ? `${dbfs(ms).toFixed(1)} dBFS` : 'digital silence')

/**
 * Purity has to be measured on a window the tone fits EXACTLY.
 *
 * Goertzel reads one bin. If the tone does not sit on a bin centre its energy
 * leaks into the neighbours and the bin under-reads by a third or more - which
 * is a fact about the window length, not about the audio. 440 Hz at 16 kHz
 * repeats every 400 samples, so any multiple of 400 puts the tone dead on a
 * bin. The onset is trimmed too: SoundPlayer fades in, and a rectangular window
 * across a rising edge leaks for the same reason.
 */
/** 400 samples at 16 kHz is exactly 11 cycles of 440 Hz. */
const TONE_PERIOD = 400

function analyse(x) {
  if (!x || x.length === 0) return null
  // Measured on the STEADY TAIL, not the whole segment. Windows fades its
  // ducking in over about two seconds, and a window straddling that fade is
  // measuring a level change rather than the signal - amplitude modulation
  // spreads energy off the bin exactly the way leakage does. The profile below
  // is where transients belong; this number is the steady state.
  const tail = Math.round(0.1 * CAPTURE_RATE)
  const end = Math.max(0, x.length - tail)
  const start = Math.max(0, end - Math.round(2 * CAPTURE_RATE))
  let body = x.subarray(start, end)
  const n = Math.floor(body.length / TONE_PERIOD) * TONE_PERIOD
  if (n >= TONE_PERIOD) body = body.subarray(body.length - n)

  // A level that is steady across the segment, or is not. A glitch shows here
  // and nowhere in an average.
  const win = Math.round(0.2 * CAPTURE_RATE)
  const profile = []
  for (let i = 0; i + win <= x.length; i += win) profile.push(meanSquare(x.subarray(i, i + win)))

  return {
    samples: x.length,
    seconds: x.length / CAPTURE_RATE,
    ms: meanSquare(x),
    steadyMs: meanSquare(body),
    purity: tonePurity(body, CAPTURE_RATE, TONE_HZ),
    profile,
    quietest: profile.length ? Math.min(...profile) : 0,
    loudest: profile.length ? Math.max(...profile) : 0,
  }
}

function profileLine(a) {
  if (!a || !a.profile.length) return
  console.log(
    `        200 ms windows: ${a.profile.map((m) => (m > 0 ? dbfs(m).toFixed(0) : '-inf')).join(' ')}`
  )
}

function line(label, a) {
  if (!a) return
  note(
    `${label.padEnd(11)}${a.seconds.toFixed(2)}s  ${fmtDb(a.steadyMs).padStart(16)}` +
      `  ${(a.purity * 100).toFixed(1).padStart(5)}% at ${TONE_HZ} Hz` +
      `  (${fmtDb(a.quietest)} .. ${fmtDb(a.loudest)} over 200 ms)`
  )
}

/* -------------------------------------------------------------- player ---- */

let player = null

/** Play the tone from ANOTHER PROCESS, so nothing of ours is in the path. */
function startTone(wavPath) {
  player = spawn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = New-Object Media.SoundPlayer '${wavPath}'; $p.PlaySync()`,
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
}

function stopTone() {
  if (!player) return
  // /T because SoundPlayer holds the device from inside the powershell process
  // tree; killing the parent alone can leave the sound running.
  try {
    spawn('taskkill', ['/PID', String(player.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
  player = null
}

/* ------------------------------------------------------------ renderer ---- */

/**
 * The renderer drives the timeline, because it is the only side that can see
 * the MediaStream. It asks main to start and stop the external tone so the two
 * clocks cannot drift apart.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>v4</title></head><body>
<script>
const { ipcRenderer } = require('electron')
const RATE = ${CAPTURE_RATE}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const WORKLET = \`
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice())
    return true
  }
}
registerProcessor('v4-tap', Tap)
\`

async function ask(withVideo) {
  await ipcRenderer.invoke('mode', withVideo ? 'video' : 'audio-only')
  // The spec rejects video:false outright, so video is always REQUESTED here.
  // Whether one is DELIVERED is main's choice, and that is the thing under test.
  return navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
}

async function run() {
  const out = { steps: [], errors: [] }

  // Q2 first: answer the request with audio and NO video source at all.
  let stream = null
  let mode = 'audio-only'
  try {
    stream = await ask(false)
  } catch (err) {
    out.errors.push('audio-only: ' + (err && err.message ? err.message : String(err)))
  }
  if (!stream || stream.getAudioTracks().length === 0) {
    if (stream) stream.getTracks().forEach((t) => t.stop())
    mode = 'video+audio'
    try {
      stream = await ask(true)
    } catch (err) {
      out.errors.push('video+audio: ' + (err && err.message ? err.message : String(err)))
      return out
    }
  }

  out.mode = mode
  out.audioTracks = stream.getAudioTracks().length
  out.videoTracks = stream.getVideoTracks().length
  out.trackLabel = out.audioTracks ? stream.getAudioTracks()[0].label : ''
  if (out.audioTracks === 0) return out

  const ctx = new AudioContext({ sampleRate: RATE })
  const blob = new Blob([WORKLET], { type: 'application/javascript' })
  await ctx.audioWorklet.addModule(URL.createObjectURL(blob))
  const node = new AudioWorkletNode(ctx, 'v4-tap')
  ctx.createMediaStreamSource(stream).connect(node)
  // A worklet with no downstream connection is not pulled in some builds.
  // A zero-gain sink keeps it running without making a sound.
  const mute = ctx.createGain()
  mute.gain.value = 0
  node.connect(mute).connect(ctx.destination)

  let bucket = []
  node.port.onmessage = (e) => bucket.push(e.data)
  const collect = async (ms) => {
    bucket = []
    await sleep(ms)
    const total = bucket.reduce((n, b) => n + b.length, 0)
    const merged = new Float32Array(total)
    let at = 0
    for (const b of bucket) { merged.set(b, at); at += b.length }
    return merged
  }

  const step = async (name, ms) => {
    const samples = await collect(ms)
    out.steps.push({ name, samples: Array.from(samples) })
    return samples
  }

  await sleep(400)                              // let the graph settle
  await step('floor', 1200)                     // nothing playing anywhere

  ipcRenderer.send('tone', 'start')
  await sleep(900)                              // SoundPlayer takes a moment
  await step('external', 8000)

  // Q2's real question: drop the video track and see if the audio survives it.
  if (out.videoTracks > 0) {
    stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t) })
    await sleep(600)
    await step('afterVideoStopped', 2000)
    out.videoTracksAfter = stream.getVideoTracks().length
    out.audioLiveAfter = stream.getAudioTracks()[0].readyState
  }

  ipcRenderer.send('tone', 'stop')
  await sleep(1000)
  await step('floor2', 1200)

  // Q3: the same tone, played by US, through the default device.
  const own = new AudioContext()
  const osc = own.createOscillator()
  const gain = own.createGain()
  osc.frequency.value = ${TONE_HZ}
  gain.gain.value = 0.3
  osc.connect(gain).connect(own.destination)
  osc.start()
  await sleep(700)
  await step('ownOutput', 2000)
  osc.stop()
  await own.close()

  stream.getTracks().forEach((t) => t.stop())
  await ctx.close()

  // Q4: a second request in the same session. If a picker were involved this is
  // where it would appear again.
  const t0 = performance.now()
  try {
    const again = await ask(mode === 'video+audio')
    out.secondRequestMs = Math.round(performance.now() - t0)
    out.secondRequestTracks = again.getAudioTracks().length
    again.getTracks().forEach((t) => t.stop())
  } catch (err) {
    out.errors.push('second request: ' + (err && err.message ? err.message : String(err)))
  }
  return out
}

run().then(
  (r) => ipcRenderer.send('done', r),
  (err) => ipcRenderer.send('done', { fatal: String((err && err.stack) || err), steps: [] })
)
</script></body></html>`

/* ------------------------------------------------------------------ run ---- */

let handlerCalls = 0
let mode = 'audio-only'
let audioOnlyRefusal = ''

app.whenReady().then(async () => {
  console.log('\nSpike V4 — system audio loopback\n')
  console.log('  This will play a 440 Hz tone through your speakers. That is the test.\n')

  mkdirSync(OUT_DIR, { recursive: true })
  const wavPath = path.join(OUT_DIR, 'tone.wav')
  writeFileSync(wavPath, toneWav(12))

  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      handlerCalls++
      if (mode === 'audio-only') {
        // No video source at all. If Electron accepts this, Q2 is free.
        // It throws synchronously when it does not, which is itself the answer.
        try {
          callback({ audio: 'loopback' })
        } catch (err) {
          // The callback is one-shot and Electron has already spent it, so this
          // request is over. The renderer asks again with video.
          audioOnlyRefusal = err instanceof Error ? err.message : String(err)
        }
        return
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      callback({ video: sources[0], audio: 'loopback' })
    },
    // The whole point: WE answer the request. A system picker would put a
    // dialog in front of the person on every meeting.
    { useSystemPicker: false }
  )

  ipcMain.handle('mode', (_e, value) => {
    mode = value
    return true
  })
  ipcMain.on('tone', (_e, what) => (what === 'start' ? startTone(wavPath) : stopTone()))

  const pagePath = path.join(OUT_DIR, 'v4.html')
  writeFileSync(pagePath, PAGE)

  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })

  const finished = new Promise((resolve) => ipcMain.once('done', (_e, r) => resolve(r)))
  await win.loadFile(pagePath)

  const timeout = setTimeout(() => {
    console.log('\n  Timed out after 60s with no result.')
    stopTone()
    app.exit(2)
  }, 60_000)

  const out = await finished
  clearTimeout(timeout)
  stopTone()

  if (out.fatal) {
    console.log(`  The renderer threw before it could report:\n${out.fatal}`)
    app.exit(2)
    return
  }

  const steps = Object.fromEntries(
    out.steps.map((s) => [s.name, Float32Array.from(s.samples)])
  )
  const floor = analyse(steps.floor)
  const external = analyse(steps.external)
  const afterVideo = analyse(steps.afterVideoStopped)
  const own = analyse(steps.ownOutput)

  for (const err of out.errors) note(err)
  note(`answered ${handlerCalls} request(s) as "${out.mode}"`)
  if (audioOnlyRefusal) note(`audio-only was refused: ${audioOnlyRefusal}`)
  note(`tracks: ${out.audioTracks} audio, ${out.videoTracks} video — "${out.trackLabel}"`)
  console.log('')
  line('floor', floor)
  line('external', external)
  profileLine(external)
  line('no video', afterVideo)
  line('own output', own)
  console.log('')

  // Q1. A tone 30 dB above the floor is not a room; it is the signal.
  const audible = (a) => Boolean(a && a.steadyMs > 1e-6 && (floor.steadyMs === 0 || a.steadyMs > floor.steadyMs * 1000))
  report(
    'captures another process’s audio',
    audible(external),
    external ? `${fmtDb(external.steadyMs)} against a ${fmtDb(floor.steadyMs)} floor` : 'nothing captured'
  )

  // The digital-tap claim the echo suppressor rests on.
  // Two independent signatures, and the floor is the stronger of them: no
  // microphone on earth returns samples that are exactly zero.
  const silentFloor = Boolean(floor && floor.ms === 0)
  report(
    'the capture is a digital tap, not a room recording',
    silentFloor && Boolean(external && external.purity > 0.9),
    external
      ? `${(external.purity * 100).toFixed(1)}% tone purity, floor ${fmtDb(floor.ms)}`
      : 'n/a'
  )

  // Q2.
  if (out.mode === 'audio-only') {
    report('audio without a video source at all', out.audioTracks > 0, 'handler answered audio-only')
  } else {
    const survived = audible(afterVideo)
    report(
      'audio survives stopping the video track',
      survived && out.videoTracksAfter === 0 && out.audioLiveAfter === 'live',
      survived
        ? `${out.videoTracksAfter} video tracks left, audio ${out.audioLiveAfter}`
        : 'audio stopped with the video track'
    )
  }

  // Q3. Reported either way: this is information for Phase 3, not a failure.
  const ownHeard = audible(own)
  note(
    ownHeard
      ? 'our own output IS in the loopback mix — Phase 3 will need to handle it'
      : 'our own output is NOT in the loopback mix'
  )

  // Q4.
  report(
    'no per-session picker: we answer the request ourselves',
    handlerCalls >= 2 && out.secondRequestTracks > 0,
    out.secondRequestMs !== undefined ? `second request in ${out.secondRequestMs} ms` : 'n/a'
  )

  const all = new Float32Array(out.steps.reduce((n, s) => n + s.samples.length, 0))
  let at = 0
  for (const s of out.steps) {
    all.set(Float32Array.from(s.samples), at)
    at += s.samples.length
  }
  const capturePath = path.join(OUT_DIR, 'captured.wav')
  writeFileSync(capturePath, encodeWav(all, CAPTURE_RATE))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) console.log(`FAILED: ${failed.map((f) => f.name).join(', ')}`)
  console.log(`\ncaptured audio: ${capturePath}`)
  console.log('  floor · external tone · no-video · floor · our own output, in that order\n')

  app.exit(failed.length ? 1 : 0)
})

process.on('exit', () => {
  stopTone()
  rmSync(path.join(OUT_DIR, 'v4.html'), { force: true })
})
