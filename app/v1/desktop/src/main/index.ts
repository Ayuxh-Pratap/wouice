import { app, clipboard, dialog, globalShortcut, ipcMain, Notification, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarSupervisor, type SidecarSnapshot } from './sidecars/supervisor.js'
import { sweepOrphans } from './sidecars/orphans.js'
import { SIDECARS } from '../shared/models.js'
import { SettingsStore } from './settings-store.js'
import { HotkeyManager } from './hotkeys.js'
import { createTray, destroyTray, refreshTray } from './tray.js'
import {
  applyPetSettings,
  applyZoom,
  broadcast,
  createHud,
  createMainWindow,
  endPetDrag,
  getMainWindow,
  restHud,
  sendToHud,
  showHud,
  startPetDrag,
} from './windows.js'
import { IPC, type EnglishOutcome, type NotesOutcome, type RepassOutcome, type CalibrationInput, type CalibrationReport, type DictionaryPatch, type NewDictionaryEntry, type Diagnostics, type RatingSheet, type SidecarView } from '../shared/ipc.js'
import type { SidecarId } from '../shared/models.js'
import { DictationController, FRAME_MS, SAMPLE_RATE, type DictationResult } from './dictation/controller.js'
import { sampleResources } from './metrics/sample.js'
import { importJsonl, openStore, validateEntry, type DictationRecord, type TaskState } from '@wouice/store'
import { RecordingStore } from './metrics/recordings.js'
import { Injector, type InjectionResult } from './injection/injector.js'
import { injectionAvailable, injectionUnavailableReason } from './injection/win32.js'
import { analyseCalibration, applyCalibration, describeLanguages, frameLevels } from './capture/calibrate.js'
import { enableSystemAudioCapture } from './meeting/display-media.js'
import { MeetingController } from './meeting/controller.js'
import { finishedSessions } from './meeting/merge.js'
import { MeetingNotesEngine, NotesUnavailable } from './meeting/notes-engine.js'
import { MicWatcher } from './meeting/mic-watcher.js'
import { repassMeeting, RepassUnavailable } from './meeting/repass.js'
import { MeetingEnglishEngine, EnglishUnavailable } from './meeting/english-engine.js'
import { kindOf } from '../shared/meeting-kind.js'
import { formatMeeting } from './metrics/diagnostic.js'
import type { Channel as MeetingChannel } from './meeting/session.js'
import { WhisperCppClient } from '@wouice/asr'
import { OpenAiCompatClient } from '@wouice/llm'
import { describeCalibration, formatDiagnostic, formatSession } from './metrics/diagnostic.js'
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs'

// MUST come before any app.getPath('userData') call, and those happen at module
// scope below. Unpackaged, Electron otherwise names itself "Electron" and puts
// our settings and metrics in a shared directory alongside every other Electron
// app run from source, which is both wrong and confusing to find.
app.setName('Wouice')

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Sidecar binaries and model weights live at the REPO root, outside app/v1/,
 * because they are large, gitignored, and shared across app versions. In a
 * packaged build these would move next to the executable; for now the layout is
 * out/main -> desktop -> app/v1 -> app -> <repo>.
 */
const REPO_ROOT = path.resolve(here, '../../../../..')
const SIDECAR_ROOT = path.join(REPO_ROOT, 'sidecars')
const MODEL_ROOT = path.join(REPO_ROOT, 'models')

const settings = new SettingsStore()
const supervisor = new SidecarSupervisor(SIDECAR_ROOT, MODEL_ROOT)
const hotkeys = new HotkeyManager()
/**
 * One SQLite file for dictations, telemetry and calibration history.
 *
 * Replaces an append-only JSONL log that kept its last 2000 events in memory
 * and showed the last twenty. Everything older was on disk and unreachable:
 * there was no way to page back through history, no way to search it, and the
 * headline figures silently described only the tail. `metrics.jsonl` is
 * absorbed on first launch and renamed rather than deleted.
 */
const store = openStore({
  dir: app.getPath('userData'),
  onMigrate: (id, name) => console.log(`[store] migration ${id}: ${name}`),
})
const recordings = new RecordingStore(app.getPath('userData'))

/** Meetings live beside the database, one directory per session. */
const MEETING_ROOT = path.join(app.getPath('userData'), 'meetings')
const meetings = new MeetingController(MEETING_ROOT, {
  // Built per request, like dictation does, because the sidecar can restart on
  // a different model and a client captured once would keep talking to the old
  // one.
  asr: {
    transcribe: (pcm, options) => whisperClient().transcribe(pcm, options),
    health: () => whisperClient().health(),
  },
  store: store.meetings,
  kind: () => kindOf(settings.get().meetings.defaultKind),
})

/**
 * Notes and tasks, after the meeting.
 *
 * One at a time: the model has a single slot on a 6 GB card, and two runs at
 * once would queue anyway while making the progress reporting meaningless.
 */
const notesEngine = new MeetingNotesEngine(
  () =>
    new OpenAiCompatClient({
      baseUrl: supervisor.baseUrl('llama'),
      model: supervisor.snapshot('llama').modelId,
    })
)
let notesRunning = 0

/**
 * The English rendering, which runs after the meeting rather than during it.
 *
 * Stored ALONGSIDE what was said, never instead of it: the raw transcript is
 * what settles a disagreement about a meeting, and this is what makes it
 * readable. Both live in the row.
 */
const englishEngine = new MeetingEnglishEngine(
  () =>
    new OpenAiCompatClient({
      baseUrl: supervisor.baseUrl('llama'),
      model: supervisor.snapshot('llama').modelId,
    })
)
let englishRunning = 0

/**
 * Write the summary and the tasks for one meeting.
 *
 * At module scope rather than inside the IPC handler because the automatic
 * pipeline calls it too: stopping a meeting should leave you with a transcript,
 * an English rendering and a summary without pressing anything, and two copies
 * of this logic would be two things to keep in step.
 */
