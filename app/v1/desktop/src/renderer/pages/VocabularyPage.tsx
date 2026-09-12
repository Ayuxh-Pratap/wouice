import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VOCABULARY_KINDS } from '@wouice/store/types'
import type {
  VocabularyAlias,
  VocabularyDraft,
  VocabularyEntry,
  VocabularyKind,
  VocabularySuggestion,
} from '../../shared/ipc.js'
import { ConfirmButton } from '../settings/Field.js'

/**
 * Your vocabulary: the names and words your meetings and dictation use.
 *
 * ITS OWN PAGE, not a box in Settings. A list of sixty names in a text field
 * was unreadable and unsorted, and the vocabulary is shared by dictation and
 * meetings, so it belongs to neither. See docs/design/09-vocabulary.md.
 *
 * WHAT IS HERE IS YOURS. Only the people on a Meet call's participant list get
 * in on their own - spelled by Google, marked as such, one click to remove.
 * Everything else is added or changed by you; what Wouice finds in meetings
 * comes as suggestions, never straight in - and "not a word" is kept, so a
 * suggestion you turned down, or a Meet name you removed, stays out.
 *
 * AN ENTRY IS MORE THAN A SPELLING: what kind of thing it is, what it tends to
 * be misheard as ("Lord" for Claude - the part a spelling alone could not fix),
 * and what it means, for the summary.
 */

const KIND: Record<VocabularyKind, { title: string; one: string; hint: string }> = {
  person: { title: 'People', one: 'Person', hint: 'Names, spelled the way they spell them.' },
  product: { title: 'Products and features', one: 'Product', hint: 'What you are building, and its parts.' },
  tool: { title: 'Tools and companies', one: 'Tool', hint: 'Services, models, libraries, companies.' },
  term: { title: 'Terms', one: 'Term', hint: 'The jargon and ideas your meetings use.' },
  place: { title: 'Places', one: 'Place', hint: 'Cities, offices, venues.' },
}

const EMPTY: VocabularyDraft = { term: '', kind: 'term', aliases: [], meaning: '', pinned: false }

