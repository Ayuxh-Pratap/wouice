import type { CalibrationLabel } from '../../shared/ipc.js'

/**
 * The words the calibration flow says, and the judgements behind them.
 *
 * Kept apart from the components because this is the part with opinions in it:
 * what to ask someone to say, and how to turn a measurement into a sentence a
 * person can act on. Both are worth testing and neither needs React.
 *
 * THE RULE FOR EVERYTHING HERE: no numbers reach the user. The separation
 * between someone's voice and their room is a ratio spanning two orders of
 * magnitude, and showing it as "31.4x" tells a person nothing they can do
 * anything about. "Your voice comes through clearly" tells them they are done;
 * "your voice and your room are at a similar level, try a headset" tells them
 * what to change. The arithmetic stays behind a developer-mode disclosure.
 */

export interface Prompt {
  label: CalibrationLabel
  /** Step heading. */
  title: string
  /** One line of direction, in plain language. */
  ask: string
  /** Something to read out, for anyone who freezes when asked to just talk. */
  example: string
  /** Roman transliteration, where the example is not in Latin script. */
  romanised?: string
}

export const PROMPTS: Prompt[] = [
  {
    label: 'english',
    title: 'Say something in English',
    ask: 'Read this out, or say anything you like. Speak the way you normally would.',
    example: 'Please review the latest draft and send me your comments by tomorrow morning.',
  },
  {
    label: 'hindi',
    title: 'Now something in Hindi',
    ask: 'Same again, in Hindi. This is what tells us whether your Hindi is coming through.',
    example: 'मुझे यह काम कल सुबह तक पूरा करना है, इसलिए थोड़ी जल्दी करनी पड़ेगी।',
    romanised: 'Mujhe yeh kaam kal subah tak poora karna hai, isliye thodi jaldi karni padegi.',
  },
  {
    label: 'mixed',
    title: 'Now the way you actually talk',
    ask: 'Mix both, the way it comes out on a normal day. Do not tidy it up.',
    example: 'Main abhi ek meeting mein hoon, can you send me that document in ten minutes?',
  },
]

/** Rotated so finishing three recordings does not feel like the same click thrice. */
export const DONE_WORDS = ['Got it.', 'Perfect.', 'That is the one.']

export interface Verdict {
  /** 1 to 4. Drives a segmented bar, never shown as a number. */
  bars: 1 | 2 | 3 | 4
  /** One or two words. */
  grade: string
  /** What it means, in terms of what the app will now do. */
  headline: string
  /** What to change, when there is something to change. Empty when there is not. */
  advice: string
  ok: boolean
}

/**
 * Turn the measurement into something a person can act on.
 *
 * The bands are wide on purpose. The difference between 18x and 31x separation
 * changes nothing anybody would do differently, so both say "clearly" and the
 * user gets on with their day. The only boundary that carries a real decision is
 * whether the gap is big enough to trust at all.
 */
export function verdictFor(quality: string, separation: number): Verdict {
  if (quality === 'unusable') {
    return {
      bars: 1,
      grade: 'No sound',
      headline: 'Nothing came through on that microphone.',
      advice:
        'Check that the right microphone is selected in Windows sound settings, then try again.',
      ok: false,
    }
  }

  if (quality === 'weak' || separation < 4) {
    return {
      bars: 1,
      grade: 'Too close',
      headline: 'Your voice and the room are at about the same level.',
      advice:
        'A quieter spot or a headset microphone will fix this. Leaving small pauses between phrases helps too.',
      ok: false,
    }
  }

  if (separation >= 15) {
    return {
      bars: 4,
      grade: 'Excellent',
      headline: 'Your voice comes through clearly above the room.',
      advice: '',
      ok: true,
    }
  }

  if (separation >= 8) {
    return {
      bars: 3,
      grade: 'Strong',
      headline: 'Your voice stands out well from the room.',
      advice: '',
      ok: true,
    }
  }

  return {
    bars: 2,
    grade: 'Workable',
    headline: 'Your voice is clear enough to work with, but the room is a little loud.',
    advice: 'This will hold up fine. A headset would make it more reliable in noisier moments.',
    ok: true,
  }
}

/**
 * What the recordings say about language, in plain words.
 *
 * This answers the question that has come up more than any other: "I said
 * something in Hindi, why is the transcript in English?" Whisper commits to ONE
 * language per utterance, so a mixed sentence resolves to whichever dominates
 * and the rest gets written phonetically. Saying so during setup costs one
 * sentence; leaving someone to discover it costs them an afternoon and the
 * belief that the app works.
 */
export function languageNotes(
  transcripts: { label: CalibrationLabel; language: string; text: string }[]
): string[] {
  const notes: string[] = []
  const by = (l: CalibrationLabel): (typeof transcripts)[number] | undefined =>
    transcripts.find((t) => t.label === l)

  const hindi = by('hindi')
  if (hindi && hindi.text) {
    notes.push(
      isHindi(hindi.language)
        ? 'Your Hindi was recognised as Hindi. It gets translated into English on its way to the cursor.'
        : `Your Hindi came through as ${pretty(hindi.language)} rather than Hindi. It still ends up as English text, just by a rougher route.`
    )
  }

  const mixed = by('mixed')
  if (mixed && mixed.text) {
    notes.push(
      'When you mix languages in one sentence, only one of them is recognised properly and the other is written out by sound. Either way the cleanup step turns it into English before it reaches your cursor.'
    )
  }

  return notes
}

function isHindi(language: string): boolean {
  return /^(hi|hin|hindi)$/i.test(language.trim())
}

/** Whisper reports ISO codes; nobody wants to read "mr" in a setup screen. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  ur: 'Urdu',
  mr: 'Marathi',
  ne: 'Nepali',
  pa: 'Punjabi',
  bn: 'Bengali',
  gu: 'Gujarati',
  ta: 'Tamil',
  te: 'Telugu',
  sa: 'Sanskrit',
  auto: 'no clear language',
  unknown: 'nothing recognisable',
}

export function pretty(language: string): string {
  const key = language.trim().toLowerCase()
  return LANGUAGE_NAMES[key] ?? (key ? key[0]!.toUpperCase() + key.slice(1) : 'something unclear')
}

/** "today" / "yesterday" / "3 days ago". Nobody needs a timestamp here. */
export function ago(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? 'a month ago' : `${months} months ago`
}
