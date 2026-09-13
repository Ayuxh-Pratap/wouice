import type { VocabularyEntry } from '../../shared/ipc.js'
import { BUTTON, Badge, Chip } from './parts.js'
import { seenLabel, type NotWord } from './view.js'

/**
 * Your words as a table, drawn as the Dictations table is: a row is the whole
 * word at a glance - spelling, sound-alikes, meaning, how often it comes up -
 * and clicking it opens the word.
 *
 * IT SCROLLS INSIDE ITSELF, with its column names held at the top: the page
 * stays where it is, so the review card and the tabs never scroll away from
 * the list they belong to.
 */

const SCROLL = 'min-h-0 flex-1 overflow-auto border-t border-white/5'
/** Held at the top while the rows scroll; the card's own colour, and a line under it. */
const TH =
  'sticky top-0 z-[1] bg-[rgb(31_31_31)] py-1.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase shadow-[inset_0_-1px_0_rgb(255_255_255/0.05)]'
const ROW = 'border-t border-white/5 align-top'
const BODY = '[&>tr:first-child]:border-t-0'

export interface EmptyState {
  title: string
  hint?: string
}

function Empty({ state, columns }: { state: EmptyState; columns: number }): React.JSX.Element {
  return (
    <tr>
      <td colSpan={columns} className="px-4 py-8 text-center">
        <p className="text-[13px] text-neutral-400">{state.title}</p>
        {state.hint && <p className="mt-1 text-[12px] text-neutral-600">{state.hint}</p>}
      </td>
    </tr>
  )
}

export function WordTable({
  words,
  empty,
  onOpen,
}: {
  words: VocabularyEntry[]
  empty: EmptyState | null
  onOpen(entry: VocabularyEntry): void
}): React.JSX.Element {
  return (
    <div className={SCROLL}>
      <table className="w-full min-w-[34rem] border-collapse text-left">
        <thead>
          <tr>
            <th className={`${TH} w-[30%] pr-3 pl-4`}>Word</th>
            <th className={`${TH} w-[25%] px-3`}>Heard as</th>
            <th className={`${TH} px-3`}>Means</th>
            <th className={`${TH} w-20 px-3 text-right`}>Seen</th>
            <th className={`${TH} w-8 px-3`} />
          </tr>
        </thead>
        <tbody className={BODY}>
          {empty && <Empty state={empty} columns={5} />}
          {words.map((e) => (
            <tr
              key={e.id}
              tabIndex={0}
              onClick={() => onOpen(e)}
              onKeyDown={(k) => k.key === 'Enter' && onOpen(e)}
              className={`${ROW} cursor-pointer transition outline-none hover:bg-white/5 focus-visible:bg-white/5`}
            >
              <td className="py-2 pr-3 pl-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] text-neutral-200">{e.term}</span>
                  {e.source === 'roster' && <Badge tone="sky">from Meet</Badge>}
                  {e.pinned && <Badge tone="emerald">always sent</Badge>}
                </div>
              </td>
              <td className="px-3 py-2">
                {e.aliases.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {e.aliases.map((a) => (
                      <Chip key={a.text} rewrite={a.rewrite}>
                        {a.text}
                      </Chip>
                    ))}
                  </div>
                ) : (
                  <span className="text-[12px] text-neutral-700">—</span>
                )}
              </td>
              <td className="max-w-0 px-3 py-2">
                <span className={`block truncate text-[12px] ${e.meaning ? 'text-neutral-400' : 'text-neutral-700'}`} title={e.meaning || undefined}>
                  {e.meaning || '—'}
                </span>
              </td>
              <td className="px-3 py-2 text-right font-mono text-[11px] whitespace-nowrap text-neutral-500 tabular-nums">{seenLabel(e)}</td>
              <td className="px-3 py-2 text-[13px] text-neutral-600">›</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** What is out, and why - each with its way back. */
export function NotWordsTable({
  items,
  empty,
  onUndo,
}: {
  items: NotWord[]
  empty: EmptyState | null
  onUndo(item: NotWord): void
}): React.JSX.Element {
  return (
    <div className={SCROLL}>
      <table className="w-full min-w-[28rem] border-collapse text-left">
        <thead>
          <tr>
            <th className={`${TH} w-[30%] pr-3 pl-4`}>Word</th>
            <th className={`${TH} px-3`}>Why</th>
            <th className={`${TH} w-20 px-4`} />
          </tr>
        </thead>
        <tbody className={BODY}>
          {empty && <Empty state={empty} columns={3} />}
          {items.map((n) => (
            <tr key={n.key} className={ROW}>
              <td className="py-2 pr-3 pl-4 text-[13px] text-neutral-300">{n.term}</td>
              <td className="px-3 py-2 text-[12px] text-neutral-500">{n.why}</td>
              <td className="px-4 py-1.5 text-right">
                <button onClick={() => onUndo(n)} className={BUTTON.small}>
                  Undo
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
