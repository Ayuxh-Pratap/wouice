import { useCallback, useEffect, useState } from 'react'
import type { DictionaryRecord } from '../../shared/ipc.js'
import { ConfirmButton } from './Field.js'

/**
 * Teaching Wouice a word.
 *
 * WHY THIS EXISTS. The shipped dictionary covers vocabulary any developer hits
 * in week one and stops there. Everything after that is personal - colleagues,
 * clients, project names, and the handful of words a particular voice reliably
 * defeats. A real one from this project's own transcripts: "मेरे हिसाब से" (in
 * my opinion) came back as "मेरे साफ से" every time, and the cleanup then turned
 * it into "more clear", inverting the meaning. Until now there was nowhere to
 * put that.
 *
 * TWO KINDS, and the difference matters enough to say in the UI rather than in
 * a tooltip. A correction rewrites text after transcription and is the half
 * that guarantees anything - which is also the half that can do damage. A term
 * only nudges the recogniser beforehand and can never rewrite something it
 * should not have.
 */

type Kind = 'term' | 'correction'

function KindPicker({ value, onChange }: { value: Kind; onChange(k: Kind): void }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      {(
        [
          ['correction', 'Always rewrite', 'Replaces the text every time it appears'],
          ['term', 'Just a name', 'Helps it hear the word. Never rewrites anything'],
        ] as const
      ).map(([kind, label, hint]) => (
        <button
          key={kind}
          onClick={() => onChange(kind)}
          className={[
            'flex-1 rounded-lg px-3 py-2 text-left transition',
            value === kind
              ? 'lift-active bg-white/[0.08] ring-1 ring-white/[0.12]'
              : 'bg-black/20 hover:bg-white/5',
          ].join(' ')}
        >
          <div className="text-[12px] font-medium text-neutral-200">{label}</div>
          <div className="mt-0.5 text-[10px] leading-snug text-neutral-500">{hint}</div>
        </button>
      ))}
    </div>
  )
}

function AddForm({ onAdded }: { onAdded(): void }): React.JSX.Element {
  const [kind, setKind] = useState<Kind>('correction')
  const [hear, setHear] = useState('')
  const [write, setWrite] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      // Validated in main as well: the rules protect every future transcript,
      // so the form is a convenience and not the enforcement point.
      const refused = await window.wouice.addDictionaryEntry({ kind, hear, write, enabled: true })
      if (refused) setProblem(refused)
      else {
        setHear('')
        setWrite('')
        onAdded()
      }
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full rounded-md bg-neutral-950 px-2.5 py-1.5 text-[12px] text-neutral-200 ring-1 ring-white/10 outline-none placeholder:text-neutral-600 focus:ring-white/25'

  return (
    <div className="rounded-lg bg-neutral-950/40 p-3">
      <KindPicker value={kind} onChange={setKind} />

      <div className={`mt-3 grid gap-2 ${kind === 'correction' ? 'sm:grid-cols-2' : ''}`}>
        <label className="block">
          <span className="mb-1 block text-[10px] tracking-wide text-neutral-500 uppercase">
            {kind === 'correction' ? 'When you hear' : 'The word'}
          </span>
          <input
            value={hear}
            onChange={(e) => setHear(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder={kind === 'correction' ? 'cloud code' : 'Himanshu'}
            className={field}
          />
        </label>
        {kind === 'correction' && (
          <label className="block">
            <span className="mb-1 block text-[10px] tracking-wide text-neutral-500 uppercase">
              Write instead
            </span>
            <input
              value={write}
              onChange={(e) => setWrite(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              placeholder="Claude Code"
              className={field}
            />
          </label>
        )}
      </div>

      {problem && (
        <p className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
          {problem}
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={busy || hear.trim().length === 0}
          className="rounded-md bg-white/10 px-3 py-1 text-[12px] font-medium text-neutral-100 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-40"
        >
          Add
        </button>
        <span className="text-[11px] text-neutral-600">
          {kind === 'correction'
            ? 'Use a phrase, not a single short word.'
            : 'Names, products, people. Safe to add anything.'}
        </span>
      </div>
    </div>
  )
}

function Entry({
  entry,
  onChanged,
}: {
  entry: DictionaryRecord
  onChanged(): void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-2">
      <button
        onClick={() => {
          void window.wouice
            .updateDictionaryEntry(entry.id!, { enabled: !entry.enabled })
            .then(onChanged)
        }}
        title={entry.enabled ? 'Switch this rule off' : 'Switch this rule on'}
        className={`size-2 shrink-0 rounded-full ${entry.enabled ? 'bg-emerald-400' : 'bg-neutral-700'}`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[12px]">
          <span className={entry.enabled ? 'text-neutral-200' : 'text-neutral-500 line-through'}>
            {entry.hear}
          </span>
          {entry.kind === 'correction' && (
            <>
              <span className="text-neutral-600">→</span>
              <span className={entry.enabled ? 'text-neutral-300' : 'text-neutral-600'}>
                {entry.write}
              </span>
            </>
          )}
        </div>
        <div className="mt-0.5 text-[10px] text-neutral-600">
          {entry.kind === 'term' ? 'name' : 'rewrite'}
          {' · '}
          {/* A rule at zero hits after weeks is either wrong or no longer needed. */}
          {entry.hits === 0 ? 'never used yet' : `used ${entry.hits}×`}
        </div>
      </div>

      <ConfirmButton
        label="Remove"
        confirmLabel="Really?"
        onClick={() => void window.wouice.removeDictionaryEntry(entry.id!).then(onChanged)}
      />
    </div>
  )
}

export function DictionaryEditor(): React.JSX.Element {
  const [entries, setEntries] = useState<DictionaryRecord[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback((): void => {
    void window.wouice
      .getDictionary()
      .then(setEntries)
      .finally(() => setLoaded(true))
  }, [])

  useEffect(load, [load])

  return (
    <div className="space-y-3">
      <AddForm onAdded={load} />

      {loaded && entries.length === 0 ? (
        <p className="px-1 py-3 text-[11px] leading-relaxed text-neutral-600">
          Nothing yet. The words worth adding are the ones you have already seen come out wrong
          twice — check the history below for repeats.
        </p>
      ) : (
        <div className="divide-y divide-white/5">
          {entries.map((e) => (
            <Entry key={e.id} entry={e} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  )
}
