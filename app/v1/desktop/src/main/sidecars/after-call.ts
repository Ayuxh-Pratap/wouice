import { EventEmitter } from 'node:events'
import type { EngineView } from '../../shared/ipc.js'
import { findModel, type SidecarId } from '../../shared/models.js'
import type { GpuReading } from './gpu.js'

/**
 * Larger models for a meeting's English and notes, after the call.
 *
 * The 4B that dictation uses is the only model that fits beside Whisper on a
 * 6 GB card, and on three graded meetings it was the weakest at the one thing
 * meetings need: finding the work in a noisy transcript without inventing any.
 * A meeting's write-up does not have to share the card with dictation, though.
 * So after a call this pauses dictation, takes both dictation models off the
 * card, loads a larger model for each step, and puts dictation back. Why these
 * models, and every number below: docs/design/08-after-call-models.md.
 *
 * NOTHING HERE MAY LEAVE DICTATION BROKEN. Everything after the pause is in
 * one try/finally, and restoring runs on success, on failure and on an abort -
 * and restores the models your settings name, never a snapshot of whatever
 * was loaded (the careful pass learned that one the hard way, see repass.ts).
 *
 * NOTHING HERE IS GUESSED ABOUT MEMORY. The card is measured before every load
 * (is there room?) and after it (did it all land on the GPU?). A model that
 * does not fit, loads partly on the processor, or does not start is passed
 * over for the next one - down to the dictation model itself - so a meeting
 * always gets its English and notes from something, and the record says which.
 */

export type Role = 'english' | 'notes'

/** The parts of the supervisor this uses. An interface, so the tests need no processes. */
export interface Sidecars {
  stop(id: SidecarId): Promise<void>
  start(id: SidecarId): Promise<void>
  switchModel(id: SidecarId, modelId: string): Promise<void>
  whenModel(id: SidecarId, modelId: string, timeoutMs?: number): Promise<boolean>
  whenIdle(id: SidecarId, timeoutMs?: number): Promise<boolean>
  snapshot(id: SidecarId): { status: string; modelId: string; lastError: string | null }
}

/** The model a step is running on. */
export interface Loaded {
  id: string
  label: string
  /** Requests it can serve at once. */
  slots: number
}

/** What the work is handed: the models, a way to report progress, and the abort. */
export interface Session {
  /** Aborted when a recording starts or you ask for dictation back. */
  readonly signal: AbortSignal
  /** Put the best model for this step on the card that safely fits, and say which it is. */
  use(role: Role): Promise<Loaded>
  /** How far through the current step. `detail` is shown under the step's name. */
  progress(done: number, total: number, detail: string): void
}

/**
 * How many WORDS each step will read; 0 when that step will not run. For the
 * time left - lines were the first measure, and a poor one: a line of Meet's
 * captions can be sixty words, a line of recorded speech five.
 */
export interface Plan {
  english: number
  notes: number
}

/** What happened, kept on the version so a slow or odd run can be explained later. */
export interface AfterCallRecord {
  at: number
  /** Which model wrote each step. */
  models: Partial<Record<Role, string>>
  /** Why a better model was passed over, or anything else that did not go to plan. */
  fallbacks: string[]
  ms: {
    pause: number
    unload: number
    work: number
    restore: number
    loads: { model: string; ms: number; addedMiB: number | null }[]
  }
  vram: { total: number | null; before: number | null; idle: number | null; peak: number | null; after: number | null }
  hottestC: number | null
  /** Both dictation models were confirmed serving again. */
  restored: boolean
  /** Why the work stopped before it finished, when it did. */
  stopped: string | null
}

export interface AfterCallDeps {
  sidecars: Sidecars
  gpu(): Promise<GpuReading | null>
  /** The models your settings name for dictation. Read when restoring, so a switch made meanwhile applies. */
  dictationModels(): Record<SidecarId, string>
  /** The setting, and whether now is a time to swap at all. Off: the dictation model writes everything. */
  enabled(): boolean
  /** Best first, per step. The dictation language model is always the last resort. */
  candidates: Record<Role, readonly string[]>
  onView?(view: EngineView): void
  onRecord?(meetingId: number, record: AfterCallRecord): void
  timing?: Partial<Timing>
}

