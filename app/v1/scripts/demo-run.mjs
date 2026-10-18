#!/usr/bin/env node
// Launch the built app against the demo profile, so nothing you really said is
// on screen. See demo-seed.ts for what the profile contains.
//
//   npm run demo            # seed, build, launch
//   node scripts/demo-run.mjs --dir D
//
// Electron's own --user-data-dir decides where settings.json and wouice.db are
// read from. Models and sidecars are NOT affected: those are found relative to
// the repository, so the demo profile borrows whatever you already fetched.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const V1 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--dir')
const dir = at === -1 ? path.resolve(V1, '../../.demo') : path.resolve(process.argv[at + 1])
const entry = path.join(V1, 'desktop', 'out', 'main', 'index.js')

if (!existsSync(entry)) {
  console.error(`No build at ${entry}\nRun: npm --prefix desktop run build`)
  process.exit(1)
}
if (!existsSync(dir)) {
  console.error(`No demo profile at ${dir}\nRun: npm run demo:seed`)
  process.exit(1)
}

console.log(`Wouice on the demo profile: ${dir}`)
const app = spawn(electron, [entry, `--user-data-dir=${dir}`], {
  stdio: 'inherit',
  cwd: path.join(V1, 'desktop'),
  // Stands up a bot that is "in a call", so the live side can be photographed.
  env: { ...process.env, WOUICE_DEMO: '1' },
})
app.on('exit', (code) => process.exit(code ?? 0))
