/**
 * A list of name/value facts, with one column width for all of them.
 *
 * WHY THIS IS A COMPONENT. Diagnostics and Storage were two `dl` grids sitting
 * one above the other, each with an `auto` first column. `auto` sizes to the
 * widest label in ITS OWN grid, so "resource_samples" pushed Storage's values
 * forty pixels right of Diagnostics', and two lists that plainly belong
 * together looked like a rendering accident. A stated column, shared, is the
 * only version of this that cannot drift.
 *
 * Wide enough for `resource_samples`, which is the longest name either list can
 * produce - table names come from the schema, and a new one longer than that
 * would need this raised.
 */
export function Facts({ rows }: { rows: [string, React.ReactNode][] }): React.JSX.Element {
  return (
    <dl className="grid gap-x-4 gap-y-1.5 font-mono text-[11px] sm:grid-cols-[9.5rem_minmax(0,1fr)]">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="truncate text-neutral-500">{name}</dt>
          <dd className="min-w-0 truncate text-neutral-300">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A heading inside a facts card, for the second and later blocks.
 *
 * Carries its own optional action, because "Show in folder" belongs beside the
 * word Storage and not in the card header shared with Diagnostics.
 */
export function FactGroup({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="pt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-neutral-400">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}
