// Shared download / extract helpers for the fetch scripts.
//
// Deliberately zero-dependency: this runs before `npm install` has necessarily
// happened, so it may only use Node builtins and tools Windows already ships.
// Zip extraction goes through PowerShell's .NET ZipFile; see `unzip` below for
// the two separate reasons tar is unusable here.

import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** app/v1/scripts/lib -> app/v1 */
export const V1_ROOT = path.resolve(here, '..', '..')
/** app/v1 -> repo root */
export const REPO_ROOT = path.resolve(V1_ROOT, '..', '..')

/** Big binaries live at the repo root, gitignored, shared across app versions. */
export const SIDECAR_DIR = path.join(REPO_ROOT, 'sidecars')
export const MODEL_DIR = path.join(REPO_ROOT, 'models')

export function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`
  return `${n} B`
}

export async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function sizeOf(p) {
  try {
    return (await stat(p)).size
  } catch {
    return 0
  }
}

/** GET JSON from the GitHub API, using GITHUB_TOKEN when present for rate limits. */
export async function ghJson(url) {
  const headers = { 'user-agent': 'wouice-fetch', accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`)
  return res.json()
}

/** SHA-256 of a file on disk, lowercase hex. */
export async function sha256File(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Hugging Face serves LFS-backed files with the object's SHA-256 in
 * `x-linked-etag`. When it is there we get real upstream verification rather
 * than merely trusting whatever arrived.
 */
function upstreamDigest(res) {
  for (const header of ['x-linked-etag', 'etag']) {
    const raw = res.headers.get(header)?.replace(/^"|"$/g, '').replace(/^sha256[:-]/i, '')
    if (raw && SHA256_HEX.test(raw)) return raw
  }
  return null
}

/**
 * Download to `dest`, streaming, hashing as it goes.
 *
 * Writes to `<dest>.part` and renames on success, so an interrupted run can
 * never leave a truncated file that a later run mistakes for complete. These
 * are multi-hundred-megabyte downloads over a connection that may well drop.
 *
 * WHY THIS HASHES: Smart App Control is off on the target machine, because
 * essentially every local-AI binary (whisper.cpp, llama.cpp, sherpa-onnx,
 * ONNX Runtime) ships unsigned and SAC refuses to load them. That removes
 * Windows' signature enforcement, so integrity checking becomes ours to do.
 * Every artifact's SHA-256 and size are recorded in the manifest, verified
 * against the upstream digest when the server publishes one, and re-checkable
 * later with `npm run verify`.
 *
 * @returns {Promise<{bytes: number, sha256: string, verified: boolean}>}
 */
export async function download(url, dest, label, expectedBytes) {
  await mkdir(path.dirname(dest), { recursive: true })
  const part = `${dest}.part`
  await rm(part, { force: true })

  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'wouice-fetch' } })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)

  const total = Number(res.headers.get('content-length') ?? 0)
  const declared = upstreamDigest(res)
  const hash = createHash('sha256')
  let seen = 0
  let lastDraw = 0

  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => {
    hash.update(c)
    seen += c.length
    const now = Date.now()
    if (now - lastDraw > 250) {
      lastDraw = now
      const pct = total ? `${((seen / total) * 100).toFixed(1).padStart(5)}%` : '     '
      process.stdout.write(`\r    ${label}  ${pct}  ${fmtBytes(seen)}${total ? ` / ${fmtBytes(total)}` : ''}   `)
    }
  })

  await pipeline(body, createWriteStream(part))
  const sha256 = hash.digest('hex')

  // Truncation and tampering both change the size, and it costs nothing to check.
  if (expectedBytes && seen !== expectedBytes) {
    await rm(part, { force: true })
    throw new Error(`${label}: expected ${expectedBytes} bytes, got ${seen}. Refusing to keep it.`)
  }
  if (declared && declared !== sha256) {
    await rm(part, { force: true })
    throw new Error(`${label}: SHA-256 mismatch.\n  upstream ${declared}\n  received ${sha256}`)
  }

  const mark = declared ? 'verified' : 'recorded'
  process.stdout.write(`\r    ${label}  done   ${fmtBytes(seen)}  sha256 ${mark}${' '.repeat(10)}\n`)
  await rename(part, dest)
  return { bytes: seen, sha256, verified: Boolean(declared) }
}

// Extracts entries one at a time so an existing file is overwritten rather than
// throwing. ZipFile.ExtractToDirectory has no overwrite overload on the .NET
// Framework that Windows PowerShell 5.1 runs on, and llama.cpp deliberately
// unpacks two archives into one directory (binaries + CUDA runtime), which
// collide. Paths arrive via the environment, so spaces and quotes in them
// cannot break the command line.
const PS_UNZIP = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:WZ_SRC)
try {
  foreach ($e in $zip.Entries) {
    if ([string]::IsNullOrEmpty($e.Name)) { continue }
    $dest = Join-Path $env:WZ_DST $e.FullName
    $dir = Split-Path $dest -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
  }
} finally { $zip.Dispose() }
`

/**
 * Extract a .zip. Windows-only, which is all we target.
 *
 * Deliberately NOT tar. Two separate traps, both hit for real:
 *
 * 1. On this machine `tar` resolves to GNU tar 1.35 from Git Bash, not the
 *    bsdtar that Windows ships. GNU tar cannot read zip archives at all and
 *    reports the useless "This does not look like a tar archive".
 * 2. Even reaching bsdtar, both parse a colon as an rsync-style `host:path`
 *    separator, so any absolute Windows path fails with "Cannot connect to C:".
 *
 * PowerShell's .NET ZipFile has neither problem and is faster besides.
 */
export async function unzip(zipPath, destDir) {
  await mkdir(destDir, { recursive: true })
  await new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_UNZIP], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, WZ_SRC: zipPath, WZ_DST: destDir },
    })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`unzip exited ${code}: ${err.trim().slice(0, 400)}`))
    )
  })
}

/**
 * A manifest of what was fetched and from where.
 *
 * llama.cpp publishes a new build every day and whisper.cpp retags, so "the
 * latest release" is not a reproducible coordinate. Recording the resolved tag
 * and URL is what lets a future run reproduce this exact set, or explain a
 * regression that arrived with a new build.
 */
export async function writeManifest(file, entry) {
  let data = {}
  if (await exists(file)) {
    try {
      data = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      data = {}
    }
  }
  Object.assign(data, entry, { updatedAt: new Date().toISOString() })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`)
}

export function heading(s) {
  console.log(`\n${s}\n${'-'.repeat(s.length)}`)
}
