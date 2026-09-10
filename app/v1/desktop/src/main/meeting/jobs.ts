import { EventEmitter } from 'node:events'
import type { MeetingJobKind, MeetingJobView, MeetingJobsView } from '../../shared/ipc.js'

/**
 * The heavy work done on meetings after the call, one job at a time.
 *
 * ONE AT A TIME BECAUSE THERE IS ONE CARD. The English pass and the summary use
 * the language model's single slot; the careful pass unloads that model to fit
 * the larger speech model. Two of these at once do not run faster, they fight
 * over six gigabytes and one of them fails halfway.
 *
 * THIS IS ALSO WHAT KNOWS WHAT IS RUNNING. The meeting page, the list and the
 * sidebar all ask it, rather than inferring "busy" from progress messages -
 * which only arrive while something is actively reporting, so a page opened
 * halfway through a run would otherwise show nothing happening.
 *
 * Nothing survives a restart. A job cut off by closing the app leaves the
 * version it was building without its English or summary, and those have a
 * button to finish them.
 */
export class MeetingJobs extends EventEmitter {
  private running: MeetingJobView | null = null
  private waiting: { view: MeetingJobView; start(): void }[] = []

  view(): MeetingJobsView {
    return { running: this.running, queued: this.waiting.map((job) => job.view) }
  }

  /** Something is running, for any meeting. */
  busy(): boolean {
    return this.running !== null
  }

  /** This meeting is being worked on, or is waiting to be. */
  involves(meetingId: number): boolean {
    return this.running?.meetingId === meetingId || this.waiting.some((j) => j.view.meetingId === meetingId)
  }

  /** This exact job is already running or waiting. */
  has(meetingId: number, kind: MeetingJobKind): boolean {
    const same = (view: MeetingJobView | null): boolean =>
      view?.meetingId === meetingId && view.kind === kind
    return same(this.running) || this.waiting.some((job) => same(job.view))
  }

  /**
   * Run `work` when everything asked for before it has finished.
   *
   * Resolves or rejects with whatever `work` does. A job that fails does not
   * hold up the ones behind it.
   */
  run<T>(meetingId: number, kind: MeetingJobKind, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const view: MeetingJobView = { meetingId, kind, since: Date.now() }
      const start = (): void => {
        this.running = { ...view, since: Date.now() }
        this.changed()
        Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.running = null
            this.next()
          })
      }
      this.waiting.push({ view, start })
      if (this.running) this.changed()
      else this.next()
    })
  }

  private next(): void {
    const job = this.waiting.shift()
    if (job) job.start()
    else this.changed()
  }

  private changed(): void {
    this.emit('change', this.view())
  }
}
