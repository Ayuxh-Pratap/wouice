/**
 * Underline tabs.
 *
 * WHY TABS AND NOT SECTIONS DOWN A PAGE. Both a meeting and the settings screen
 * hold several things that are read at different times and almost never
 * together: you open a meeting to check what you agreed, or to read the
 * transcript, but rarely both in one visit. Stacked, every visit costs a scroll
 * past the parts you did not come for.
 *
 * A LINE, NOT A BOX. The tab strip is chrome and should read as chrome; a row
 * of filled buttons competes with the content underneath for the same
 * attention. One moving underline is enough to say which one you are on.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: number }[]
  active: T
  onChange(id: T): void
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      // WRAPS, never scrolls. `overflow-x-auto` made a scroll container, and a
      // scroll container on Windows draws a bar across the strip and clips the
      // active tab's underline - the underline sits one pixel below the box it
      // is in, which is exactly what overflow hides.
      className="flex flex-wrap gap-x-5 gap-y-1 border-b border-white/[0.08] px-0.5"
    >
      {tabs.map((tab) => {
        const on = tab.id === active
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.id)}
            className={
              'relative -mb-px shrink-0 border-b-2 px-0.5 pb-2 text-[12.5px] transition ' +
              (on
                ? 'border-neutral-200 text-neutral-100'
                : 'border-transparent text-neutral-500 hover:text-neutral-300')
            }
          >
            {tab.label}
            {tab.badge ? (
              <span
                className={
                  'ml-1.5 rounded-full px-1.5 py-px text-[10px] tabular-nums ' +
                  (on ? 'bg-white/[0.12] text-neutral-200' : 'bg-white/[0.06] text-neutral-500')
                }
              >
                {tab.badge}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
