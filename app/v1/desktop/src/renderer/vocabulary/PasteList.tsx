import { useState } from 'react'
import { BUTTON } from './parts.js'

/** A list you already have, pasted in: each is sorted into a kind for you to check. */
export function PasteList({ onDone }: { onDone(notice?: string): void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async (): Promise<void> => {
    setBusy(true)
    const result = await window.wouice.importVocabulary(text)
    setBusy(false)
    onDone(`Added ${result.added}` + (result.skipped > 0 ? ` · ${result.skipped} already there` : '') + '.')
  }

  return (
    <div>
      <p className="mb-2 text-[11.5px] text-neutral-500">One per line or comma-separated. “Bible — the team's knowledge base” adds a meaning.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        autoFocus
        placeholder={"Priya, Rahul, Jeremy\nFinch Bot\nHandbook — the team's knowledge-base document"}
        className="w-full resize-y rounded-md bg-neutral-950 px-3 py-2 font-mono text-[12px] leading-relaxed text-neutral-200 ring-1 ring-white/10 outline-none placeholder:text-neutral-600 focus:ring-white/25"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={() => onDone()} className={BUTTON.cancel}>
          Cancel
        </button>
        <button onClick={() => void go()} disabled={busy || !text.trim()} className={BUTTON.confirm}>
          {busy ? 'Sorting…' : 'Add these'}
        </button>
      </div>
    </div>
  )
}
