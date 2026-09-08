import { useId, useLayoutEffect, useRef, useState } from 'react'

/**
 * Chart primitives, hand-rolled in SVG.
 *
 * No charting library, deliberately. The data here is tens to hundreds of
 * points, and the mark specs that make these readable (4px rounded data-ends
 * anchored to the baseline, a 2px surface gap between stacked segments, 2px
 * lines, recessive grid) are less code to write directly than to force onto a
 * library's defaults. It also keeps a ~100 KB dependency out of a project whose
 * whole posture is a small surface.
 *
 * Colours come from the validated categorical palette, slots 1 and 2 stepped
 * for a dark surface. Verified against #171717: worst-pair CVD deltaE 26.8,
 * normal-vision 31.8, both well clear of the floors.
 */
export const SERIES = {
  /** slot 1, blue */
  one: '#3987e5',
  /** slot 2, orange */
  two: '#d95926',
} as const

/** Text wears text tokens, never a series colour. */
const INK = { primary: '#e5e5e5', secondary: '#a3a3a3', muted: '#737373' } as const
const GRID = '#262626'
const SURFACE = '#171717'

/**
 * The chart's own width, in CSS pixels.
 *
 * WHY MEASURED, AND NOT A STRETCHED viewBox. Both SVG charts used a fixed
 * 800-unit viewBox with `w-full`, which asks the browser to scale the entire
 * drawing to whatever width it lands in. On a 32-inch monitor the wide chart
 * stretched to about 1770px, so its `fontSize={9}` axis labels rendered at
 * twenty-odd pixels - twice the size of the app's own text sitting beside them -
 * and the bars grew with them. The chart was not too big; it was drawn at a
 * different scale from everything around it.
 *
 * Measuring makes one SVG unit one CSS pixel. Axis labels are then 9px in every
 * window, and they scale with the interface scale exactly like the rest of the
 * type, because CSS pixels are what the zoom factor acts on.
 */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      // contentRect is in CSS pixels, which is the unit the SVG will draw in.
      setWidth(Math.max(0, Math.round(entries[0]?.contentRect.width ?? 0)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}

export function formatMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms >= 1_000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

export function Legend({ items }: { items: { label: string; color: string }[] }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-[2px]" style={{ background: i.color }} />
          <span className="text-[11px] text-neutral-400">{i.label}</span>
        </span>
      ))}
    </div>
  )
}

export function ChartFrame({
  title,
  subtitle,
  legend,
  children,
  empty,
}: {
  title: string
  subtitle?: string
  legend?: { label: string; color: string }[]
  children: React.ReactNode
  empty?: string
}): React.JSX.Element {
  return (
    <section className="lift rounded-xl bg-white/[0.035] p-4 ring-1 ring-white/[0.08]">
      <header className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[13px] font-semibold text-neutral-100">{title}</h3>
          {subtitle && <p className="text-[11px] text-neutral-500">{subtitle}</p>}
        </div>
        {legend && legend.length >= 2 && <Legend items={legend} />}
      </header>
      {empty ? (
        <p className="py-10 text-center text-[12px] text-neutral-600">{empty}</p>
      ) : (
        children
      )}
    </section>
  )
}

/** A headline number. The form heuristic says this is a stat tile, not a chart. */
export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'good' | 'warn'
}): React.JSX.Element {
  const valueColor =
    tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-neutral-100'
  return (
    <div className="lift rounded-xl bg-white/[0.035] px-4 py-3 ring-1 ring-white/[0.08]">
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className={`mt-0.5 font-mono text-xl tabular-nums ${valueColor}`}>{value}</div>
      {hint && <div className="text-[10px] text-neutral-600">{hint}</div>}
    </div>
  )
}

interface Tip {
  x: number
  y: number
  lines: string[]
}

function Tooltip({ tip, width }: { tip: Tip; width: number }): React.JSX.Element {
  // Flip before the right edge so the tooltip never leaves the plot.
  const flip = tip.x > width * 0.6
  return (
    <foreignObject
      x={flip ? tip.x - 172 : tip.x + 8}
      y={Math.max(2, tip.y - 12)}
      width={168}
      height={78}
      style={{ pointerEvents: 'none', overflow: 'visible' }}
    >
      <div className="rounded-lg bg-neutral-950/95 px-2.5 py-1.5 text-[11px] leading-snug ring-1 ring-white/15">
        {tip.lines.map((l, i) => (
          <div key={i} className={i === 0 ? 'font-medium text-neutral-200' : 'text-neutral-400'}>
            {l}
          </div>
        ))}
      </div>
    </foreignObject>
  )
}