export interface Timing {
  /** How long to wait for a dictation in flight. One is capped at five minutes, then transcribed. */
  pauseMs: number
  /** How long to wait for memory to come back after stopping the dictation models. */
  releaseMs: number
  loadMs: number
  restoreMs: number
  pollMs: number
  /** How often the card is measured while this runs. */
  sampleMs: number
}

const TIMING: Timing = {
  pauseMs: 7 * 60_000,
  releaseMs: 15_000,
  loadMs: 120_000,
  restoreMs: 120_000,
  pollMs: 500,
  sampleMs: 3_000,
}

/**
 * Free memory a model needs beyond its own footprint before it is loaded.
 *
 * Above llama.cpp's own `--fit-target` of 256 on purpose. Given less than
 * that, `--fit` quietly moves layers to the processor to keep 256 free - no
 * failure, just a slower model - so a margin below it would let a load
 * through that was always going to spill.
 */
export const LOAD_MARGIN_MIB = 300
/** Memory that must still be free once a model has loaded. */
export const MIN_FREE_AFTER_LOAD_MIB = 128
/**
 * Less than this share of a model's footprint arriving on the card means
 * layers went to the processor. Measured loads of one model varied by 4%.
 */
export const ON_GPU_SHARE = 0.9
/** Stopping the dictation models must give back at least this share of what they hold. */
export const RELEASE_SHARE = 0.8
/** Above this a laptop GPU slows itself down. Not unsafe; worth saying. */
export const HOT_C = 90

/**
 * How long each step takes before it has a rate of its own, measured on the
 * hot GPU (08 §8), per word. English on Gemma 4 E4B: 0.065 s a word on one
 * slot, 0.035 on four. Qwen3.5's notes: 20 s plus 0.08 s a word, within 10% on
 * all three graded meetings. Replaced by the step's real rate once it has one.
 */
const ENGLISH_SEC_PER_WORD = { oneSlot: 0.065, parallel: 0.035 }
const NOTES_SEC = { fixed: 20, perWord: 0.08 }
const UNLOAD_SEC = 4
const LOAD_SEC = 8
const RESTORE_SEC = 12

/** Room for this model: free memory covers its footprint and the margin. Unknown memory is not a veto. */
export function roomFor(footprintMiB: number, gpu: GpuReading | null): boolean {
  if (!gpu) return true
  return gpu.totalMiB - gpu.usedMiB >= footprintMiB + LOAD_MARGIN_MIB
}

/**
 * Where a model landed, from the card before and after loading it.
 *
 * 'spilled': far less arrived than it takes, so `--fit` put layers on the
 * processor - correct, and several times slower (Gemma 12B took 34 minutes over
 * one meeting's notes). 'tight': it is all there, with too little left for the
 * card to work with.
 */
export function landing(
  footprintMiB: number,
  before: GpuReading | null,
  after: GpuReading | null
): 'ok' | 'spilled' | 'tight' {
  if (!before || !after) return 'ok'
  if (after.totalMiB - after.usedMiB < MIN_FREE_AFTER_LOAD_MIB) return 'tight'
  if (after.usedMiB - before.usedMiB < footprintMiB * ON_GPU_SHARE) return 'spilled'
  return 'ok'
}

/** "a minute", "4 min" - no false precision. */
export function inMinutes(sec: number): string {
  return sec < 90 ? 'a minute' : `${Math.round(sec / 60)} min`
}

/**
 * A notes step as one steady bar and a few words.
 *
 * The notes engine reports stages - each part read, then its work found, then
 * the summary, then each task written up - and each restarts its own count.
 * Shown raw, the bar ran to the end and jumped back three times over one
 * meeting. Here they are laid end to end in the order they happen.
 */
