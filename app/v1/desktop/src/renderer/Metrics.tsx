import { useEffect, useMemo, useState } from 'react'
import type { MetricsSnapshot } from '../shared/ipc.js'
import {
  ChartFrame,
  CompareBars,
  LineChart,
  SERIES,
  Stat,
  StackedBars,
  formatMs,
} from './charts/primitives.js'

/**
 * Live monitoring.
 *
 * Order is deliberate: what the machine is doing RIGHT NOW comes first - GPU
 * headroom and which speech model is actually faster - because those are the
 * two things worth glancing at while the app is running. The per-dictation
 * breakdown is a look back at recent work and reads better underneath, above
 * the history it explains.
 *
 * The headline figures come from SQL over the whole history rather than from
 * whatever is loaded here. The previous version averaged the in-memory buffer,
 * so "median end to end" quietly meant "median of the last two thousand".
 */

const EMPTY: MetricsSnapshot = {
  dictations: [],
  resources: [],
  summary: { count: 0, p50Ms: 0, p95Ms: 0, degraded: 0, chars: 0 },
  byAsrModel: [],
}

export function Metrics(): React.JSX.Element {
  const [snap, setSnap] = useState<MetricsSnapshot>(EMPTY)

  useEffect(() => {
    const load = (): void => {
      void window.wouice.getMetrics().then(setSnap)
    }
    load()
    const off = window.wouice.onMetric(load)
    // Resource samples arrive on their own cadence; a slow poll keeps the VRAM
    // line moving without pushing an IPC message per sample.
    const timer = setInterval(load, 5_000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])

  const { summary, resources, dictations, byAsrModel } = snap

  const vram = useMemo(
    () => resources.map((r) => ({ at: r.at, value: r.vramUsedMiB })),
    [resources]
  )
  const vramTotal = resources.at(-1)?.vramTotalMiB ?? 6144
  const vramNow = resources.at(-1)?.vramUsedMiB ?? 0
  const headroom = vramTotal - vramNow
  const degradeRate = summary.count ? (summary.degraded / summary.count) * 100 : 0

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Median end to end"
          value={summary.count ? formatMs(summary.p50Ms) : '—'}
          hint={summary.count ? `p95 ${formatMs(summary.p95Ms)}` : 'no dictations yet'}
          tone={summary.p50Ms > 0 && summary.p50Ms < 2500 ? 'good' : summary.p50Ms ? 'warn' : 'neutral'}
        />
        <Stat
          label="Dictations"
          value={String(summary.count)}
          hint={`${summary.chars.toLocaleString()} chars produced`}
        />
        <Stat
          label="Degraded"
          value={summary.count ? `${degradeRate.toFixed(0)}%` : '—'}
          hint="fell back to rule-based text"
          tone={degradeRate > 20 ? 'warn' : 'neutral'}
        />
        <Stat
          label="VRAM headroom"
          value={vramTotal ? `${headroom} MiB` : '—'}
          hint={`${vramNow} of ${vramTotal} MiB in use`}
          tone={headroom < 300 ? 'warn' : 'good'}
        />
      </div>

      {/* What the machine is doing now, before the look back at recent work. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartFrame
          title="GPU memory"
          subtitle={`Against this card's ${vramTotal} MiB`}
          empty={vram.length < 2 ? 'Sampling. A line appears within a minute.' : undefined}
        >
          <LineChart data={vram} ceiling={vramTotal} ceilingLabel={`${vramTotal} MiB`} unit="MiB" />
        </ChartFrame>

        <ChartFrame
          title="Speech model, measured in real use"
          subtitle="Mean recognition time per model. Switch in the tray to compare."
          empty={
            byAsrModel.length === 0
              ? 'No data yet.'
              : byAsrModel.length === 1
                ? `Only ${byAsrModel[0]?.model} has been used. Switch models in the tray to compare.`
                : undefined
          }
        >
          <CompareBars rows={byAsrModel.map((m) => ({ label: m.model, value: m.meanMs, n: m.n }))} />
        </ChartFrame>
      </div>

      <ChartFrame
        title="Where the time goes"
        subtitle={`Last ${dictations.length} dictations, speech recognition versus cleanup`}
        legend={[
          { label: 'ASR', color: SERIES.one },
          { label: 'LLM cleanup', color: SERIES.two },
        ]}
        empty={
          dictations.length === 0 ? 'Dictate something and the breakdown appears here.' : undefined
        }
      >
        <StackedBars
          data={dictations.map((d) => ({
            label: `${(d.audioMs / 1000).toFixed(1)}s audio${d.chunks ? ` · ${d.chunks} chunks` : ''}`,
            a: d.asrMs,
            b: d.llmMs,
          }))}
          labels={['ASR', 'LLM']}
        />
      </ChartFrame>
    </div>
  )
}
