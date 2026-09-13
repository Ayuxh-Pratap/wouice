/**
 * The small pieces the Vocabulary page is drawn with, in the app's own
 * classes: the Notes badge, the Quality key hint, the button sizes every other
 * page uses.
 */

const TONE = {
  quiet: 'bg-white/[0.05] text-neutral-400 ring-white/10',
  sky: 'bg-sky-500/10 text-sky-300/90 ring-sky-500/20',
  emerald: 'bg-emerald-500/10 text-emerald-300/90 ring-emerald-500/20',
  amber: 'bg-amber-500/10 text-amber-300/90 ring-amber-500/20',
} as const

export function Badge({ tone = 'quiet', children }: { tone?: keyof typeof TONE; children: React.ReactNode }): React.JSX.Element {
  return <span className={`inline-block rounded px-1.5 py-px text-[10px] whitespace-nowrap ring-1 ${TONE[tone]}`}>{children}</span>
}

/** A sound-alike. Amber when it is always rewritten in dictation. */
export function Chip({ rewrite = false, children }: { rewrite?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      title={rewrite ? 'Always rewritten in dictation' : undefined}
      className={`inline-block rounded px-1.5 py-px text-[11px] ring-1 ${rewrite ? TONE.amber : 'bg-black/20 text-neutral-400 ring-white/[0.08]'}`}
    >
      {children}
    </span>
  )
}

export function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <kbd className="ml-2 rounded bg-white/5 px-1.5 py-px font-mono text-[10px] text-neutral-500">{children}</kbd>
}

export const BUTTON = {
  /** Dialog confirm. */
  confirm:
    'rounded-lg bg-white/[0.09] px-3 py-1.5 text-[12.5px] font-medium text-neutral-100 ring-1 ring-white/20 transition hover:bg-white/[0.15] disabled:opacity-40',
  /** Dialog cancel. */
  cancel: 'rounded-lg px-3 py-1.5 text-[12.5px] text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/5',
  /** Yes, in a card. */
  affirm:
    'rounded-lg bg-emerald-500/15 px-3 py-1.5 text-[12px] font-medium text-emerald-200 ring-1 ring-emerald-500/30 transition hover:bg-emerald-500/25 disabled:opacity-40',
  /** The second choice, in a card. */
  second:
    'rounded-lg bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-neutral-300 ring-1 ring-white/10 transition hover:bg-white/[0.08] disabled:opacity-40',
  /** No, in a card. */
  decline: 'rounded-lg px-3 py-1.5 text-[12px] text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-200',
  /** The main action in a card header. */
  compact:
    'rounded-md bg-white/[0.06] px-2.5 py-1 text-[11.5px] font-medium text-neutral-200 ring-1 ring-white/10 transition hover:bg-white/[0.12]',
  /** A small outlined action. */
  small: 'rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-neutral-200',
} as const

/** Inputs, as Settings draws them. */
export const FIELD =
  'w-full rounded-md bg-neutral-950 px-2.5 py-1.5 text-[13px] text-neutral-100 ring-1 ring-white/10 outline-none placeholder:text-neutral-600 focus:ring-white/25'

/** A field's name, and at most a few words on what goes in it. */
export function Label({ name, hint }: { name: string; hint?: string }): React.JSX.Element {
  return (
    <span className="mb-1.5 block text-[12px] text-neutral-300">
      {name}
      {hint && <span className="text-[11px] text-neutral-500"> — {hint}</span>}
    </span>
  )
}
