import { describe, expect, it } from 'vitest'
import {
  appFromKey,
  dismiss,
  initialDetectState,
  isMeetingApp,
  meetingAppsInUse,
  parseConsentStore,
  step,
  DEFAULT_DETECT,
} from './detect.js'

/**
 * Meeting detection: reading the registry, and deciding whether to say anything.
 *
 * The failure that matters is a false positive. An app that offers to record a
 * meeting when there is no meeting trains you to dismiss the prompt, and a
 * prompt you always dismiss is the same as one that was never built.
 */

const BASE = 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'

function entry(key: string, start: string | null, stop: string | null): string {
  const lines = [`${BASE}\\${key}`]
  if (start) lines.push(`    LastUsedTimeStart    REG_QWORD    ${start}`)
  lines.push('    LastUserAnnotatedLabel    REG_DWORD    0x2')
  if (stop) lines.push(`    LastUsedTimeStop    REG_QWORD    ${stop}`)
  return lines.join('\r\n')
}

const IN_USE = '0x0'
const FINISHED = '0x1dd3de2a3acf188'
const STARTED = '0x1dd3de29f5ab3f6'

describe('reading the registry', () => {
  it('sees an app that has the microphone right now', () => {
    // LastUsedTimeStop of zero is the signal, and it is the same one the
    // privacy indicator in the tray uses.
    const users = parseConsentStore(
      entry('NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe', STARTED, IN_USE)
    )
    expect(users).toEqual([
      { key: `${BASE}\\NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe`, app: 'Zoom.exe', inUse: true },
    ])
  })

  it('sees an app that has finished with it', () => {
    const [user] = parseConsentStore(
      entry('NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe', STARTED, FINISHED)
    )
    expect(user!.inUse).toBe(false)
  })

  it('ignores an app that has never used it', () => {
    // Consent recorded, microphone never opened.
    expect(parseConsentStore(entry('Microsoft.WindowsCamera_8wekyb3d8bbwe', null, null))).toEqual([])
  })

  it('reads a packaged app by its family name', () => {
    const [user] = parseConsentStore(entry('MSTeams_8wekyb3d8bbwe', STARTED, IN_USE))
    expect(user!.app).toBe('MSTeams_8wekyb3d8bbwe')
  })

  it('survives lines it was not written against', () => {
    // Somebody's real registry will contain things this has never seen.
    const raw = [
      `${BASE}`,
      '    Value    REG_SZ    Allow',
      '    LastSetTime    REG_QWORD    0x1dcef3cb617bfe4',
      '',
      entry('NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe', STARTED, IN_USE),
      'total nonsense that is not a registry line at all',
    ].join('\r\n')
    expect(meetingAppsInUse(raw)).toEqual(['Zoom.exe'])
  })

  it('handles an empty read', () => {
    expect(parseConsentStore('')).toEqual([])
    expect(meetingAppsInUse('')).toEqual([])
  })
})

describe('which apps count', () => {
  it('takes the exe name out of a NonPackaged key', () => {
    expect(appFromKey(`${BASE}\\NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe`)).toBe('Zoom.exe')
  })

  it('counts the obvious meeting applications', () => {
    for (const app of ['Zoom.exe', 'ms-teams.exe', 'slack.exe', 'Webex.exe']) {
      expect(isMeetingApp(app)).toBe(true)
    }
  })

  it('counts browsers, because Google Meet is a tab', () => {
    expect(isMeetingApp('chrome.exe')).toBe(true)
    expect(isMeetingApp('msedge.exe')).toBe(true)
  })

  it('never counts us', () => {
    // Every dictation opens the microphone. An app that offered to record a
    // meeting each time you dictated would be unusable within a day.
    expect(isMeetingApp('electron.exe')).toBe(false)
    expect(isMeetingApp('wouice.exe')).toBe(false)
  })

  it('does not count games or the shell', () => {
    for (const app of ['VALORANT-Win64-Shipping.exe', 'RocketLeague.exe', 'SearchHost.exe']) {
      expect(isMeetingApp(app)).toBe(false)
    }
  })

  it('reports each app once even with several registry entries', () => {
    // Versioned install directories leave one key per version.
    const raw = [
      entry('NonPackaged\\C:#a#chrome.exe', STARTED, IN_USE),
      entry('NonPackaged\\C:#b#chrome.exe', STARTED, IN_USE),
    ].join('\r\n')
    expect(meetingAppsInUse(raw)).toEqual(['chrome.exe'])
  })
})

