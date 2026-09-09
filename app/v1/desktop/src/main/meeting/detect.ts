/**
 * Noticing that a meeting has started, without asking Windows for permission
 * to watch anything.
 *
 * HOW IT KNOWS. Windows records which applications are using the microphone in
 * the CapabilityAccessManager ConsentStore, one registry key per app, with
 * `LastUsedTimeStart` and `LastUsedTimeStop`. **`LastUsedTimeStop` of zero
 * means the app has the microphone right now.** That is the same signal the
 * privacy indicator in the system tray uses, it needs no elevation, no driver
 * and no hook, and it costs one registry read every few seconds.
 *
 * IT OFFERS; IT DOES NOT RECORD. Starting a recording on its own judgement is
 * the kind of thing that has to be right every single time, on a machine that
 * records calls. Being wrong in the offering direction costs a dismissed
 * prompt. Being wrong the other way records a conversation nobody agreed to.
 *
 * PURE. Parsing, matching and the timing rules are all here with no registry
 * and no clock, because these are the numbers that get tuned by use and every
 * one of them should be arguable in a test. `mic-watcher.ts` does the reading.
 */

export interface MicUser {
  /** The registry key leaf: an exe path for classic apps, a package family. */
  key: string
  /** Something a person would recognise: `Zoom.exe`, `MSTeams`. */
  app: string
  inUse: boolean
}

/**
 * Applications whose microphone use means "a meeting is happening".
 *
 * Matched on the executable name, or the start of a package family name. Kept
 * deliberately short: a false positive trains you to dismiss the prompt, which
 * is the same as not having built it.
 */
const MEETING_APPS = [
  'zoom.exe',
  'teams.exe',
  'ms-teams.exe',
  'msteams.exe',
  'slack.exe',
  'discord.exe',
  'webex.exe',
  'webexhost.exe',
  'ciscocollabhost.exe',
  'skype.exe',
  'gotomeeting.exe',
  'bluejeans.exe',
  // Browsers, because Google Meet is a tab. This is the noisiest entry by far
  // and also the one most likely to be right for this user.
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
  'brave.exe',
  'arc.exe',
  'zen.exe',
  'opera.exe',
  'vivaldi.exe',
]

const MEETING_PACKAGES = ['msteams_', 'microsoft.teams', 'zoom', 'slack', 'discord']

/**
 * Applications whose microphone use is NOT a meeting.
 *
 * Ourselves first and most importantly: every dictation opens the microphone,
 * and an app that offered to record a meeting every time you dictated would be
 * unusable within a day. Dictation tools generally, and voice assistants, for
 * the same reason.
 */
const NOT_MEETINGS = [
  'electron.exe',
  'wouice.exe',
  'claude.exe',
  'fluidvoice.exe',
  'wisprflow.exe',
  'superwhisper.exe',
  'voiceaccess.exe',
  'searchapp.exe',
  'searchhost.exe',
  'shellexperiencehost.exe',
  'valorant-win64-shipping.exe',
  'rocketleague.exe',
  'msedgewebview2.exe',
]

/** The app name a ConsentStore key refers to. */
export function appFromKey(key: string): string {
  const leaf = key.split('\\').pop() ?? key
  // NonPackaged keys are the full exe path with '#' where a backslash was.
  if (leaf.includes('#')) return leaf.split('#').pop() ?? leaf
  return leaf
}

export function isMeetingApp(app: string): boolean {
  const name = app.toLowerCase()
  if (NOT_MEETINGS.includes(name)) return false
  if (MEETING_APPS.includes(name)) return true
  return MEETING_PACKAGES.some((prefix) => name.startsWith(prefix))
}

/**
 * Read `reg query ... /s` output into one entry per application.
 *
 * Tolerant by construction: an unrecognised line is skipped rather than
 * treated as a parse failure, because this is somebody's registry and it will
 * contain things this was not written against.
 */
