import { app, clipboard, dialog, globalShortcut, ipcMain, Notification, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarSupervisor, type SidecarSnapshot } from './sidecars/supervisor.js'
import { sweepOrphans } from './sidecars/orphans.js'
import { SIDECARS } from '../shared/models.js'
import { AfterCall, describeNotesStep, type Plan, type Session } from './sidecars/after-call.js'
import { readGpu } from './sidecars/gpu.js'
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
import { IPC, type EnglishOutcome, type NotesOutcome, type RepassOutcome, type CalibrationInput, type CalibrationReport, type VocabularyDraft, type VocabularyImport,type Diagnostics, type RatingSheet, type SidecarView } from '../shared/ipc.js'
import type { SidecarId } from '../shared/models.js'
import { DictationController, FRAME_MS, SAMPLE_RATE, type DictationResult } from './dictation/controller.js'
import { sampleResources } from './metrics/sample.js'
import {
  importJsonl,
  openStore,
  validateEntry,
  MEET_CAPTIONS_SOURCE,
  type DictationRecord,
  type TaskRecord,
  type TaskState,
  type VocabularyKind,
} from '@wouice/store'
import { RecordingStore } from './metrics/recordings.js'
import { Injector, type InjectionResult } from './injection/injector.js'
import { injectionAvailable, injectionUnavailableReason } from './injection/win32.js'
import { analyseCalibration, applyCalibration, describeLanguages, frameLevels } from './capture/calibrate.js'
import { enableSystemAudioCapture } from './meeting/display-media.js'
import { MeetingController } from './meeting/controller.js'
import { MeetingJobs } from './meeting/jobs.js'
import { BotIdentity } from './bot/identity.js'
import { findChrome } from './bot/chrome.js'
import { launchBotBrowser } from './bot/browser.js'
import { MeetingBot, type CaptureSink } from './bot/runner.js'
import { captionSegment } from './bot/captions.js'
import { carryOver } from './meeting/versions.js'
import { finishedSessions } from './meeting/merge.js'
import { discardRecording } from './meeting/remove.js'
import { MeetingNotesEngine, NotesUnavailable, type NotesProgress } from './meeting/notes-engine.js'
import { appears, asDictionary, glossaryFor, mentionedIn, parseKinds, parseVocabularyList } from './meeting/vocabulary.js'
import { VocabularyMiner } from './meeting/vocabulary-miner.js'
import { MicWatcher } from './meeting/mic-watcher.js'
import { repassMeeting, RepassUnavailable } from './meeting/repass.js'
import { MeetingEnglishEngine, EnglishUnavailable } from './meeting/english-engine.js'
import { kindOf, meetCaptionLanguage } from '../shared/meeting-kind.js'
import { formatMeeting } from './metrics/diagnostic.js'
import type { Channel as MeetingChannel } from './meeting/session.js'
import { WhisperCppClient } from '@wouice/asr'
import { OpenAiCompatClient, VOCABULARY_KINDS_SYSTEM } from '@wouice/llm'
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
 * The heavy work on meetings after the call - English, summary, the careful
 * pass - one job at a time, and the one place that knows which meeting it is
 * on. Every screen that shows "busy" reads this rather than guessing from
 * progress messages. See `MeetingJobs`.
 */
const jobs = new MeetingJobs()
jobs.on('change', (view: unknown) => broadcast(IPC.meetingJobs, view))

/**
 * Larger models for a meeting's English and notes, after the call: dictation
 * pauses, both of its models leave the card, and they come back when the
 * meeting is written up. It always runs inside a job above, so never two at
 * once. See `AfterCall` and docs/design/08-after-call-models.md.
 */
/** What the tray last said about the engine, so it is rebuilt only when that changes. */
let trayEngine = ''
const afterCall = new AfterCall({
  sidecars: supervisor,
  gpu: readGpu,
  dictationModels: () => settings.get().models,
  // Never while you are recording a meeting yourself: its live transcription
  // needs Whisper on the card. Then the dictation model writes it, as before.
  enabled: () => settings.get().meetings.largerModels && meetings.state().phase === 'idle',
  // Chosen by measurement (08 §2): E4B writes the best English, Qwen3.5 finds
  // the most real work. The dictation model is always the last resort.
  candidates: { english: ['gemma4-e4b'], notes: ['qwen35-9b', 'gemma4-e4b'] },
  onView: (view) => {
    broadcast(IPC.engineState, view)
    // Only when what it says changes. Progress arrives a few times a second,
    // and rebuilding the menu that often closes it under your cursor.
    const said = `${view.mode}|${view.title}`
    if (said !== trayEngine) {
      trayEngine = said
      refreshTray(trayDeps)
    }
  },
  // Kept on the version it wrote up, beside that version's English and notes.
  onRecord: (meetingId, record) => {
    const meeting = store.meetings.byId(meetingId)
    const versionId = meeting?.mainVersionId
    if (versionId === null || versionId === undefined) return
    // Every run, newest last, like the notes runs: redoing the English and then
    // the summary is two runs, and keeping only the latest lost the first.
    const earlier = meeting?.versions.find((v) => v.id === versionId)?.diagnostics.afterCall
    const runs = Array.isArray(earlier) ? earlier : earlier ? [earlier] : []
    try {
      store.meetings.setVersionDiagnostics(versionId, { afterCall: [...runs, record] })
    } catch (err) {
      console.warn('[after-call] could not record the run:', err)
    }
    console.log(
      `[after-call] meeting ${meetingId}: ${JSON.stringify(record.models)}, ` +
        `${record.fallbacks.length} fallback(s), restored ${record.restored}` +
        (record.stopped ? `, stopped: ${record.stopped}` : '')
    )
  },
})

/** The bot's own Chrome profile: signed in by hand once, used by every run. */
const BOT_PROFILE = path.join(app.getPath('userData'), 'bot', 'chrome-profile')

/**
 * The meeting bot's identity: its own Chrome profile, signed in by hand once,
 * and the check that says which account it holds. See docs/design/07-meeting-bot.md.
 */
const botIdentity = new BotIdentity({
  profileDir: BOT_PROFILE,
  expected: () => settings.get().meetings.bot.email,
  chromePath: () => findChrome(),
})
botIdentity.on('status', (view: unknown) => broadcast(IPC.botStatus, view))