export function describeNotesStep(p: { stage: string; chunk: number; chunks: number }): { share: number; words: string } {
  const of = p.chunk > 0 && p.chunks > 0 ? ` ${p.chunk} of ${p.chunks}` : ''
  const parts = Math.max(1, p.chunks)
  switch (p.stage) {
    case 'condensing':
      return { share: (0.6 * Math.max(0, p.chunk - 1)) / parts, words: `reading part${of}` }
    case 'extracting':
      return { share: (0.6 * Math.max(0, p.chunk - 0.5)) / parts, words: `finding the work in part${of}` }
    case 'writing':
      return { share: 0.62, words: 'writing the summary' }
    default:
      return p.chunk > 0
        ? { share: 0.65 + (0.35 * p.chunk) / parts, words: `writing up task${of}` }
        : { share: 0.64, words: 'grouping the work' }
  }
}

export type Stage = 'pausing' | 'unloading' | 'loading' | 'working' | 'restoring'

/** Where a write-up has got to, which is all the time left depends on. */
export interface Position {
  stage: Stage
  /** The step being loaded or worked on; null before the first. */
  role: Role | null
  plan: Plan
  /** Slots of the English model: the one loaded, or the one about to be. */
  slots: number
  /** How far through the step being worked on, 0..1. */
  fraction: number
  /** Seconds since the current stage began. */
  stageSec: number
}

function stepSeconds(role: Role, words: number, slots: number): number {
  return role === 'english'
    ? words * (slots > 1 ? ENGLISH_SEC_PER_WORD.parallel : ENGLISH_SEC_PER_WORD.oneSlot)
    : NOTES_SEC.fixed + words * NOTES_SEC.perWord
}

/**
 * Seconds until dictation is back: what is left of this stage, every step
 * still to come with its load, and the restore.
 *
 * A step in progress is judged by its own rate once it has done a twentieth
 * of its work - which says more about this meeting on this card today than
 * any constant - and by the measured rate until then.
 */
export function secondsLeft(p: Position): number {
  if (p.stage === 'restoring') return Math.max(2, Math.round(RESTORE_SEC - p.stageSec))
  let sec = RESTORE_SEC
  if (p.stage === 'pausing') sec += UNLOAD_SEC
  if (p.stage === 'unloading') sec += Math.max(1, UNLOAD_SEC - p.stageSec)
  const order: Role[] = ['english', 'notes']
  const current = p.role ? order.indexOf(p.role) : -1
  for (const [i, role] of order.entries()) {
    const words = p.plan[role]
    if (!words || i < current) continue
    const whole = stepSeconds(role, words, p.slots)
    if (i === current && p.stage === 'working') {
      sec +=
        p.fraction >= 0.05 && p.stageSec >= 3
          ? (p.stageSec * (1 - p.fraction)) / p.fraction
          : Math.max(5, whole - p.stageSec)
    } else if (i === current && p.stage === 'loading') {
      sec += Math.max(2, LOAD_SEC - p.stageSec) + whole
    } else {
      sec += LOAD_SEC + whole
    }
  }
  return Math.round(sec)
}

function label(id: SidecarId, modelId: string): string {
  const model = findModel(id, modelId)
  return model?.short ?? model?.label ?? modelId
}

interface Live {
  meetingId: number
  plan: Plan
  stage: Stage
  /** The step, in a few words: "Writing the English". */
  title: string
  detail: string
  role: Role | null
  slots: number
  done: number
  total: number
  startedAt: number
  stageStarted: number
  /** The percentage last shown, so it never goes backwards when an estimate grows. */
  shown: number
}

export class AfterCall extends EventEmitter {
  private live: Live | null = null
  private abortController: AbortController | null = null
  private stopReason: string | null = null
  /** The app is quitting: stop, and bring nothing back up behind it. */
  private closing = false
  private gpuNow: GpuReading | null = null
  /** Why dictation could not be brought back, until it is. */
  private restoreProblem: string | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private lastEmit = 0
  private readonly timing: Timing

  constructor(private readonly deps: AfterCallDeps) {
    super()
    this.timing = { ...TIMING, ...deps.timing }
  }

  /** Keep the card's memory reading fresh while nothing is running. */
  startSampling(everyMs = 15_000): void {
    const tick = async (): Promise<void> => {
      if (this.live) return
      this.gpuNow = await this.deps.gpu()
      this.emitView(true)
    }
    void tick()
    this.idleTimer = setInterval(() => void tick(), everyMs)
  }

  stopSampling(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
  }

