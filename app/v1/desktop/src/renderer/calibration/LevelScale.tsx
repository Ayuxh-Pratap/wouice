import { SERIES } from '../charts/primitives.js'

/**
 * Where the gate sits relative to the room and the voice.
 *
 * ON A LOG AXIS, because the numbers span two or three orders of magnitude and
 * because that is the scale the threshold is chosen on. Drawn linearly, the
 * quiet cluster and the gate would both collapse into the first two pixels and
 * the picture would show nothing.
 *
 * The one thing this has to make obvious is whether the gate falls BETWEEN the
 * two clusters. That was the original bug: a gate sitting above the median
 * speech frame, which no number in isolation made apparent.
 */

const INK = { primary: '#e5e5e5', secondary: '#a3a3a3', muted: '#737373' } as const
const GRID = '#262626'

const W = 600
const H = 104
const PAD = 28
const AXIS_Y = 62

function fmt(v: number): string {
  return v.toFixed(5)
}

export function LevelScale({
  silenceLevel,
  speechLevel,
  threshold,
  previousThreshold,
}: {
  silenceLevel: number
  speechLevel: number
  threshold: number
  previousThreshold: number
}): React.JSX.Element {
  // A zero level would take log to -Infinity. Clamp to something below any
  // believable microphone floor rather than dropping the mark.
  const safe = (v: number): number => Math.max(v, 1e-6)
  const values = [silenceLevel, speechLevel, threshold, previousThreshold].map(safe)
  const lo = Math.log10(Math.min(...values) / 3)
  const hi = Math.log10(Math.max(...values) * 3)

  const x = (v: number): number => PAD + ((Math.log10(safe(v)) - lo) / (hi - lo)) * (W - PAD * 2)

  const xSilence = x(silenceLevel)
  const xSpeech = x(speechLevel)
  const xGate = x(threshold)
  const xPrev = x(previousThreshold)

  // Decade gridlines, so the log scale is legible as a scale rather than a
  // rubber band with marks on it.
  const decades: number[] = []
  for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) decades.push(10 ** e)

  const prevIsDistinct = Math.abs(xPrev - xGate) > 46
  const gateInGap = threshold > silenceLevel && threshold < speechLevel

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[104px] w-full min-w-[420px]" role="img">
        {decades.map((d) => (
          <g key={d}>
            <line x1={x(d)} y1={30} x2={x(d)} y2={AXIS_Y + 6} stroke={GRID} strokeWidth={1} />
            <text x={x(d)} y={H - 20} textAnchor="middle" fill={INK.muted} fontSize={9}>
              {d < 0.001 ? d.toExponential(0) : d.toString()}
            </text>
          </g>
        ))}

        {/* The gap the gate has to land in. */}
        <rect
          x={Math.min(xSilence, xSpeech)}
          y={AXIS_Y - 9}
          width={Math.abs(xSpeech - xSilence)}
          height={18}
          fill="#ffffff"
          fillOpacity={0.04}
        />
        <line x1={PAD} y1={AXIS_Y} x2={W - PAD} y2={AXIS_Y} stroke={GRID} strokeWidth={2} />

        {/* Previous gate, muted and dashed: context, not a reading. */}
        <line
          x1={xPrev}
          y1={AXIS_Y - 16}
          x2={xPrev}
          y2={AXIS_Y + 16}
          stroke={INK.muted}
          strokeWidth={2}
          strokeDasharray="3 3"
        />
        {prevIsDistinct && (
          <text x={xPrev} y={AXIS_Y + 30} textAnchor="middle" fill={INK.muted} fontSize={9}>
            was {fmt(previousThreshold)}
          </text>
        )}

        {/* The new gate. */}
        <line
          x1={xGate}
          y1={AXIS_Y - 22}
          x2={xGate}
          y2={AXIS_Y + 22}
          stroke={gateInGap ? INK.primary : '#f87171'}
          strokeWidth={2}
        />
        <text
          x={xGate}
          y={AXIS_Y + 34}
          textAnchor="middle"
          fill={gateInGap ? INK.primary : '#f87171'}
          fontSize={10}
          fontWeight={600}
        >
          gate {fmt(threshold)}
        </text>

        {/* The two clusters. 2px surface ring so a mark on the axis line still
            reads as a mark. */}
        {(
          [
            { cx: xSilence, color: SERIES.one, label: `room ${fmt(silenceLevel)}`, anchor: 'start' },
            { cx: xSpeech, color: SERIES.two, label: `voice ${fmt(speechLevel)}`, anchor: 'end' },
          ] as const
        ).map((m) => (
          <g key={m.label}>
            <circle cx={m.cx} cy={AXIS_Y} r={5} fill={m.color} stroke="#171717" strokeWidth={2} />
            <text
              x={m.cx}
              y={AXIS_Y - 18}
              textAnchor={m.anchor === 'start' ? 'start' : 'end'}
              fill={INK.secondary}
              fontSize={10}
            >
              {m.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