function ago(at: number | null): string | null {
  if (at === null) return null
  const days = Math.floor((Date.now() - at) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** What it sounds like when misheard, as chips: type and press Enter, or a comma. */
function SoundsLike({
  aliases,
  onChange,
}: {
  aliases: VocabularyAlias[]
  onChange(next: VocabularyAlias[]): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const add = (): void => {
    const parts = text
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const known = new Set(aliases.map((a) => a.text.toLowerCase()))
    onChange([...aliases, ...parts.filter((p) => !known.has(p.toLowerCase())).map((p) => ({ text: p, rewrite: false }))])
    setText('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-black/25 px-2 py-1.5 ring-1 ring-white/[0.08] focus-within:ring-white/20">
      {aliases.map((alias, i) => (
        <span key={alias.text} className="flex items-center gap-1 rounded bg-white/[0.07] py-0.5 pr-1 pl-1.5 text-[11.5px] text-neutral-200">
          {alias.text}
          <button
            type="button"
            onClick={() => onChange(aliases.map((a, j) => (j === i ? { ...a, rewrite: !a.rewrite } : a)))}
            title={
              alias.rewrite
                ? 'Always rewritten in dictation. Click to make it a hint only.'
                : 'A hint only. Click to always rewrite it in dictation - only for a sound-alike that is never a real word.'
            }
            className={`rounded px-1 text-[10px] leading-4 ${alias.rewrite ? 'bg-amber-400/20 text-amber-200' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            {alias.rewrite ? 'always rewrite' : 'hint'}
          </button>
          <button
            type="button"
            onClick={() => onChange(aliases.filter((_, j) => j !== i))}
            aria-label={`Remove ${alias.text}`}
            className="px-0.5 text-neutral-500 hover:text-neutral-200"
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
        placeholder={aliases.length === 0 ? 'Lord, लॉर्ड - how it comes out when it is misheard' : 'Add another'}
        className="min-w-[10rem] flex-1 bg-transparent py-0.5 text-[12px] text-neutral-200 outline-none placeholder:text-neutral-600"
      />
    </div>
  )
}

/**
 * Adding, editing and pasting open over the list, not above it: opened at the
 * top of the page, they scrolled you away from the word you were looking at,
 * and back to the top when they closed.
 */
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose(): void
  children: React.ReactNode
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onClick={onClose} role="presentation">
      <div
        className="lift w-full max-w-xl rounded-xl bg-neutral-900 px-5 py-4 ring-1 ring-white/[0.12]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <h2 className="mb-3 text-[14px] font-medium text-neutral-100">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function Editor({
  initial,
  suggestion,
  onDone,
}: {
  initial: VocabularyDraft
  /** Opened from a suggestion: saving takes it. */
  suggestion?: number
  /** Closed: with the word when it was saved, without when cancelled. */
  onDone(saved?: string): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<VocabularyDraft>(initial)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const save = async (): Promise<void> => {
    setBusy(true)
    const refused =
      suggestion === undefined
        ? await window.wouice.saveVocabulary(draft)
        : await window.wouice.acceptSuggestion(suggestion, draft)
    setBusy(false)
    if (refused) setProblem(refused)
    else onDone(draft.term.trim())
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[12rem] flex-1">
          <span className="mb-1 block text-[11px] text-neutral-500">Spelled</span>
          <input
            ref={first}
            value={draft.term}
            onChange={(e) => setDraft({ ...draft, term: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder="Claude"
            className="w-full rounded-md bg-black/25 px-2.5 py-1.5 text-[13px] text-neutral-100 ring-1 ring-white/[0.08] outline-none placeholder:text-neutral-600 focus:ring-white/20"
          />
        </label>
        <div>
          <span className="mb-1 block text-[11px] text-neutral-500">Kind</span>
          <div className="flex rounded-md bg-black/25 p-0.5 ring-1 ring-white/[0.08]">
            {VOCABULARY_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setDraft({ ...draft, kind })}
                className={`rounded px-2 py-1 text-[11.5px] transition ${
                  draft.kind === kind ? 'bg-white/[0.12] text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {KIND[kind].one}
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] text-neutral-500">
          Heard as <span className="text-neutral-600">- what the captions or the recogniser write instead</span>
        </span>
        <SoundsLike aliases={draft.aliases} onChange={(aliases) => setDraft({ ...draft, aliases })} />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] text-neutral-500">
          Means <span className="text-neutral-600">- one line, for the summary</span>
        </span>
        <input
          value={draft.meaning}
          onChange={(e) => setDraft({ ...draft, meaning: e.target.value })}
          placeholder="the team's knowledge-base document"
          className="w-full rounded-md bg-black/25 px-2.5 py-1.5 text-[12.5px] text-neutral-200 ring-1 ring-white/[0.08] outline-none placeholder:text-neutral-600 focus:ring-white/20"
        />
      </label>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[12px] text-neutral-400" title="Sent with every request, whether or not the text mentions it.">
          <input
            type="checkbox"
            checked={draft.pinned}
            onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })}
            className="accent-amber-400"
          />
          Always send it
        </label>
        <div className="flex items-center gap-2">
          {problem && <span className="text-[11.5px] text-rose-300">{problem}</span>}
          <button onClick={() => onDone()} className="rounded-md px-2.5 py-1 text-[12px] text-neutral-400 hover:text-neutral-200">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || !draft.term.trim()}
            className="rounded-md bg-white/[0.1] px-3 py-1 text-[12px] font-medium text-neutral-100 ring-1 ring-white/15 transition hover:bg-white/[0.15] disabled:opacity-40"
          >
            {initial.id === undefined || suggestion !== undefined ? 'Add' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PasteList({ onDone }: { onDone(message: string): void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async (): Promise<void> => {
    setBusy(true)
    const result = await window.wouice.importVocabulary(text)
    setBusy(false)
    onDone(
      `Added ${result.added}` + (result.skipped > 0 ? `, and left ${result.skipped} you already had as they were` : '') + '.'
    )
  }
  return (
    <div className="space-y-2.5">
      <p className="text-[12px] leading-relaxed text-neutral-400">
        One per line, or separated by commas. "Bible - the team's knowledge base" adds a meaning with it. Each is sorted
        into a kind for you to check; anything you already have is left alone.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={7}
        autoFocus
        placeholder={'Ayush, Himanshu, Jeremy\nFinch Bot\nBible - the team\'s knowledge-base document'}
        className="w-full resize-y rounded-md bg-black/25 px-2.5 py-2 font-mono text-[12px] text-neutral-200 ring-1 ring-white/[0.08] outline-none placeholder:text-neutral-600 focus:ring-white/20"
      />
      <div className="flex justify-end gap-2">
        <button onClick={() => onDone('')} className="rounded-md px-2.5 py-1 text-[12px] text-neutral-400 hover:text-neutral-200">
          Cancel
        </button>
        <button
          onClick={() => void go()}
          disabled={busy || !text.trim()}
          className="rounded-md bg-white/[0.1] px-3 py-1 text-[12px] font-medium text-neutral-100 ring-1 ring-white/15 transition hover:bg-white/[0.15] disabled:opacity-40"
        >
          {busy ? 'Sorting…' : 'Add these'}
        </button>
      </div>
    </div>
  )
}

function Row({ entry, onEdit }: { entry: VocabularyEntry; onEdit(): void }): React.JSX.Element {
  const seen = entry.meetings > 0 ? `${entry.meetings} meeting${entry.meetings === 1 ? '' : 's'}, last ${ago(entry.lastSeenAt)}` : null
  return (
    <li className="group flex items-start gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-neutral-100">{entry.term}</span>
          {entry.pinned && (
            <span title="Always sent" className="text-[10px] text-amber-300/80">
              always sent
            </span>
          )}
          {entry.source === 'roster' && (
            <span className="rounded bg-sky-400/10 px-1.5 py-px text-[10px] text-sky-200/80" title="Added from a Meet call's participant list">
              from a Meet call
            </span>
          )}
          {entry.aliases.map((a) => (
            <span
              key={a.text}
              title={a.rewrite ? 'Heard as this - always rewritten in dictation' : 'Heard as this'}
              className={`rounded px-1.5 py-px text-[10.5px] ${a.rewrite ? 'bg-amber-400/10 text-amber-200/80' : 'bg-white/[0.05] text-neutral-400'}`}
            >
              {a.text}
            </span>
          ))}
        </div>
        {entry.meaning && <p className="mt-0.5 text-[12px] text-neutral-400">{entry.meaning}</p>}
      </div>
      {seen && <span className="shrink-0 pt-0.5 text-[10.5px] text-neutral-500 tabular-nums">{seen}</span>}
      <div className="flex shrink-0 items-center gap-1 opacity-60 transition group-hover:opacity-100">
        <button onClick={onEdit} className="rounded-md px-2 py-0.5 text-[11px] text-neutral-300 ring-1 ring-white/10 hover:bg-white/5">
          Edit
        </button>
        <ConfirmButton label="Remove" confirmLabel="Remove?" onClick={() => void window.wouice.removeVocabulary(entry.id)} />
      </div>
    </li>
  )
}

/** The draft a suggestion opens in the editor: a new word as it was found, a mishearing added to its entry. */
function draftFor(s: VocabularySuggestion, entries: readonly VocabularyEntry[]): VocabularyDraft {
  const heard = { text: s.heard, rewrite: false }
  if (s.type === 'new') return { term: s.term, kind: s.kind, aliases: [], meaning: '', pinned: false }
  const e = entries.find((x) => x.term.toLowerCase() === s.term.toLowerCase())
  return e
    ? { id: e.id, term: e.term, kind: e.kind, aliases: [...e.aliases, heard], meaning: e.meaning, pinned: e.pinned }
    : { term: s.term, kind: s.kind, aliases: [heard], meaning: '', pinned: false }
}

const ACTION = 'rounded-md px-2 py-0.5 text-[11px] ring-1 ring-white/10 hover:bg-white/5'

/**
 * What your meetings suggest. Nothing here is in your vocabulary until you take
 * it - as it stands, or edited first - and "not a word" is kept, so it never
 * comes back. Each shows the line it was found in, for you to judge it by.
 */
function Suggestions({
  waiting,
  onEdit,
}: {
  waiting: VocabularySuggestion[]
  onEdit(s: VocabularySuggestion): void
}): React.JSX.Element | null {
  if (waiting.length === 0) return null
  return (
    <section className="lift overflow-hidden rounded-xl bg-amber-300/[0.035] ring-1 ring-amber-200/[0.14]">
      <header className="flex items-baseline gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-neutral-100">Suggested from your meetings</h2>
        <span className="text-[11px] text-neutral-500 tabular-nums">{waiting.length}</span>
        <span className="ml-auto text-[11px] text-neutral-600">Nothing goes in until you add it.</span>
      </header>
      <ul className="divide-y divide-white/[0.05]">
        {waiting.map((s) => {
          const quote = s.evidence[s.evidence.length - 1]?.quote
          return (
            <li key={s.id} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                {s.type === 'new' ? (
                  <p className="text-[13px] text-neutral-100">
                    <span className="font-medium">{s.term}</span>{' '}
                    <span className="text-[11px] text-neutral-500">{KIND[s.kind].one.toLowerCase()}</span>
                  </p>
                ) : (
                  <p className="text-[13px] text-neutral-300">
                    <span className="font-medium text-neutral-100">{s.heard}</span> may be{' '}
                    <span className="font-medium text-neutral-100">{s.term}</span>, misheard
                  </p>
                )}
                {quote && <p className="mt-0.5 truncate text-[11.5px] text-neutral-500 italic">“{quote}”</p>}
              </div>
              <span className="shrink-0 pt-0.5 text-[10.5px] text-neutral-500 tabular-nums">
                {s.meetings} meeting{s.meetings === 1 ? '' : 's'}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => void window.wouice.acceptSuggestion(s.id)}
                  className="rounded-md bg-white/[0.1] px-2 py-0.5 text-[11px] font-medium text-neutral-100 ring-1 ring-white/15 hover:bg-white/[0.15]"
                >
                  {s.type === 'new' ? 'Add' : 'Add as heard-as'}
                </button>
                <button onClick={() => onEdit(s)} className={`${ACTION} text-neutral-300`}>
                  Edit
                </button>
                <button onClick={() => void window.wouice.rejectSuggestion(s.id)} className={`${ACTION} text-neutral-500`}>
                  {s.type === 'new' ? 'Not a word' : 'Not this'}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** What you said is not a word - turned-down suggestions and removed Meet names - each with an undo. */
function NotWords({
  rejected,
  entries,
}: {
  rejected: VocabularySuggestion[]
  entries: VocabularyEntry[]
}): React.JSX.Element | null {
  const words = [
    ...rejected.map((s) => ({
      key: `s${s.id}`,
      text: s.type === 'new' ? s.term : `${s.heard} → ${s.term}`,
      undo: () => void window.wouice.reviveSuggestion(s.id),
    })),
    ...entries
      .filter((e) => e.state === 'rejected')
      .map((e) => ({
        key: `e${e.id}`,
        text: e.term,
        undo: () =>
          void window.wouice.saveVocabulary({ id: e.id, term: e.term, kind: e.kind, aliases: e.aliases, meaning: e.meaning, pinned: e.pinned }),
      })),
  ]
  if (words.length === 0) return null
  return (
    <details className="text-[12px] text-neutral-500">
      <summary className="cursor-pointer select-none hover:text-neutral-300">
        Not words · {words.length} <span className="text-neutral-600">- never suggested or added again</span>
      </summary>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {words.map((w) => (
          <span key={w.key} className="flex items-center gap-1 rounded bg-white/[0.04] py-0.5 pr-1 pl-2 text-[11.5px] text-neutral-400">
            {w.text}
            <button
              onClick={w.undo}
              title="Undo: it can be suggested or added again"
              className="rounded px-1 text-[10.5px] text-neutral-500 hover:text-neutral-200"
            >
              undo
            </button>
          </span>
        ))}
      </div>
    </details>
  )
}

export function VocabularyPage(): React.JSX.Element {
  const [entries, setEntries] = useState<VocabularyEntry[] | null>(null)
  const [suggestions, setSuggestions] = useState<VocabularySuggestion[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<VocabularyDraft | null>(null)
  const [fromSuggestion, setFromSuggestion] = useState<number | undefined>(undefined)
  const [pasting, setPasting] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback((): void => {
    void window.wouice.getVocabulary().then(setEntries)
    void window.wouice.getVocabularySuggestions().then(setSuggestions)
  }, [])
  useEffect(() => {
    load()
    return window.wouice.onVocabulary(load)
  }, [load])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (entries ?? []).filter(
      (e) =>
        e.state === 'active' &&
        (!q ||
          e.term.toLowerCase().includes(q) ||
          e.meaning.toLowerCase().includes(q) ||
          e.aliases.some((a) => a.text.toLowerCase().includes(q)))
    )
  }, [entries, query])

  // A notice says what happened, then gets out of the way.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(t)
  }, [notice])

  const active = (entries ?? []).filter((e) => e.state === 'active')
  const fromMeet = active.filter((e) => e.source === 'roster').length
  const edit = (e: VocabularyEntry): void => {
    setFromSuggestion(undefined)
    setEditing({ id: e.id, term: e.term, kind: e.kind, aliases: e.aliases, meaning: e.meaning, pinned: e.pinned })
  }
  const editSuggestion = (s: VocabularySuggestion): void => {
    setPasting(false)
    setFromSuggestion(s.id)
    setEditing(draftFor(s, entries ?? []))
  }

  const closeEditor = (saved?: string): void => {
    setEditing(null)
    setFromSuggestion(undefined)
    if (saved) setNotice(`Saved ${saved}.`)
  }

  return (
    <div className="space-y-4">
      {/* Stays put while the list scrolls under it: search and Add are never a scroll away. */}
      <div className="sticky top-0 z-10 -mx-7 -mt-6 space-y-3 border-b border-white/[0.05] bg-neutral-900/95 px-7 pt-6 pb-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-[12.5px] text-neutral-400">
            {entries === null
              ? ' '
              : active.length === 0
                ? 'Nothing yet.'
                : `${active.length} name${active.length === 1 ? '' : 's'} and words` +
                  (fromMeet > 0 ? ` · ${fromMeet} from Meet calls` : '')}
          </p>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search your vocabulary"
            className="w-48 rounded-md bg-black/25 px-2.5 py-1 text-[12px] text-neutral-200 ring-1 ring-white/[0.08] outline-none placeholder:text-neutral-600 focus:ring-white/20"
          />
          <button
            onClick={() => {
              setEditing(null)
              setPasting(true)
            }}
            className="rounded-md px-2.5 py-1 text-[12px] text-neutral-300 ring-1 ring-white/10 hover:bg-white/5"
          >
            Paste a list
          </button>
          <button
            onClick={() => {
              setPasting(false)
              setFromSuggestion(undefined)
              setEditing(EMPTY)
            }}
            className="rounded-md bg-white/[0.1] px-3 py-1 text-[12px] font-medium text-neutral-100 ring-1 ring-white/15 hover:bg-white/[0.15]"
          >
            Add
          </button>
        </div>
        {notice && (
          <p className="rounded-lg bg-emerald-400/[0.07] px-3 py-2 text-[12px] text-emerald-200/90 ring-1 ring-emerald-300/15">{notice}</p>
        )}
      </div>

      {pasting && (
        <Dialog title="Paste a list" onClose={() => setPasting(false)}>
          <PasteList
            onDone={(message) => {
              setPasting(false)
              setNotice(message)
            }}
          />
        </Dialog>
      )}
      {editing && (
        <Dialog
          title={fromSuggestion !== undefined ? 'Add from a suggestion' : editing.id === undefined ? 'Add a word' : `Edit ${editing.term}`}
          onClose={() => closeEditor()}
        >
          <Editor
            key={`${fromSuggestion ?? ''}:${editing.id ?? 'new'}`}
            initial={editing}
            suggestion={fromSuggestion}
            onDone={closeEditor}
          />
        </Dialog>
      )}

      <Suggestions waiting={suggestions.filter((s) => s.state === 'suggested')} onEdit={editSuggestion} />

      {entries !== null && active.length === 0 && !pasting && !editing && (
        <section className="rounded-xl bg-white/[0.03] px-5 py-4 text-[12.5px] leading-relaxed text-neutral-400 ring-1 ring-white/[0.08]">
          <p className="text-neutral-200">Teach Wouice the names and words your meetings use.</p>
          <p className="mt-1.5">
            Each one is spelled right in the English, the summary and your dictation. Add what it is misheard as - "Lord"
            for Claude - and the models turn the mishearing back into the word. The people on a Meet call are added on
            their own; everything else is yours to add, one at a time or as a pasted list.
          </p>
        </section>
      )}

      {VOCABULARY_KINDS.map((kind) => {
        const list = shown.filter((e) => e.kind === kind)
        if (list.length === 0) return null
        return (
          <section key={kind} className="lift overflow-hidden rounded-xl bg-white/[0.035] ring-1 ring-white/[0.08]">
            <header className="flex items-baseline gap-2 border-b border-white/[0.06] px-4 py-2.5">
              <h2 className="text-[13px] font-semibold text-neutral-100">{KIND[kind].title}</h2>
              <span className="text-[11px] text-neutral-500 tabular-nums">{list.length}</span>
              <span className="ml-auto text-[11px] text-neutral-600">{KIND[kind].hint}</span>
            </header>
            <ul className="divide-y divide-white/[0.05]">
              {list.map((entry) => (
                <Row key={entry.id} entry={entry} onEdit={() => edit(entry)} />
              ))}
            </ul>
          </section>
        )
      })}

      {entries !== null && active.length > 0 && shown.length === 0 && (
        <p className="text-[12px] text-neutral-500">Nothing matches "{query}".</p>
      )}

      <NotWords rejected={suggestions.filter((s) => s.state === 'rejected')} entries={entries ?? []} />
    </div>
  )
}