  /** Meeting work holds the card, so a dictation must not start. */
  pausesDictation(): boolean {
    return this.live !== null
  }

  /** For the HUD, as "title · reason". */
  pausedMessage(): string {
    const live = this.live
    if (!live) return ''
    const what =
      live.stage === 'working'
        ? live.role === 'english'
          ? 'writing the meeting English'
          : 'writing the meeting notes'
        : live.stage === 'restoring'
          ? 'bringing dictation back'
          : 'making room for a larger model'
    return `Dictation paused · ${what}, back in about ${inMinutes(secondsLeft(this.position(live)))}`
  }

  /** Stop the work now and restore. Steps already finished keep what they wrote. */
  abort(reason: string): void {
    if (!this.abortController || this.abortController.signal.aborted) return
    this.stopReason = reason
    this.abortController.abort(new Error(reason))
  }

  /**
   * Why the last run was stopped, or null. Asked after a run fails, because an
   * abort surfaces from the model client as whatever error it chose to throw.
   */
  stoppedBecause(): string | null {
    return this.stopReason
  }

  /**
   * The app is quitting. Stops any work, and restoring is skipped: the
   * supervisor is about to stop every sidecar, and one started now would race it.
   */
  shutdown(): void {
    this.closing = true
    this.abort('Wouice is closing')
    this.stopSampling()
  }

  /** A sidecar changed state: the card may need to say so. */
  sidecarsChanged(): void {
    if (!this.live && this.restoreProblem) {
      const s = this.deps.sidecars
      if (s.snapshot('whisper').status === 'ready' && s.snapshot('llama').status === 'ready') {
        this.restoreProblem = null
      }
    }
    this.emitView(true)
  }

  /** "Restart models": the dictation models, from scratch. */
  async restartDictation(): Promise<void> {
    if (this.live) return
    this.restoreProblem = null
    const want = this.deps.dictationModels()
    for (const id of ['whisper', 'llama'] as const) {
      await this.deps.sidecars.stop(id)
      await this.bring(id, want[id])
    }
    this.emitView(true)
  }

  /** A `run` now would swap models: the setting is on and nothing rules it out. */
  willSwap(): boolean {
    return !this.live && !this.closing && this.deps.enabled()
  }

  /**
   * Dictation's models running, on what settings name, whatever left them off.
   *
   * The careful pass hands the card straight to the write-up with both models
   * stopped. If the write-up then does not swap after all - the setting went
   * off, a recording started - this is what brings dictation back.
   */
  async ensureDictation(): Promise<void> {
    if (this.live || this.closing) return
    const want = this.deps.dictationModels()
    for (const id of ['whisper', 'llama'] as const) {
      const s = this.deps.sidecars.snapshot(id)
      if (s.status === 'stopped' || s.modelId !== want[id]) await this.bring(id, want[id])
    }
  }