describe('deciding whether to say anything', () => {
  const config = DEFAULT_DETECT

  it('waits out the debounce before offering', () => {
    // Applications touch the microphone briefly for all sorts of reasons: a
    // device test, a permission prompt nothing came of.
    let state = initialDetectState()
    let result = step(state, { now: 1_000, apps: ['Zoom.exe'], recording: false }, config)
    expect(result.offer).toBeNull()

    result = step(result.state, { now: 3_000, apps: ['Zoom.exe'], recording: false }, config)
    expect(result.offer).toBeNull()

    result = step(result.state, { now: 6_000, apps: ['Zoom.exe'], recording: false }, config)
    expect(result.offer).toBe('Zoom.exe')
  })

  it('forgets an app that let go before the debounce elapsed', () => {
    let result = step(initialDetectState(), { now: 1_000, apps: ['Zoom.exe'], recording: false }, config)
    result = step(result.state, { now: 2_000, apps: [], recording: false }, config)
    result = step(result.state, { now: 6_000, apps: ['Zoom.exe'], recording: false }, config)
    // The clock restarted when it came back, so this is too early.
    expect(result.offer).toBeNull()
  })

  it('asks once, not every few seconds', () => {
    let result = step(initialDetectState(), { now: 0, apps: ['Zoom.exe'], recording: false }, config)
    result = step(result.state, { now: 5_000, apps: ['Zoom.exe'], recording: false }, config)
    expect(result.offer).toBe('Zoom.exe')

    result = step(result.state, { now: 20_000, apps: ['Zoom.exe'], recording: false }, config)
    expect(result.offer).toBeNull()
  })

  it('says nothing at all while already recording', () => {
    const result = step(
      initialDetectState(),
      { now: 10_000, apps: ['Zoom.exe'], recording: true },
      config
    )
    expect(result.offer).toBeNull()
    expect(result.state.candidate).toBeNull()
  })

  it('leaves you alone for a while after a recording ends', () => {
    // A short microphone dropout mid-call must not read as a second meeting.
    let result = step(initialDetectState(), { now: 0, apps: ['Zoom.exe'], recording: true }, config)
    result = step(result.state, { now: 10_000, apps: ['Zoom.exe'], recording: false }, config)
    expect(result.offer).toBeNull()

    // Past the session gap, and the call is still going: now it is fair.
    result = step(
      result.state,
      { now: 10_000 + config.sessionGapMs + 5_000, apps: ['Zoom.exe'], recording: false },
      config
    )
    expect(result.offer).toBe('Zoom.exe')
  })

  it('stays quiet after you say no', () => {
    let result = step(initialDetectState(), { now: 0, apps: ['Zoom.exe'], recording: false }, config)
    result = step(result.state, { now: 5_000, apps: ['Zoom.exe'], recording: false }, config)
    expect(result.offer).toBe('Zoom.exe')

    const quiet = dismiss(result.state, 6_000, config)
    const after = step(quiet, { now: 60_000, apps: ['Zoom.exe'], recording: false }, config)
    expect(after.offer).toBeNull()
  })

  it('keeps watching through the quiet period', () => {
    // If the call is still going when the cooldown expires, it is still a call:
    // clearing the candidate would restart the debounce for nothing.
    let result = step(initialDetectState(), { now: 0, apps: ['Zoom.exe'], recording: false }, config)
    result = step(result.state, { now: 5_000, apps: ['Zoom.exe'], recording: false }, config)
    const quiet = dismiss(result.state, 5_000, config)
    const during = step(quiet, { now: 60_000, apps: ['Zoom.exe'], recording: false }, config)
    expect(during.state.candidate?.app).toBe('Zoom.exe')
  })

  it('says nothing when nothing is using the microphone', () => {
    const result = step(initialDetectState(), { now: 0, apps: [], recording: false }, config)
    expect(result.offer).toBeNull()
  })
})
