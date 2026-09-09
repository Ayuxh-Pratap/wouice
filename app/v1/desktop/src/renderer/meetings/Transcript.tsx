import type { MeetingSegment } from '../../shared/ipc.js'

/**
 * A meeting transcript, read as a conversation.
 *
 * TWO SPEAKERS, NOT A WALL OF TEXT. The whole point of capturing two channels
 * is that who said what is known for free, so the transcript shows it: your
 * lines and theirs are visually distinct, and neither is guessed at.
 *
 * ECHO IS SHOWN, DIMMED, NOT HIDDEN. When you are on speakers, the far side
 * comes back through your microphone and lands on your channel. The segmenter
 * flags those. Hiding them would mean a wrong flag silently deletes something
 * that was actually said - and nobody could ever tell. Dimmed and labelled, a
 * mistake is visible and harmless.
 */

export function Transcript({
  segments,
  emptyMessage = 'Nothing transcribed yet.',
  highlight = '',
}: {
  segments: MeetingSegment[]
  emptyMessage?: string
  highlight?: string
}): React.JSX.Element {
  if (segments.length === 0) {
    return <p className="px-1 py-6 text-center text-[12px] text-neutral-600">{emptyMessage}</p>
  }

  return (
    <ol className="space-y-2">
      {segments.map((segment) => (
        <li key={segment.id} className="flex gap-2.5">
          <span className="w-11 shrink-0 pt-px text-right font-mono text-[10.5px] tabular-nums text-neutral-600">
            {formatStamp(segment.startMs)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span
                className="text-[11px] font-medium"
                style={{ color: segment.channel === 'me' ? '#34d399' : '#60a5fa' }}
              >
                {segment.channel === 'me' ? 'You' : 'Them'}
              </span>
              {segment.echo ? (
                <span
                  className="rounded px-1 py-px text-[9.5px] text-neutral-500 ring-1 ring-white/10"
                  title="This looks like the far side coming back through your microphone."
                >
                  echo
                </span>
              ) : null}
            </div>
            <p
              className={
                'text-[13px] leading-relaxed ' +
                (segment.echo ? 'text-neutral-600' : 'text-neutral-200')
              }
            >
              {highlight ? mark(segment.text, highlight) : segment.text}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

/** `m:ss` from the start of the meeting, or `h:mm:ss` past an hour. */
export function formatStamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
  return `${minutes}:${seconds}`
}

/**
 * Highlight the searched words inside a line.
 *
 * Split rather than `dangerouslySetInnerHTML`: a transcript is text somebody
 * else spoke, and it is never worth turning it into markup.
 */
function mark(text: string, query: string): React.ReactNode {
  const words = query
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return text

  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'ig')
  return text.split(pattern).map((part, i) =>
    pattern.test(part) && i % 2 === 1 ? (
      <mark key={i} className="rounded bg-amber-400/20 text-amber-200">
        {part}
      </mark>
    ) : (
      part
    )
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