  /**
   * Run `work` with the larger models on the card, then put dictation back.
   *
   * Resolves or rejects with whatever `work` does. One at a time: the caller
   * runs this inside the meeting job queue.
   */
  async run<T>(meetingId: number, plan: Plan, work: (session: Session) => Promise<T>): Promise<T> {
    if (this.live) throw new Error('the after-call models are already in use')
    this.stopReason = null
    if (this.closing || !this.deps.enabled()) return work(this.passthrough())

    const record: AfterCallRecord = {
      at: Date.now(),
      models: {},
      fallbacks: [],
      ms: { pause: 0, unload: 0, work: 0, restore: 0, loads: [] },
      vram: { total: null, before: null, idle: null, peak: null, after: null },
      hottestC: null,
      restored: false,
      stopped: null,
    }
    const abort = new AbortController()
    this.abortController = abort
    const now = Date.now()
    this.live = {
      meetingId,
      plan,
      stage: 'pausing',
      title: 'Waiting for your dictation to finish',
      detail: 'Nothing is unloaded until it is done',
      role: null,
      // The English model's slots, until it is loaded and says for itself.
      slots: findModel('llama', this.deps.candidates.english[0] ?? '')?.serve?.parallel ?? 1,
      done: 0,
      total: 0,
      startedAt: now,
      stageStarted: now,
      shown: 0,
    }
    this.emitView(true)
    const sampler = setInterval(() => {
      void this.read(record).then(() => this.emitView())
    }, this.timing.sampleMs)

    let touched = false
    try {
      // A dictation in flight holds both models, and a switch asked for now
      // would only be queued behind it. Dictation is refused from the moment
      // `live` was set, so this waits for at most the one already running.
      const idle =
        (await this.deps.sidecars.whenIdle('whisper', this.timing.pauseMs)) &&
        (await this.deps.sidecars.whenIdle('llama', this.timing.pauseMs))
      abort.signal.throwIfAborted()
      record.ms.pause = Date.now() - now
      if (!idle) {
        // A dictation that never finished. Better the dictation model writes
        // this meeting up than nothing does, and nothing has been touched yet.
        record.fallbacks.push('a dictation was still running after seven minutes, so the dictation model wrote this')
        this.live = null
        this.emitView(true)
        return await work(this.passthrough())
      }

      // What is actually on the card. The careful pass hands it over with both
      // models already stopped, and then there is nothing to wait for.
      const holding = (['whisper', 'llama'] as const).flatMap((id) => {
        const s = this.deps.sidecars.snapshot(id)
        return s.status === 'stopped' ? [] : [{ id, model: s.modelId }]
      })
      this.stage(
        'unloading',
        'Making room on the GPU',
        holding.length > 0 ? `Stopping ${holding.map((h) => label(h.id, h.model)).join(' and ')}` : 'The GPU is already clear'
      )
      const before = await this.read(record)
      record.vram.before = before?.usedMiB ?? null
      touched = true
      const unloading = Date.now()
      await this.deps.sidecars.stop('llama')
      await this.deps.sidecars.stop('whisper')
      const held = holding.reduce((n, h) => n + (findModel(h.id, h.model)?.vramMiB ?? 0), 0)
      const idleGpu = await this.waitForRelease(before, held, record)
      record.ms.unload = Date.now() - unloading
      record.vram.idle = idleGpu?.usedMiB ?? null
      abort.signal.throwIfAborted()

      const working = Date.now()
      try {
        return await work(this.session(record, abort.signal))
      } finally {
        record.ms.work = Date.now() - working
      }
    } catch (err) {
      if (abort.signal.aborted) {
        record.stopped = abort.signal.reason instanceof Error ? abort.signal.reason.message : 'stopped'
      }
      throw err
    } finally {
      clearInterval(sampler)
      // The engines turn an abort into a failed step rather than an error, so
      // the work can return normally having been stopped.
      if (abort.signal.aborted && !record.stopped) record.stopped = this.stopReason ?? 'stopped'
      if (touched) await this.restore(record)
      this.live = null
      this.abortController = null
      if (touched) this.deps.onRecord?.(meetingId, record)
      this.emitView(true)
    }
  }

  view(): EngineView {
    const s = this.deps.sidecars
    const whisper = s.snapshot('whisper')
    const llama = s.snapshot('llama')
    const base = {
      speech: whisper.status === 'ready' ? label('whisper', whisper.modelId) : null,
      language: llama.status === 'ready' ? label('llama', llama.modelId) : null,
      vram: this.gpuNow ? { usedMiB: this.gpuNow.usedMiB, totalMiB: this.gpuNow.totalMiB } : null,
      tempC: this.gpuNow?.tempC ?? null,
    }

    // One state for the whole write-up, whatever the step: the question the
    // card answers first is "can I dictate", and the answer is no from the
    // pause to the restore. The step changes underneath it.
    const live = this.live
    if (live) {
      const hot = (this.gpuNow?.tempC ?? 0) >= HOT_C ? ' · GPU hot, running slower' : ''
      return {
        ...base,
        mode: 'working',
        title: 'Dictation paused',
        step: live.title,
        detail: live.detail + hot,
        dictationPaused: true,
        meetingId: live.meetingId,
        percent: this.percent(live),
        backInSec: secondsLeft(this.position(live)),
      }
    }

    const quiet = { ...base, step: null, dictationPaused: false, meetingId: null, percent: null, backInSec: null }
    const failed = [whisper, llama].find((x) => x.status === 'failed')
    if (failed) {
      return { ...quiet, mode: 'problem', title: 'Dictation unavailable', detail: failed.lastError ?? 'A model could not start' }
    }
    if (this.restoreProblem) {
      return { ...quiet, mode: 'problem', title: 'Dictation unavailable', detail: this.restoreProblem }
    }
    const models = `${label('whisper', whisper.modelId)} · ${label('llama', llama.modelId)}`
    if (whisper.status === 'ready' && llama.status === 'ready') {
      return { ...quiet, mode: 'ready', title: 'Dictation ready', detail: models }
    }
    return { ...quiet, mode: 'busy', title: 'Starting dictation', detail: models }
  }

