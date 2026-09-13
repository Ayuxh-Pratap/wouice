import { useEffect, useRef, useState } from 'react'
import type { VocabularyAlias, VocabularyDraft, VocabularyEntry } from '../../shared/ipc.js'
import { Choice, ConfirmButton, Toggle } from '../settings/Field.js'
import { BUTTON, FIELD, Label } from './parts.js'
import { KINDS, KIND_LABEL, historyLine } from './view.js'

/**
 * One word, added or edited, in a dialog - in the Settings controls, so it
 * reads as part of the same app: the segmented choice for its kind, the switch
 * for "always send it".
 */

/** What it is misheard as, as chips: type and press Enter or a comma. */
function SoundsLike({ aliases, onChange }: { aliases: VocabularyAlias[]; onChange(next: VocabularyAlias[]): void }): React.JSX.Element {
  const [text, setText] = useState('')
  const add = (): void => {
    const known = new Set(aliases.map((a) => a.text.toLowerCase()))
    const fresh = text
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p && !known.has(p.toLowerCase()))
    if (fresh.length > 0) onChange([...aliases, ...fresh.map((p) => ({ text: p, rewrite: false }))])
    setText('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-neutral-950 px-2 py-1.5 ring-1 ring-white/10 focus-within:ring-white/25">
      {aliases.map((alias, i) => (
        <span
          key={alias.text}
          className={`flex items-center gap-1 rounded py-px pr-0.5 pl-1.5 text-[12px] ring-1 ${
            alias.rewrite ? 'bg-amber-500/10 text-amber-200 ring-amber-500/20' : 'bg-white/[0.05] text-neutral-200 ring-white/10'
          }`}
        >
          {alias.text}
          <button
            type="button"
            onClick={() => onChange(aliases.map((a, j) => (j === i ? { ...a, rewrite: !a.rewrite } : a)))}
            title={
              alias.rewrite
                ? 'Always rewritten in dictation. Click to make it a hint.'
                : 'A hint. Click to always rewrite it in dictation — only for a sound-alike that is never a real word.'
            }
            className={`rounded px-1 text-[10px] leading-4 transition ${alias.rewrite ? 'text-amber-300' : 'text-neutral-600 hover:text-neutral-300'}`}
          >
            {alias.rewrite ? 'always' : 'hint'}
          </button>
          <button
            type="button"
            onClick={() => onChange(aliases.filter((_, j) => j !== i))}
            aria-label={`Remove ${alias.text}`}
            className="px-1 text-neutral-500 transition hover:text-neutral-200"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          }
          if (e.key === 'Backspace' && !text && aliases.length > 0) onChange(aliases.slice(0, -1))
        }}
        onBlur={add}
        placeholder={aliases.length === 0 ? 'Lord, लॉर्ड' : 'Add another'}
        className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-[12.5px] text-neutral-200 outline-none placeholder:text-neutral-600"
      />
    </div>
  )
}

export function WordEditor({
  initial,
  entry,
  suggestion,
  onDone,
}: {
  initial: VocabularyDraft
  /** The word being edited: its history, and Remove. */
  entry?: VocabularyEntry
  /** Opened from a suggestion: saving takes it. */
  suggestion?: number
  /** Closed - with what happened, to say so, or nothing when cancelled. */
  onDone(notice?: string): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<VocabularyDraft>(initial)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const adding = initial.id === undefined || suggestion !== undefined
  const term = draft.term.trim()

  const save = async (): Promise<void> => {
    if (!term || busy) return
    setBusy(true)
    const refused =
      suggestion === undefined ? await window.wouice.saveVocabulary(draft) : await window.wouice.acceptSuggestion(suggestion, draft)
    setBusy(false)
    if (refused) setProblem(refused)
    else onDone(`${adding ? 'Added' : 'Saved'} ${term}.`)
  }

  const remove = async (): Promise<void> => {
    if (!entry) return
    await window.wouice.removeVocabulary(entry.id)
    onDone(entry.source === 'roster' ? `${entry.term} moved to Not words.` : `Removed ${entry.term}.`)
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[12rem] flex-1">
          <Label name="Spelled" />
          <input
            ref={first}
            value={draft.term}
            onChange={(e) => setDraft({ ...draft, term: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder="Claude"
            className={FIELD}
          />
        </label>
        <div>
          <Label name="Kind" />
          <Choice
            value={draft.kind}
            options={KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind].one }))}
            onChange={(kind) => setDraft({ ...draft, kind })}
          />
        </div>
      </div>

      <div className="mt-3 divide-y divide-white/5 border-t border-white/5">
        <div className="py-3">
          <Label name="Heard as" hint="what the captions write instead" />
          <SoundsLike aliases={draft.aliases} onChange={(aliases) => setDraft({ ...draft, aliases })} />
        </div>
        <label className="block py-3">
          <Label name="Means" hint="one line, for the summary" />
          <input
            value={draft.meaning}
            onChange={(e) => setDraft({ ...draft, meaning: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder="the team's knowledge-base document"
            className={`${FIELD} text-[12.5px]`}
          />
        </label>
        <div className="flex items-center justify-between gap-6 py-3">
          <div>
            <p className="text-[12px] text-neutral-300">Always send it</p>
            <p className="mt-0.5 text-[11px] text-neutral-500">Sent with every request. For a few core words.</p>
          </div>
          <Toggle on={draft.pinned} onChange={(pinned) => setDraft({ ...draft, pinned })} label="Always send it" />
        </div>
        {entry && <p className="py-2.5 text-[11.5px] text-neutral-500">{historyLine(entry)}</p>}
      </div>

      {problem && <p className="mt-2 text-[11.5px] text-amber-400">{problem}</p>}

      <div className="mt-3 flex items-center gap-2">
        {entry && <ConfirmButton label="Remove" confirmLabel="Remove?" onClick={() => void remove()} />}
        <span className="flex-1" />
        <button onClick={() => onDone()} className={BUTTON.cancel}>
          Cancel
        </button>
        <button onClick={() => void save()} disabled={busy || !term} className={BUTTON.confirm}>
          {adding ? 'Add' : 'Save'}
        </button>
      </div>
    </div>
  )
}
