import { useEffect, useMemo, useState } from 'react'
import type { DictationMetric, ResourceMetric } from '../shared/ipc.js'
import {
  ChartFrame,
  CompareBars,
  LineChart,
  SERIES,
  Stat,
  StackedBars,
  formatMs,
} from './charts/primitives.js'

const RECENT = 30

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i] ?? 0
}

export function Metrics(): React.JSX.Element {
  const [dictations, setDictations] = useState<DictationMetric[]>([])
  const [resources, setResources] = useState<ResourceMetric[]>([])

  useEffect(() => {
    const load = (): void => {
      void window.wouice.getMetrics().then((m) => {
        setDictations(m.dictations)
        setResources(m.resources)
      })
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

  const recent = useMemo(() => dictations.slice(-RECENT), [dictations])

  const stats = useMemo(() => {
    const totals = dictations.map((d) => d.asrMs + d.llmMs)
    const degraded = dictations.filter((d) => d.degraded).length
    const words = dictations.reduce((n, d) => n + d.finalChars, 0)
    return {
      count: dictations.length,
      p50: percentile(totals, 50),
      p95: percentile(totals, 95),
      degradeRate: dictations.length ? (degraded / dictations.length) * 100 : 0,
      chars: words,
    }
  }, [dictations])

  /** The A8c experiment: which ASR model is actually faster in real use. */
  const byAsrModel = useMemo(() => {
    const groups = new Map<string, number[]>()
    for (const d of dictations) {
      const list = groups.get(d.asrModel) ?? []
      list.push(d.asrMs)
      groups.set(d.asrModel, list)
    }
    return [...groups.entries()]
      .map(([label, ms]) => ({
        label,
        value: ms.reduce((a, b) => a + b, 0) / ms.length,
        n: ms.length,
      }))
      .sort((a, b) => a.value - b.value)
  }, [dictations])

  const vram = useMemo(
    () => resources.slice(-60).map((r) => ({ at: r.at, value: r.vramUsedMiB })),
    [resources]
  )
  const vramTotal = resources.at(-1)?.vramTotalMiB ?? 6144
  const vramNow = resources.at(-1)?.vramUsedMiB ?? 0
  const headroom = vramTotal - vramNow

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Median end to end"
          value={stats.count ? formatMs(stats.p50) : '—'}
          hint={stats.count ? `p95 ${formatMs(stats.p95)}` : 'no dictations yet'}
          tone={stats.p50 > 0 && stats.p50 < 2500 ? 'good' : stats.p50 ? 'warn' : 'neutral'}
        />
        <Stat label="Dictations" value={String(stats.count)} hint={`${stats.chars} chars produced`} />
        <Stat
          label="Degraded"
          value={stats.count ? `${stats.degradeRate.toFixed(0)}%` : '—'}
          hint="fell back to rule-based text"
          tone={stats.degradeRate > 20 ? 'warn' : 'neutral'}
        />
        <Stat
          label="VRAM headroom"
          value={vramTotal ? `${headroom} MiB` : '—'}
          hint={`${vramNow} of ${vramTotal} MiB in use`}
          tone={headroom < 300 ? 'warn' : 'good'}
        />
      </div>

      <ChartFrame
        title="Where the time goes"
        subtitle={`Last ${Math.min(recent.length, RECENT)} dictations, speech recognition versus cleanup`}
        legend={[
          { label: 'ASR', color: SERIES.one },
          { label: 'LLM cleanup', color: SERIES.two },
        ]}
        empty={recent.length === 0 ? 'Dictate something and the breakdown appears here.' : undefined}
      >
        <StackedBars
          data={recent.map((d, i) => ({
            label: `#${dictations.length - recent.length + i + 1} · ${(d.audioMs / 1000).toFixed(1)}s audio${d.chunks ? ` · ${d.chunks} chunks` : ''}`,
            a: d.asrMs,
            b: d.llmMs,
          }))}
          labels={['ASR', 'LLM']}
        />
      </ChartFrame>

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
          subtitle="Mean ASR time per model. Switch in the tray to compare."
          empty={
            byAsrModel.length === 0
              ? 'No data yet.'
              : byAsrModel.length === 1
                ? `Only ${byAsrModel[0]?.label} has been used. Switch models in the tray to compare.`
                : undefined
          }
        >
          <CompareBars rows={byAsrModel} />
        </ChartFrame>
      </div>
    </div>
  )
}
