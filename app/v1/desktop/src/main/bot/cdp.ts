import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

/**
 * Talking to Chrome over the DevTools protocol, through a pipe.
 *
 * A PIPE, NOT A PORT. `--remote-debugging-port` opens a socket that any
 * program on this machine can connect to, and while it is open that program is
 * driving a browser signed in to the bot's Google account. With
 * `--remote-debugging-pipe` the connection belongs to this process alone:
 * Chrome reads commands on file descriptor 3 and writes replies on 4, every
 * message ending in a NUL byte.
 *
 * Deliberately small. Checking which account the bot is signed in to needs a
 * handful of commands; driving a meeting (stage B1) is where a full driver
 * earns its place.
 */

export class CdpError extends Error {}

interface Waiter {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class CdpConnection {
  private buffer = Buffer.alloc(0)
  private nextId = 0
  private readonly pending = new Map<number, Waiter>()
  private closedReason: string | null = null

  constructor(private readonly write: (frame: Buffer) => void) {}

  /**
   * Bytes from Chrome.
   *
   * Kept as bytes until a NUL arrives: a message can be split across chunks,
   * and so can a multi-byte character inside it, which decoding each chunk on
   * its own would corrupt.
   */
  receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    let end: number
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const raw = this.buffer.subarray(0, end).toString('utf8')
      this.buffer = this.buffer.subarray(end + 1)
      this.dispatch(raw)
    }
  }

  private dispatch(raw: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }
    // Events carry no id. Nothing here listens for them yet.
    if (typeof message.id !== 'number') return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new CdpError(message.error.message ?? 'command failed'))
    else waiter.resolve(message.result ?? {})
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    sessionId?: string,
    timeoutMs = 15_000
  ): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new CdpError(this.closedReason))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`${method} got no answer in ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.write(Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'))
    })
  }

  /** Every command still waiting fails now, with a reason worth reading. */
  close(reason: string): void {
    if (this.closedReason === null) this.closedReason = reason
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new CdpError(reason))
      this.pending.delete(id)
    }
  }
}

export interface LaunchedChrome {
  cdp: CdpConnection
  process: ChildProcess
  /** Asks Chrome to close, and makes sure it has. */
  close(): Promise<void>
}

export interface LaunchOptions {
  chromePath: string
  userDataDir: string
  headless: boolean
  args?: string[]
}

export function launchChrome(options: LaunchOptions): LaunchedChrome {
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.headless ? ['--headless=new'] : []),
    ...(options.args ?? []),
    'about:blank',
  ]
  const child = spawn(options.chromePath, args, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const toChrome = child.stdio[3] as Writable
  const fromChrome = child.stdio[4] as Readable

  const cdp = new CdpConnection((frame) => toChrome.write(frame))
  fromChrome.on('data', (chunk: Buffer) => cdp.receive(chunk))
  child.on('exit', (code) => cdp.close(`Chrome exited${code === null ? '' : ` with code ${code}`}`))
  child.on('error', (err) => cdp.close(`Chrome could not start: ${err.message}`))
  // Writing after Chrome has gone raises EPIPE here; the exit above already
  // says what happened, and an unhandled stream error would crash the app.
  toChrome.on('error', () => undefined)

  const gone = (): boolean => child.exitCode !== null || child.signalCode !== null
  const close = async (): Promise<void> => {
    if (gone()) return
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      if (gone()) resolve()
    })
    await cdp.send('Browser.close', {}, undefined, 3_000).catch(() => undefined)
    // A Chrome that ignores the request is killed, never left holding the
    // bot's profile - the next check would find it "in use" forever.
    const timer = setTimeout(() => child.kill(), 5_000)
    await exited
    clearTimeout(timer)
  }

  return { cdp, process: child, close }
}
