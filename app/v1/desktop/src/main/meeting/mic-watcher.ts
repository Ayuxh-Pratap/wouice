import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import {
  dismiss,
  initialDetectState,
  meetingAppsInUse,
  step,
  DEFAULT_DETECT,
  type DetectConfig,
  type DetectState,
} from './detect.js'

/**
 * Watch the microphone, and offer to record when a meeting starts.
 *
 * READ-ONLY, AND CHEAP. One `reg query` of the CapabilityAccessManager consent
 * store every few seconds. No hook, no driver, no elevation, and nothing that
 * could interfere with the application actually using the microphone - which
 * matters, because the thing being watched is a call the person is on.
 *
 * EVERY DECISION IS IN `detect.ts`. This is the shell: it reads, it hands the
 * text to a pure function, and it emits what that function decided. The timing
 * rules are the part that will be tuned by use, so they live where they can be
 * argued with in a test.
 */

const CONSENT_STORE =
  'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'

/**
 * How often to look.
 *
 * Four seconds against a four second debounce means an offer arrives within
 * about eight seconds of a call starting, which is soon enough to be useful and
 * slow enough that a device test does not trigger it.
 */
const POLL_MS = 4_000

/** A registry read that hangs must not accumulate. */
const READ_TIMEOUT_MS = 5_000

export interface MicWatcherDeps {
  /** True while a meeting is already being recorded. */
  isRecording(): boolean
  config?: DetectConfig
  intervalMs?: number
}

export class MicWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private state: DetectState = initialDetectState()
  private reading = false
  private lastError = ''

  constructor(private readonly deps: MicWatcherDeps) {
    super()
  }

  get running(): boolean {
    return this.timer !== null
  }

  /** Why the last read failed, for the diagnostics panel. Empty when fine. */
  get problem(): string {
    return this.lastError
  }

  start(): void {
    if (this.timer) return
    this.state = initialDetectState()
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? POLL_MS)
    // Not on the first tick: an app already in a call when the watcher starts
    // still has to clear the debounce, so nothing fires at launch.
    void this.tick()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** You said no to the offer. */
  dismissOffer(now = Date.now()): void {
    this.state = dismiss(this.state, now, this.deps.config)
  }

  private async tick(): Promise<void> {
    // A slow registry read must not stack up behind itself.
    if (this.reading) return
    this.reading = true
    try {
      const apps = await this.read()
      const result = step(
        this.state,
        { now: Date.now(), apps, recording: this.deps.isRecording() },
        this.deps.config
      )
      this.state = result.state
      if (result.offer) this.emit('offer', result.offer)
    } finally {
      this.reading = false
    }
  }

  /**
   * @returns meeting applications holding the microphone, or an empty list.
   *
   * A failed read is never an error the person has to see. The consent store is
   * a Windows implementation detail; if it moves or is locked down, automatic
   * detection stops working and the button still does.
   */
  private async read(): Promise<string[]> {
    try {
      const output = await query(`HKCU\\${CONSENT_STORE}`)
      this.lastError = ''
      return meetingAppsInUse(output)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return []
    }
  }
}

function query(key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'reg',
      ['query', key, '/s'],
      { timeout: READ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        // `reg query` exits non-zero when the key does not exist, which is a
        // legitimate state on a machine where nothing has ever used the
        // microphone - not a failure worth reporting.
        if (err && !stdout) reject(err)
        else resolve(stdout)
      }
    )
  })
}
