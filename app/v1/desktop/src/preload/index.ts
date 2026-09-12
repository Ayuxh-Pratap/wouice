import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type Diagnostics,
  type DictationOutcome,
  type EngineView,
  type HotkeyReport,
  type HudState,
  type MeetingChannel,
  type MeetingSegment,
  type EnglishProgressView,
  type RepassProgressView,
  type NotesProgressView,
  type BotRunView,
  type BotStatusView,
  type MeetingJobsView,
  type MeetingState,
  type MetricsSnapshot,
  type SidecarView,
  type WouiceApi,
} from '../shared/ipc.js'
import type { Settings } from '../shared/settings.js'
import type { SidecarId } from '../shared/models.js'
import type { TaskState } from '@wouice/store'

/**
 * The only bridge between renderer and main.
 *
 * Context isolation is on and nodeIntegration off, so the renderer gets exactly
 * these functions and nothing else. Every subscription returns its own
 * unsubscribe, because a React effect that cannot clean up leaks a listener per
 * remount and those are invisible until the app is slow.
 */
function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: unknown, value: T) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: WouiceApi = {
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.setSettings, patch),
  getSidecars: () => ipcRenderer.invoke(IPC.getSidecars),
  switchModel: (id: SidecarId, modelId: string) => ipcRenderer.invoke(IPC.switchModel, id, modelId),
  restartSidecar: (id: SidecarId) => ipcRenderer.invoke(IPC.restartSidecar, id),
  getDiagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke(IPC.getDiagnostics),
  hideHud: () => ipcRenderer.send(IPC.hideHud),
  getMetrics: (): Promise<MetricsSnapshot> => ipcRenderer.invoke(IPC.getMetrics),
  getDictationPage: (offset, limit, query) =>
    ipcRenderer.invoke(IPC.getDictationPage, offset, limit, query),
  deleteDictations: (ats: number[]) => ipcRenderer.invoke(IPC.deleteDictations, ats),
  clearDictations: () => ipcRenderer.invoke(IPC.clearDictations),
  getRatingSheet: () => ipcRenderer.invoke(IPC.getRatingSheet),
  rateDictation: (at: number, ship: boolean, note?: string) =>
    ipcRenderer.invoke(IPC.rateDictation, at, ship, note ?? ''),
  clearRating: (at: number) => ipcRenderer.invoke(IPC.clearRating, at),
  getStorage: () => ipcRenderer.invoke(IPC.getStorage),
  getVocabulary: () => ipcRenderer.invoke(IPC.getVocabulary),
  saveVocabulary: (draft) => ipcRenderer.invoke(IPC.saveVocabulary, draft),
  removeVocabulary: (id) => ipcRenderer.invoke(IPC.removeVocabulary, id),
  importVocabulary: (text) => ipcRenderer.invoke(IPC.importVocabulary, text),
  getVocabularySuggestions: () => ipcRenderer.invoke(IPC.getVocabularySuggestions),
  acceptSuggestion: (id, draft) => ipcRenderer.invoke(IPC.acceptSuggestion, id, draft),
  rejectSuggestion: (id) => ipcRenderer.invoke(IPC.rejectSuggestion, id),
  reviveSuggestion: (id) => ipcRenderer.invoke(IPC.reviveSuggestion, id),
  onVocabulary: (cb) => subscribe<null>(IPC.vocabularyChanged, () => cb()),
  getRecordings: () => ipcRenderer.invoke(IPC.getRecordings),
  deleteRecording: (file) => ipcRenderer.invoke(IPC.deleteRecording, file),
  clearRecordings: () => ipcRenderer.invoke(IPC.clearRecordings),
  copyDiagnostic: (at: number): Promise<boolean> => ipcRenderer.invoke(IPC.copyDiagnostic, at),
  exportDiagnostics: (withAudio: boolean): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportDiagnostics, withAudio),
  revealMetrics: () => ipcRenderer.send(IPC.revealMetrics),
  calibrate: (samples, device) => ipcRenderer.invoke(IPC.calibrate, samples, device),
  calibrateApply: (report) => ipcRenderer.invoke(IPC.calibrateApply, report),
  // Float32Array crosses the bridge as a structured clone. At 16 kHz that is
  // ~64 KB/s, which is nothing, and it keeps ALL decision logic in main where
  // the state machine lives rather than splitting it across the bridge.
  startMeeting: () => ipcRenderer.invoke(IPC.startMeeting),
  stopMeeting: () => ipcRenderer.invoke(IPC.stopMeeting),
  getMeetingState: () => ipcRenderer.invoke(IPC.getMeetingState),
  listMeetings: () => ipcRenderer.invoke(IPC.listMeetings),
  getMeetingSegments: (meetingId: number, versionId?: number) =>
    ipcRenderer.invoke(IPC.getMeetingSegments, meetingId, versionId),
  searchMeetings: (query: string) => ipcRenderer.invoke(IPC.searchMeetings, query),
  deleteMeeting: (meetingId: number) => ipcRenderer.invoke(IPC.deleteMeeting, meetingId),
  setMeetingScratch: (meetingId: number, markdown: string) =>
    ipcRenderer.invoke(IPC.setMeetingScratch, meetingId, markdown),
  onMeetingSegments: (cb) => subscribe<MeetingSegment[]>(IPC.meetingSegments, cb),
  generateNotes: (meetingId: number) => ipcRenderer.invoke(IPC.generateNotes, meetingId),
  processMeeting: (meetingId: number) => ipcRenderer.invoke(IPC.processMeeting, meetingId),
  getMeetingTasks: (meetingId: number, versionId?: number) =>
    ipcRenderer.invoke(IPC.getMeetingTasks, meetingId, versionId),
  getMeetingJobs: () => ipcRenderer.invoke(IPC.getMeetingJobs),
  getBotStatus: () => ipcRenderer.invoke(IPC.getBotStatus),
  checkBot: () => ipcRenderer.invoke(IPC.checkBot),
  openBotSignIn: () => ipcRenderer.invoke(IPC.openBotSignIn),
  onBotStatus: (cb) => subscribe<BotStatusView>(IPC.botStatus, cb),
  sendBot: (url: string) => ipcRenderer.invoke(IPC.sendBot, url),
  leaveBot: () => ipcRenderer.invoke(IPC.leaveBot),
  getBotRun: () => ipcRenderer.invoke(IPC.getBotRun),
  onBotRun: (cb) => subscribe<BotRunView>(IPC.botRun, cb),
  revealBotRun: () => ipcRenderer.send(IPC.revealBotRun),
  setMainVersion: (meetingId: number, versionId: number) =>
    ipcRenderer.invoke(IPC.setMainVersion, meetingId, versionId),
  onMeetingJobs: (cb) => subscribe<MeetingJobsView>(IPC.meetingJobs, cb),
  getEngine: () => ipcRenderer.invoke(IPC.getEngine),
  onEngine: (cb) => subscribe<EngineView>(IPC.engineState, cb),
  resumeDictation: () => ipcRenderer.invoke(IPC.resumeDictation),
  restartModels: () => ipcRenderer.invoke(IPC.restartModels),
  onMeetingUpdated: (cb) => subscribe<number>(IPC.meetingUpdated, cb),
  setTaskState: (taskId: number, state: TaskState) =>
    ipcRenderer.invoke(IPC.setTaskState, taskId, state),
  getOpenTasks: () => ipcRenderer.invoke(IPC.getOpenTasks),
  onNotesProgress: (cb) => subscribe<NotesProgressView>(IPC.notesProgress, cb),
  getMeetingOffer: () => ipcRenderer.invoke(IPC.getMeetingOffer),
  dismissMeetingOffer: () => ipcRenderer.invoke(IPC.dismissMeetingOffer),
  copyMeetingDiagnostic: (meetingId: number) =>
    ipcRenderer.invoke(IPC.copyMeetingDiagnostic, meetingId),
  onMeetingOffer: (cb) => subscribe<string | null>(IPC.meetingOffer, cb),
  getMeeting: (meetingId: number) => ipcRenderer.invoke(IPC.getMeeting, meetingId),
  renderEnglish: (meetingId: number) => ipcRenderer.invoke(IPC.renderEnglish, meetingId),
  setMeetingKind: (meetingId: number, kind: string) =>
    ipcRenderer.invoke(IPC.setMeetingKind, meetingId, kind),
  onEnglishProgress: (cb) => subscribe<EnglishProgressView>(IPC.englishProgress, cb),
  onMeetingProcessed: (cb) => subscribe<number>(IPC.meetingReady2, cb),
  repassMeeting: (meetingId: number) => ipcRenderer.invoke(IPC.repassMeeting, meetingId),
  onRepassProgress: (cb) => subscribe<RepassProgressView>(IPC.repassProgress, cb),
  revealMeeting: (dir: string) => ipcRenderer.send(IPC.revealMeeting, dir),
  sendMeetingFrame: (sessionId: number, channel: MeetingChannel, frame: Float32Array) =>
    ipcRenderer.send(IPC.meetingFrame, sessionId, channel, frame),
  meetingReady: (sessionId: number) => ipcRenderer.send(IPC.meetingReady, sessionId),
  meetingFailed: (sessionId: number, channel: MeetingChannel, reason: string) =>
    ipcRenderer.send(IPC.meetingFailed, sessionId, channel, reason),
  meetingClosed: (sessionId: number) => ipcRenderer.send(IPC.meetingClosed, sessionId),
  onMeetingState: (cb) => subscribe<MeetingState>(IPC.meetingState, cb),
  sendAudioFrame: (sessionId: number, frame: Float32Array) =>
    ipcRenderer.send(IPC.audioFrame, sessionId, frame),
  captureReady: (sessionId: number) => ipcRenderer.send(IPC.captureReady, sessionId),
  captureFailed: (sessionId: number, reason: string) =>
    ipcRenderer.send(IPC.captureFailed, sessionId, reason),
  cancelDictation: () => ipcRenderer.send(IPC.cancelDictation),
  petClick: () => ipcRenderer.send(IPC.petClick),
  petDragStart: () => ipcRenderer.send(IPC.petDragStart),
  petDragEnd: () => ipcRenderer.send(IPC.petDragEnd),
  onHudHover: (cb) => subscribe(IPC.hudHover, cb),
  onHudDragging: (cb) => subscribe(IPC.hudDragging, cb),
  onHudPlacement: (cb) => subscribe(IPC.hudPlacement, cb),
  onStartCapture: (cb) => {
    // Two arguments, so this cannot use `subscribe`: the microphone travels
    // with the message rather than being fetched separately, which is what
    // guarantees the device in force is the one settings named.
    const handler = (_e: unknown, sessionId: number, deviceId: string | null): void =>
      cb(sessionId, deviceId)
    ipcRenderer.on(IPC.startCapture, handler)
    return () => ipcRenderer.removeListener(IPC.startCapture, handler)
  },
  onStopCapture: (cb) => subscribe<number>(IPC.stopCapture, cb),
  onMetric: (cb) => subscribe<void>(IPC.metric, cb),
  onDictationResult: (cb) => subscribe<DictationOutcome>(IPC.dictationResult, cb),
  onSidecarState: (cb) => subscribe<SidecarView>(IPC.sidecarState, cb),
  onSettingsChanged: (cb) => subscribe<Settings>(IPC.settingsChanged, cb),
  onHudState: (cb) => subscribe<HudState>(IPC.hudState, cb),
  onHotkeyFailed: (cb) => subscribe<HotkeyReport>(IPC.hotkeyFailed, cb),
}

contextBridge.exposeInMainWorld('wouice', api)
