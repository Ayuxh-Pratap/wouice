import type { SidecarId } from './models.js'
import type { Settings } from './settings.js'
import type {
  DictationRecord,
  MeetingRecord,
  TaskRecord,
  TaskState,
  DictionaryRecord,
  Page,
  RatingProgress,
  RatingRecord,
  ResourceRecord,
  StoreStats,
} from '@wouice/store'

/**
 * The IPC surface, typed in one place so main and renderer cannot drift.
 *
 * Channel names are string constants rather than inline literals precisely
 * because a typo in one of two places is a silent no-op that is miserable to
 * track down.
 */
export const IPC = {
  // renderer -> main, request/response
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  getSidecars: 'sidecars:get',
  switchModel: 'sidecars:switchModel',
  restartSidecar: 'sidecars:restart',
  getDiagnostics: 'app:diagnostics',
  hideHud: 'hud:hide',
  getMetrics: 'metrics:get',
  getDictationPage: 'metrics:page',
  deleteDictations: 'metrics:delete',
  getRatingSheet: 'ratings:sheet',
  rateDictation: 'ratings:set',
  clearRating: 'ratings:clear',
  clearDictations: 'metrics:clear',
  getStorage: 'storage:stats',
  getDictionary: 'dictionary:list',
  addDictionaryEntry: 'dictionary:add',
  updateDictionaryEntry: 'dictionary:update',
  removeDictionaryEntry: 'dictionary:remove',
  getRecordings: 'recordings:list',
  deleteRecording: 'recordings:delete',
  clearRecordings: 'recordings:clear',
  copyDiagnostic: 'metrics:copyDiagnostic',
  exportDiagnostics: 'metrics:export',
  revealMetrics: 'metrics:reveal',
  calibrate: 'calibrate:run',
  calibrateApply: 'calibrate:apply',
  // renderer -> main: one 20ms frame of 16kHz mono Float32
  audioFrame: 'capture:frame',
  captureReady: 'capture:ready',
  captureFailed: 'capture:failed',
  cancelDictation: 'dictation:cancel',
  // Meetings. Main owns the decision to record; the window owns the two web
  // APIs that can actually open audio, so the two talk in both directions.
  startMeeting: 'meeting:start',
  stopMeeting: 'meeting:stop',
  getMeetingState: 'meeting:state',
  listMeetings: 'meeting:list',
  revealMeeting: 'meeting:reveal',
  getMeetingSegments: 'meeting:segments',
  searchMeetings: 'meeting:search',
  deleteMeeting: 'meeting:delete',
  setMeetingScratch: 'meeting:scratch',
  generateNotes: 'meeting:writeNotes',
  getMeetingTasks: 'meeting:tasks',
  setTaskState: 'meeting:taskState',
  getOpenTasks: 'meeting:openTasks',
  getMeetingOffer: 'meeting:offer',
  dismissMeetingOffer: 'meeting:dismissOffer',
  copyMeetingDiagnostic: 'meeting:copyDiagnostic',
  renderEnglish: 'meeting:renderEnglish',
  repassMeeting: 'meeting:repass',
  setMeetingKind: 'meeting:setKind',
  getMeeting: 'meeting:one',
  meetingFrame: 'meeting:frame',
  meetingReady: 'meeting:ready',
  meetingFailed: 'meeting:failed',
  meetingClosed: 'meeting:closed',
  // The pet reports gestures; main does the moving. The renderer never knows
  // where on the desktop it is.
  petClick: 'pet:click',
  petDragStart: 'pet:dragStart',
  petDragEnd: 'pet:dragEnd',

  // main -> renderer, push
  sidecarState: 'sidecars:state',
  settingsChanged: 'settings:changed',
  hudState: 'hud:state',
  hotkeyFailed: 'hotkey:failed',
  // main -> renderer: open/close the mic for this session
  startCapture: 'capture:start',
  stopCapture: 'capture:stop',
  metric: 'metrics:new',
  dictationResult: 'dictation:result',
  hudHover: 'hud:hover',
  hudDragging: 'hud:dragging',
  hudPlacement: 'hud:placement',
  meetingState: 'meeting:changed',
  meetingSegments: 'meeting:newSegments',
  notesProgress: 'meeting:notesProgress',
  englishProgress: 'meeting:englishProgress',
  meetingReady2: 'meeting:processed',
  repassProgress: 'meeting:repassProgress',
  meetingOffer: 'meeting:offered',
} as const

