import { useEffect, useState } from 'react'

/**
 * The small pieces every settings row is made of.
 *
 * Separate from the panel because there are a dozen rows and they must all look
 * and behave identically. A settings screen where each control was styled where
 * it was written is a settings screen that drifts.
 */

export function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-[13px] text-neutral-200">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean
  onChange(next: boolean): void
  label: string
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={[
        'relative h-5 w-9 shrink-0 rounded-full shadow-[inset_0_1px_2px_rgb(0_0_0/0.4)] transition',
        on ? 'bg-emerald-500/80' : 'bg-neutral-700',
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-0.5 size-4 rounded-full bg-white shadow-sm shadow-black/40 transition-[left]',
          on ? 'left-[1.125rem]' : 'left-0.5',
        ].join(' ')}
      />
    </button>
  )
}

export function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange(next: T): void
}): React.JSX.Element {
  return (
    <div className="flex rounded-lg bg-neutral-950/60 p-0.5 ring-1 ring-white/10">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={[
            'rounded-md px-2.5 py-1 text-[11px] transition',
            value === o.value
              ? 'lift-active bg-white/10 text-neutral-100 ring-1 ring-white/[0.08]'
              : 'text-neutral-500 hover:text-neutral-300',
          ].join(' ')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="lift rounded-xl bg-white/[0.035] px-4 py-3 ring-1 ring-white/[0.08]">
      <header className="border-b border-white/5 pb-2">
        <h3 className="text-[13px] font-semibold text-neutral-100">{title}</h3>
        {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">{hint}</p>}
      </header>
      <div className="divide-y divide-white/5">{children}</div>
    </section>
  )
}

/**
 * A destructive button that asks first, in place.
 *
 * No dialog: a modal for "delete 6 recordings" is heavier than the action. The
 * two-step press is enough to stop an accidental click, and it reverts on its
 * own so a half-pressed button never sits there looking armed.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onClick,
}: {
  label: string
  confirmLabel: string
  onClick(): void
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4_000)
    return () => clearTimeout(t)
  }, [armed])

  return (
    <button
      onClick={() => {
        if (armed) {
          onClick()
          setArmed(false)
        } else setArmed(true)
      }}
      className={[
        'rounded-md px-2.5 py-1 text-[11px] transition',
        armed
          ? 'bg-red-500/20 text-red-200 ring-1 ring-red-500/40'
          : 'text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200',
      ].join(' ')}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}