async function writeNotes(id: number): Promise<NotesOutcome> {
  const empty = { notesMd: null, tasks: 0, gaps: 0 }
  if (notesRunning === id) {
    return { ok: false, message: 'already writing the notes for this meeting', ...empty }
  }
  const meeting = store.meetings.byId(id)
  if (!meeting) return { ok: false, message: 'that meeting is gone', ...empty }

  notesRunning = id
  try {
    const run = await notesEngine.generate({
      // The English rendering when there is one: notes written from
      // "स्थमाल" and "रंबाली" never had a chance, and a 4B model summarising
      // raw code-mixed recognition output is the weakest link in the chain.
      lines: store.meetings.segments(id).map((s) => ({
        id: s.id,
        channel: s.channel,
        startMs: s.startMs,
        text: s.textEn ?? s.text,
        echo: s.echo,
      })),
      scratch: meeting.scratchMd,
      startedAt: meeting.startedAt,
      onProgress: (p) => broadcast(IPC.notesProgress, { meetingId: id, ...p }),
    })

    store.meetings.setNotes(id, run.notesMd)
    store.meetings.replaceTasks(id, run.tasks)
    store.meetings.recordNotesRun(id, {
      at: Date.now(),
      ok: true,
      chunks: run.chunks,
      gaps: run.failedChunks,
      tasks: run.tasks.length,
      ms: run.ms,
    })
    console.log(
      `[meeting] notes for ${id}: ${run.chunks} chunk(s), ${run.tasks.length} task(s)` +
        `, ${Math.round(run.ms / 1000)}s` +
        (run.failedChunks ? `, ${run.failedChunks} gap(s)` : '')
    )
    return {
      ok: true,
      message: '',
      notesMd: run.notesMd,
      tasks: run.tasks.length,
      gaps: run.failedChunks,
    }
  } catch (err) {
    // The transcript is untouched either way, so this is always worth
    // retrying rather than being a state to recover from.
    const message =
      err instanceof NotesUnavailable
        ? err.message
        : `the model could not be reached: ${err instanceof Error ? err.message : String(err)}`
    // Recorded as well as returned: a failure you can still read tomorrow is
    // the difference between diagnosing this and guessing at it.
    try {
      store.meetings.recordNotesRun(id, {
        at: Date.now(),
        ok: false,
        chunks: 0,
        gaps: 0,
        tasks: 0,
        ms: 0,
        message,
      })
    } catch {
      // Bookkeeping. Never worth turning into a second failure.
    }
    return { ok: false, message, ...empty }
  } finally {
    notesRunning = 0
  }
}

async function renderEnglish(id: number): Promise<EnglishOutcome> {
  const empty = { rendered: 0, missed: 0 }
  if (englishRunning === id) {
    return { ok: false, message: 'already rendering this meeting', ...empty }
  }
  const meeting = store.meetings.byId(id)
  if (!meeting) return { ok: false, message: 'that meeting is gone', ...empty }
  if (!kindOf(meeting.kind).translate) {
    return { ok: false, message: 'this meeting is already in English', ...empty }
  }

  englishRunning = id
  try {
    const run = await englishEngine.render({
      // Echo lines are the far side heard twice; rendering them spends the
      // model on duplicates of lines that are already being rendered.
      lines: store.meetings
        .segments(id)
        .filter((seg) => !seg.echo)
        .map((seg) => ({ id: seg.id, text: seg.text })),
      onProgress: (p) => broadcast(IPC.englishProgress, { meetingId: id, ...p }),
    })
    store.meetings.setEnglish(run.rendered.map((r) => ({ id: r.id, textEn: r.textEn })))
    store.meetings.setDiagnostics(id, {
      english: {
        at: Date.now(),
        rendered: run.rendered.length,
        missed: run.missed,
        failedBatches: run.failedBatches,
        ms: run.ms,
      },
    })
    console.log(
      `[meeting] english for ${id}: ${run.rendered.length} line(s), ${run.missed} missed, ${Math.round(run.ms / 1000)}s`
    )
    return { ok: true, message: '', rendered: run.rendered.length, missed: run.missed }
  } catch (err) {
    const message =
      err instanceof EnglishUnavailable
        ? err.message
        : `the model could not be reached: ${err instanceof Error ? err.message : String(err)}`
    return { ok: false, message, ...empty }
  } finally {
    englishRunning = 0
  }
}

/**
 * Automatic detection: notice a meeting application taking the microphone and
 * offer to record.
 *
 * OFFERS, NEVER STARTS. Being wrong in this direction costs a dismissed
 * prompt; being wrong the other way records a conversation nobody agreed to.
 */
const micWatcher = new MicWatcher({
  isRecording: () => meetings.state().phase !== 'idle',
})

/** The app we have offered to record, or null. Pushed to the window. */
let pendingOffer: string | null = null

micWatcher.on('offer', (app_: string) => {
  pendingOffer = app_
  broadcast(IPC.meetingOffer, pendingOffer)

  // A toast as well as the in-app banner, because the window is usually not the
  // thing you are looking at when a call starts.
  try {
    if (Notification.isSupported()) {
      const toast = new Notification({
        title: 'Record this meeting?',
        body: `${app_} is using your microphone.`,
        silent: true,
      })
      toast.on('click', () => {
        pendingOffer = null
        broadcast(IPC.meetingOffer, null)
        meetings.start()
        const main = getMainWindow()
        if (main) {
          if (main.isMinimized()) main.restore()
          main.show()
          main.focus()
        }
      })
      toast.on('close', () => micWatcher.dismissOffer())
      toast.show()
    }
  } catch {
    // Notifications are disabled or unavailable. The banner still shows.
  }
})

function applyAutoDetect(on: boolean): void {
  if (on && !micWatcher.running) micWatcher.start()
  else if (!on && micWatcher.running) {
    micWatcher.stop()
    pendingOffer = null
    broadcast(IPC.meetingOffer, null)
  }
}

