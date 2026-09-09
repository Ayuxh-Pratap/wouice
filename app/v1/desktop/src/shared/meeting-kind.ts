import type { Language } from '@wouice/asr'

/**
 * What kind of meeting this is, which decides how it gets transcribed.
 *
 * NOT A LANGUAGE DROPDOWN. "hi" and "en" are what the model wants; they are not
 * what you know when you are about to join a call. What you know is whether it
 * is a client call in English, the team standup in Hindi, or the usual mix -
 * and each of those implies a different recognition language AND a different
 * answer to "should this be rendered into English afterwards".
 *
 * WHY THE LANGUAGE MATTERS SO MUCH. Detection runs per 25-second request and
 * thrashes on real conversation: one recorded meeting came back as Icelandic,
 * Japanese, Spanish and English in turn. The same 25 seconds that produced
 * "What are the things that are going on?" under detection produced the
 * sentence that was actually spoken under Hindi. Naming it is worth more than
 * any other single setting here.
 */
export type MeetingKind = 'english' | 'hindi' | 'mixed' | 'detect'

export interface KindDefinition {
  id: MeetingKind
  label: string
  /** What to force the recogniser to. */
  language: Language
  /**
   * Whether to render an English version alongside the raw transcript.
   *
   * False for an English meeting because there is nothing to render: the raw
   * transcript already is the English one, and a second pass over it would only
   * add a chance to change what somebody said.
   */
  translate: boolean
  hint: string
}

export const MEETING_KINDS: KindDefinition[] = [
  {
    id: 'english',
    label: 'English',
    language: 'en',
    translate: false,
    hint: 'Client calls and anything in English only. Nothing is rendered afterwards — the transcript already is the English one.',
  },
  {
    id: 'hindi',
    label: 'Hindi',
    language: 'hi',
    translate: true,
    hint: 'Team meetings in Hindi. Stored as spoken, with an English rendering on top.',
  },
  {
    id: 'mixed',
    label: 'Hindi + English',
    language: 'hi',
    translate: true,
    hint: 'The usual mix. Recognised as Hindi, which also picks up the English words in it — forcing English loses the Hindi entirely.',
  },
  {
    id: 'detect',
    label: 'Let it detect',
    language: 'auto',
    translate: true,
    hint: 'For a language not listed. Detects once on the first chunk and keeps that for the whole meeting rather than guessing again every 25 seconds.',
  },
]

export const DEFAULT_MEETING_KIND: MeetingKind = 'mixed'

export function kindOf(id: string | null | undefined): KindDefinition {
  return MEETING_KINDS.find((k) => k.id === id) ?? MEETING_KINDS.find((k) => k.id === DEFAULT_MEETING_KIND)!
}