/** Which way the capsule opens, and whether there is a pet to open it from. */
export interface HudPlacement {
  side: 'left' | 'right'
  pet: boolean
}

/**
 * Record shapes come from `@wouice/store`, which is the thing that persists
 * them. Re-exported rather than redeclared: a second copy of a shape is exactly
 * how `SilenceConfig` ended up missing three fields on one side, bridged with a
 * cast, and silently breaking speech detection at runtime.
 *
 * Type-only, so the renderer never pulls `node:sqlite` into its bundle.
 */
export type {
  AppliedRule,
  CaptureDiagnostics,
  DictationRecord,
  Page,
  RatingProgress,
  RatingRecord,
  ResourceRecord,
  StoreStats,
  DictionaryRecord,
  CalibrationRecord as CalibrationRun,
} from '@wouice/store'

/** What the dashboard needs for its charts and headline figures. */
export interface MetricsSnapshot {
  /** Oldest first: the charts read left to right. */
  dictations: DictationRecord[]
  resources: ResourceRecord[]
  /** Computed over the WHOLE history in SQL, not over the slice above. */
  summary: {
    count: number
    p50Ms: number
    p95Ms: number
    degraded: number
    chars: number
  }
  byAsrModel: { model: string; meanMs: number; n: number }[]
}

export type CalibrationLabel = 'english' | 'hindi' | 'mixed'

/**
 * One recorded prompt, sent whole for analysis.
 *
 * Deliberately raw audio and nothing else. Levels are measured in main with the
 * same function the live silence gate uses, so a calibration can never be
 * computed against a slightly different measure than the one it is tuning.
 */
export interface CalibrationInput {
  label: CalibrationLabel
  /** The whole recording: 16 kHz mono Float32. */
  pcm: Float32Array
  /** Wall-clock length, for display. */
  durationMs: number
}

export interface CalibrationReport {
  minNoiseFloor: number
  speechFactor: number
  threshold: number
  quality: 'good' | 'weak' | 'unusable'
  reason: string
  observed: {
    frames: number
    silenceLevel: number
    speechLevel: number
    separation: number
    speechRatio: number
  }
  /** What the ASR made of each prompt, so accuracy is visible before committing. */
  transcripts: { label: CalibrationLabel; text: string; language: string; durationMs: number }[]
  /** The threshold that was in force before this run, for comparison. */
  previousThreshold: number
  /** Which microphone this was measured on. */
  device: string
  /** Row id of this run in the calibration history. 0 if it could not be stored. */
  runId: number
  /** Plain-English notes about language handling. */
  notes: string[]
}

export interface NewDictionaryEntry {
  kind: 'term' | 'correction'
  hear: string
  write: string
  enabled: boolean
}

export type DictionaryPatch = Partial<{ hear: string; write: string; enabled: boolean }>

/** One retained WAV, for the settings screen to list and delete. */
export interface RetainedAudio {
  file: string
  at: number
  bytes: number
}

export interface DictationOutcome {
  final: string
  raw: string
  language: string
  asrMs: number
  llmMs: number
  degraded: string | null
  delivered: 'copied' | 'inserted'
}

/** What the HUD is showing. Mirrors the dictation state machine in spec 6.2. */
export type HudPhase = 'idle' | 'arming' | 'listening' | 'thinking' | 'inserted' | 'copied' | 'error'

export interface HudState {
  phase: HudPhase
  /** 0..1 smoothed mic level, drives the meter. */
  level: number
  elapsedMs: number
  message?: string
}

/**
 * The rating screen's whole state.
 *
 * One shape and one round trip rather than four calls that can disagree with
 * each other: the verdict you just recorded, the count it changed, and the next
 * dictation to judge all have to move together or the screen shows a number
 * that no longer matches what is in front of you.
 */
export interface RatingSheet {
  /** The next dictation with no verdict, oldest first. Null when none are left. */
  next: DictationRecord | null
  remaining: number
  progress: RatingProgress
  /** Recent verdicts, newest first, so a misclick can be found and undone. */
  recent: { rating: RatingRecord; text: string; language: string }[]
}

export interface SidecarView {
  id: SidecarId
  status: string
  modelId: string
  pendingModelId: string | null
  port: number
  pid: number | null
  lastError: string | null
}

