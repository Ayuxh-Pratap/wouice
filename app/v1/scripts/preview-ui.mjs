#!/usr/bin/env node
// Look at the renderer in a browser, without Electron and without the models.
//
//   cd desktop && npx electron-vite build
//   npx tsx scripts/preview-ui.mjs          # writes out/renderer/preview.html
//   npx tsx scripts/preview-ui.mjs --serve  # ...and serves it on :8787
//
// WHY. The UI cannot be seen without launching the app, and launching the app
// loads several gigabytes of model weights onto a 6 GB card. That is a slow and
// destructive way to check whether a sidebar is the right width.
//
// This writes a copy of the built index.html with a stand-in for the preload
// bridge in front of it, so every page renders against plausible data. It is a
// LOOKING GLASS AND NOT A TEST: nothing here proves the real IPC works, and a
// stub that drifts from `WouiceApi` will render a page that cannot exist. Treat
// a surprise here as a question, not an answer.

import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { V1_ROOT, heading } from './lib/fetch-util.mjs'

const OUT = path.join(V1_ROOT, 'desktop', 'out', 'renderer')
const PORT = Number(process.env.PORT ?? 8787)

const STUB = `<script>
  // Stand-in for the preload bridge. Shapes only - see shared/ipc.ts.
  const noop = () => () => {}
  const settings = {
    hotkeys: { dictate: 'Control+Alt+W', meeting: 'Control+Alt+M', companion: 'Control+Alt+C' },
    models: { whisper: 'turbo', llama: 'qwen3-4b' },
    silence: { shortWindowMs: 1800, longWindowMs: 3000, adaptAfterMs: 15000, minSpeechMs: 300,
               maxSessionMs: 300000, chunkAfterMs: 20000, chunkPauseMs: 600,
               speechFactor: 2, minNoiseFloor: 0.0012 },
    cleanup: { enabled: true },
    developerMode: true,
    retainAudio: true,
    calibration: { at: Date.now() - 3600000, device: 'Microphone Array (Realtek)', quality: 'good',
                   silenceLevel: 0.0004, speechLevel: 0.015, separation: 40,
                   languages: [{ label: 'english', detected: 'english' }] },
    injection: { enabled: true, pasteOverrides: {} },
    audio: { deviceId: null, deviceLabel: '' },
    appearance: { zoom: 1 },
  }
  const TEXTS = [
    'I think we should ship the thing and see what happens.',
    'Please review the latest draft and send me your comments by tomorrow morning.',
    'The sidebar could be a little shorter, and the text inside it a bit clearer.',
  ]
  const dictation = (id) => ({
    id, at: Date.now() - id * 600000, audioMs: 9000 + id * 1200, asrMs: 1420, llmMs: 810,
    totalMs: 2230, chunks: id % 4 === 0 ? 2 : 0, asrModel: 'turbo', llmModel: 'qwen3-4b',
    language: id % 2 ? 'english' : 'hindi', rawChars: 180, finalChars: 172, corrections: 1,
    degraded: id === 4 ? 'llm-timeout' : null,
    raw: TEXTS[id % TEXTS.length], corrected: TEXTS[id % TEXTS.length],
    sentSystem: 'You clean up raw speech-to-text output.',
    sentUser: TEXTS[id % TEXTS.length], received: TEXTS[id % TEXTS.length],
    applied: [{ from: 'cloud code', to: 'Claude Code', count: 1 }],
    capture: { stoppedBy: 'silence', speechMs: 9000, silenceMs: 1800, longestPauseMs: 700,
               windowMs: 1800, chunkAfterMs: 20000, chunkPauseMs: 600,
               peakRms: 0.1, meanSpeechRms: 0.02, thresholdRms: 0.0024 },
    audioPath: null, inserted: id !== 4, delivery: id !== 4 ? 'paste' : 'copy',
    targetExe: 'code.exe', deliveryNote: id === 4 ? 'focus moved to chrome.exe' : '',
  })
  const rows = Array.from({ length: 23 }, (_, i) => dictation(i + 1)).reverse()
  window.wouice = {
    deleteDictations: async () => 0,
    clearDictations: async () => 0,
    getSettings: async () => settings,
    setSettings: async (p) => Object.assign(settings, p),
    getSidecars: async () => [
      { id: 'whisper', status: 'ready', modelId: 'turbo', pendingModelId: null, port: 8178, pid: 1234, lastError: null },
      { id: 'llama', status: 'ready', modelId: 'qwen3-4b', pendingModelId: null, port: 8179, pid: 5678, lastError: null },
    ],
    switchModel: async () => {}, restartSidecar: async () => {},
    getDiagnostics: async () => ({
      sidecarRoot: 'C:\\\\dev\\\\wouice\\\\sidecars', modelRoot: 'C:\\\\dev\\\\wouice\\\\models',
      userData: 'C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\Wouice',
      hotkeyRegistered: { dictate: true }, hotkeys: [], platform: 'win32 x64', electron: '44.2.0',
    }),
    hideHud: () => {},
    getMetrics: async () => ({
      dictations: rows.slice(0, 12).reverse(),
      resources: Array.from({ length: 40 }, (_, i) => ({
        at: Date.now() - (40 - i) * 15000,
        vramUsedMiB: 4200 + Math.round(Math.sin(i / 4) * 320), vramTotalMiB: 6144, rssMiB: 320,
      })),
      summary: { count: 23, p50Ms: 2230, p95Ms: 2528, degraded: 1, chars: 4820 },
      byAsrModel: [{ model: 'turbo', meanMs: 1423, n: 14 }, { model: 'large-v3', meanMs: 3528, n: 9 }],
    }),
    getDictationPage: async (offset, limit) =>
      ({ rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit }),
    getStorage: async () => ({
      file: 'C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\Wouice\\\\wouice.db', version: 4, bytes: 356000,
      tables: [{ name: 'calibrations', rows: 1 }, { name: 'dictations', rows: 23 },
               { name: 'dictionary', rows: 2 }, { name: 'resource_samples', rows: 667 }],
    }),
    getDictionary: async () => ([
      { id: 1, kind: 'correction', hear: 'cloud code', write: 'Claude Code', enabled: true, hits: 7, createdAt: Date.now() },
      { id: 2, kind: 'term', hear: 'Himanshu', write: '', enabled: true, hits: 0, createdAt: Date.now() },
    ]),
    addDictionaryEntry: async () => null, updateDictionaryEntry: async () => {},
    removeDictionaryEntry: async () => {},
    getRecordings: async () => Array.from({ length: 6 }, (_, i) =>
      ({ file: 'clip' + i + '.wav', at: Date.now() - i * 900000, bytes: 980000 })),
    deleteRecording: async () => {}, clearRecordings: async () => {},
    copyDiagnostic: async () => true, exportDiagnostics: async () => null, revealMetrics: () => {},
    calibrate: async () => ({}), calibrateApply: async () => {},
    sendAudioFrame: () => {}, captureReady: () => {}, captureFailed: () => {}, cancelDictation: () => {},
    onStartCapture: noop, onStopCapture: noop, onMetric: noop, onDictationResult: noop,
    onSidecarState: noop, onSettingsChanged: noop, onHudState: noop, onHotkeyFailed: noop,
  }
</script>
`

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

async function main() {
  const index = path.join(OUT, 'index.html')
  if (!existsSync(index)) {
    console.log('No build found. Run:  cd desktop && npx electron-vite build')
    process.exit(1)
  }

  const html = await readFile(index, 'utf8')
  const out = path.join(OUT, 'preview.html')
  await writeFile(out, html.replace('<script type="module"', `${STUB}    <script type="module"`), 'utf8')

  heading('UI preview')
  console.log(`  wrote ${out}`)

  if (!process.argv.includes('--serve')) {
    console.log('  add --serve to host it (file:// cannot load ES modules)')
    return
  }

  createServer(async (req, res) => {
    const rel = (req.url ?? '/').split('?')[0]
    const file = path.join(OUT, rel === '/' ? 'preview.html' : rel)
    // Never serve outside the build directory, however the URL is spelled.
    if (!path.resolve(file).startsWith(path.resolve(OUT))) {
      res.writeHead(403).end()
      return
    }
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`  http://127.0.0.1:${PORT}/            dashboard`)
    console.log(`  http://127.0.0.1:${PORT}/#/dictations`)
    console.log(`  http://127.0.0.1:${PORT}/#/settings`)
    console.log('\n  Ctrl+C to stop.')
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