/**
 * Where the bot's captions go: a meeting of their own, beside anything you
 * record yourself. Its transcript is a "Meet captions" version, the main one
 * from the start; the first-pass version beside it stays empty, because
 * nothing was recorded. The folder is made without a checkpoints folder in it,
 * which is what recovery reads as an abandoned recording.
 */
const botCapture: CaptureSink = {
  open(startedAt) {
    const dir = path.join(MEETING_ROOT, `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-bot`)
    mkdirSync(dir, { recursive: true })
    const id = store.meetings.start(dir, startedAt, settings.get().meetings.defaultKind)
    store.meetings.setMain(id, store.meetings.appendToVersion(id, MEET_CAPTIONS_SOURCE, [], startedAt))
    broadcast(IPC.meetingReady2, id)
    return id
  },
  append(meetingId, lines, startedAt) {
    const me = settings.get().meetings.me.name
    store.meetings.appendToVersion(
      meetingId,
      MEET_CAPTIONS_SOURCE,
      lines.map((line) => captionSegment(line, startedAt, me))
    )
    broadcast(IPC.meetingUpdated, meetingId)
  },
  close(meetingId, { endedAt, lines, people }) {
    // The people on the call, spelled by Google: into your vocabulary on their
    // own - the one source trusted enough for that. Never over one you changed
    // or said is not a word.
    try {
      const added = store.vocabulary.addPeople(people)
      store.vocabulary.markSeen(people.flatMap((name) => store.vocabulary.byTerm(name)?.id ?? []), meetingId)
      if (added.length > 0) broadcast(IPC.vocabularyChanged, null)
    } catch (err) {
      console.warn('[vocabulary] could not add the people on the call:', err)
    }
    const meeting = store.meetings.byId(meetingId)
    if (!meeting) return
    store.meetings.finish(meetingId, { endedAt, audioPath: null, durationMs: endedAt - meeting.startedAt })
    // Its length and "finished" now, not when the English and the summary are
    // done minutes later: until then the list still said "never finished · 0s".
    broadcast(IPC.meetingUpdated, meetingId)
    // Kept even when empty. A meeting that vanished when the bot left was a
    // call with nowhere to look for what happened to it.
    if (lines === 0) {
      broadcast(IPC.meetingReady2, meetingId)
      return
    }
    // English, then the summary and tasks, as after a recorded meeting.
    void finishMeeting(meetingId)
  },
}

/**
 * The meeting bot: joins a Meet link in the bot's Chrome, waits to be let in,
 * keeps Meet's captions as a meeting, and leaves by itself, saying why.
 */
const meetingBot = new MeetingBot({
  sink: botCapture,
  // Follows "Spoken in" on the Meetings page, which the bot panel says beside it.
  captionLanguage: () => meetCaptionLanguage(settings.get().meetings.defaultKind).code,
  runsDir: path.join(app.getPath('userData'), 'bot', 'runs'),
  launch: () => {
    const chromePath = findChrome()
    if (!chromePath) return Promise.reject(new Error('Chrome is not installed'))
    return launchBotBrowser({ chromePath, profileDir: BOT_PROFILE })
  },
  // Before every run. A bot that finds out on Meet's own page that it is
  // signed out has already become an anonymous guest in the risky queue.
  ensureSignedIn: async () => {
    const status = await botIdentity.check()
    const right = !status.expected || status.email === status.expected
    if (status.state === 'signed-in' && status.email && right) return null
    return status.message || "The bot's Chrome profile is not signed in."
  },
})
meetingBot.on('run', (view: unknown) => {
  broadcast(IPC.botRun, view)
  // The bot is capturing the call now. An offer to record a meeting, made
  // because your own browser is using the microphone, is for this same call.
  if ((view as { state?: string } | null)?.state === 'in-meeting' && pendingOffer) {
    pendingOffer = null
    broadcast(IPC.meetingOffer, null)
    micWatcher.dismissOffer()
  }
})

/** Whether the bot is in a call, which the microphone watcher would otherwise offer to record. */
function botInCall(): boolean {
  const state = meetingBot.view()?.state
  return state === 'in-meeting' || state === 'leaving'
}

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
    }),
  countLlamaTokens
)

/**
 * The model's own count of a piece of text.
 *
 * WHY ASK RATHER THAN ESTIMATE. The estimate was calibrated on dictation and
 * undercounted a real meeting by up to 1.8x; three of four summary chunks
 * overflowed and the summary was written from the last six minutes. llama.cpp
 * will tell us exactly. Null when it cannot, and the engine falls back to a
 * padded estimate - wrong in the safe direction.
 */
