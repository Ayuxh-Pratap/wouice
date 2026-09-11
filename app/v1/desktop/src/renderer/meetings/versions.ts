import {
  LIVE_SOURCE,
  MEET_CAPTIONS_SOURCE,
  type MeetingRecord,
  type VersionRecord,
} from '@wouice/store/types'

/**
 * A meeting's versions, as the interface names them.
 *
 * NAMED BY WHERE THE TRANSCRIPT CAME FROM, not numbered: the one written live,
 * the one Meet captioned through the bot, the careful pass. "Version 3" would
 * tell you nothing about why it differs from version 2.
 */

export function versionLabel(source: string): string {
  if (source === LIVE_SOURCE) return 'First pass'
  if (source === MEET_CAPTIONS_SOURCE) return 'Meet captions'
  return 'Improved'
}

export function mainVersion(meeting: Pick<MeetingRecord, 'versions'>): VersionRecord | null {
  return meeting.versions.find((v) => v.main) ?? null
}

/** The main version is the careful pass: the only time the page says "improved". */
export function isImproved(meeting: Pick<MeetingRecord, 'versions'>): boolean {
  const main = mainVersion(meeting)
  return main !== null && main.source !== LIVE_SOURCE && main.source !== MEET_CAPTIONS_SOURCE
}

/**
 * The versions worth offering: any with lines, and the main one always.
 *
 * A meeting the bot kept has an empty first pass - nothing was recorded on this
 * machine - and a switch to a transcript with nothing in it is a switch to
 * nowhere.
 */
export function visibleVersions(meeting: Pick<MeetingRecord, 'versions'>): VersionRecord[] {
  return meeting.versions.filter((v) => v.main || v.segments > 0)
}
