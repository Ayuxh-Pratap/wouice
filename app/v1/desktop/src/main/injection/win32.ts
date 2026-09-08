import { createRequire } from 'node:module'
import path from 'node:path'
import type { PasteCombo, Target } from './policy.js'

/**
 * The Win32 surface, and nothing else.
 *
 * No policy lives here: this reads the foreground window and pushes keystrokes,
 * and `policy.ts` decides whether either is a good idea. Keeping the split means
 * every rule that matters is testable without a desktop.
 *
 * koffi rather than a bespoke native addon. It is Node-API, so it is ABI-stable
 * across Electron versions - the rebuild problem that pushed the first storage
 * decision away from `better-sqlite3` does not apply - and its prebuilt binary
 * ships inside the package, so `npm ci --ignore-scripts` on a stranger's machine
 * still produces something that works. Measured cost of a full target read on
 * this machine: 0.03 ms.
 */

const require = createRequire(import.meta.url)

interface KoffiLib {
  func(convention: string, name: string, ret: string, args: unknown[]): (...a: unknown[]) => unknown
}
interface Koffi {
  load(dll: string): KoffiLib
  pointer(type: string): unknown
  out(type: unknown): unknown
  inout(type: unknown): unknown
  decode(buffer: Buffer, type: string): unknown
  version?: string
}

let koffi: Koffi | null = null
let loadError: string | null = null

try {
  koffi = require('koffi') as Koffi
} catch (err) {
  // A machine without the native binary must still run the app: everything
  // degrades to clipboard-only, which is what the previous build did anyway.
  loadError = err instanceof Error ? err.message : String(err)
}

export function injectionAvailable(): boolean {
  return koffi !== null
}

export function injectionUnavailableReason(): string | null {
  return loadError
}

type Fn = (...a: unknown[]) => unknown

const bindings = (() => {
  if (!koffi) return null
  const k = koffi
  const user32 = k.load('user32.dll')
  const kernel32 = k.load('kernel32.dll')
  const advapi32 = k.load('advapi32.dll')

  return {
    GetForegroundWindow: user32.func('__stdcall', 'GetForegroundWindow', 'void *', []) as Fn,
    GetWindowTextW: user32.func('__stdcall', 'GetWindowTextW', 'int', [
      'void *',
      k.out(k.pointer('uint16_t')),
      'int',
    ]) as Fn,
    GetWindowThreadProcessId: user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', [
      'void *',
      k.out(k.pointer('uint32_t')),
    ]) as Fn,
    SendInput: user32.func('__stdcall', 'SendInput', 'uint32_t', [
      'uint32_t',
      'void *',
      'int',
    ]) as Fn,
    GetLastError: kernel32.func('__stdcall', 'GetLastError', 'uint32_t', []) as Fn,
    OpenProcess: kernel32.func('__stdcall', 'OpenProcess', 'void *', [
      'uint32_t',
      'bool',
      'uint32_t',
    ]) as Fn,
    QueryFullProcessImageNameW: kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', [
      'void *',
      'uint32_t',
      k.out(k.pointer('uint16_t')),
      k.inout(k.pointer('uint32_t')),
    ]) as Fn,
    CloseHandle: kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *']) as Fn,
    GetCurrentProcess: kernel32.func('__stdcall', 'GetCurrentProcess', 'void *', []) as Fn,
    OpenProcessToken: advapi32.func('__stdcall', 'OpenProcessToken', 'bool', [
      'void *',
      'uint32_t',
      k.out(k.pointer('void *')),
    ]) as Fn,
    GetTokenInformation: advapi32.func('__stdcall', 'GetTokenInformation', 'bool', [
      'void *',
      'int',
      k.out(k.pointer('uint8_t')),
      'uint32_t',
      k.out(k.pointer('uint32_t')),
    ]) as Fn,
  }
})()

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TOKEN_QUERY = 0x0008
/** TOKEN_INFORMATION_CLASS::TokenElevation */
const TOKEN_ELEVATION = 20

/**
 * Is this process running elevated?
 *
 * MEASURED, in spike V6c. Windows silently drops synthetic input crossing from
 * a lower integrity level to a higher one: `SendInput` returned 4 of 4 events
 * accepted, and not one character reached an elevated window. The transcript
 * would be gone with nothing anywhere reporting a problem.
 *
 * The first version of the policy guessed at this by checking whether the
 * target's executable could be read, on the theory that a refused `OpenProcess`
 * meant higher integrity. V6c disproved it: `powershell.exe` running as
 * administrator reported its name perfectly well, so the guard never fired.
 * `TokenElevation` gives the real answer, and gives it from outside.
 *
 * `pid: 0` means this process. Returns null when the answer cannot be
 * determined, which callers must read as "assume it might be", never as "no".
 */
export function isProcessElevated(pid: number): boolean | null {
  if (!bindings) return null
  const handle =
    pid === 0
      ? bindings.GetCurrentProcess()
      : bindings.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return null

  let result: boolean | null = null
  const tokenBuf = Buffer.alloc(8)
  if (bindings.OpenProcessToken(handle, TOKEN_QUERY, tokenBuf)) {
    const token = koffi!.decode(tokenBuf, 'void *')
    const info = Buffer.alloc(4)
    const returned = Buffer.alloc(4)
    if (bindings.GetTokenInformation(token, TOKEN_ELEVATION, info, 4, returned)) {
      result = info.readUInt32LE(0) !== 0
    }
    bindings.CloseHandle(token)
  }
  if (pid !== 0) bindings.CloseHandle(handle)
  return result
}