export interface HotkeyReport {
  name: string
  /** null when nothing in the chain could be claimed. */
  accelerator: string | null
  requested: string
  substituted: boolean
  rejected: string[]
}

export interface Diagnostics {
  sidecarRoot: string
  modelRoot: string
  userData: string
  hotkeyRegistered: Record<string, boolean>
  hotkeys: HotkeyReport[]
  platform: string
  electron: string
}

/** Shape exposed on `window.wouice` by the preload bridge. */
/** Mirrors the main-process controller. Kept here so the window cannot drift. */
export type MeetingChannel = 'me' | 'them'
export type MeetingPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'merging'

export interface MeetingChannelView {
  channel: MeetingChannel
  live: boolean
  samples: number
  level: number
  problem: string | null
}

export interface MeetingState {
  phase: MeetingPhase
  sessionId: number
  startedAt: number | null
  elapsedMs: number
  channels: MeetingChannelView[]
  meetingId: number | null
  transcript: { segments: number; queued: number; failed: number; live: boolean }
  message: string
}

export interface NotesProgressView {
  meetingId: number
  stage: 'condensing' | 'extracting' | 'checking' | 'writing'
  chunk: number
  chunks: number
}

export interface EnglishProgressView {
  meetingId: number
  batch: number
  batches: number
}

export interface EnglishOutcome {
  ok: boolean
  message: string
  /** Lines rendered, and lines the model did not manage. */
  rendered: number
  missed: number
}

export interface RepassProgressView {
  meetingId: number
  stage: 'loading' | 'transcribing' | 'restoring' | 'rendering' | 'summarising'
  doneSec: number
  totalSec: number
}

export interface RepassOutcome {
  ok: boolean
  message: string
  segments: number
  seconds: number
}

export interface NotesOutcome {
  ok: boolean
  /** Why it could not be done. Empty when it worked. */
  message: string
  notesMd: string | null
  tasks: number
  /** Stretches the model could not summarise. Marked in the notes themselves. */
  gaps: number
}

/** One line of the transcript. Echo is flagged, never removed. */
export interface MeetingSegment {
  id: number
  meetingId: number
  channel: MeetingChannel
  startMs: number
  endMs: number
  /** What was said, as heard. */
  text: string
  /** The same line in English, or null when it has not been rendered. */
  textEn: string | null
  echo: boolean
}

