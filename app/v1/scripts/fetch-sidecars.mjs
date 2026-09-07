#!/usr/bin/env node
// Fetch the whisper.cpp and llama.cpp CUDA server binaries for Windows x64.
//
// Two gotchas this script exists to absorb, both discovered by inspection
// rather than assumption:
//
// 1. llama.cpp's GitHub "latest release" is a marker tag (v0.4.0) holding a
//    single nightly-tag.txt. The real builds are daily `bNNNN` PRERELEASES.
//    Asking for /releases/latest gets you a text file and no binaries.
//
// 2. llama.cpp ships its CUDA runtime DLLs in a SEPARATE `cudart-*` archive.
//    Without it llama-server.exe starts and then dies looking for cublas64_*.
//    whisper.cpp's cublas zip bundles its own, which is why it needs only one.
//
// CUDA 12.4 is chosen over the smaller 13.3 build deliberately: driver 581.86
// supports both, and 12.4 is the more widely exercised path. Switch with
// CUDA=13.3 if 12.4 ever misbehaves.

import { mkdir, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  SIDECAR_DIR, download, unzip, exists, ghJson, writeManifest, heading, fmtBytes, sha256File,
} from './lib/fetch-util.mjs'

const CUDA = process.env.CUDA ?? '12.4'
const FORCE = process.argv.includes('--force')

/** Newest `bNNNN` build, skipping the marker release that holds no binaries. */
async function resolveLlamaTag() {
  const releases = await ghJson(
    'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15'
  )
  const build = releases.find((r) => /^b\d+$/.test(r.tag_name) && r.assets.length > 0)
  if (!build) throw new Error('no llama.cpp bNNNN release with assets in the last 15')
  return build
}

/** Newest whisper.cpp release that actually ships the cublas Windows zip. */
async function resolveWhisperRelease() {
  const releases = await ghJson(
    'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10'
  )
  const rel = releases.find((r) =>
    r.assets.some((a) => a.name.includes(`cublas-${CUDA}`) && a.name.includes('x64'))
  )
  if (!rel) throw new Error(`no whisper.cpp release with a cublas-${CUDA} x64 asset`)
  return rel
}

function pickAsset(release, predicate, what) {
  const a = release.assets.find(predicate)
  if (!a) {
    const names = release.assets.map((x) => x.name).join('\n  ')
    throw new Error(`could not find ${what} in ${release.tag_name}. Assets:\n  ${names}`)
  }
  return a
}

/** Recursively locate an executable by name; layouts differ between builds. */
async function findExe(dir, name) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const hit = await findExe(p, name)
      if (hit) return hit
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return p
    }
  }
  return null
}

async function main() {
  console.log(`Fetching sidecars into ${SIDECAR_DIR}`)
  console.log(`CUDA ${CUDA} - x64 - Windows`)

  const tmp = path.join(SIDECAR_DIR, '.tmp')
  await mkdir(tmp, { recursive: true })
  const manifest = path.join(SIDECAR_DIR, 'manifest.json')
  let downloaded = 0

  // ---- whisper.cpp -------------------------------------------------------
  heading('whisper.cpp')
  const whisperDir = path.join(SIDECAR_DIR, 'whisper')
  const haveWhisper = await findExe(whisperDir, 'whisper-server.exe').catch(() => null)

  if (haveWhisper && !FORCE) {
    console.log(`  already present: ${path.relative(SIDECAR_DIR, haveWhisper)}`)
  } else {
    const rel = await resolveWhisperRelease()
    const asset = pickAsset(
      rel,
      (a) => a.name.includes(`cublas-${CUDA}`) && a.name.includes('x64') && a.name.endsWith('.zip'),
      'cublas x64 zip'
    )
    console.log(`  release ${rel.tag_name}  asset ${asset.name}  (${fmtBytes(asset.size)})`)
    const zip = path.join(tmp, asset.name)
    let whisperDigest = null
    if (!(await exists(zip))) {
      const got = await download(asset.browser_download_url, zip, 'whisper', asset.size)
      downloaded += got.bytes
      whisperDigest = got.sha256
    } else {
      console.log('    (zip already downloaded, extracting)')
      whisperDigest = await sha256File(zip)
    }
    await rm(whisperDir, { recursive: true, force: true })
    await unzip(zip, whisperDir)
    const exe = await findExe(whisperDir, 'whisper-server.exe')
    if (!exe) throw new Error('whisper-server.exe not found after extraction')
    console.log(`    -> ${path.relative(SIDECAR_DIR, exe)}`)
    await writeManifest(manifest, {
      whisper: {
        tag: rel.tag_name,
        asset: asset.name,
        cuda: CUDA,
        exe: path.relative(SIDECAR_DIR, exe),
        sha256: whisperDigest,
        bytes: asset.size,
        url: asset.browser_download_url,
      },
    })
  }

  // ---- llama.cpp ---------------------------------------------------------
  heading('llama.cpp')
  const llamaDir = path.join(SIDECAR_DIR, 'llama')
  const haveLlama = await findExe(llamaDir, 'llama-server.exe').catch(() => null)

  if (haveLlama && !FORCE) {
    console.log(`  already present: ${path.relative(SIDECAR_DIR, haveLlama)}`)
  } else {
    const rel = await resolveLlamaTag()
    const bin = pickAsset(
      rel,
      (a) => a.name === `llama-${rel.tag_name}-bin-win-cuda-${CUDA}-x64.zip`,
      `llama-${rel.tag_name}-bin-win-cuda-${CUDA}-x64.zip`
    )
    // Gotcha 2: the runtime DLLs are a separate archive.
    const cudart = pickAsset(
      rel,
      (a) => a.name === `cudart-llama-bin-win-cuda-${CUDA}-x64.zip`,
      `cudart-llama-bin-win-cuda-${CUDA}-x64.zip`
    )
    console.log(`  release ${rel.tag_name}`)
    console.log(`    ${bin.name}     (${fmtBytes(bin.size)})`)
    console.log(`    ${cudart.name}  (${fmtBytes(cudart.size)})`)

    await rm(llamaDir, { recursive: true, force: true })
    const llamaDigests = {}
    for (const a of [bin, cudart]) {
      const zip = path.join(tmp, a.name)
      if (!(await exists(zip))) {
        const got = await download(a.browser_download_url, zip, a.name.startsWith('cudart') ? 'cudart ' : 'llama  ', a.size)
        downloaded += got.bytes
        llamaDigests[a.name] = got.sha256
      } else {
        llamaDigests[a.name] = await sha256File(zip)
      }
      // Both extract into the same directory: the DLLs must sit beside the exe.
      await unzip(zip, llamaDir)
    }
    const exe = await findExe(llamaDir, 'llama-server.exe')
    if (!exe) throw new Error('llama-server.exe not found after extraction')
    console.log(`    -> ${path.relative(SIDECAR_DIR, exe)}`)
    await writeManifest(manifest, {
      llama: {
        tag: rel.tag_name,
        assets: [bin.name, cudart.name],
        cuda: CUDA,
        exe: path.relative(SIDECAR_DIR, exe),
        sha256: llamaDigests,
        urls: [bin.browser_download_url, cudart.browser_download_url],
      },
    })
  }

  heading('done')
  if (downloaded) console.log(`  downloaded ${fmtBytes(downloaded)}`)
  console.log(`  manifest: ${path.relative(process.cwd(), manifest)}`)
  console.log(`  zips kept in ${path.relative(SIDECAR_DIR, tmp)}/ - safe to delete once things run`)
}

main().catch((err) => {
  console.error(`\nfetch-sidecars failed: ${err.message}`)
  process.exit(1)
})
