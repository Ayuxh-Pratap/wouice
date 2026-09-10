import type { MeetingSegment } from '../../shared/ipc.js'

/**
 * Whether a line still needs an English rendering.
 *
 * A line spoken in English and recognised in English already is its English.
 * Counting it as missing put "The English is being written" above a transcript
 * that was plainly already in English, and tagged its lines "not rendered".
 * Only a line with Hindi script in it and no rendering yet is missing one. Echo
 * lines are never rendered, so they are never missing it.
 */

const DEVANAGARI = /\p{Script=Devanagari}/u

export function needsEnglish(line: Pick<MeetingSegment, 'text' | 'textEn' | 'echo'>): boolean {
  if (line.echo || line.textEn) return false
  return DEVANAGARI.test(line.text)
}