async function countLlamaTokens(text: string): Promise<number | null> {
  try {
    const res = await fetch(`${supervisor.baseUrl('llama')}/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { tokens?: unknown[] }
    return Array.isArray(body.tokens) ? body.tokens.length : null
  } catch {
    return null
  }
}

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

/** After a meeting, on the model that wrote its notes: names and words to suggest for your vocabulary. */
const vocabularyMiner = new VocabularyMiner(
  () =>
    new OpenAiCompatClient({
      baseUrl: supervisor.baseUrl('llama'),
      model: supervisor.snapshot('llama').modelId,
    })
)

/**
 * Wait for the language model to answer before asking it anything.
 *
 * A started sidecar is not a ready one: it spends seconds reading its weights.
 * The careful pass restarts this model, and asked it for the English and the
 * summary fifty milliseconds later - both failed against a server that was
 * still loading, and the improved meeting was left with neither. Every job
 * that needs the model waits here first, including one queued right after
 * the app starts.
 */
function languageModelReady(): Promise<boolean> {
  return supervisor.whenReady('llama')
}

/**
 * Write the summary and the tasks for one meeting.
 *
 * At module scope rather than inside the IPC handler because the automatic
 * pipeline calls it too: stopping a meeting should leave you with a transcript,
 * an English rendering and a summary without pressing anything, and two copies
 * of this logic would be two things to keep in step.
 */
async function writeNotes(
  id: number,
  versionId?: number,
  opts: { signal?: AbortSignal; onStep?(p: NotesProgress): void } = {}
): Promise<NotesOutcome> {
  const empty = { notesMd: null, tasks: 0, gaps: 0 }
  const meeting = store.meetings.byId(id)
  if (!meeting) return { ok: false, message: 'that meeting is gone', ...empty }
  // The main version unless told otherwise. A summary belongs to the
  // transcript it was written from, and is only ever stored on that one.
  const version = meeting.versions.find((v) => v.id === (versionId ?? meeting.mainVersionId))
  if (!version) return { ok: false, message: 'that transcript is gone', ...empty }
  const segments = store.meetings.segments(id, version.id)
  // Which model writes it, for the record: after a call a larger one than
  // dictation's, or whichever the swap fell back to.
  const model = supervisor.snapshot('llama').modelId

  if (!(await languageModelReady())) {
    const message = 'the language model did not start, so nothing could be written'
    store.meetings.recordNotesRun(version.id, {
      at: Date.now(),
      ok: false,
      chunks: 0,
      gaps: 0,
      tasks: 0,
      ms: 0,
      message,
    })
    return { ok: false, message, ...empty }
  }

  try {
    const run = await notesEngine.generate({
      // The English rendering when there is one: notes written from
      // "स्थमाल" and "रंबाली" never had a chance, and a 4B model summarising
      // raw code-mixed recognition output is the weakest link in the chain.
      lines: segments.map((s) => ({
        id: s.id,
        channel: s.channel,
        startMs: s.startMs,
        text: s.textEn ?? s.text,
        echo: s.echo,
        // The name Meet's captions gave the line, so a task finds its owner.
        speaker: s.speaker,
      })),
      scratch: meeting.scratchMd,
      startedAt: meeting.startedAt,
      me: { name: settings.get().meetings.me.name },
      // With meanings here: "Bible" is the team's knowledge base, not scripture.
      glossary: glossaryFor(store.vocabulary.active(), {
        meanings: true,
        people: [...new Set(segments.flatMap((s) => (s.speaker ? [s.speaker] : [])))],
      }),
      onProgress: (p) => {
        broadcast(IPC.notesProgress, { meetingId: id, ...p })
        opts.onStep?.(p)
      },
      signal: opts.signal,
    })

    // What you had ticked or dropped - in this version or another - goes onto
    // the new list; see `carryOver`. This version's own states first, then the
    // newest, so the state you set last is the one that wins.
    const startOf = new Map(segments.map((s) => [s.id, s.startMs]))
    const sourceOf = new Map(meeting.versions.map((v) => [v.id, v.source]))
    const own = (versionOf: number | null): number => (versionOf === version.id ? 0 : 1)
    const acted = store.meetings
      .allTasks(id)
      .filter((t) => t.state !== 'open')
      .sort((a, b) => own(a.versionId) - own(b.versionId) || b.createdAt - a.createdAt)
    const { tasks, carried } = carryOver(
      acted,
      run.tasks.map((t) => ({
        ...t,
        atMs: t.segmentId === null ? null : (startOf.get(t.segmentId) ?? null),
      })),
      (from) => sourceOf.get(from ?? -1) ?? 'live'
    )

    store.meetings.setVersionNotes(version.id, run.notesMd)
    // The entries this meeting used, counted once for it: how an entry shows
    // on the Vocabulary page that it still earns its place.
    try {
      const said = segments.map((s) => s.textEn ?? s.text).join('\n')
      store.vocabulary.markSeen(mentionedIn(said, store.vocabulary.active()).map((e) => e.id), id)
      broadcast(IPC.vocabularyChanged, null)
    } catch (err) {
      console.warn('[vocabulary] could not count this meeting:', err)
    }
    store.meetings.replaceTasks(version.id, [...tasks, ...carried])
    store.meetings.recordNotesRun(version.id, {
      at: Date.now(),
      ok: true,
      model,
      chunks: run.chunks,
      gaps: run.failedChunks,
      tasks: run.tasks.length,
      ms: run.ms,
      coveredLines: run.coveredLines,
      totalLines: run.totalLines,
      gapsAt: run.gapsAt,
      candidates: run.candidates,
      filtered: run.filtered,
      merged: run.merged,
      rejected: run.rejected,
    })
    broadcast(IPC.meetingUpdated, id)
    console.log(
      `[meeting] notes for ${id}: ${run.chunks} chunk(s), covered ${run.coveredLines}/${run.totalLines} lines,` +
        ` tasks ${run.tasks.length} kept of ${run.candidates}` +
        ` (${run.filtered} filtered, ${run.merged} merged, ${run.rejected} refused)` +
        `, ${Math.round(run.ms / 1000)}s`
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
    const message = opts.signal?.aborted
      ? `stopped because ${afterCall.stoppedBecause() ?? 'it was asked to'}`
      : err instanceof NotesUnavailable
        ? err.message
        : `the model could not be reached: ${err instanceof Error ? err.message : String(err)}`
    // Recorded as well as returned: a failure you can still read tomorrow is
    // the difference between diagnosing this and guessing at it.
    try {
      store.meetings.recordNotesRun(version.id, {
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
  }
}

async function renderEnglish(
  id: number,
  versionId?: number,
  opts: { signal?: AbortSignal; concurrency?: number; onLine?(done: number, total: number): void } = {}
): Promise<EnglishOutcome> {
  const empty = { rendered: 0, missed: 0 }
  const meeting = store.meetings.byId(id)
  if (!meeting) return { ok: false, message: 'that meeting is gone', ...empty }
  if (!kindOf(meeting.kind).translate) {
    return { ok: false, message: 'this meeting is already in English', ...empty }
  }
  // The main version unless told otherwise; its English is stored on its lines.
  const version = meeting.versions.find((v) => v.id === (versionId ?? meeting.mainVersionId))
  if (!version) return { ok: false, message: 'that transcript is gone', ...empty }

  // A failure is recorded on the version, like a failed summary, so the page
  // can say why its English is missing instead of silently showing none.
  const failed = (message: string): EnglishOutcome => {
    try {
      store.meetings.setVersionDiagnostics(version.id, {
        english: { at: Date.now(), rendered: 0, missed: 0, failedBatches: 0, ms: 0, ok: false, message },
      })
    } catch {
      // Bookkeeping. Never worth turning into a second failure.
    }
    return { ok: false, message, ...empty }
  }

  if (!(await languageModelReady())) {
    return failed('the language model did not start, so nothing could be rendered')
  }

  try {
    // Echo lines are the far side heard twice; rendering them spends the
    // model on duplicates of lines that are already being rendered.
    const heard = store.meetings.segments(id, version.id).filter((seg) => !seg.echo)
    const model = supervisor.snapshot('llama').modelId
    const run = await englishEngine.render({
      // With who said each line, where Meet's captions named them: a reply
      // reads differently once the model knows whose question it answers.
      lines: heard.map((seg) => ({ id: seg.id, text: seg.text, speaker: seg.speaker })),
      people: [...new Set(heard.flatMap((seg) => (seg.speaker ? [seg.speaker] : [])))],
      // Read fresh on every call, so notes added AFTER the meeting are used by
      // the next render - which is the point of being able to add them later.
      context: meeting.scratchMd,
      // Your vocabulary, as much of it as each line calls for: how "Lord"
      // becomes Claude. The people in this meeting are always in it.
      glossary: glossaryFor(store.vocabulary.active(), {
        people: [...new Set(heard.flatMap((seg) => (seg.speaker ? [seg.speaker] : [])))],
      }),
      onProgress: (p) => {
        broadcast(IPC.englishProgress, { meetingId: id, ...p })
        opts.onLine?.(p.batch, p.batches)
      },
      // As many lines at once as the model on the card has slots for.
      concurrency: opts.concurrency,
      signal: opts.signal,
    })
    store.meetings.setEnglish(run.rendered.map((r) => ({ id: r.id, textEn: r.textEn })))
    store.meetings.setVersionDiagnostics(version.id, {
      english: {
        ok: true,
        at: Date.now(),
        model,
        rendered: run.rendered.length,
        missed: run.missed,
        failedBatches: run.failedBatches,
        ms: run.ms,
      },
    })
    // Said now, not when the whole job ends: the summary still has minutes to
    // go, and the page should show the English it already has.
    broadcast(IPC.meetingUpdated, id)
    console.log(
      `[meeting] english for ${id}: ${run.rendered.length} line(s), ${run.missed} missed, ${Math.round(run.ms / 1000)}s`
    )
    return { ok: true, message: '', rendered: run.rendered.length, missed: run.missed }
  } catch (err) {
    if (opts.signal?.aborted) return failed(`stopped because ${afterCall.stoppedBecause() ?? 'it was asked to'}`)
    return failed(
      err instanceof EnglishUnavailable
        ? err.message
        : `the model could not be reached: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Bring what you ticked on a meeting's other versions onto this one's list.
 *
 * Used when you choose which version is main: the list you work from changes,
 * and work you finished must not reappear as open on it. The same matching the
 * summary uses - see `carryOver`. This version's own states win over anything
 * carried in.
 */
function adoptTaskStates(meetingId: number, versionId: number): void {
  const meeting = store.meetings.byId(meetingId)
  if (!meeting) return
  const acted = store.meetings
    .allTasks(meetingId)
    .filter((t) => t.versionId !== versionId && t.state !== 'open')
    .sort((a, b) => b.createdAt - a.createdAt)
  if (acted.length === 0) return

  const own = store.meetings.tasksFor(meetingId, versionId)
  const sourceOf = new Map(meeting.versions.map((v) => [v.id, v.source]))
  const asInput = (t: TaskRecord) => ({
    text: t.text,
    owner: t.owner,
    due: t.due,
    segmentId: t.segmentId,
    area: t.area,
    kind: t.kind,
    mine: t.mine,
    source: t.source,
    noteQuote: t.noteQuote ?? null,
    reason: t.reason,
    carriedFrom: t.carriedFrom,
    description: t.description,
    evidence: t.evidence.map((e) => ({ segmentId: e.segmentId, quote: e.quote })),
    status: t.status,
  })
  const { tasks, carried } = carryOver(
    acted,
    own.map((t) => ({ ...asInput(t), atMs: t.quoteAtMs })),
    (from) => sourceOf.get(from ?? -1) ?? 'live'
  )
  store.meetings.replaceTasks(versionId, [
    ...tasks.map((t, i) => {
      const mine = own[i]!.state
      return { ...t, state: mine !== 'open' ? mine : (t.state ?? 'open') }
    }),
    ...carried,
  ])
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
  if (botInCall()) {
    micWatcher.dismissOffer()
    return
  }
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
  // Your vocabulary, the same one meetings use: a hint for every entry, and a
  // rewrite for each sound-alike marked always-rewrite. See `asDictionary`.
  userDictionary: () => asDictionary(store.vocabulary.active()),
  onRulesFired: (applied) => {
    try {
      store.vocabulary.recordHits(applied.map((a) => ({ text: a.from, count: a.count })))
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
  // Recording beats improving. A meeting that starts while the careful pass
  // holds the card would otherwise be transcribed live by the large model.
  if (state.phase === 'starting' && improving) improving.abort()
  // And it beats a meeting's write-up: live transcription needs Whisper back.
  if (state.phase === 'starting') afterCall.abort('a recording started')
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
      segmentsUnheard: summary.segmentsUnheard as number,
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
/** What the careful pass transcribes with, and so the source its version is filed under. */
const IMPROVE_MODEL = 'large-v3'
/** The careful pass in progress, so a recording that starts can stop it. */
let improving: AbortController | null = null

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
  // Checked when the job starts, not when it was asked for: it may have waited
  // behind another, and a recording could have begun in between.
  if (meetings.state().phase !== 'idle') {
    return { ok: false, message: 'not while a meeting is recording', ...empty }
  }

  const started = Date.now()
  const abort = new AbortController()
  improving = abort
  try {
    const result = await repassMeeting(meetingId, {
      supervisor,
      meetings: store.meetings,
      modelId: IMPROVE_MODEL,
      // Back to the model your settings name - never whatever happened to be
      // loaded, which once left the large model on the card for the next meeting.
      restoreModelId: settings.get().models.whisper,
      onProgress: (p) => broadcast(IPC.repassProgress, p),
      signal: abort.signal,
      // Straight to the write-up on the after-call models, without loading
      // both dictation models in between only for it to stop them again.
      handOver: afterCall.willSwap(),
    })
    if (!result.restored && !result.handedOver) {
      notify(
        'Speech model not restored',
        `Wouice could not confirm ${settings.get().models.whisper} is back. Restart Wouice before your next meeting.`
      )
    }

    // A new version, beside the first pass and never over it. It is the main
    // version from the moment its transcript exists: if what follows fails,
    // the page shows THIS transcript and says its summary is still to come,
    // rather than the old summary above the new lines.
    const versionId = store.meetings.createVersion(meetingId, IMPROVE_MODEL, result.segments)
    store.meetings.setVersionDiagnostics(versionId, {
      transcription: {
        at: Date.now(),
        model: IMPROVE_MODEL,
        segments: result.segments.length,
        ms: Date.now() - started,
        languages: result.languages,
        unheard: result.unheard,
        // Handed over, the write-up's own record says whether dictation came back.
        restored: result.handedOver ? undefined : result.restored,
      },
    })
    broadcast(IPC.meetingReady2, meetingId)

    broadcast(IPC.repassProgress, { meetingId, stage: 'warming', doneSec: 0, totalSec: 0 })

    // Everything built on a transcript is built again, from this one - on the
    // after-call models, which take the card from here and put dictation back
    // when they are done. Each step waits for its own model to answer.
    const meeting = store.meetings.byId(meetingId)
    const translate = meeting ? kindOf(meeting.kind).translate : false
    const words = wordsIn(result.segments)
    await onMeetingModels(
      meetingId,
      { english: translate ? words : 0, notes: words },
      async (session) => {
        if (translate) {
          broadcast(IPC.repassProgress, { meetingId, stage: 'rendering', doneSec: 0, totalSec: 0 })
          await englishStep(session, meetingId, versionId)
        }
        broadcast(IPC.repassProgress, { meetingId, stage: 'summarising', doneSec: 0, totalSec: 0 })
        await notesStep(session, meetingId, versionId)
      },
      () => undefined
    )

    notify(
      'Transcript improved',
      `${result.segments.length} lines, ${Math.round((Date.now() - started) / 1000)}s.`
    )
    return { ok: true, message: '', segments: result.segments.length, seconds: result.seconds }
  } catch (err) {
    const message = abort.signal.aborted
      ? 'Stopped because a recording started. Nothing was changed - run Improve again when the meeting is over.'
      : err instanceof RepassUnavailable
        ? err.message
        : `the careful pass failed: ${err instanceof Error ? err.message : String(err)}`
    notify('Could not improve the transcript', message)
    return { ok: false, message, ...empty }
  } finally {
    improving = null
    // Whatever happened above, dictation's models end up running: the careful
    // pass may have handed the card to a write-up that then did not swap.
    await afterCall.ensureDictation()
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

/**
 * English, then the summary and tasks, for the main version.
 *
 * What stopping a meeting does, and what "try again" does after either step
 * failed. The English runs only when this transcript has none: the summary is
 * written FROM the English, so a retry that wrote the summary first would
 * build it from raw recognition output - which is what a manual retry of a
 * failed summary did, a minute before the English arrived.
 */
async function processVersion(meetingId: number): Promise<NotesOutcome> {
  const empty = { notesMd: null, tasks: 0, gaps: 0 }
  const meeting = store.meetings.byId(meetingId)
  if (!meeting) return { ok: false, message: 'that meeting is gone', ...empty }
  const segments = store.meetings.segments(meetingId)
  if (segments.length === 0) {
    return { ok: false, message: 'there is no transcript to write from', ...empty }
  }

  const english = kindOf(meeting.kind).translate && !segments.some((s) => s.textEn)
  return onMeetingModels(
    meetingId,
    { english: english ? wordsIn(segments.filter((s) => !s.echo)) : 0, notes: wordsIn(segments) },
    async (session) => {
      if (english) {
        const rendered = await englishStep(session, meetingId)
        if (!rendered.ok) console.warn(`[meeting] english pass: ${rendered.message}`)
      }
      const notes = await notesStep(session, meetingId)
      if (!notes.ok) console.warn(`[meeting] notes: ${notes.message}`)
      return notes
    },
    (message) => ({ ok: false, message, ...empty })
  )
}

/**
 * How many words a step will read, for the time left. The English if there is
 * some, what was said if not: they are close enough in length to plan with.
 */
function wordsIn(segments: readonly { text: string; textEn?: string | null }[]): number {
  return segments.reduce((n, s) => n + (s.textEn ?? s.text).split(/\s+/).filter(Boolean).length, 0)
}

/**
 * A meeting's write-up on the after-call models.
 *
 * A stop - a recording starting, or you asking for dictation back - comes
 * back as an outcome that says so, not as an error: what was finished is
 * stored, and the rest can simply be run again.
 */
async function onMeetingModels<T>(
  meetingId: number,
  plan: Plan,
  work: (session: Session) => Promise<T>,
  stopped: (message: string) => T
): Promise<T> {
  try {
    return await afterCall.run(meetingId, plan, work)
  } catch (err) {
    const why = afterCall.stoppedBecause()
    if (why) return stopped(`Stopped because ${why}. What was finished is kept - run it again when you like.`)
    throw err
  }
}

/**
 * The English, on the best model that fits the card. A model that could not be
 * loaded leaves the step to fail and say why, like any failed step.
 */
async function englishStep(session: Session, meetingId: number, versionId?: number): Promise<EnglishOutcome> {
  let label = supervisor.snapshot('llama').modelId
  let slots = 1
  try {
    const model = await session.use('english')
    label = model.label
    slots = model.slots
  } catch (err) {
    if (session.signal.aborted) throw err
    console.warn('[after-call] english:', err instanceof Error ? err.message : err)
  }
  return renderEnglish(meetingId, versionId, {
    signal: session.signal,
    concurrency: slots,
    onLine: (done, total) => session.progress(done, total, `${label} · ${done} of ${total} lines`),
  })
}

/** The summary and tasks, on the best model that fits the card. */
async function notesStep(session: Session, meetingId: number, versionId?: number): Promise<NotesOutcome> {
  let label = supervisor.snapshot('llama').modelId
  try {
    label = (await session.use('notes')).label
  } catch (err) {
    if (session.signal.aborted) throw err
    console.warn('[after-call] notes:', err instanceof Error ? err.message : err)
  }
  const outcome = await writeNotes(meetingId, versionId, {
    signal: session.signal,
    onStep: (p) => {
      const step = describeNotesStep(p)
      session.progress(Math.round(step.share * 1000), 1000, `${label} · ${step.words}`)
    },
  })
  // While the model that wrote them is still loaded. The notes are saved by
  // now: whatever happens here costs the suggestions, never the notes.
  if (outcome.ok) {
    session.progress(999, 1000, `${label} · looking for new names`)
    try {
      await suggestVocabulary(meetingId, versionId, session.signal)
    } catch (err) {
      console.warn('[vocabulary] could not look for new names:', err instanceof Error ? err.message : err)
    }
  }
  return outcome
}

/**
 * What this meeting suggests for your vocabulary. Suggestions only: nothing is
 * added until you say so on the Vocabulary page, and a new word is shown only
 * once a second meeting or something outside the transcript backs it.
 */
async function suggestVocabulary(meetingId: number, versionId: number | undefined, signal?: AbortSignal): Promise<void> {
  const meeting = store.meetings.byId(meetingId)
  const version = meeting?.versions.find((v) => v.id === (versionId ?? meeting.mainVersionId))
  if (!meeting || !version) return
  const segments = store.meetings.segments(meetingId, version.id).filter((s) => !s.echo)
  const speakers = segments.flatMap((s) => (s.speaker ? [s.speaker] : []))
  const scratch = meeting.scratchMd ?? ''
  const started = Date.now()
  const found = await vocabularyMiner.mine({
    lines: segments.map((s) => ({ id: s.id, text: s.textEn ?? s.text, speaker: s.speaker })),
    known: store.vocabulary.all(),
    signal,
  })
  let waiting = 0
  for (const f of found) {
    // Backed outside the transcript: a speaker Meet named, or your own notes.
    const backed = f.type === 'new' && (speakers.some((s) => appears(f.term, s)) || appears(f.term, scratch))
    const state = store.vocabulary.propose({ ...f, meetingId, corroborated: backed })
    if (state === 'suggested') waiting++
  }
  console.log(`[vocabulary] meeting ${meetingId}: ${found.length} found, ${waiting} suggested, ${Date.now() - started}ms`)
  if (found.length > 0) broadcast(IPC.vocabularyChanged, null)
}

/** A suggestion taken - as it stands, or as you edited it. Why it was refused, or null. */
function acceptSuggestion(id: number, draft?: VocabularyDraft): string | null {
  if (draft) {
    const refused = saveVocabulary(draft)
    if (refused) return refused
    store.vocabulary.setSuggestionState(id, 'accepted')
  } else if (store.vocabulary.accept(id) === null) {
    return 'That suggestion is no longer there.'
  }
  broadcast(IPC.vocabularyChanged, null)
  return null
}

function finishMeeting(meetingId: number): Promise<void> {
  // Queued like everything else: stopping one meeting while another is being
  // improved must not put two models on the card at once.
  return jobs
    .run(meetingId, 'process', async () => {
      await processVersion(meetingId)
      broadcast(IPC.meetingReady2, meetingId)
    })
    .catch((err: unknown) => console.warn('[meeting] processing failed:', err))
}

/**
 * Give every recording on disk a row, and every row its audio.
 *
 * The filesystem is the source of truth for audio - a directory with an
 * `audio.wav` is a meeting that happened, whether or not anything wrote it
 * down. Recordings made before the table existed, or recovered from a crash
 * that took the database write with it, would otherwise be invisible in an app
 * that is holding them.
 *
 * Which is why removing a meeting takes its directory to the Recycle Bin (see
 * `discardRecording`). A removed row with its audio still here is, to this
 * function, a recording nobody wrote down - and it adopts it straight back.
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
    // Saved, not applied, while meeting work holds the card: bringing
    // dictation back loads what settings name, so the choice lands then.
    if (afterCall.pausesDictation()) return
    void supervisor.switchModel(id, modelId)
  },
  onRestart: (id: SidecarId) => {
    if (afterCall.pausesDictation()) return
    void supervisor.stop(id).then(() => supervisor.start(id))
  },
  status: () => (afterCall.pausesDictation() ? afterCall.pausedMessage().replace(' · ', ': ') : null),
}

supervisor.on('state', (snap: SidecarSnapshot) => {
  broadcast(IPC.sidecarState, toView(snap))
  refreshTray(trayDeps)
  afterCall.sidecarsChanged()
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
  // A meeting's write-up holds the card. Not an error, and not silence
  // either: the HUD says why, and when dictation is back. A dictation already
  // running is still stopped by the hotkey as usual.
  if (afterCall.pausesDictation() && dictation.phase === 'idle') {
    showHud()
    broadcast(IPC.hudState, { phase: 'paused', level: 0, elapsedMs: 0, message: afterCall.pausedMessage() })
    setTimeout(() => {
      if (dictation.phase !== 'idle') return
      broadcast(IPC.hudState, { phase: 'idle', level: 0, elapsedMs: 0 })
      restHud()
    }, 4_000)
    return
  }
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

/**
 * Add or change one vocabulary entry from its page. Why it was refused, or null.
 *
 * Checked here, not only in the form: an always-rewrite sound-alike changes
 * every future dictation, and the rule that it must be more specific than the
 * word it replaces ("cloud" for Claude would break "cloud storage") is main's
 * to keep. An entry you change is yours from then on, whoever added it.
 */
function saveVocabulary(draft: VocabularyDraft): string | null {
  const term = draft.term.trim()
  if (!term) return 'Enter the name or word.'
  if (term.length > 60) return 'That is too long for a name or a word.'
  for (const alias of draft.aliases) {
    if (!alias.rewrite) continue
    const check = validateEntry({ kind: 'correction', hear: alias.text, write: term })
    if (!check.ok) return check.reason
  }
  const fields = {
    term,
    kind: draft.kind,
    aliases: draft.aliases,
    meaning: draft.meaning,
    pinned: draft.pinned,
    source: 'you' as const,
    state: 'active' as const,
  }
  const saved = draft.id === undefined ? store.vocabulary.add(fields) !== null : store.vocabulary.update(draft.id, fields)
  if (!saved) return `${term} is already in your vocabulary.`
  broadcast(IPC.vocabularyChanged, null)
  return null
}

/**
 * A pasted list, added as yours: each word sorted into a kind by the language
 * model on the card, with its meaning when the line gave one. Words you already
 * have are left exactly as they are.
 */
async function importVocabulary(text: string): Promise<VocabularyImport> {
  const pasted = parseVocabularyList(text)
  const fresh = pasted.filter((p) => !store.vocabulary.byTerm(p.term))
  const kinds = await sortIntoKinds(fresh.map((p) => p.term))
  for (const p of fresh) {
    store.vocabulary.add({
      term: p.term,
      kind: kinds.get(p.term) ?? 'term',
      aliases: [],
      meaning: p.meaning,
      pinned: false,
      source: 'you',
      state: 'active',
    })
  }
  if (fresh.length > 0) broadcast(IPC.vocabularyChanged, null)
  return { added: fresh.length, skipped: pasted.length - fresh.length }
}

/**
 * Which kind each word is, asked of whichever language model is serving, in
 * groups small enough for its context. Any word it could not place is a plain
 * term, and a model that is not up is never a reason to refuse the paste.
 */
async function sortIntoKinds(terms: readonly string[]): Promise<Map<string, VocabularyKind>> {
  const kinds = new Map<string, VocabularyKind>()
  if (terms.length === 0 || !supervisor.canServe('llama')) return kinds
  const client = new OpenAiCompatClient({
    baseUrl: supervisor.baseUrl('llama'),
    model: supervisor.snapshot('llama').modelId,
    timeoutMs: 60_000,
  })
  for (let at = 0; at < terms.length; at += 60) {
    const group = terms.slice(at, at + 60)
    try {
      const result = await client.complete({
        system: VOCABULARY_KINDS_SYSTEM,
        user: group.join('\n'),
        maxTokens: 40 + group.length * 24,
        temperature: 0,
      })
      for (const [term, kind] of parseKinds(result.text, group)) kinds.set(term, kind)
    } catch (err) {
      console.warn('[vocabulary] could not sort part of a pasted list:', err instanceof Error ? err.message : err)
    }
  }
  return kinds
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
  ipcMain.handle(IPC.getEngine, () => afterCall.view())
  ipcMain.handle(IPC.resumeDictation, () => afterCall.abort('you asked for dictation back'))
  ipcMain.handle(IPC.restartModels, () => afterCall.restartDictation())
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

  ipcMain.handle(IPC.getVocabulary, () => store.vocabulary.all())
  ipcMain.handle(IPC.saveVocabulary, (_e, draft: VocabularyDraft) => saveVocabulary(draft))
  ipcMain.handle(IPC.getVocabularySuggestions, () => store.vocabulary.suggestions(['suggested', 'rejected']))
  ipcMain.handle(IPC.acceptSuggestion, (_e, id: number, draft?: VocabularyDraft) => acceptSuggestion(id, draft))
  ipcMain.handle(IPC.rejectSuggestion, (_e, id: number) => {
    store.vocabulary.reject(id)
    broadcast(IPC.vocabularyChanged, null)
  })
  ipcMain.handle(IPC.reviveSuggestion, (_e, id: number) => {
    store.vocabulary.revive(id)
    broadcast(IPC.vocabularyChanged, null)
  })
  ipcMain.handle(IPC.removeVocabulary, (_e, id: number) => {
    // A name from a Meet call is put aside as "not a word", not deleted:
    // deleted, the next call with them in it would add it straight back.
    if (store.vocabulary.byId(id)?.source === 'roster') store.vocabulary.update(id, { state: 'rejected' })
    else store.vocabulary.remove(id)
    broadcast(IPC.vocabularyChanged, null)
  })
  ipcMain.handle(IPC.importVocabulary, (_e, text: string) => importVocabulary(text))

  ipcMain.handle(IPC.getRecordings, () => recordings.list())
  ipcMain.handle(IPC.deleteRecording, (_e, file: string) => {
    recordings.remove(file)
  })
  ipcMain.handle(IPC.clearRecordings, () => recordings.clear())
  ipcMain.handle(IPC.getBotStatus, () => botIdentity.view())
  ipcMain.handle(IPC.checkBot, () => botIdentity.check())
  ipcMain.handle(IPC.openBotSignIn, () => botIdentity.openSignIn())
  ipcMain.handle(IPC.sendBot, (_e, url: unknown) => meetingBot.send(typeof url === 'string' ? url : ''))
  ipcMain.handle(IPC.leaveBot, () => meetingBot.leave())
  ipcMain.handle(IPC.getBotRun, () => meetingBot.view())
  // No path from the window: only ever the folder of the bot's own last run.
  ipcMain.on(IPC.revealBotRun, () => {
    const dir = meetingBot.view()?.dir
    if (dir) void shell.openPath(dir)
  })
  ipcMain.handle(IPC.startMeeting, () => meetings.start())
  ipcMain.handle(IPC.stopMeeting, () => {
    // Asks; the merge runs once the window says its streams are shut, or after
    // the grace period if it never does.
    meetings.requestStop()
  })
  ipcMain.handle(IPC.getMeetingState, () => meetings.state())
  ipcMain.handle(IPC.listMeetings, () => store.meetings.list())
  ipcMain.handle(IPC.getMeetingSegments, (_e, id: number, versionId?: number) =>
    store.meetings.segments(id, typeof versionId === 'number' ? versionId : undefined)
  )
  ipcMain.handle(IPC.getMeetingJobs, () => jobs.view())
  ipcMain.handle(IPC.setMainVersion, (_e, id: number, versionId: number): string | null => {
    // Not while something is writing to it: the list would change under the job.
    if (jobs.involves(id)) return 'Wouice is still working on this meeting. Try again when it has finished.'
    if (!store.meetings.setMain(id, versionId)) return 'That version is gone.'
    adoptTaskStates(id, versionId)
    broadcast(IPC.meetingReady2, id)
    return null
  })
  ipcMain.handle(IPC.searchMeetings, (_e, query: string) => store.meetings.search(query))
  ipcMain.handle(IPC.deleteMeeting, async (_e, id: number): Promise<string | null> => {
    // The recording goes to the Recycle Bin with the row. Left where it was,
    // `reconcileMeetings` adopts it straight back at the next launch.
    const meeting = store.meetings.byId(id)
    if (!meeting) return null
    if (meetings.state().meetingId === id) return 'This meeting is still recording. Stop it first.'
    if (jobs.involves(id)) {
      return 'Wouice is still working on this meeting. Remove it when that has finished.'
    }
    // The file first. If the bin refuses, the meeting stays listed, rather than
    // vanishing now and coming back as a stranger tomorrow.
    const problem = await discardRecording(MEETING_ROOT, meeting.dir, (target) =>
      shell.trashItem(target)
    )
    if (problem) return problem
    store.meetings.remove(id)
    return null
  })
  ipcMain.handle(IPC.setMeetingScratch, (_e, id: number, markdown: string) =>
    store.meetings.setScratch(id, markdown)
  )
  ipcMain.handle(IPC.getMeetingTasks, (_e, id: number, versionId?: number) =>
    store.meetings.tasksFor(id, typeof versionId === 'number' ? versionId : undefined)
  )
  ipcMain.handle(IPC.getMeeting, (_e, id: number) => store.meetings.byId(id))
  ipcMain.handle(IPC.setMeetingKind, (_e, id: number, kind: string) =>
    store.meetings.setKind(id, kind)
  )
  // These queue behind whatever is running - the window has already asked
  // whether you want to wait. Asking twice for the same thing is refused
  // rather than queued twice.
  ipcMain.handle(IPC.renderEnglish, (_e, id: number): Promise<EnglishOutcome> =>
    jobs.has(id, 'english')
      ? Promise.resolve({ ok: false, message: 'That is already running or waiting.', rendered: 0, missed: 0 })
      : jobs.run(id, 'english', () => {
          const meeting = store.meetings.byId(id)
          // Nothing to render: say so without moving any model.
          if (!meeting || !kindOf(meeting.kind).translate) return renderEnglish(id)
          const heard = store.meetings.segments(id).filter((s) => !s.echo)
          return onMeetingModels(
            id,
            { english: wordsIn(heard), notes: wordsIn(heard) },
            async (session) => {
              const english = await englishStep(session, id)
              // The summary and tasks were written from the English just
              // replaced. Rewritten from the new one in the same pause, rather
              // than left describing a transcript that is no longer there.
              if (english.ok) {
                const notes = await notesStep(session, id)
                if (!notes.ok) console.warn(`[meeting] notes after the english: ${notes.message}`)
              }
              return english
            },
            (message) => ({ ok: false, message, rendered: 0, missed: 0 })
          )
        })
  )
  ipcMain.handle(IPC.repassMeeting, (_e, id: number): Promise<RepassOutcome> =>
    jobs.has(id, 'improve')
      ? Promise.resolve({ ok: false, message: 'That is already running or waiting.', segments: 0, seconds: 0 })
      : jobs.run(id, 'improve', () => runRepass(id))
  )
  ipcMain.handle(IPC.getMeetingOffer, () => pendingOffer)
  ipcMain.handle(IPC.dismissMeetingOffer, () => {
    micWatcher.dismissOffer()
    pendingOffer = null
    broadcast(IPC.meetingOffer, null)
  })
  ipcMain.handle(IPC.copyMeetingDiagnostic, async (_e, id: number) => {
    const meeting = store.meetings.byId(id)
    if (!meeting) return false
    await clipboard.writeText(
      formatMeeting(meeting, (versionId) => store.meetings.tasksFor(id, versionId).length)
    )
    return true
  })
  ipcMain.handle(IPC.getOpenTasks, () => store.meetings.openTasks())
  ipcMain.handle(IPC.setTaskState, (_e, taskId: number, state: TaskState) =>
    store.meetings.setTaskState(taskId, state)
  )
  ipcMain.handle(IPC.generateNotes, (_e, id: number): Promise<NotesOutcome> =>
    jobs.has(id, 'notes')
      ? Promise.resolve({ ok: false, message: 'That is already running or waiting.', notesMd: null, tasks: 0, gaps: 0 })
      : jobs.run(id, 'notes', () =>
          onMeetingModels(
            id,
            { english: 0, notes: wordsIn(store.meetings.segments(id)) },
            (session) => notesStep(session, id),
            (message) => ({ ok: false, message, notesMd: null, tasks: 0, gaps: 0 })
          )
        )
  )
  ipcMain.handle(IPC.processMeeting, (_e, id: number): Promise<NotesOutcome> =>
    jobs.has(id, 'process')
      ? Promise.resolve({ ok: false, message: 'That is already running or waiting.', notesMd: null, tasks: 0, gaps: 0 })
      : jobs.run(id, 'process', async () => {
          const outcome = await processVersion(id)
          broadcast(IPC.meetingReady2, id)
          return outcome
        })
  )
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

    // What was in the old glossary box moves into the vocabulary - sorted into
    // kinds once the language model answers - and the box is emptied only when
    // that worked, so a launch that closes first simply tries again.
    const boxed = settings.get().meetings.glossary
    if (boxed.trim()) {
      void languageModelReady()
        .then(() => importVocabulary(boxed))
        .then((moved) => {
          settings.set({ meetings: { ...settings.get().meetings, glossary: '' } })
          console.log(`[vocabulary] moved in from the glossary setting: ${moved.added} added, ${moved.skipped} already there`)
        })
        .catch((err: unknown) => console.warn('[vocabulary] could not move the glossary setting in:', err))
    }

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
    // The status card's memory reading, kept fresh while nothing is running.
    afterCall.startSampling()

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
    // First, so nothing it would restore starts behind the stop below.
    afterCall.shutdown()
    hotkeys.unregisterAll()
    destroyTray()
    // Sidecars are children, but killing them explicitly avoids orphaned
    // processes holding the GPU if Electron exits uncleanly.
    await meetingBot.dispose()
    botIdentity.dispose()
    await supervisor.stopAll()
    store.close()
  })
}