  /** The work, handed the models one step at a time. */
  private session(record: AfterCallRecord, signal: AbortSignal): Session {
    let loaded: Loaded | null = null
    return {
      signal,
      use: async (role) => {
        signal.throwIfAborted()
        const want = this.deps.dictationModels()
        const chain = [...new Set([...this.deps.candidates[role], want.llama])]
        for (const id of chain) {
          if (loaded?.id === id) {
            record.models[role] = id
            this.working(role, loaded)
            return loaded
          }
          const model = findModel('llama', id)
          if (!model) {
            record.fallbacks.push(`${id}: not a known model`)
            continue
          }
          // The previous step's model first: two large models never share the card.
          await this.deps.sidecars.stop('llama')
          loaded = null
          const before = await this.read(record)
          if (!roomFor(model.vramMiB, before)) {
            const free = before ? before.totalMiB - before.usedMiB : 0
            record.fallbacks.push(`${model.label}: needs ${model.vramMiB + LOAD_MARGIN_MIB} MiB free, ${free} were`)
            continue
          }

          if (this.live && role === 'english') this.live.slots = model.serve?.parallel ?? 1
          this.stage('loading', `Loading ${model.short ?? model.label}`, role === 'english' ? 'For the English' : 'For the summary and tasks', role)
          const loading = Date.now()
          await this.bring('llama', id)
          const up = await this.deps.sidecars.whenModel('llama', id, this.timing.loadMs)
          signal.throwIfAborted()
          if (!up) {
            record.fallbacks.push(`${model.label}: did not start (${this.deps.sidecars.snapshot('llama').lastError ?? 'no answer'})`)
            continue
          }
          const after = await this.read(record)
          record.ms.loads.push({
            model: id,
            ms: Date.now() - loading,
            addedMiB: before && after ? after.usedMiB - before.usedMiB : null,
          })
          const where = landing(model.vramMiB, before, after)
          if (where !== 'ok') {
            record.fallbacks.push(
              `${model.label}: ${where === 'spilled' ? 'part of it loaded off the GPU' : 'left too little GPU memory'}`
            )
            continue
          }

          loaded = { id, label: model.short ?? model.label, slots: model.serve?.parallel ?? 1 }
          record.models[role] = id
          this.working(role, loaded)
          return loaded
        }
        await this.deps.sidecars.stop('llama')
        throw new Error(`no model could be loaded for the ${role === 'english' ? 'English' : 'notes'}`)
      },
      progress: (done, total, detail) => {
        const live = this.live
        if (!live || live.stage !== 'working') return
        live.done = done
        live.total = total
        live.detail = detail
        this.emitView()
      },
    }
  }

  /** The setting is off, or dictation never went quiet: the model on the card writes it. */
  private passthrough(): Session {
    return {
      signal: new AbortController().signal,
      use: async () => {
        const id = this.deps.sidecars.snapshot('llama').modelId
        return { id, label: label('llama', id), slots: 1 }
      },
      progress: () => {},
    }
  }

