import { useEffect, useState } from 'react'
import type { StoreStats } from '../../shared/ipc.js'
import { FactGroup, Facts } from './Facts.js'

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * What is actually inside the database.
 *
 * There is no server to look at and no admin console: the app IS the deployment,
 * so "how much of my voice is on this disk, in what, and is the schema where it
 * should be" has to be answerable from here. The reveal button opens the folder,
 * for anyone who wants to point a SQLite browser at the file.
 *
 * Shares `Facts` with the diagnostics above it so the two lists line up on one
 * column rather than each sizing to its own longest label.
 */
export function Storage(): React.JSX.Element | null {
  const [stats, setStats] = useState<StoreStats | null>(null)

  useEffect(() => {
    void window.wouice
      .getStorage()
      .then(setStats)
      .catch(() => setStats(null))
  }, [])

  if (!stats) return null

  return (
    <FactGroup
      title="Storage"
      action={
        <button
          onClick={() => window.wouice.revealMetrics()}
          className="rounded-md px-2 py-0.5 text-[11px] text-neutral-500 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-300"
        >
          Show in folder
        </button>
      }
    >
      <Facts
        rows={[
          ['database', stats.file],
          ['schema', `v${stats.version} · ${bytes(stats.bytes)} on disk`],
          ...stats.tables.map(
            (t) =>
              [t.name, <span className="tabular-nums">{t.rows.toLocaleString()} rows</span>] as [
                string,
                React.ReactNode,
              ]
          ),
        ]}
      />
    </FactGroup>
  )
}