function whisperClient(): WhisperCppClient {
  return new WhisperCppClient({
    baseUrl: supervisor.baseUrl('whisper'),
    model: supervisor.snapshot('whisper').modelId,
  })
}

/**
 * Text injection. Falls back to clipboard-only if the native layer is missing,
 * which is what every build before this one did anyway.
 */
const injector = new Injector({
  enabled: () => settings.get().injection.enabled,
  pasteOverrides: () => settings.get().injection.pasteOverrides,
})

const dictation = new DictationController({
  supervisor,
  silence: () => settings.get().silence,
  userDictionary: () =>
    store.dictionary.active().map((e) =>
      e.kind === 'term'
        ? { kind: 'term' as const, hear: e.hear, enabled: true }
        : { kind: 'correction' as const, hear: e.hear, write: e.write, enabled: true }
    ),
  onRulesFired: (applied) => {
    try {
      store.dictionary.recordHits(applied.map((a) => ({ hear: a.from, count: a.count })))
    } catch {
      // Bookkeeping. Never worth interrupting a dictation for.
    }
  },
  cleanupEnabled: () => settings.get().cleanup.enabled,
  retainAudio: () => settings.get().retainAudio,
  saveAudio: async (pcm) => recordings.save(pcm),
})

/** Phase names the HUD understands; the machine has one more than it shows. */
const HUD_PHASE: Record<string, string> = {
  idle: 'idle',
  arming: 'arming',
  listening: 'listening',
  transcribing: 'thinking',
  delivering: 'thinking',
  error: 'error',
}

/**
 * Escape, bound globally but ONLY while a dictation is in flight.
 *
 * A6 says Escape always returns to idle. The state machine has always handled
 * it from every phase - and nothing could ever deliver the event. The only
 * listener was a `keydown` in the HUD, and the HUD is created
 * `focusable: false` precisely so it cannot take keyboard focus, so that
 * handler could not fire even in principle. The criterion was unmeetable by a
 * person, which running the real app is the only way to notice.
 *
 * Bound and unbound around the dictation rather than held for the session: a
 * permanent global Escape would swallow the key for every other application on
 * the machine, which is a far worse bug than the one being fixed.
 */
let escapeBound = false

function setEscapeCancel(on: boolean): void {
  if (on === escapeBound) return
  try {
    if (on) {
      escapeBound = globalShortcut.register('Escape', () => dictation.send({ type: 'escape' }))
    } else {
      globalShortcut.unregister('Escape')
      escapeBound = false
    }
  } catch {
    // Another app owns Escape, or the platform refused. Cancelling by pressing
    // the hotkey again still works; this is the convenience, not the mechanism.
    escapeBound = false
  }
}

/**
 * The meeting's state, pushed rather than polled.
 *
 * A ticker runs only while something is recording. The level meter and the
 * elapsed clock both need to move without anything happening - no frame
 * arriving is exactly the condition the UI most needs to show - and a renderer
 * polling four times a second for the twenty-three hours a day when nothing is
 * recording is the wrong shape.
 */
let meetingTicker: NodeJS.Timeout | null = null
meetings.on('state', (state: { phase: string }) => {
  broadcast(IPC.meetingState, meetings.state())
  const busy = state.phase !== 'idle'
  if (busy && !meetingTicker) {
    meetingTicker = setInterval(() => broadcast(IPC.meetingState, meetings.state()), 250)
  } else if (!busy && meetingTicker) {
    clearInterval(meetingTicker)
    meetingTicker = null
  }
})

meetings.on('segments', (segments: unknown) => broadcast(IPC.meetingSegments, segments))

/**
 * Write down what happened, at the one moment all of it is still known.
 *
 * A meeting is an hour long and happens once. "Which step failed" is the only
 * question worth asking when a transcript is wrong, and it cannot be answered
 * from a console line that scrolled past during the call.
 */
meetings.on('finished', (summary: { meetingId: number } & Record<string, unknown>) => {
  try {
    store.meetings.setDiagnostics(summary.meetingId, {
      asrModel: supervisor.snapshot('whisper').modelId,
      llmModel: supervisor.snapshot('llama').modelId,
      chunksSent: summary.chunksSent as number,
      chunksFailed: summary.chunksFailed as number,
      chunksSkipped: summary.chunksSkipped as number,
      language: summary.language as string,
      segments: summary.segments as number,
      channels: summary.channels as never,
      skewMs: summary.skewMs as number | null,
      driftPpm: summary.driftPpm as never,
      recoveredWithoutManifest: summary.recoveredWithoutManifest as boolean,
    })
  } catch (err) {
    console.warn('[meeting] could not record diagnostics:', err)
  }
  // A finished meeting resets the offer: whatever the call was, it is over.
  pendingOffer = null
  broadcast(IPC.meetingOffer, null)

  // Render it without being asked. The alternative is a transcript that sits
  // in Hindi until somebody remembers there is a button, and a person reading
  // their own meeting should not have to know the pipeline has two halves.
  void finishMeeting(summary.meetingId)
})

/**
 * What happens after a meeting ends, without anybody pressing anything.
 *
 * as spoken -> English -> summary and tasks. In that order, because the
 * summary is written FROM the English: notes built on raw code-mixed
 * recognition output never had a chance, and that was the weakest link in the
 * chain before this ran automatically.
 *
 * Each step is allowed to fail without taking the next one with it. A meeting
 * whose English pass failed still gets a summary from what was actually said,
 * which is worse than the alternative and much better than nothing.
 */
let repassRunning = 0

/**
 * The careful pass, end to end: re-transcribe, then redo everything built on it.
 *
 * Sequential and exclusive. It stops the language model to make room for the
 * larger speech model, so nothing else that needs either can run while it does
 * - including dictation. That is the cost the warning in the interface is
 * about, and it is the reason this is a button rather than something automatic.
 */
