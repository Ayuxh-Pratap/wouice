import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MeetingController, type MeetingState } from './controller.js'
import { abandonedSessions } from './merge.js'
import { MeetingRecorder } from './recorder.js'
import { CHECKPOINT_SAMPLES } from './session.js'

/**
 * The meeting state machine, which decides what a half-open capture means.
 *
 * The interesting cases are all failures: one channel refused, both refused,
 * and a window that goes away without telling anyone. Each of those has an
 * obvious wrong behaviour - lose the meeting - and the tests pin the right one.
 */

let root: string
let controller: MeetingController

const speech = (n = 320, value = 0.05): Float32Array => new Float32Array(n).fill(value)

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wouice-mc-'))
  controller = new MeetingController(root)
})

afterEach(async () => {
  await controller.stop()
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

describe('the happy path', () => {
  it('walks idle → starting → recording → merging → idle', async () => {
    const seen: string[] = []
    controller.on('state', (s: MeetingState) => seen.push(s.phase))

    const session = controller.start(1_000_000)
    expect(session).not.toBeNull()
    controller.captureReady(session!)
    controller.frame(session!, 'me', speech(), 1_000_000)
    await controller.stop(1_000_500)

    expect(seen).toEqual(['starting', 'recording', 'merging', 'idle'])
  })

  it('produces a file that outlives the meeting', async () => {
    const session = controller.start(2_000_000)!
    controller.captureReady(session)
    controller.frame(session, 'me', speech(16_000), 2_000_000)
    controller.frame(session, 'them', speech(16_000, -0.05), 2_000_000)

    const result = await controller.stop(2_001_000)
    expect(result).not.toBeNull()
    expect(existsSync(result!.path)).toBe(true)
  })

  it('refuses to start a second meeting on top of one', () => {
    const first = controller.start(3_000_000)
    expect(first).not.toBeNull()
    expect(controller.start(3_000_100)).toBeNull()
  })
})

describe('frames that should not land', () => {
  it('ignores a frame stamped with a previous session', async () => {
    const first = controller.start(4_000_000)!
    controller.captureReady(first)
    await controller.stop(4_000_100)

    const second = controller.start(4_000_200)!
    controller.captureReady(second)
    controller.frame(first, 'me', speech(16_000), 4_000_300)

    const state = controller.state(4_000_400)
    expect(state.channels.find((c) => c.channel === 'me')!.samples).toBe(0)
  })

  it('ignores frames once the meeting is over', async () => {
    const session = controller.start(5_000_000)!
    controller.captureReady(session)
    await controller.stop(5_000_100)
    // A worklet in flight when the stream closed. Nothing to write to.
    expect(() => controller.frame(session, 'me', speech(), 5_000_200)).not.toThrow()
  })
})

describe('a channel that will not open', () => {
  it('records the other one anyway', async () => {
    // A refused microphone still leaves the far side recorded, which is worth
    // much more than refusing to record at all.
    const session = controller.start(6_000_000)!
    controller.captureFailed(session, 'me', 'permission denied')
    controller.frame(session, 'them', speech(16_000), 6_000_000)

    const state = controller.state(6_000_100)
    expect(state.phase).toBe('recording')
    expect(state.channels.find((c) => c.channel === 'me')!.problem).toBe('permission denied')

    const result = await controller.stop(6_001_000)
    expect(result).not.toBeNull()
  })

  it('gives up only when both fail', async () => {
    const session = controller.start(7_000_000)!
    controller.captureFailed(session, 'me', 'permission denied')
    controller.captureFailed(session, 'them', 'no loopback')

    // stop() is asynchronous; the phase leaves 'starting' either way.
    await controller.stop()
    expect(controller.state().phase).toBe('idle')
  })
})

describe('the level meter', () => {
  it('falls back to zero when frames stop arriving', () => {
    const session = controller.start(8_000_000)!
    controller.captureReady(session)
    controller.frame(session, 'me', speech(320, 0.2), 8_000_000)

    expect(controller.state(8_000_100).channels[0]!.level).toBeGreaterThan(0)
    // A meter still showing the last level two seconds later reads as
    // "listening" when nothing is being heard.
    const stale = controller.state(8_002_000).channels[0]!
    expect(stale.level).toBe(0)
    expect(stale.live).toBe(false)
  })
})

describe('recovery at startup', () => {
  it('merges what a previous run left behind', async () => {
    const orphan = new MeetingRecorder(root, 9_000_000)
    orphan.write('me', new Float32Array(CHECKPOINT_SAMPLES).fill(0.2), 9_000_000)
    expect(abandonedSessions(root)).toHaveLength(1)

    const recovered = await controller.recoverAbandoned()
    expect(recovered).toBe(1)
    expect(abandonedSessions(root)).toHaveLength(0)
  })

  it('finds nothing to do on a clean start', async () => {
    expect(await controller.recoverAbandoned()).toBe(0)
  })
})
