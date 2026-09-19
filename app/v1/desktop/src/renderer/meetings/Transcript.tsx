import { useEffect } from 'react'
import type { MeetingSegment } from '../../shared/ipc.js'
import { needsEnglish } from './english.js'

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
  english = false,
  awaitingEnglish = false,
  focus = null,
}: {
  segments: MeetingSegment[]
  emptyMessage?: string
  highlight?: string
  /** Show the English rendering where there is one. Never instead of it. */
  english?: boolean
  /**
   * The English has not been written yet - the call is still on, or it is
   * being written now - so a line without it is not "not rendered", only early.
   */
  awaitingEnglish?: boolean
  /**
   * A line to bring into view and mark: where a key point of the summary came
   * from. A new object each time, so the same line can be asked for twice.
   */
  focus?: { id: number } | null
}): React.JSX.Element {
  useEffect(() => {
    if (!focus) return
    document.getElementById(`line-${focus.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focus])

  if (segments.length === 0) {
    return <p className="px-1 py-6 text-center text-[12px] text-neutral-600">{emptyMessage}</p>
  }

  return (
    <ol className="space-y-2">
      {segments.map((segment) => (
        <li
          key={segment.id}
          id={`line-${segment.id}`}
          className={
            'flex gap-2.5 rounded-md transition ' +
            (focus?.id === segment.id ? '-mx-1.5 bg-amber-400/[0.07] px-1.5 py-1 ring-1 ring-amber-400/25' : '')
          }
        >
          <span className="w-11 shrink-0 pt-px text-right font-mono text-[10.5px] tabular-nums text-neutral-600">
            {formatStamp(segment.startMs)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span
                className="text-[11px] font-medium"
                style={{ color: segment.channel === 'me' ? '#34d399' : '#60a5fa' }}
              >
                {/* A name when the transcript has one: Meet's captions name
                    everybody, where two channels of audio only know "them". */}
                {segment.channel === 'me' ? 'You' : (segment.speaker ?? 'Them')}
              </span>
              {segment.echo ? (
                <span
                  className="rounded px-1 py-px text-[9.5px] text-neutral-500 ring-1 ring-white/10"
                  title="This looks like the far side coming back through your microphone."
                >
                  echo
                </span>
              ) : null}
              {segment.dropped ? (
                <span
                  className="rounded px-1 py-px text-[9.5px] text-neutral-500 ring-1 ring-white/10"
                  title="Meet's captions showed this, then replaced it with other words. It is not in Meet's own captions."
                >
                  dropped by Meet
                </span>
              ) : null}
            </div>
            <p
              className={
                'text-[13px] leading-relaxed ' +
                (segment.echo ? 'text-neutral-600' : segment.dropped ? 'text-neutral-500' : 'text-neutral-200')
              }
              // The line as spoken, always reachable. The rendering is a
              // model's account of it, and if the two disagree that is the
              // interesting part.
              title={english && segment.textEn ? segment.text : undefined}
            >
              {(() => {
                const shown = english && segment.textEn ? segment.textEn : segment.text
                return highlight ? mark(shown, highlight) : shown
              })()}
            </p>
            {/* Only a Hindi line lacks English; one spoken in English is its own. */}
            {english && !awaitingEnglish && needsEnglish(segment) ? (
              <span className="text-[10px] text-neutral-600">not rendered</span>
            ) : null}
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