async function runRepass(meetingId: number): Promise<RepassOutcome> {
  const empty = { segments: 0, seconds: 0 }
  if (repassRunning) {
    return { ok: false, message: 'a careful pass is already running', ...empty }
  }
  if (meetings.state().phase !== 'idle') {
    return { ok: false, message: 'not while a meeting is recording', ...empty }
  }

  repassRunning = meetingId
  const started = Date.now()
  try {
    const result = await repassMeeting(meetingId, {
      supervisor,
      meetings: store.meetings,
      modelId: 'large-v3',
      onProgress: (p) => broadcast(IPC.repassProgress, p),
    })

    // Everything downstream was built from the old transcript, so it all has to
    // be built again. Leaving yesterday's summary above today's transcript
    // would be the kind of quiet wrongness nobody checks for.
    const meeting = store.meetings.byId(meetingId)
    if (meeting && kindOf(meeting.kind).translate) {
      broadcast(IPC.repassProgress, {
        meetingId,
        stage: 'rendering',
        doneSec: 0,
        totalSec: 0,
      })
      await renderEnglish(meetingId)
    }
    broadcast(IPC.repassProgress, { meetingId, stage: 'summarising', doneSec: 0, totalSec: 0 })
    await writeNotes(meetingId)

    store.meetings.setDiagnostics(meetingId, {
      repass: { at: Date.now(), model: 'large-v3', segments: result.segments, ms: Date.now() - started },
    })
    notify(
      'Transcript improved',
      `${result.segments} lines, ${Math.round((Date.now() - started) / 1000)}s.`
    )
    return { ok: true, message: '', segments: result.segments, seconds: result.seconds }
  } catch (err) {
    const message =
      err instanceof RepassUnavailable
        ? err.message
        : `the careful pass failed: ${err instanceof Error ? err.message : String(err)}`
    notify('Could not improve the transcript', message)
    return { ok: false, message, ...empty }
  } finally {
    repassRunning = 0
    broadcast(IPC.meetingReady2, meetingId)
  }
}

/** A toast, when something that took minutes has finished. */
function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
  } catch {
    // Notifications off. The interface still updates.
  }
}

async function finishMeeting(meetingId: number): Promise<void> {
  const meeting = store.meetings.byId(meetingId)
  if (!meeting) return
  if (store.meetings.segments(meetingId).length === 0) return

  if (kindOf(meeting.kind).translate) {
    const rendered = await renderEnglish(meetingId)
    if (!rendered.ok) console.warn(`[meeting] english pass: ${rendered.message}`)
  }
  const notes = await writeNotes(meetingId)
  if (!notes.ok) console.warn(`[meeting] notes: ${notes.message}`)
  broadcast(IPC.meetingReady2, meetingId)
}

/**
 * Give every recording on disk a row, and every row its audio.
 *
 * The filesystem is the source of truth for audio - a directory with an
 * `audio.wav` is a meeting that happened, whether or not anything wrote it
 * down. Recordings made before the table existed, or recovered from a crash
 * that took the database write with it, would otherwise be invisible in an app
 * that is holding them.
 */
function reconcileMeetings(): void {
  try {
    for (const session of finishedSessions(MEETING_ROOT)) {
      if (store.meetings.byDir(session.dir)) continue
      const id = store.meetings.start(session.dir, session.startedAt)
      store.meetings.finish(id, {
        endedAt: session.startedAt + session.durationMs,
        audioPath: session.path,
        durationMs: session.durationMs,
      })
      console.log(`[meeting] adopted ${session.dir}`)
    }
  } catch (err) {
    console.warn('[meeting] could not reconcile recordings with the database:', err)
  }
}

dictation.on('phase', ({ phase, message }: { phase: string; message: string | null }) => {
  setEscapeCancel(phase !== 'idle')
  broadcast(IPC.hudState, {
    phase: HUD_PHASE[phase] ?? 'idle',
    level: dictation.level,
    elapsedMs: dictation.elapsedMs,
    ...(message ? { message } : {}),
  })
  // `restHud`, not `hideHud`: with the pet on, going idle closes the capsule
  // and leaves the character where it was put. Hiding would mean the app
  // disappeared off the desktop after every dictation.
  if (phase === 'idle') restHud()
  else showHud()
})

dictation.on('level', ({ level, elapsedMs }: { level: number; elapsedMs: number }) => {
  sendToHud(IPC.hudState, { phase: 'listening', level, elapsedMs })
})

dictation.on('startCapture', (sessionId: number) =>
  sendToHud(IPC.startCapture, sessionId, settings.get().audio.deviceId)
)
dictation.on('stopCapture', (sessionId: number) => sendToHud(IPC.stopCapture, sessionId))

dictation.on('result', (r) => {
  void (async () => {
    const delivery = await injector.deliver(r.final)

    try {
      store.dictations.insert(toRecord(r, delivery))
    } catch (err) {
      console.warn('[store] could not record dictation:', err)
    }
    broadcast(IPC.metric, undefined)
    broadcast(IPC.dictationResult, {
      final: r.final,
      raw: r.raw,
      language: r.language,
      asrMs: r.asrMs,
      llmMs: r.llmMs,
      degraded: r.degraded,
      delivered: delivery.delivered,
    })
    broadcast(IPC.hudState, {
      phase: delivery.delivered === 'inserted' ? 'inserted' : 'copied',
      level: 0,
      elapsedMs: 0,
      message: hudMessage(delivery, r.final.length),
    })
    setTimeout(() => dictation.send({ type: 'delivered' }), 1_400)
  })()
})

/**
 * What the HUD says about where the text went.
 *
 * "Copied" on its own is the message that wastes someone's time: they look for
 * text that never arrived and have no idea why. When insertion did not happen,
 * the reason goes in the pill.
 */
function hudMessage(delivery: InjectionResult, chars: number): string {
  if (delivery.delivered === 'inserted') {
    return delivery.clipboardReplaced ? `Inserted · clipboard replaced` : `Inserted · ${chars} chars`
  }
  return delivery.reason ? `Copied · ${delivery.reason}` : `Copied · ${chars} chars`
}