/** Cached: a process cannot change its own elevation while it runs. */
let selfElevatedCache: boolean | null | undefined
export function selfElevated(): boolean {
  if (selfElevatedCache === undefined) selfElevatedCache = isProcessElevated(0)
  return selfElevatedCache === true
}
/** Chrome puts the whole page title in there, so this is generous on purpose. */
const TITLE_CHARS = 1024

/**
 * Everything the policy needs about the window in front.
 *
 * Returns `exe: ''` when the process could not be opened at all - a protected
 * process, or one that exited between the two calls. That is NOT an elevation
 * check: V6c measured an elevated `powershell.exe` reporting its name perfectly
 * well through `PROCESS_QUERY_LIMITED_INFORMATION`, which is exactly what the
 * "limited" access right exists for. Elevation is `isProcessElevated`.
 */
export function foregroundTarget(): Target | null {
  if (!bindings) return null
  const hwnd = bindings.GetForegroundWindow()
  if (!hwnd) return null

  const titleBuf = Buffer.alloc(TITLE_CHARS * 2)
  const n = Number(bindings.GetWindowTextW(hwnd, titleBuf, TITLE_CHARS))
  const title = n > 0 ? titleBuf.toString('utf16le', 0, n * 2) : ''

  const pidBuf = Buffer.alloc(4)
  bindings.GetWindowThreadProcessId(hwnd, pidBuf)
  const pid = pidBuf.readUInt32LE(0)

  let exe = ''
  const handle = bindings.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (handle) {
    const nameBuf = Buffer.alloc(2048)
    const sizeBuf = Buffer.alloc(4)
    sizeBuf.writeUInt32LE(1024, 0)
    if (bindings.QueryFullProcessImageNameW(handle, 0, nameBuf, sizeBuf)) {
      exe = path
        .basename(nameBuf.toString('utf16le', 0, sizeBuf.readUInt32LE(0) * 2))
        .toLowerCase()
    }
    bindings.CloseHandle(handle)
  }

  return { hwnd: String(hwnd), pid, exe, title }
}

// ------------------------------------------------------------------- input

/**
 * One INPUT record, built as raw bytes rather than a koffi struct.
 *
 * x64 layout, which a struct definition would have to reproduce anyway:
 *   0  DWORD type            (INPUT_KEYBOARD = 1)
 *   4  (4 bytes padding: the union is 8-aligned because of dwExtraInfo)
 *   8  WORD  wVk
 *  10  WORD  wScan
 *  12  DWORD dwFlags
 *  16  DWORD time
 *  24  ULONG_PTR dwExtraInfo
 *  The union is sized by MOUSEINPUT (32 bytes), so the record is 40.
 */
const INPUT_SIZE = 40
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

function record(vk: number, scan: number, flags: number): Buffer {
  const b = Buffer.alloc(INPUT_SIZE)
  b.writeUInt32LE(1, 0)
  b.writeUInt16LE(vk, 8)
  b.writeUInt16LE(scan, 10)
  b.writeUInt32LE(flags, 12)
  return b
}

export interface SendResult {
  sent: number
  expected: number
  lastError: number
}

function send(records: Buffer[]): SendResult {
  if (!bindings || records.length === 0) return { sent: 0, expected: records.length, lastError: 0 }
  const sent = Number(bindings.SendInput(records.length, Buffer.concat(records), INPUT_SIZE))
  return {
    sent,
    expected: records.length,
    lastError: sent === records.length ? 0 : Number(bindings.GetLastError()),
  }
}

/** Press a key with modifiers held around it. */
export function pressCombo(combo: PasteCombo): SendResult {
  return send([
    ...combo.modifiers.map((m) => record(m, 0, 0)),
    record(combo.key, 0, 0),
    record(combo.key, 0, KEYEVENTF_KEYUP),
    ...[...combo.modifiers].reverse().map((m) => record(m, 0, KEYEVENTF_KEYUP)),
  ])
}

/** Records per SendInput call, and the pause after each. Two records per char. */
const TYPE_BATCH_RECORDS = 200
const TYPE_GAP_MS = 4

/**
 * Type text as Unicode, in paced batches.
 *
 * `KEYEVENTF_UNICODE` puts a UTF-16 code unit in `wScan` and leaves `wVk` zero,
 * so the character arrives regardless of keyboard layout and Devanagari behaves
 * exactly like ASCII.
 *
 * The pacing is not a preference. V6b measured a 585-character string sent as a
 * single call arriving intact on two runs out of five, losing up to 73
 * characters on the others - with `SendInput` reporting every event accepted.
 * Batching made it reliable at that length in isolation and still failed under
 * load, which is why this path is only ever used for short text. `await` rather
 * than a busy wait, because this runs on the main thread.
 */
export async function typeText(text: string): Promise<SendResult> {
  const records: Buffer[] = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    records.push(record(0, code, KEYEVENTF_UNICODE))
    records.push(record(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
  }

  let sent = 0
  for (let i = 0; i < records.length; i += TYPE_BATCH_RECORDS) {
    sent += send(records.slice(i, i + TYPE_BATCH_RECORDS)).sent
    if (i + TYPE_BATCH_RECORDS < records.length) {
      await new Promise((resolve) => setTimeout(resolve, TYPE_GAP_MS))
    }
  }
  return { sent, expected: records.length, lastError: 0 }
}