  private async restore(record: AfterCallRecord): Promise<void> {
    if (this.closing) return
    const want = this.deps.dictationModels()
    this.stage('restoring', 'Bringing dictation back', `Loading ${label('whisper', want.whisper)} and ${label('llama', want.llama)}`)
    const restoring = Date.now()
    try {
      // The larger model goes first: the two dictation models need its room.
      await this.deps.sidecars.stop('llama')
      await Promise.all([this.bring('whisper', want.whisper), this.bring('llama', want.llama)])
      const [speech, language] = await Promise.all([
        this.deps.sidecars.whenModel('whisper', want.whisper, this.timing.restoreMs),
        this.deps.sidecars.whenModel('llama', want.llama, this.timing.restoreMs),
      ])
      record.restored = speech && language
      if (!record.restored) {
        const missing = speech ? 'llama' : 'whisper'
        const why = this.deps.sidecars.snapshot(missing).lastError
        this.restoreProblem = `${label(missing, want[missing])} did not come back${why ? `: ${why}` : ''}`
      }
    } catch (err) {
      record.restored = false
      this.restoreProblem = `The dictation models could not be started: ${err instanceof Error ? err.message : String(err)}`
    }
    record.ms.restore = Date.now() - restoring
    record.vram.after = (await this.read(record))?.usedMiB ?? null
  }

  /** Start a stopped sidecar on this model, whichever model it last had. */
  private async bring(id: SidecarId, modelId: string): Promise<void> {
    // A switch to the model it already names does nothing, so a stopped
    // sidecar on the right model is started instead.
    if (this.deps.sidecars.snapshot(id).modelId === modelId) await this.deps.sidecars.start(id)
    else await this.deps.sidecars.switchModel(id, modelId)
  }

  /** Until the card has given back what the dictation models held, or the wait runs out. */
  private async waitForRelease(before: GpuReading | null, heldMiB: number, record: AfterCallRecord): Promise<GpuReading | null> {
    if (!before) return null
    const target = before.usedMiB - heldMiB * RELEASE_SHARE
    const deadline = Date.now() + this.timing.releaseMs
    let last: GpuReading = before
    while (Date.now() < deadline) {
      const now = await this.read(record)
      if (!now) return null
      last = now
      if (now.usedMiB <= target) return now
      await new Promise((resolve) => setTimeout(resolve, this.timing.pollMs))
    }
    record.fallbacks.push(`GPU memory came back only to ${last.usedMiB} MiB after stopping the dictation models`)
    return last
  }

  /** Measure the card, and keep the peak and the hottest for the record. */
  private async read(record: AfterCallRecord): Promise<GpuReading | null> {
    const now = await this.deps.gpu()
    if (!now) return null
    this.gpuNow = now
    record.vram.total = now.totalMiB
    record.vram.peak = Math.max(record.vram.peak ?? 0, now.usedMiB)
    if (now.tempC !== null) record.hottestC = Math.max(record.hottestC ?? 0, now.tempC)
    return now
  }

  private position(live: Live): Position {
    return {
      stage: live.stage,
      role: live.role,
      plan: live.plan,
      slots: live.slots,
      fraction: live.total > 0 ? Math.min(1, live.done / live.total) : 0,
      stageSec: (Date.now() - live.stageStarted) / 1000,
    }
  }

  /**
   * How far through the whole write-up: the time spent over the time spent
   * plus the time left. Held at its highest, so a step that turns out slower
   * than expected slows the bar down instead of pulling it back.
   */
  private percent(live: Live): number {
    const elapsed = (Date.now() - live.startedAt) / 1000
    const left = secondsLeft(this.position(live))
    const now = Math.min(99, Math.floor((100 * elapsed) / Math.max(1, elapsed + left)))
    live.shown = Math.max(live.shown, now)
    return live.shown
  }

  private stage(stage: Stage, title: string, detail: string, role: Role | null = null): void {
    const live = this.live
    if (!live) return
    Object.assign(live, { stage, title, detail, role, done: 0, total: 0, stageStarted: Date.now() })
    this.emitView(true)
  }

  private working(role: Role, model: Loaded): void {
    const live = this.live
    if (!live) return
    Object.assign(live, {
      stage: 'working' as const,
      title: role === 'english' ? 'Writing the English' : 'Writing the summary and tasks',
      detail: model.label,
      role,
      slots: role === 'english' ? model.slots : live.slots,
      done: 0,
      total: 0,
      stageStarted: Date.now(),
    })
    this.emitView(true)
  }

  private emitView(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 400) return
    this.lastEmit = now
    const view = this.view()
    this.deps.onView?.(view)
    this.emit('view', view)
  }
}