/** Controller result -> stored record. The only place the two shapes meet. */
function toRecord(r: DictationResult, delivery: InjectionResult): DictationRecord {
  return {
    at: Date.now(),
    audioMs: r.audioMs,
    asrMs: r.asrMs,
    llmMs: r.llmMs,
    totalMs: r.totalMs,
    chunks: r.chunks,
    asrModel: r.asrModel,
    llmModel: r.llmModel,
    language: r.language,
    rawChars: r.raw.length,
    finalChars: r.final.length,
    corrections: r.applied.length,
    degraded: r.degraded,
    raw: r.raw,
    corrected: r.corrected,
    sentSystem: r.sent.system,
    sentUser: r.sent.user,
    received: r.received,
    applied: r.applied,
    capture: r.capture,
    audioPath: r.audioPath,
    inserted: delivery.delivered === 'inserted',
    delivery: delivery.method,
    targetExe: delivery.targetExe,
    deliveryNote: delivery.reason,
  }
}

/**
 * Keep every calibration run, accepted or not.
 *
 * A rejected run is evidence rather than noise: three weak results in a row on
 * the same microphone says the room or the hardware is the problem, not the
 * algorithm, and that is only visible if the misses are kept alongside the hits.
 */
function recordCalibration(report: Omit<CalibrationReport, 'runId'>): number {
  try {
    return store.calibrations.insert({
      at: Date.now(),
      device: report.device,
      quality: report.quality,
      silenceLevel: report.observed.silenceLevel,
      speechLevel: report.observed.speechLevel,
      separation: report.observed.separation,
      threshold: report.threshold,
      minNoiseFloor: report.minNoiseFloor,
      speechFactor: report.speechFactor,
      applied: false,
      samples: report.transcripts.map((t) => ({
        label: t.label,
        text: t.text,
        language: t.language,
        durationMs: t.durationMs,
      })),
    })
  } catch (err) {
    console.warn('[store] could not record calibration:', err)
    return 0
  }
}

function toView(s: SidecarSnapshot): SidecarView {
  return {
    id: s.id,
    status: s.status,
    modelId: s.modelId,
    pendingModelId: s.pendingModelId,
    port: s.port,
    pid: s.pid,
    lastError: s.lastError,
  }
}

const trayDeps = {
  supervisor,
  settings,
  onOpenWindow: () => createMainWindow(settings.get().appearance.zoom),
  onSwitchModel: (id: SidecarId, modelId: string) => {
    // Persist first so the choice survives a crash during the restart.
    settings.set({ models: { ...settings.get().models, [id]: modelId } })
    void supervisor.switchModel(id, modelId)
  },
  onRestart: (id: SidecarId) => {
    void supervisor.stop(id).then(() => supervisor.start(id))
  },
}

supervisor.on('state', (snap: SidecarSnapshot) => {
  broadcast(IPC.sidecarState, toView(snap))
  refreshTray(trayDeps)
})

/**
 * Start or stop a dictation. THE ONLY WAY IN, for every trigger.
 *
 * WHY THIS IS A FUNCTION. The hotkey used to do two things - capture the window
 * in front, then send the event - and when the pet gained a click it was given
 * only the second. Every dictation started by clicking the pet therefore ran
 * with no captured target and fell back to the clipboard, reporting "no window
 * was captured when you pressed the hotkey" at somebody who had not pressed it.
 *
 * The comment on the click handler said two ways in through different code are
 * two state machines waiting to disagree. They were. This is the fix that makes
 * that true rather than aspirational.
 */
function startDictation(): void {
  // BEFORE anything else. This is key-down, and the window in front right now
  // is the one the user means. Capturing at paste time instead would deliver
  // into whatever they alt-tabbed to while transcription ran.
  injector.captureTarget()
  dictation.send({ type: 'hotkey', now: Date.now() })
}

