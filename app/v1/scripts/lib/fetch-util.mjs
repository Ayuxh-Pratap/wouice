// Shared download / extract helpers for the fetch scripts.
//
// Deliberately zero-dependency: this runs before `npm install` has necessarily
// happened, so it may only use Node builtins and tools Windows already ships.
// Zip extraction uses bsdtar (C:\Windows\System32\tar.exe, present since
// Win10 1803), which is both faster and less fussy than PowerShell's
// Expand-Archive on multi-hundred-megabyte archives.

import { createWriteStream } from 'node:fs'
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

/**
 * Download to `dest`, streaming, with a single rewriting progress line.
 *
 * Writes to `<dest>.part` and renames on success, so an interrupted run can
 * never leave a truncated file that a later run mistakes for complete. That
 * matters here because these are multi-hundred-megabyte downloads over a
 * connection that may well drop.
 */
export async function download(url, dest, label) {
  await mkdir(path.dirname(dest), { recursive: true })
  const part = `${dest}.part`
  await rm(part, { force: true })

  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'wouice-fetch' } })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)

  const total = Number(res.headers.get('content-length') ?? 0)
  let seen = 0
  let lastDraw = 0

  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => {
    seen += c.length
    const now = Date.now()
    if (now - lastDraw > 250) {
      lastDraw = now
      const pct = total ? `${((seen / total) * 100).toFixed(1).padStart(5)}%` : '     '
      process.stdout.write(`\r    ${label}  ${pct}  ${fmtBytes(seen)}${total ? ` / ${fmtBytes(total)}` : ''}   `)
    }
  })

  await pipeline(body, createWriteStream(part))
  process.stdout.write(`\r    ${label}  done   ${fmtBytes(seen)}${' '.repeat(24)}\n`)
  await rename(part, dest)
  return seen
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
