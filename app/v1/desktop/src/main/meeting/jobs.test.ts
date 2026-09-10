import { describe, expect, it } from 'vitest'
import type { MeetingJobsView } from '../../shared/ipc.js'
import { MeetingJobs } from './jobs.js'

/**
 * The job queue: one heavy thing at a time, and always able to say which.
 */

function gate(): { promise: Promise<void>; open(): void } {
  let open = (): void => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the meeting job queue', () => {
  it('runs one job at a time, in the order asked', async () => {
    const jobs = new MeetingJobs()
    const order: string[] = []
    const first = gate()
    const second = gate()

    const a = jobs.run(1, 'process', async () => {
      order.push('first starts')
      await first.promise
      return 'A'
    })
    const b = jobs.run(2, 'improve', async () => {
      order.push('second starts')
      await second.promise
      return 'B'
    })
    await settle()

    expect(order).toEqual(['first starts'])
    expect(jobs.view().running).toMatchObject({ meetingId: 1, kind: 'process' })
    expect(jobs.view().queued).toEqual([expect.objectContaining({ meetingId: 2, kind: 'improve' })])

    first.open()
    expect(await a).toBe('A')
    await settle()
    expect(order).toEqual(['first starts', 'second starts'])
    expect(jobs.view().running).toMatchObject({ meetingId: 2 })

    second.open()
    expect(await b).toBe('B')
    await settle()
    expect(jobs.view()).toEqual({ running: null, queued: [] })
  })

  it('carries on after a job fails', async () => {
    const jobs = new MeetingJobs()
    const failed = jobs.run(1, 'notes', async () => {
      throw new Error('the model went away')
    })
    const next = jobs.run(2, 'notes', async () => 'ran')
    await expect(failed).rejects.toThrow('the model went away')
    expect(await next).toBe('ran')
  })

  it('knows which meeting it is working on, and what it has waiting', async () => {
    const jobs = new MeetingJobs()
    const hold = gate()
    const a = jobs.run(1, 'improve', () => hold.promise)
    const b = jobs.run(2, 'notes', async () => undefined)
    await settle()

    expect(jobs.busy()).toBe(true)
    expect(jobs.involves(1)).toBe(true)
    expect(jobs.involves(2)).toBe(true)
    expect(jobs.involves(3)).toBe(false)
    expect(jobs.has(1, 'improve')).toBe(true)
    expect(jobs.has(1, 'notes')).toBe(false)

    hold.open()
    await Promise.all([a, b])
    await settle()
    expect(jobs.busy()).toBe(false)
    expect(jobs.involves(1)).toBe(false)
  })

  it('says so every time something starts, waits or finishes', async () => {
    const jobs = new MeetingJobs()
    const seen: MeetingJobsView[] = []
    jobs.on('change', (view: MeetingJobsView) => seen.push(view))

    await jobs.run(1, 'english', async () => undefined)
    await settle()

    expect(seen.map((v) => v.running?.kind ?? 'idle')).toEqual(['english', 'idle'])
  })
})
