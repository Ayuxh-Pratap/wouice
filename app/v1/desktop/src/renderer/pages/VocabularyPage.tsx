import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VocabularyDraft, VocabularyEntry, VocabularySuggestion } from '../../shared/ipc.js'
import { Dialog } from '../shell/Dialog.js'
import { Tabs } from '../shell/Tabs.js'
import { PasteList } from '../vocabulary/PasteList.js'
import { ReviewCard } from '../vocabulary/ReviewCard.js'
import { WordEditor } from '../vocabulary/WordEditor.js'
import { NotWordsTable, WordTable, type EmptyState } from '../vocabulary/WordTable.js'
import { BUTTON } from '../vocabulary/parts.js'
import { EMPTY_DRAFT, draftFor, notWords, summary, tabsFor, wordsIn, type NotWord, type TabId } from '../vocabulary/view.js'

/**
 * Your vocabulary: the names and words your meetings and dictation use.
 *
 * BUILT AROUND WHAT YOUR MEETINGS TAUGHT IT. The page you open after a call:
 * first what is waiting for a yes or no, then your words, by kind, as a table.
 * See docs/design/10-vocabulary-page.md.
 *
 * WHAT IS HERE IS YOURS. Only the people on a Meet call get in on their own;
 * everything Wouice finds is a suggestion, and "not a word" is kept, with an
 * undo. See docs/design/09-vocabulary.md.
 */

type Open =
  | { kind: 'add' }
  | { kind: 'edit'; entry: VocabularyEntry }
  | { kind: 'suggestion'; suggestion: VocabularySuggestion; draft: VocabularyDraft }
  | { kind: 'paste' }

function editorTitle(open: Open): string {
  if (open.kind === 'edit') return `Edit ${open.entry.term}`
  if (open.kind === 'suggestion') {
    const s = open.suggestion
    return s.type === 'new' ? `Add ${s.term}` : `Add “${s.heard}” to ${s.term}`
  }
  return open.kind === 'paste' ? 'Paste a list' : 'Add a word'
}

export function VocabularyPage(): React.JSX.Element {
  const [entries, setEntries] = useState<VocabularyEntry[] | null>(null)
  const [suggestions, setSuggestions] = useState<VocabularySuggestion[]>([])
  const [tab, setTab] = useState<TabId>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Open | null>(null)
  const [notice, setNotice] = useState('')

  const load = useCallback((): void => {
    void window.wouice.getVocabulary().then(setEntries)
    void window.wouice.getVocabularySuggestions().then(setSuggestions)
  }, [])
  useEffect(() => {
    load()
    return window.wouice.onVocabulary(load)
  }, [load])

  // What just happened, where the summary is - then the summary again.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 3000)
    return () => clearTimeout(t)
  }, [notice])

  const all = useMemo(() => entries ?? [], [entries])
  const out = useMemo(() => notWords(all, suggestions), [all, suggestions])
  const tabs = tabsFor(all, out.length)
  const current = tabs.some((t) => t.id === tab) ? tab : 'all'
  const q = query.trim()
  const words = useMemo(() => wordsIn(current, all, q), [current, all, q])
  const outShown = out.filter((n) => !q || n.term.toLowerCase().includes(q.toLowerCase()))
  const waiting = suggestions.filter((s) => s.state === 'suggested')

  const close = (message?: string): void => {
    setOpen(null)
    if (message) setNotice(message)
  }

  const undo = (n: NotWord): void => {
    if ('suggestion' in n.undo) void window.wouice.reviveSuggestion(n.undo.suggestion)
    else {
      const e = n.undo.entry
      void window.wouice.saveVocabulary({ id: e.id, term: e.term, kind: e.kind, aliases: e.aliases, meaning: e.meaning, pinned: e.pinned })
    }
    setNotice(`${n.term} is back.`)
  }

  const empty: EmptyState | null =
    entries === null
      ? { title: 'Loading…' }
      : !all.some((e) => e.state === 'active')
        ? { title: 'No words yet.', hint: 'Add one, or paste a list you already have.' }
        : words.length === 0
          ? { title: q ? `Nothing matches “${q}”.` : 'None of this kind yet.' }
          : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="shrink-0">
        <ReviewCard
          waiting={waiting}
          blocked={open !== null}
          onEdit={(s) => setOpen({ kind: 'suggestion', suggestion: s, draft: draftFor(s, all) })}
        />
      </div>

      {/* Only the list scrolls: the card above, the tabs and the table's header stay put. */}
      <div className="flex min-h-[16rem] flex-1 flex-col gap-3">
        <div className="shrink-0">
          <Tabs<TabId> tabs={tabs} active={current} onChange={setTab} />
        </div>
        <section className="lift flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-white/[0.035] ring-1 ring-white/[0.08]">
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
            {notice ? (
              <p className="text-[12px] text-emerald-300">{notice}</p>
            ) : (
              <p className="text-[12px] text-neutral-400">{entries === null ? ' ' : summary(all)}</p>
            )}
            <div className="flex items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search words"
                aria-label="Search your words, what they are heard as, and what they mean"
                className="w-56 rounded-md bg-neutral-950 px-2.5 py-1 text-[12px] text-neutral-200 ring-1 ring-white/10 outline-none placeholder:text-neutral-600 focus:ring-white/25"
              />
              <button onClick={() => setOpen({ kind: 'paste' })} className={BUTTON.small}>
                Paste a list
              </button>
              <button onClick={() => setOpen({ kind: 'add' })} className={BUTTON.compact}>
                Add a word
              </button>
            </div>
          </header>
          {current === 'not' ? (
            <NotWordsTable items={outShown} empty={outShown.length === 0 ? { title: `Nothing matches “${q}”.` } : null} onUndo={undo} />
          ) : (
            <WordTable words={words} empty={empty} onOpen={(entry) => setOpen({ kind: 'edit', entry })} />
          )}
        </section>
      </div>

      {open && (
        <Dialog title={editorTitle(open)} onClose={() => close()} wide={open.kind !== 'paste'}>
          {open.kind === 'paste' ? (
            <PasteList onDone={close} />
          ) : open.kind === 'edit' ? (
            <WordEditor
              initial={{
                id: open.entry.id,
                term: open.entry.term,
                kind: open.entry.kind,
                aliases: open.entry.aliases,
                meaning: open.entry.meaning,
                pinned: open.entry.pinned,
              }}
              entry={open.entry}
              onDone={close}
            />
          ) : open.kind === 'suggestion' ? (
            <WordEditor initial={open.draft} suggestion={open.suggestion.id} onDone={close} />
          ) : (
            <WordEditor initial={EMPTY_DRAFT} onDone={close} />
          )}
        </Dialog>
      )}
    </div>
  )
}
