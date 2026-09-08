import { useEffect, useState } from 'react'
import type { StoreStats } from '../../shared/ipc.js'

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
 */
export function Storage(): React.JSX.Element | null {
  const [stats, setStats] = useState<StoreStats | null>(null)

  useEffect(() => {
    void window.wouice.getStorage().then(setStats).catch(() => setStats(null))
  }, [])

  if (!stats) return null

  return (
    <div className="mt-4 border-t border-white/5 pt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-neutral-400">Storage</span>
        <button
          onClick={() => window.wouice.revealMetrics()}
          className="rounded-md px-2 py-0.5 text-[11px] text-neutral-500 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-300"
        >
          Show in folder
        </button>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 font-mono text-[11px] sm:grid-cols-[auto_1fr]">
        <dt className="text-neutral-500">database</dt>
        <dd className="truncate text-neutral-300">{stats.file}</dd>
        <dt className="text-neutral-500">schema</dt>
        <dd className="text-neutral-300">
          v{stats.version} · {bytes(stats.bytes)} on disk
        </dd>
        {stats.tables.map((t) => (
          <div key={t.name} className="contents">
            <dt className="text-neutral-500">{t.name}</dt>
            <dd className="text-neutral-300 tabular-nums">{t.rows.toLocaleString()} rows</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
