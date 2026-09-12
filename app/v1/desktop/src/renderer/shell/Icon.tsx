import type { IconName } from './routes.js'

/**
 * The handful of icons the shell needs, drawn inline.
 *
 * No icon library. A handful of shapes do not justify a dependency, and the charts in
 * this app are hand-rolled SVG for the same reason - one line weight, one
 * stroke style, nothing to keep in step with a package's idea of a grid.
 *
 * All of them are 24x24 with a 1.6 stroke and `currentColor`, so they inherit
 * whatever the surrounding text is doing, including the dimmed state.
 */

type ExtraIcon = 'chevronLeft' | 'chevronRight' | 'search' | 'mic' | 'speaker'

const PATHS: Record<IconName | ExtraIcon, React.ReactNode> = {
  // A speedometer: numbers about speed and load.
  gauge: (
    <>
      <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
      <path d="m13.4 10.6 3.6-3.6" />
      <path d="M4 18a9 9 0 1 1 16 0" />
    </>
  ),
  // Lines of text on a page: the transcripts.
  transcript: (
    <>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M8 10h8M8 14h8M8 18h5" />
    </>
  ),
  // Two people: a conversation with someone else in it.
  meeting: (
    <>
      <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 6a3 3 0 0 1 0 6" />
      <path d="M18 14a5 5 0 0 1 3 5" />
    </>
  ),
  // A speech bubble with a spark: something that answers back.
  companion: (
    <>
      <path d="M20 14a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />
      <path d="M12 8v4M10 10h4" />
    </>
  ),
  // An open book: the words this app should know.
  vocabulary: (
    <>
      <path d="M12 6.5C10.4 5.1 7.9 4.5 4 4.5v13c3.9 0 6.4.6 8 2 1.6-1.4 4.1-2 8-2v-13c-3.9 0-6.4.6-8 2Z" />
      <path d="M12 6.5v13" />
    </>
  ),
  // A tick inside a circle: a judgement recorded.
  quality: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  settings: (
    <>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </>
  ),
  // Double chevrons: the collapse control, pointing the way the rail will move.
  chevronLeft: (
    <>
      <path d="m11 7-5 5 5 5" />
      <path d="m18 7-5 5 5 5" />
    </>
  ),
  chevronRight: (
    <>
      <path d="m13 7 5 5-5 5" />
      <path d="m6 7 5 5-5 5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  // A microphone: the channel that is your own voice, off your own input.
  mic: (
    <>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
    </>
  ),
  // A speaker: the channel that is everyone else, off the system's output.
  speaker: (
    <>
      <path d="M11 4.5 6.5 8.5H3.5v7h3l4.5 4z" />
      <path d="M15.5 9a4 4 0 0 1 0 6" />
      <path d="M18.5 6a8 8 0 0 1 0 12" />
    </>
  ),
}

export function Icon({
  name,
  className = 'size-[18px]',
}: {
  name: IconName | ExtraIcon
  className?: string
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  )
}