function registerHotkeys(): void {
  const { hotkeys: keys } = settings.get()
  const results = hotkeys.register([
    {
      name: 'dictate',
      accelerator: keys.dictate,
      handler: startDictation,
    },
  ])

  // Registration fails silently at the OS level, so an app that assumes success
  // just does nothing forever and looks broken. Report exactly what happened.
  for (const r of results) {
    if (r.accelerator === null) {
      console.error(`[hotkey] ${r.name}: NOTHING available. tried ${[r.requested, ...r.rejected].join(', ')}`)
      broadcast(IPC.hotkeyFailed, { name: r.name, requested: r.requested, accelerator: null, rejected: r.rejected })
    } else if (r.substituted) {
      console.warn(`[hotkey] ${r.name}: ${r.requested} taken, using ${r.accelerator}`)
      broadcast(IPC.hotkeyFailed, r)
    } else {
      console.log(`[hotkey] ${r.name}: ${r.accelerator}`)
    }
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => settings.get())
  ipcMain.handle(IPC.setSettings, (_e, patch) => {
    const next = settings.set(patch)
    registerHotkeys()
    // Zoom is the one setting the renderer cannot apply to itself: the factor
    // lives on the WebContents, above the document.
    applyZoom(next.appearance.zoom)
    applyPetSettings(next.pet)
    applyAutoDetect(next.meetings.autoDetect)
    broadcast(IPC.settingsChanged, next)
    return next
  })
  ipcMain.handle(IPC.getSidecars, () => supervisor.snapshotAll().map(toView))
  ipcMain.handle(IPC.switchModel, (_e, id: SidecarId, modelId: string) => {
    trayDeps.onSwitchModel(id, modelId)
  })
  ipcMain.handle(IPC.restartSidecar, (_e, id: SidecarId) => trayDeps.onRestart(id))
  ipcMain.handle(IPC.getDiagnostics, (): Diagnostics => ({
    sidecarRoot: SIDECAR_ROOT,
    modelRoot: MODEL_ROOT,
    userData: app.getPath('userData'),
    hotkeyRegistered: hotkeys.liveStatus(),
    hotkeys: hotkeys.status(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron,
  }))
  // Rest rather than hide: dismissing the overlay means closing the capsule,
  // not removing the pet someone deliberately put on their desktop.
  ipcMain.on(IPC.hideHud, () => restHud())
  ipcMain.handle(IPC.getMetrics, () => ({
    // Oldest first for the charts; SQL returns newest first because that is
    // what every other reader wants.
    dictations: store.dictations.recent(60).reverse(),
    resources: store.resources.recent(120),
    // Over the whole history, computed in SQL. The old version averaged
    // whatever happened to be in memory, so the headline figures quietly
    // described the tail rather than the record.
    summary: store.dictations.summary(),
    byAsrModel: store.dictations.meanAsrByModel(),
  }))

  ipcMain.handle(IPC.getDictationPage, (_e, offset: number, limit: number, query?: string) =>
    store.dictations.page(offset, limit, query)
  )

  /**
   * Deleting history.
   *
   * Two steps that must both happen: the rows, and the WAV files those rows
   * were pointing at. Doing only the first leaves orphaned audio on disk that
   * nothing in the app can reach or delete - the user's own voice, kept
   * silently, after they asked for it to be gone.
   *
   * The database comes first. If unlinking a file fails - it is open in a
   * player, say - the row is still gone and the recording store's own pruning
   * will reach the file later; the reverse order could delete audio for a
   * dictation that then survives.
   */
  ipcMain.handle(IPC.deleteDictations, (_e, ats: unknown) => {
    const list = Array.isArray(ats) ? ats.filter((n): n is number => typeof n === 'number') : []
    const { deleted, audioPaths } = store.dictations.deleteAt(list)
    recordings.forget(audioPaths)
    broadcast(IPC.metric, undefined)
    return deleted
  })

  ipcMain.handle(IPC.clearDictations, () => {
    const { deleted, audioPaths } = store.dictations.deleteAll()
    recordings.forget(audioPaths)
    broadcast(IPC.metric, undefined)
    return deleted
  })

  /**
   * The rating sheet, assembled in one place.
   *
   * Every one of the three handlers below returns the WHOLE sheet rather than
   * just what it changed. The verdict, the count and the next dictation move
   * together or the screen shows a number that no longer describes what is in
   * front of it, and one shape crossing the bridge is how that is guaranteed
   * rather than remembered.
   */
  const ratingSheet = (): RatingSheet => {
    const { next, remaining } = store.dictations.nextUnrated()
    return {
      next,
      remaining,
      progress: store.ratings.progress(),
      recent: store.ratings.all(12).flatMap((rating) => {
        const d = store.dictations.byAt(rating.dictationAt)
        // A verdict whose dictation has been deleted has nothing to show. The
        // cascade should have taken it, so this is belt and braces.
        return d ? [{ rating, text: d.received || d.corrected || d.raw, language: d.language }] : []
      }),
    }
  }

  ipcMain.handle(IPC.getRatingSheet, () => ratingSheet())
  ipcMain.handle(IPC.rateDictation, (_e, at: number, ship: boolean, note: string) => {
    store.ratings.set(at, ship, note)
    return ratingSheet()
  })
  ipcMain.handle(IPC.clearRating, (_e, at: number) => {
    store.ratings.clear(at)
    return ratingSheet()
  })

  ipcMain.handle(IPC.getStorage, () => store.stats())

  ipcMain.handle(IPC.getDictionary, () => store.dictionary.all())
  ipcMain.handle(IPC.addDictionaryEntry, (_e, entry: NewDictionaryEntry) => {
    // Validated in main, not only in the form: the rule that a correction must
    // be more specific than the word it replaces protects every future
    // transcript, and a renderer is not the place to enforce it.
    const check = validateEntry(entry)
    if (!check.ok) return check.reason
    const id = store.dictionary.add({
      kind: entry.kind,
      hear: entry.hear.trim(),
      write: entry.kind === 'correction' ? entry.write.trim() : '',
      enabled: entry.enabled,
    })
    return id === null ? 'You already have a rule for that.' : null
  })
  ipcMain.handle(IPC.updateDictionaryEntry, (_e, id: number, patch: DictionaryPatch) => {
    store.dictionary.update(id, patch)
  })
  ipcMain.handle(IPC.removeDictionaryEntry, (_e, id: number) => store.dictionary.remove(id))

  ipcMain.handle(IPC.getRecordings, () => recordings.list())
  ipcMain.handle(IPC.deleteRecording, (_e, file: string) => {
    recordings.remove(file)
  })
  ipcMain.handle(IPC.clearRecordings, () => recordings.clear())
  ipcMain.handle(IPC.startMeeting, () => meetings.start())
  ipcMain.handle(IPC.stopMeeting, () => {
    // Asks; the merge runs once the window says its streams are shut, or after
    // the grace period if it never does.
    meetings.requestStop()
  })
  ipcMain.handle(IPC.getMeetingState, () => meetings.state())
  ipcMain.handle(IPC.listMeetings, () => store.meetings.list())
  ipcMain.handle(IPC.getMeetingSegments, (_e, id: number) => store.meetings.segments(id))
  ipcMain.handle(IPC.searchMeetings, (_e, query: string) => store.meetings.search(query))
  ipcMain.handle(IPC.deleteMeeting, (_e, id: number) => {
    // The row goes; the audio stays. Deleting a recording of other people is a
    // separate decision from tidying a list, and the file is reachable from
    // "Show file" until it is made deliberately.
    store.meetings.remove(id)
  })
  ipcMain.handle(IPC.setMeetingScratch, (_e, id: number, markdown: string) =>
    store.meetings.setScratch(id, markdown)
  )
  ipcMain.handle(IPC.getMeetingTasks, (_e, id: number) => store.meetings.tasksFor(id))
  ipcMain.handle(IPC.getMeeting, (_e, id: number) => store.meetings.byId(id))
  ipcMain.handle(IPC.setMeetingKind, (_e, id: number, kind: string) =>
    store.meetings.setKind(id, kind)
  )
  ipcMain.handle(IPC.renderEnglish, (_e, id: number) => renderEnglish(id))
  ipcMain.handle(IPC.repassMeeting, (_e, id: number) => runRepass(id))
  ipcMain.handle(IPC.getMeetingOffer, () => pendingOffer)
  ipcMain.handle(IPC.dismissMeetingOffer, () => {
    micWatcher.dismissOffer()
    pendingOffer = null
    broadcast(IPC.meetingOffer, null)
  })
  ipcMain.handle(IPC.copyMeetingDiagnostic, async (_e, id: number) => {
    const meeting = store.meetings.byId(id)
    if (!meeting) return false
    await clipboard.writeText(formatMeeting(meeting, store.meetings.tasksFor(id).length))
    return true
  })
  ipcMain.handle(IPC.getOpenTasks, () => store.meetings.openTasks())
  ipcMain.handle(IPC.setTaskState, (_e, taskId: number, state: TaskState) =>
    store.meetings.setTaskState(taskId, state)
  )
  ipcMain.handle(IPC.generateNotes, (_e, id: number) => writeNotes(id))
  ipcMain.on(IPC.revealMeeting, (_e, dir: string) => shell.showItemInFolder(path.join(dir, 'audio.wav')))
  ipcMain.on(
    IPC.meetingFrame,
    (_e, sessionId: number, channel: MeetingChannel, frame: Float32Array) =>
      meetings.frame(sessionId, channel, frame)
  )
  ipcMain.on(IPC.meetingReady, (_e, sessionId: number) => meetings.captureReady(sessionId))
  ipcMain.on(
    IPC.meetingFailed,
    (_e, sessionId: number, channel: MeetingChannel, reason: string) =>
      meetings.captureFailed(sessionId, channel, reason)
  )
  ipcMain.on(IPC.meetingClosed, (_e, sessionId: number) => meetings.captureClosed(sessionId))

  ipcMain.on(IPC.audioFrame, (_e, sessionId: number, frame: Float32Array) =>
    dictation.pushFrame(sessionId, frame)
  )
  ipcMain.on(IPC.captureReady, (_e, sessionId: number) => {
    if (sessionId === dictation.sessionId) dictation.send({ type: 'micReady' })
  })
  ipcMain.on(IPC.captureFailed, (_e, sessionId: number, reason: string) => {
    if (sessionId === dictation.sessionId) dictation.send({ type: 'micFailed', reason })
  })
  ipcMain.on(IPC.cancelDictation, () => dictation.send({ type: 'escape' }))

  // Tapping the pet IS the hotkey - the same function, not a parallel path.
  ipcMain.on(IPC.petClick, () => startDictation())
  ipcMain.on(IPC.petDragStart, () => startPetDrag())
  ipcMain.on(IPC.petDragEnd, () => {
    const placement = endPetDrag()
    if (!placement) return
    // Persisted on drop rather than on every frame of the drag: this file is
    // written synchronously and a 60Hz drag would rewrite it a hundred times.
    const next = settings.set({ pet: { ...settings.get().pet, placement } })
    broadcast(IPC.settingsChanged, next)
  })

  ipcMain.handle(IPC.copyDiagnostic, async (_e, at: number) => {
    const d = store.dictations.byAt(at)
    if (!d) return false
    // Awaited: Electron 44's clipboard is asynchronous, so returning true from
    // an unawaited write claims success before the write has happened.
    await clipboard.writeText(formatDiagnostic(d, d.id ?? 0, describeCalibration(settings.get())))
    return true
  })

  ipcMain.handle(IPC.exportDiagnostics, async (_e, withAudio: boolean) => {
    // Bounded: an export is meant to be read and pasted, and the whole history
    // could be thousands of transcripts.
    const all = store.dictations.recent(200)
    if (all.length === 0) return null

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Wouice diagnostics',
      defaultPath: `wouice-diagnostics-${stamp}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (canceled || !filePath) return null

    const snap = supervisor.snapshotAll()
    const md = formatSession(all, {
      app: app.getVersion(),
      electron: process.versions.electron,
      platform: `${process.platform} ${process.arch}`,
      models: snap.map((x) => `${x.id}=${x.modelId}`).join(' '),
      // Whether the levels below were measured or inherited. Without this,
      // "why did it not stop when I stopped talking?" is unanswerable from an
      // export alone: shipped defaults and a bad calibration look identical.
      levels: describeCalibration(settings.get()),
    })
    writeFileSync(filePath, md, 'utf8')

    if (withAudio) {
      // Alongside the markdown rather than inside it: audio next to the text
      // that describes it means one folder to zip and send.
      const dir = filePath.replace(/\.md$/, '') + '-audio'
      mkdirSync(dir, { recursive: true })
      for (const d of all) {
        if (!d.audioPath) continue
        try {
          copyFileSync(d.audioPath, path.join(dir, path.basename(d.audioPath)))
        } catch {
          // Pruned since it was recorded. The markdown still stands alone.
        }
      }
    }
    shell.showItemInFolder(filePath)
    return filePath
  })

  ipcMain.on(IPC.revealMetrics, () => shell.showItemInFolder(store.file))

  /**
   * Calibration. Analyses only; nothing is written until the user accepts.
   *
   * The speech threshold cannot ship as a constant: a value derived from one
   * microphone classified 70% of speech as silence on that very machine, and
   * anyone with a different mic or a quieter voice hits the same wall. So it is
   * measured here from the user's own voice.
   */
  ipcMain.handle(IPC.calibrate, async (_e, inputs: CalibrationInput[], device: string): Promise<CalibrationReport> => {
    const samples = inputs.map((i) => ({
      label: i.label,
      rms: frameLevels(Float32Array.from(i.pcm), (SAMPLE_RATE * FRAME_MS) / 1000),
    }))
    const result = analyseCalibration(samples)

    // Transcribe each prompt as well. The numbers say whether the gate will
    // work; only the text says whether the recognition is any good, and it is
    // the only place the "was my Hindi actually heard as Hindi?" question gets
    // a straight answer.
    const transcripts: CalibrationReport['transcripts'] = []
    if (supervisor.canServe('whisper')) {
      const asr = new WhisperCppClient({
        baseUrl: supervisor.baseUrl('whisper'),
        model: supervisor.snapshot('whisper').modelId,
      })
      for (const i of inputs) {
        try {
          const r = await asr.transcribe(Float32Array.from(i.pcm), { language: 'auto' })
          transcripts.push({
            label: i.label,
            text: r.text.trim(),
            language: r.language,
            durationMs: i.durationMs,
          })
        } catch (err) {
          transcripts.push({
            label: i.label,
            text: err instanceof Error ? err.message : 'transcription failed',
            language: 'unknown',
            durationMs: i.durationMs,
          })
        }
      }
    }

    const cfg = settings.get().silence
    const report: Omit<CalibrationReport, 'runId'> = {
      ...result,
      transcripts,
      previousThreshold: cfg.minNoiseFloor * cfg.speechFactor,
      device,
      notes: describeLanguages(
        samples.map((s) => ({
          ...s,
          language: transcripts.find((t) => t.label === s.label)?.language,
        }))
      ),
    }
    // Written now, before the user has decided anything. A run they looked at
    // and walked away from is the record of a microphone or a room that did not
    // work, and that is worth more than a history of successes only.
    return { ...report, runId: recordCalibration(report) }
  })

  ipcMain.handle(IPC.calibrateApply, (_e, report: CalibrationReport) => {
    if (report.quality === 'unusable') return
    if (report.runId) store.calibrations.markApplied(report.runId)
    const next = settings.set({
      silence: applyCalibration(settings.get().silence, report),
      calibration: {
        at: Date.now(),
        device: report.device,
        quality: report.quality,
        silenceLevel: report.observed.silenceLevel,
        speechLevel: report.observed.speechLevel,
        separation: report.observed.separation,
        languages: report.transcripts.map((t) => ({ label: t.label, detected: t.language })),
      },
    })
    broadcast(IPC.settingsChanged, next)
  })
}

// A second instance would fight over the hotkey and the sidecar ports.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createMainWindow(settings.get().appearance.zoom))

  app.whenReady().then(async () => {
    // On a 6 GB card whose hot set needs ~5.4 GB, one stray sidecar left by a
    // manual benchmark or debug launch is the difference between starting and a
    // CUDA out-of-memory. Guarantee a deterministic starting state.
    const ourExes = Object.values(SIDECARS).map((d) => path.join(SIDECAR_ROOT, d.exe))
    const sweep = await sweepOrphans(ourExes)
    if (sweep.killed.length) {
      console.warn(
        `[orphans] killed ${sweep.killed.length} leftover sidecar(s): ` +
          sweep.killed.map((k) => `${k.exe}#${k.pid}`).join(', ')
      )
    }

    // Only now, holding the single-instance lock. The import RENAMES the old
    // log, so a second launch that is about to quit must never reach it: the
    // instance still running would lose the file it is appending to.
    try {
      const imported = importJsonl(store.db, path.join(app.getPath('userData'), 'metrics.jsonl'))
      if (imported.ran) {
        console.log(
          `[store] imported ${imported.dictations} dictation(s) and ${imported.resources} sample(s)` +
            (imported.malformed ? `, skipped ${imported.malformed} malformed line(s)` : '')
        )
      }
    } catch (err) {
      // The original is untouched by any failure here, so the next launch
      // simply tries again. Never a reason to refuse to start.
      console.warn('[store] could not import metrics.jsonl:', err)
    }

    if (!injectionAvailable()) {
      console.warn(
        `[injection] unavailable, falling back to clipboard only: ${injectionUnavailableReason()}`
      )
    }

    const { models } = settings.get()
    supervisor.register('whisper', models.whisper)
    supervisor.register('llama', models.llama)

    // Must be installed before any renderer asks for system audio, and it costs
    // nothing when no meeting is ever started.
    enableSystemAudioCapture()

    // Anything a previous run left in checkpoints, before a new meeting can
    // start on top of it. The audio is already on disk; this is what turns it
    // into a file.
    void meetings.recoverAbandoned().then(() => reconcileMeetings())
    applyAutoDetect(settings.get().meetings.autoDetect)

    registerIpc()
    createHud()
    applyPetSettings(settings.get().pet)
    createTray(trayDeps)
    registerHotkeys()
    createMainWindow(settings.get().appearance.zoom)

    // Start both sidecars. They load multi-GB models, so this takes seconds;
    // the UI is usable throughout and reports status as it changes.
    void supervisor.start('whisper')
    void supervisor.start('llama')

    // Slow on purpose: spawning nvidia-smi costs ~80ms and the headroom this
    // watches changes on the scale of seconds, never milliseconds. It is never
    // called on the dictation path.
    let samples = 0
    const sample = async (): Promise<void> => {
      const r = await sampleResources()
      try {
        store.resources.insert({ at: Date.now(), ...r })
        // This is the one table that grows on its own, so it is the one table
        // that trims itself. Hourly is often enough for a row every 15s.
        if (++samples % 240 === 0) store.resources.prune()
      } catch (err) {
        console.warn('[store] could not record sample:', err)
      }
    }
    void sample()
    setInterval(() => void sample(), 15_000)
  })

  // Tray app: closing the window must not quit.
  app.on('window-all-closed', () => {})

  app.on('before-quit', async () => {
    hotkeys.unregisterAll()
    destroyTray()
    // Sidecars are children, but killing them explicitly avoids orphaned
    // processes holding the GPU if Electron exits uncleanly.
    await supervisor.stopAll()
    store.close()
  })
}
