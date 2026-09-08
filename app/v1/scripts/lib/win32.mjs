// Win32 bindings for the injection spikes, via koffi.
//
// Kept in one place because two spikes need them and, more to the point,
// because this is the shape the production module will take: a thin, typed
// surface over user32/kernel32 with no policy in it. Nothing here decides
// anything - it reads the foreground window and sends input, and the callers
// decide whether either is a good idea.

import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

export const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'void *', [])
export const FindWindowW = user32.func('__stdcall', 'FindWindowW', 'void *', ['void *', 'str16'])
export const SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['void *'])
export const BringWindowToTop = user32.func('__stdcall', 'BringWindowToTop', 'bool', ['void *'])
// koffi registers prototypes by name globally, so this is declared once and
// reused. Declaring it twice is a hard error, not a shadowed redefinition.
const EnumProc = koffi.pointer(koffi.proto('__stdcall', 'EnumProc', 'bool', ['void *', 'int64_t']))
export const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'bool', [EnumProc, 'int64_t'])
export const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', ['void *'])
export const SendInput = user32.func('__stdcall', 'SendInput', 'uint32_t', ['uint32_t', 'void *', 'int'])
export const AttachThreadInput = user32.func('__stdcall', 'AttachThreadInput', 'bool', [
  'uint32_t',
  'uint32_t',
  'bool',
])

const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', [
  'void *',
  koffi.out(koffi.pointer('uint16_t')),
  'int',
])
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', [
  'void *',
  koffi.out(koffi.pointer('uint32_t')),
])
const GetCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32_t', [])
const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32_t', [])
const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32_t', 'bool', 'uint32_t'])
const QueryFullProcessImageNameW = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', [
  'void *',
  'uint32_t',
  koffi.out(koffi.pointer('uint16_t')),
  koffi.inout(koffi.pointer('uint32_t')),
])
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *'])

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** Window titles can be long; Chrome puts the whole page title in there. */
const TITLE_CHARS = 2048

export function windowTitle(hwnd) {
  if (!hwnd) return ''
  const buf = Buffer.alloc(TITLE_CHARS * 2)
  const n = GetWindowTextW(hwnd, buf, TITLE_CHARS)
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : ''
}

export function windowProcess(hwnd) {
  const pidBuf = Buffer.alloc(4)
  const threadId = GetWindowThreadProcessId(hwnd, pidBuf)
  const pid = pidBuf.readUInt32LE(0)

  let exe = ''
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (handle) {
    const nameBuf = Buffer.alloc(2048)
    const sizeBuf = Buffer.alloc(4)
    sizeBuf.writeUInt32LE(1024, 0)
    if (QueryFullProcessImageNameW(handle, 0, nameBuf, sizeBuf)) {
      exe = path.basename(nameBuf.toString('utf16le', 0, sizeBuf.readUInt32LE(0) * 2))
    }
    CloseHandle(handle)
  }
  return { pid, threadId, exe }
}

/** Everything the injection policy needs to decide whether to send input. */
export function foregroundTarget() {
  const hwnd = GetForegroundWindow()
  if (!hwnd) return null
  const { pid, exe } = windowProcess(hwnd)
  return { hwnd: String(hwnd), pid, exe, title: windowTitle(hwnd) }
}

/** First visible top-level window whose title satisfies `match`. */
export function findWindow(match) {
  let found = null
  const cb = koffi.register((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true
    const title = windowTitle(hwnd)
    if (title && match(title)) {
      found = { hwnd, title }
      return false
    }
    return true
  }, EnumProc)
  try {
    EnumWindows(cb, 0)
  } finally {
    koffi.unregister(cb)
  }
  return found
}

/**
 * Pull a window to the front.
 *
 * SPIKE SCAFFOLDING, not something the product does. The real flow never moves
 * focus - the user is already in the window they want text in - but Windows
 * refuses to let a freshly launched process take the foreground, so a test
 * target has to be dragged forward. Attaching input queues is what lifts that
 * lock for the duration of the call.
 */
export function forceForeground(hwnd) {
  const fg = GetForegroundWindow()
  const fgThread = fg ? windowProcess(fg).threadId : 0
  const ourThread = GetCurrentThreadId()
  if (fgThread) AttachThreadInput(ourThread, fgThread, true)
  BringWindowToTop(hwnd)
  const ok = SetForegroundWindow(hwnd)
  if (fgThread) AttachThreadInput(ourThread, fgThread, false)
  return ok
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
export const INPUT_SIZE = 40
export const KEYEVENTF_KEYUP = 0x0002
export const KEYEVENTF_UNICODE = 0x0004

export const VK = {
  CONTROL: 0x11,
  MENU: 0x12, // Alt
  SHIFT: 0x10,
  RETURN: 0x0d,
  F4: 0x73,
  S: 0x53,
  W: 0x57,
  V: 0x56,
}

export function input(vk, scan, flags) {
  const b = Buffer.alloc(INPUT_SIZE)
  b.writeUInt32LE(1, 0)
  b.writeUInt16LE(vk, 8)
  b.writeUInt16LE(scan, 10)
  b.writeUInt32LE(flags, 12)
  return b
}

export function send(records) {
  if (records.length === 0) return { sent: 0, expected: 0, lastError: 0 }
  const sent = SendInput(records.length, Buffer.concat(records), INPUT_SIZE)
  return { sent, expected: records.length, lastError: sent === records.length ? 0 : GetLastError() }
}

/** A key with modifiers held down around it, e.g. chord(VK.S, [VK.CONTROL]). */
export function chord(vk, modifiers = []) {
  return send([
    ...modifiers.map((m) => input(m, 0, 0)),
    input(vk, 0, 0),
    input(vk, 0, KEYEVENTF_KEYUP),
    ...[...modifiers].reverse().map((m) => input(m, 0, KEYEVENTF_KEYUP)),
  ])
}

/**
 * Build the INPUT records to type text as Unicode.
 *
 * KEYEVENTF_UNICODE puts a UTF-16 code unit in wScan and leaves wVk zero, so
 * the character arrives regardless of keyboard layout: no dead keys, no layout
 * mapping, and Devanagari behaves exactly like ASCII. Surrogate pairs go as two
 * consecutive units, which is what Windows expects.
 */
export function unicodeRecords(text) {
  const records = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    records.push(input(0, code, KEYEVENTF_UNICODE))
    records.push(input(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
  }
  return records
}

/**
 * Type text in paced batches.
 *
 * One SendInput call for the whole string is the ideal - the sequence cannot
 * then be interleaved with the user's own typing - but it does not survive
 * contact with real targets. Measured: a 585-character string sent as one call
 * of 1170 records lost a third of itself in Chrome and all of itself in VS
 * Code. The events are delivered; the target drops them when they arrive faster
 * than it drains its input queue.
 *
 * So the string goes in chunks with a real pause between them. `await` rather
 * than a busy wait, because this runs on the app's main thread and blocking it
 * would freeze the UI for the duration of a long transcript.
 */
export async function typeUnicodePaced(text, { batch = 100, gapMs = 5 } = {}) {
  const records = unicodeRecords(text)
  const started = performance.now()
  let sent = 0
  let batches = 0

  // A batch of 0 means "all of it in one call". Without this the loop below
  // advances by zero and never terminates.
  const step = batch > 0 ? batch : records.length

  for (let i = 0; i < records.length; i += step) {
    const r = send(records.slice(i, i + step))
    sent += r.sent
    batches++
    if (gapMs > 0 && i + step < records.length) {
      await new Promise((resolve) => setTimeout(resolve, gapMs))
    }
  }

  return { sent, expected: records.length, batches, ms: performance.now() - started }
}