export interface StackedPoint {
  label: string
  /** Bottom segment. */
  a: number
  /** Top segment. */
  b: number
  meta?: string
}

/**
 * Stacked bars: two segments per bar, magnitude plus composition.
 *
 * The 2px gap between segments is a surface-coloured spacer, not a stroke, so
 * the boundary reads without adding a line weight that competes with the data.
 * Only the topmost end is rounded; the baseline end stays square because a bar
 * is anchored to zero and a rounded foot implies it floats.
 */
export function StackedBars({
  data,
  labels,
  height = 148,
}: {
  data: StackedPoint[]
  labels: [string, string]
  height?: number
}): React.JSX.Element {
  const [tip, setTip] = useState<Tip | null>(null)
  const clipId = useId()
  const [ref, width] = useWidth()

  const padTop = 10
  const padBottom = 18
  const padLeft = 44
  const plotH = height - padTop - padBottom
  const plotW = width - padLeft - 8

  const max = Math.max(...data.map((d) => d.a + d.b), 1)
  const stepX = plotW / Math.max(data.length, 1)
  // Width follows the step rather than a constant. Fifteen 16px bars spread
  // across a 32-inch monitor's 1200px panel is a fifth of the plot inked and
  // four fifths gap, which reads as a sparse scatter rather than a comparison.
  const barW = Math.max(3, Math.min(26, stepX * 0.55))

  const ticks = [0, max / 2, max]

  return (
    // The height is reserved before the width is known, so the first paint does
    // not push everything below the chart down by 148px a frame later.
    <div ref={ref} className="relative" style={{ height }}>
      {width > 0 && (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={width} height={height} />
          </clipPath>
        </defs>

        {ticks.map((t, i) => {
          const y = padTop + plotH - (t / max) * plotH
          return (
            <g key={i}>
              <line x1={padLeft} x2={width - 8} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
              <text x={padLeft - 6} y={y + 3} textAnchor="end" fontSize={9} fill={INK.muted}>
                {formatMs(t)}
              </text>
            </g>
          )
        })}

        {data.map((d, i) => {
          const total = d.a + d.b
          const x = padLeft + i * stepX + (stepX - barW) / 2
          const hA = (d.a / max) * plotH
          const hB = (d.b / max) * plotH
          const yA = padTop + plotH - hA
          // 2px surface gap between the segments.
          const yB = yA - hB - 2
          const r = Math.min(4, barW / 2)

          const show = () =>
            setTip({
              x,
              y: yB,
              lines: [d.label, `${labels[0]} ${formatMs(d.a)}`, `${labels[1]} ${formatMs(d.b)}`, `total ${formatMs(total)}`],
            })

          return (
            <g key={i} onMouseEnter={show} onMouseLeave={() => setTip(null)}>
              {/* Hit target wider than the mark. */}
              <rect
                x={padLeft + i * stepX}
                y={padTop}
                width={stepX}
                height={plotH}
                fill="transparent"
              />
              <rect x={x} y={yA} width={barW} height={Math.max(hA, 1)} fill={SERIES.one} />
              {hB > 0.5 && (
                <path
                  d={`M ${x} ${yB + hB} L ${x} ${yB + r} Q ${x} ${yB} ${x + r} ${yB} L ${x + barW - r} ${yB} Q ${x + barW} ${yB} ${x + barW} ${yB + r} L ${x + barW} ${yB + hB} Z`}
                  fill={SERIES.two}
                />
              )}
            </g>
          )
        })}

        <line
          x1={padLeft}
          x2={width - 8}
          y1={padTop + plotH}
          y2={padTop + plotH}
          stroke={GRID}
          strokeWidth={1}
        />
        {tip && <Tooltip tip={tip} width={width} />}
      </svg>
      )}
    </div>
  )
}

export interface SeriesPoint {
  at: number
  value: number
}