export interface WouiceApi {
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  getSidecars(): Promise<SidecarView[]>
  switchModel(id: SidecarId, modelId: string): Promise<void>
  restartSidecar(id: SidecarId): Promise<void>
  getDiagnostics(): Promise<Diagnostics>
  hideHud(): void
  getMetrics(): Promise<MetricsSnapshot>
  /** One page of history, newest first, with the total so pages can be counted. */
  getDictationPage(offset: number, limit: number, query?: string): Promise<Page<DictationRecord>>
  /**
   * Delete specific dictations, by the timestamps the table already keys on.
   * Their retained audio goes too. Returns how many rows were actually removed.
   */
  deleteDictations(ats: number[]): Promise<number>
  /** Delete every dictation and every retained recording. Returns the count. */
  clearDictations(): Promise<number>
  /** Everything the rating screen needs, in one round trip. */
  getRatingSheet(): Promise<RatingSheet>
  /** Record a verdict and get the next one back. */
  rateDictation(at: number, ship: boolean, note?: string): Promise<RatingSheet>
  /** Undo a verdict, putting that dictation back in the queue. */
  clearRating(at: number): Promise<RatingSheet>
  /** What is in the database: schema version, size, and per-table row counts. */
  getStorage(): Promise<StoreStats>
  getDictionary(): Promise<DictionaryRecord[]>
  /** Returns the problem when the entry was refused, or null when it was added. */
  addDictionaryEntry(entry: NewDictionaryEntry): Promise<string | null>
  updateDictionaryEntry(id: number, patch: DictionaryPatch): Promise<void>
  removeDictionaryEntry(id: number): Promise<void>
  getRecordings(): Promise<RetainedAudio[]>
  deleteRecording(file: string): Promise<void>
  clearRecordings(): Promise<void>
  /** Put one dictation's full diagnostic on the clipboard, ready to paste. */
  copyDiagnostic(at: number): Promise<boolean>
  /** Write a markdown export, optionally with the retained audio. Returns the path. */
  exportDiagnostics(withAudio: boolean): Promise<string | null>
  revealMetrics(): void
  /** Analyse recorded prompts. Does not change settings. */
  calibrate(samples: CalibrationInput[], device: string): Promise<CalibrationReport>
  /** Commit a calibration to settings. */
  calibrateApply(report: CalibrationReport): Promise<void>
  /**
   * Ask for a meeting. Returns the session id to stamp frames with, or null
   * when one is already running.
   */
  startMeeting(): Promise<number | null>
  stopMeeting(): Promise<void>
  getMeetingState(): Promise<MeetingState>
  listMeetings(): Promise<MeetingRecord[]>
  getMeetingSegments(meetingId: number): Promise<MeetingSegment[]>
  /** Full-text across every meeting. Empty query is no results, not an error. */
  searchMeetings(query: string): Promise<MeetingSegment[]>
  /**
   * Remove a meeting, and move its recording to the Recycle Bin so it is not
   * adopted back at the next launch. Returns why it could not, or null.
   */
  deleteMeeting(meetingId: number): Promise<string | null>
  /** What you type during the call, saved as you type it. */
  setMeetingScratch(meetingId: number, markdown: string): Promise<void>
  revealMeeting(dir: string): void
  onMeetingSegments(cb: (segments: MeetingSegment[]) => void): () => void
  /**
   * Write the notes and extract the tasks. Runs after the meeting, so it takes
   * tens of seconds; progress arrives on `onNotesProgress`.
   */
  generateNotes(meetingId: number): Promise<NotesOutcome>
  getMeetingTasks(meetingId: number): Promise<TaskRecord[]>
  setTaskState(taskId: number, state: TaskState): Promise<void>
  getOpenTasks(): Promise<TaskRecord[]>
  onNotesProgress(cb: (p: NotesProgressView) => void): () => void
  /** The app we noticed taking the microphone, or null. */
  getMeetingOffer(): Promise<string | null>
  dismissMeetingOffer(): Promise<void>
  /** Everything about one meeting's run, on the clipboard. */
  copyMeetingDiagnostic(meetingId: number): Promise<boolean>
  onMeetingOffer(cb: (app: string | null) => void): () => void
  /** One meeting, or null if it is gone. */
  getMeeting(meetingId: number): Promise<MeetingRecord | null>
  /** Render the transcript into English alongside what was said. */
  renderEnglish(meetingId: number): Promise<EnglishOutcome>
  setMeetingKind(meetingId: number, kind: string): Promise<void>
  onEnglishProgress(cb: (p: EnglishProgressView) => void): () => void
  /** Fires when a meeting's automatic pipeline has finished with it. */
  onMeetingProcessed(cb: (meetingId: number) => void): () => void
  /**
   * Transcribe this meeting again with the larger model.
   *
   * Takes minutes, stops the language model while it runs, and re-runs the
   * English pass and the summary afterwards.
   */
  repassMeeting(meetingId: number): Promise<RepassOutcome>
  onRepassProgress(cb: (p: RepassProgressView) => void): () => void
  sendMeetingFrame(sessionId: number, channel: MeetingChannel, frame: Float32Array): void
  meetingReady(sessionId: number): void
  meetingFailed(sessionId: number, channel: MeetingChannel, reason: string): void
  meetingClosed(sessionId: number): void
  onMeetingState(cb: (s: MeetingState) => void): () => void
  sendAudioFrame(sessionId: number, frame: Float32Array): void
  captureReady(sessionId: number): void
  captureFailed(sessionId: number, reason: string): void
  cancelDictation(): void
  /** Tapping the pet starts or stops a dictation, exactly like the hotkey. */
  petClick(): void
  petDragStart(): void
  petDragEnd(): void
  onHudHover(cb: (over: boolean) => void): () => void
  onHudDragging(cb: (dragging: boolean) => void): () => void
  onHudPlacement(cb: (p: HudPlacement) => void): () => void
  onStartCapture(cb: (sessionId: number, deviceId: string | null) => void): () => void
  onStopCapture(cb: (sessionId: number) => void): () => void
  onMetric(cb: () => void): () => void
  onDictationResult(cb: (r: DictationOutcome) => void): () => void
  onSidecarState(cb: (s: SidecarView) => void): () => void
  onSettingsChanged(cb: (s: Settings) => void): () => void
  onHudState(cb: (s: HudState) => void): () => void
  onHotkeyFailed(cb: (report: HotkeyReport) => void): () => void
}
