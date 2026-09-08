#!/usr/bin/env node
// Which global hotkeys can this machine actually claim?
//
//   node scripts/probe-hotkeys.mjs            # the standard candidate set
//   node scripts/probe-hotkeys.mjs "Control+Alt+P" "F16"
//
// Spike V1 exists because registration fails SILENTLY at the OS level: an app
// that assumes success looks alive and simply never responds. It found that
// both the spec's default (Control+Alt+Space) and its documented fallback
// (Control+Shift+Space) were already taken here, so guessing is not good enough.
//
// Must run under Electron, since globalShortcut is what actually answers the
// question. `npm run probe:hotkeys` wires that up.

import { app, globalShortcut } from 'electron'

const LETTERS = 'WDQJKLPRGTYUIOBNM'.split('')

function standardCandidates() {
  const out = []
  // W first: the product is Wouice, so a W binding is the memorable one.
  for (const mods of ['Control+Alt', 'Control+Shift', 'Alt+Shift', 'Control+Shift+Alt']) {
    out.push(`${mods}+W`)
  }
  for (const l of LETTERS) out.push(`Control+Alt+${l}`)
  out.push(
    'Control+Alt+Space',
    'Control+Shift+Space',
    'Alt+Space',
    'Control+Space',
    'Control+Alt+Enter',
    'Control+Alt+`',
    'Control+Alt+;',
    "Control+Alt+'",
    'Control+Alt+,',
    'Control+Alt+.',
    'Control+Alt+/',
    'Control+Alt+[',
    'Control+Alt+]',
    // Function keys above F12 exist on no physical keyboard here, but a
    // remapper (PowerToys Keyboard Manager) can synthesise them, which makes
    // them the most conflict-proof option available.
    'F13', 'F14', 'F15', 'F16', 'F17', 'F18',
    'Control+Alt+F1', 'Control+Alt+F2',
  )
  return [...new Set(out)]
}

app.disableHardwareAcceleration()

app.whenReady().then(() => {
  const candidates = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const list = candidates.length ? candidates : standardCandidates()

  const free = []
  const taken = []

  for (const acc of list) {
    let ok = false
    try {
      ok = globalShortcut.register(acc, () => {}) && globalShortcut.isRegistered(acc)
    } catch {
      ok = false
    }
    if (ok) {
      globalShortcut.unregister(acc)
      free.push(acc)
    } else {
      taken.push(acc)
    }
  }

  const pad = (s) => s.padEnd(24)
  console.log('\nGLOBAL HOTKEY AVAILABILITY')
  console.log('='.repeat(52))
  console.log(`\nTAKEN by another app (${taken.length}):\n`)
  for (const a of taken) console.log(`  x  ${a}`)
  console.log(`\nFREE (${free.length}):\n`)
  for (let i = 0; i < free.length; i += 2) {
    console.log(`  ${pad(free[i] ?? '')}${free[i + 1] ?? ''}`)
  }
  console.log('\n' + '='.repeat(52))
  console.log(`${free.length} of ${list.length} available`)
  console.log('\nNOTE: availability is a snapshot. An app started later can')
  console.log('steal a combination, which is why the app falls back and reports.')

  globalShortcut.unregisterAll()
  app.quit()
})