export function parseConsentStore(output: string): MicUser[] {
  const users: MicUser[] = []
  let key: string | null = null
  let start: bigint | null = null
  let stop: bigint | null = null

  const flush = (): void => {
    if (key && start !== null) {
      users.push({ key, app: appFromKey(key), inUse: stop === null || stop === 0n })
    }
    start = null
    stop = null
  }

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^HKEY_/i.test(line.trim())) {
      flush()
      key = line.trim()
      continue
    }
    const value = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line)
    if (!value) continue
    let parsed: bigint
    try {
      parsed = BigInt(value[2]!)
    } catch {
      continue
    }
    if (/start/i.test(value[1]!)) start = parsed
    else stop = parsed
  }
  flush()

  return users
}

/** Meeting applications holding the microphone right now. */
export function meetingAppsInUse(output: string): string[] {
  const found = parseConsentStore(output)
    .filter((user) => user.inUse && isMeetingApp(user.app))
    .map((user) => user.app)
  return [...new Set(found)]
}

/* ------------------------------------------------------------ timing ---- */

export interface DetectConfig {
  /** How long an app must hold the microphone before we say anything. */
  debounceMs: number
  /** Silence after an offer or a dismissal, so it asks once, not repeatedly. */
  cooldownMs: number
  /** Quiet period after a recording ends, so a short gap is not two meetings. */
  sessionGapMs: number
}

export const DEFAULT_DETECT: DetectConfig = {
  debounceMs: 4_000,
  cooldownMs: 5 * 60_000,
  sessionGapMs: 2 * 60_000,
}

export interface DetectState {
  /** The app currently holding the microphone, and since when. */
  candidate: { app: string; since: number } | null
  /** Nothing is offered before this. */
  quietUntil: number
  /** When a recording last stopped. */
  lastRecordingEndedAt: number
}

export function initialDetectState(): DetectState {
  return { candidate: null, quietUntil: 0, lastRecordingEndedAt: 0 }
}

export interface DetectInput {
  now: number
  /** Meeting applications currently holding the microphone. */
  apps: readonly string[]
  /** True while we are already recording. */
  recording: boolean
}

export interface DetectStep {
  state: DetectState
  /** The app to offer to record, or null for "say nothing". */
  offer: string | null
}

/**
 * Whether to offer, given what the registry says.
 *
 * The debounce is the important one. Applications touch the microphone briefly
 * for all sorts of reasons - a device test, a notification sound check, a tab
 * that asked for permission and did nothing with it - and four seconds of
 * continuous use separates those from a call without making the offer feel slow.
 */
export function step(
  state: DetectState,
  input: DetectInput,
  config: DetectConfig = DEFAULT_DETECT
): DetectStep {
  const { now, apps, recording } = input

  if (recording) {
    // Already recording. Keep the end time current so the session gap starts
    // from when it actually stopped.
    return {
      state: { ...state, candidate: null, lastRecordingEndedAt: now },
      offer: null,
    }
  }

  const app = apps[0]
  if (!app) return { state: { ...state, candidate: null }, offer: null }

  const candidate =
    state.candidate?.app === app ? state.candidate : { app, since: now }

  // Held off for one of three reasons, and none of them clears the candidate:
  // if the call is still going when the quiet period ends, it is still a call.
  if (now < state.quietUntil) return { state: { ...state, candidate }, offer: null }
  if (now - state.lastRecordingEndedAt < config.sessionGapMs && state.lastRecordingEndedAt > 0) {
    return { state: { ...state, candidate }, offer: null }
  }
  if (now - candidate.since < config.debounceMs) return { state: { ...state, candidate }, offer: null }

  return {
    state: { ...state, candidate, quietUntil: now + config.cooldownMs },
    offer: app,
  }
}

/** You said no. Do not ask again for a while. */
export function dismiss(
  state: DetectState,
  now: number,
  config: DetectConfig = DEFAULT_DETECT
): DetectState {
  return { ...state, quietUntil: now + config.cooldownMs }
}