/**
 * A single line with a soft fill and a threshold reference.
 *
 * One series, so no legend: the title names it. The ceiling is drawn as a
 * recessive dashed rule in muted ink rather than a status colour, because a
 * capacity line is context, not an alarm; the y-axis topping out at capacity is
 * what makes headroom legible.
 */
export function LineChart({
  data,
  ceiling,
  ceilingLabel,
  unit,
  height = 148,
}: {
  data: SeriesPoint[]
  ceiling?: number
  ceilingLabel?: string
  unit: string
  height?: number
}): React.JSX.Element {
  const [tip, setTip] = useState<Tip | null>(null)
  const gradId = useId()
  const [ref, width] = useWidth()

  const padTop = 10
  const padBottom = 18
  const padLeft = 44
  const plotH = height - padTop - padBottom
  const plotW = width - padLeft - 8

  const max = Math.max(ceiling ?? 0, ...data.map((d) => d.value), 1)
  const x = (i: number) => padLeft + (i / Math.max(data.length - 1, 1)) * plotW
  const y = (v: number) => padTop + plotH - (v / max) * plotH

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d.value)}`).join(' ')
  const area = data.length
    ? `${line} L ${x(data.length - 1)} ${padTop + plotH} L ${x(0)} ${padTop + plotH} Z`
    : ''

  return (
    <div ref={ref} className="relative" style={{ height }}>
      {width > 0 && (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={SERIES.one} stopOpacity={0.28} />
          <stop offset="100%" stopColor={SERIES.one} stopOpacity={0} />
        </linearGradient>
      </defs>

      {[0, max / 2, max].map((t, i) => (
        <g key={i}>
          <line x1={padLeft} x2={width - 8} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
          <text x={padLeft - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill={INK.muted}>
            {Math.round(t)}
          </text>
        </g>
      ))}

      {ceiling !== undefined && (
        <g>
          <line
            x1={padLeft}
            x2={width - 8}
            y1={y(ceiling)}
            y2={y(ceiling)}
            stroke={INK.muted}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          {ceilingLabel && (
            <text x={width - 10} y={y(ceiling) - 4} textAnchor="end" fontSize={9} fill={INK.muted}>
              {ceilingLabel}
            </text>
          )}
        </g>
      )}

      {area && <path d={area} fill={`url(#${gradId})`} />}
      {data.length > 1 && (
        <path d={line} fill="none" stroke={SERIES.one} strokeWidth={2} strokeLinejoin="round" />
      )}

      {data.map((d, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(d.value)}
          r={8}
          fill="transparent"
          onMouseEnter={() =>
            setTip({
              x: x(i),
              y: y(d.value),
              lines: [
                new Date(d.at).toLocaleTimeString(),
                `${Math.round(d.value)} ${unit}`,
                ceiling ? `${Math.round(ceiling - d.value)} ${unit} free` : '',
              ].filter(Boolean),
            })
          }
          onMouseLeave={() => setTip(null)}
        />
      ))}

      {tip && (
        <>
          <circle cx={tip.x} cy={tip.y} r={3.5} fill={SERIES.one} stroke={SURFACE} strokeWidth={2} />
          <Tooltip tip={tip} width={width} />
        </>
      )}
    </svg>
      )}
    </div>
  )
}

/**
 * Horizontal bars where the CATEGORY AXIS carries identity, so one colour.
 *
 * Using two series colours here would invite reading them as the same encoding
 * as the stacked chart above, where blue means ASR. Identity belongs to the
 * label; colour would be decoration that actively misleads.
 */
export function CompareBars({
  rows,
  unit = 'ms',
}: {
  rows: { label: string; value: number; n: number }[]
  unit?: string
}): React.JSX.Element {
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3">
          <span className="truncate text-[12px] text-neutral-300">{r.label}</span>
          <div className="h-5 overflow-hidden rounded-[4px] bg-neutral-800/60">
            <div
              className="h-full rounded-r-[4px]"
              style={{ width: `${Math.max((r.value / max) * 100, 1.5)}%`, background: SERIES.one }}
            />
          </div>
          <span className="font-mono text-[11px] tabular-nums text-neutral-300">
            {unit === 'ms' ? formatMs(r.value) : `${Math.round(r.value)}${unit}`}
            <span className="ml-1.5 text-neutral-600">n={r.n}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
