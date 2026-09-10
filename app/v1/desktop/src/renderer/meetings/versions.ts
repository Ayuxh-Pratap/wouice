import { LIVE_SOURCE, type MeetingRecord, type VersionRecord } from '@wouice/store/types'

/**
 * A meeting's versions, as the interface names them.
 *
 * NAMED BY WHERE THE TRANSCRIPT CAME FROM, not numbered. Today there are two -
 * the one written live and the careful pass - but the next sources are already
 * in view (the meeting's own captions, a Hindi-first model), and "version 3"
 * would tell you nothing about why it differs from version 2.
 */

export function versionLabel(source: string): string {
  return source === LIVE_SOURCE ? 'First pass' : 'Improved'
}

export function mainVersion(meeting: Pick<MeetingRecord, 'versions'>): VersionRecord | null {
  return meeting.versions.find((v) => v.main) ?? null
}

/** The main version is the careful pass: the only time the page says "improved". */
export function isImproved(meeting: Pick<MeetingRecord, 'versions'>): boolean {
  const main = mainVersion(meeting)
  return main !== null && main.source !== LIVE_SOURCE
}
