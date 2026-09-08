import type { SidecarView } from '../../shared/ipc.js'
import { SIDECARS } from '../../shared/models.js'

/**
 * Which speech and language model is running, and the controls to change them.
 *
 * Lives on the settings page rather than the dashboard: choosing a model is a
 * decision you make occasionally, not a number you glance at. The status pill
 * and the restart button stay with it because when a model is wrong the next
 * question is always whether it is even running.
 */

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  starting: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  restarting: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  failed: 'bg-red-500/15 text-red-300 ring-red-500/30',
  stopped: 'bg-neutral-500/15 text-neutral-400 ring-neutral-500/30',
}

function Pill({ status }: { status: string }): React.JSX.Element {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
        STATUS_STYLE[status] ?? STATUS_STYLE.stopped
      }`}
    >
      {status}
    </span>
  )
}

export function SidecarCard({
  view,
  onSwitch,
  onRestart,
}: {
  view: SidecarView
  onSwitch: (modelId: string) => void
  onRestart: () => void
}): React.JSX.Element {
  const def = SIDECARS[view.id]
  const title = view.id === 'whisper' ? 'Speech recognition' : 'Language model'

  return (
    <section className="lift rounded-xl bg-white/[0.035] p-4 ring-1 ring-white/[0.08]">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
          <p className="font-mono text-[11px] text-neutral-500">
            127.0.0.1:{view.port}
            {view.pid ? ` · pid ${view.pid}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill status={view.status} />
          <button
            onClick={onRestart}
            className="rounded-md px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-neutral-200"
          >
            Restart
          </button>
        </div>
      </header>

      <div className="space-y-1.5">
        {def.models.map((m) => {
          const isActive = m.id === view.modelId
          const isQueued = m.id === view.pendingModelId
          return (
            <button
              key={m.id}
              onClick={() => onSwitch(m.id)}
              className={[
                'flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition',
                isActive
                  ? 'lift-active bg-white/[0.08] ring-1 ring-white/[0.12]'
                  : 'hover:bg-white/5',
              ].join(' ')}
            >
              <span
                className={[
                  'mt-1 size-2 shrink-0 rounded-full',
                  isActive ? 'bg-emerald-400' : isQueued ? 'bg-amber-400' : 'bg-neutral-700',
                ].join(' ')}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium text-neutral-100">{m.label}</span>
                  <span className="font-mono text-[10px] text-neutral-500">{m.vramMiB} MiB</span>
                  {isQueued && (
                    <span className="text-[10px] text-amber-400">switching when idle</span>
                  )}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">
                  {m.note}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {view.lastError && (
        <p className="mt-3 rounded-md bg-red-500/10 p-2 font-mono text-[11px] leading-snug text-red-300">
          {view.lastError}
        </p>
      )}
    </section>
  )
}
