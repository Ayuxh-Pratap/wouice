import type { Language } from '@wouice/asr'
import type { MeetingChannel } from '@wouice/store'

/**
 * Which language to tell the careful pass each chunk is in.
 *
 * WHY NOT THE MEETING'S LANGUAGE. A Hindi + English meeting is recognised as
 * Hindi. The fast live model takes that as a hint: it still wrote "okay, so I
 * am recording this for testing purposes" in English. The large model takes it
 * as an order, and wrote the same sentence as "अगर आपको इसे पर प्रवाप्त करने के
 * लिए दिखाई हैं" - on a real meeting that was mostly English, the "improved"
 * transcript was worse than the first, and its summary found nothing.
 *
 * WHY NOT DETECTION. Asked to detect per chunk, a model thrashes on real
 * conversation: one meeting came back as Icelandic, Japanese and Spanish.
 *
 * WHAT IS USED INSTEAD: WHAT THE FIRST PASS WROTE. Forced to Hindi, the live
 * model still writes Hindi speech in Devanagari and English speech in Latin
 * letters. So the lines it heard in the same stretch, on the same side, say
 * which language that stretch was - measured rather than guessed, and free.
 * Counted in words rather than letters, so "मैं leaderboard check करूँगा" is
 * the Hindi sentence it is and not English because English words are longer.
 */

const DEVANAGARI = /\p{Script=Devanagari}/u
const LATIN = /[A-Za-z]/

/** The language most of these lines' words are written in, or `fallback` when they say nothing. */
export function scriptLanguage(texts: readonly string[], fallback: Language): Language {
  let hindi = 0
  let english = 0
  for (const text of texts) {
    for (const word of text.split(/\s+/)) {
      if (DEVANAGARI.test(word)) hindi++
      else if (LATIN.test(word)) english++
    }
  }
  if (hindi === 0 && english === 0) return fallback
  if (english > hindi) return 'en'
  if (hindi > english) return 'hi'
  return fallback
}

interface Heard {
  channel: MeetingChannel
  startMs: number
  endMs: number
  text: string
}

/** What the first pass heard on one side, overlapping a stretch of the audio. */
export function heardIn(
  lines: readonly Heard[],
  side: MeetingChannel,
  fromMs: number,
  toMs: number
): string[] {
  return lines
    .filter((line) => line.channel === side && line.startMs < toMs && line.endMs > fromMs)
    .map((line) => line.text)
}

/**
 * The language for one chunk of the careful pass.
 *
 * An English meeting stays English. A Hindi or mixed one goes by what the
 * first pass wrote in that stretch. "Let it detect" uses what the live pass
 * pinned - and if that was Hindi, the same per-stretch rule, for the same
 * reason.
 */
export function languageForChunk(
  meetingLanguage: Language,
  heard: readonly string[],
  pinned?: string | null
): Language {
  if (meetingLanguage === 'en') return 'en'
  if (meetingLanguage === 'auto') {
    if (pinned === 'hi') return scriptLanguage(heard, 'hi')
    return pinned === 'en' ? 'en' : 'auto'
  }
  return scriptLanguage(heard, meetingLanguage)
}
