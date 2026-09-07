#!/usr/bin/env node
// Re-verify every downloaded binary and model against the recorded manifest.
//
// This exists because Smart App Control is off on this machine. It has to be:
// whisper.cpp, llama.cpp, sherpa-onnx and ONNX Runtime all ship unsigned, and
// SAC refuses to load unsigned DLLs (error 4551, process dies at 0xC0E90002
// before main() with no output anywhere except the CodeIntegrity event log).
//
// Turning SAC off removes Windows' signature enforcement for these files, so
// integrity verification becomes ours. Run this after any fetch, before trusting
// a machine you have not used in a while, or any time something starts behaving
// oddly. A changed hash on a binary you did not re-download is worth
// investigating properly.
//
//   npm run verify
//
// Note what this does and does not prove. It proves the bytes on disk are the
// bytes we recorded when we first fetched them, and for Hugging Face models it
// proves they match the digest the server published. It does NOT prove the
// upstream artifact was benign. That trust comes from the source: the official
// ggml-org repositories and Hugging Face over HTTPS, both pinned by URL in the
// manifest so a typo-squatted mirror would be visible in a diff.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { MODEL_DIR, SIDECAR_DIR, exists, sha256File, sizeOf, fmtBytes, heading } from './lib/fetch-util.mjs'

const GREEN = '✓'
const RED = '✗'
const DASH = '-'

async function loadManifest(dir) {
  const file = path.join(dir, 'manifest.json')
  if (!(await exists(file))) return null
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    console.error(`  cannot parse ${file}: ${err.message}`)
    return null
  }
}

/**
 * @param optional  Downloaded archives are a disposable cache: the script that
 *   fetches them says so, and the extracted binaries are what actually matter.
 *   A missing archive is therefore informational, while a MISMATCHED one is
 *   still a hard failure.
 * @returns {Promise<'ok'|'bad'|'skip'>}
 */
async function checkFile(label, file, expectedSha, expectedBytes, optional = false) {
  if (!(await exists(file))) {
    if (optional) {
      console.log(`  ${DASH} ${label.padEnd(46)} not cached (fine, it is disposable)`)
      return 'skip'
    }
    console.log(`  ${RED} ${label.padEnd(46)} MISSING`)
    return 'bad'
  }
  const bytes = await sizeOf(file)
  if (expectedBytes && bytes !== expectedBytes) {
    console.log(`  ${RED} ${label.padEnd(46)} size ${bytes} != recorded ${expectedBytes}`)
    return 'bad'
  }
  if (!expectedSha) {
    console.log(`  ${DASH} ${label.padEnd(46)} ${fmtBytes(bytes)}  (no hash recorded)`)
    return 'skip'
  }
  const actual = await sha256File(file)
  if (actual !== expectedSha) {
    console.log(`  ${RED} ${label.padEnd(46)} HASH MISMATCH`)
    console.log(`      recorded ${expectedSha}`)
    console.log(`      on disk  ${actual}`)
    return 'bad'
  }
  console.log(`  ${GREEN} ${label.padEnd(46)} ${fmtBytes(bytes)}  ${actual.slice(0, 12)}...`)
  return 'ok'
}

async function main() {
  let ok = 0
  let bad = 0
  let skipped = 0

  const tally = (r) => {
    if (r === 'ok') ok++
    else if (r === 'bad') bad++
    else skipped++
  }

  heading('models')
  const models = await loadManifest(MODEL_DIR)
  if (!models) {
    console.log('  no manifest; run `npm run fetch:models` first')
  } else {
    for (const [key, m] of Object.entries(models)) {
      if (key === 'updatedAt' || !m?.file) continue
      const mark = m.upstreamVerified ? ' (upstream-verified)' : ''
      tally(await checkFile(`${key}: ${m.file}${mark}`, path.join(MODEL_DIR, m.file), m.sha256, m.bytes))
    }
  }

  heading('sidecar archives')
  const side = await loadManifest(SIDECAR_DIR)
  if (!side) {
    console.log('  no manifest; run `npm run fetch:sidecars` first')
  } else {
    const tmp = path.join(SIDECAR_DIR, '.tmp')

    if (side.whisper?.asset) {
      tally(
        await checkFile(
          `whisper ${side.whisper.tag}: ${side.whisper.asset}`,
          path.join(tmp, side.whisper.asset),
          side.whisper.sha256,
          side.whisper.bytes,
          true
        )
      )
    }
    // llama records a name -> sha map, since it takes two archives.
    for (const [name, sha] of Object.entries(side.llama?.sha256 ?? {})) {
      tally(await checkFile(`llama ${side.llama.tag}: ${name}`, path.join(tmp, name), sha, null, true))
    }

    heading('extracted executables')
    for (const [name, entry] of [
      ['whisper-server', side.whisper],
      ['llama-server', side.llama],
    ]) {
      if (!entry?.exe) continue
      const p = path.join(SIDECAR_DIR, entry.exe)
      console.log(`  ${(await exists(p)) ? GREEN : RED} ${name.padEnd(46)} ${entry.exe}`)
      if (!(await exists(p))) bad++
    }
  }

  heading('result')
  console.log(`  ${ok} verified, ${bad} failed, ${skipped} skipped`)
  if (bad) {
    console.log('\n  A mismatch on something you did not re-download is worth investigating.')
    console.log('  Delete the file and re-run the matching fetch script to get a clean copy.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`\nverify failed: ${err.message}`)
  process.exit(1)
})
