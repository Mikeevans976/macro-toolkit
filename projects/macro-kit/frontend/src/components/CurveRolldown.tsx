import { useMemo, useState } from 'react'
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot, ReferenceLine,
} from 'recharts'
import { chart, series as palette, fg } from '../theme'

// ─── Types (from /api/tools/swaps-rv) ─────────────────────────────────────────

export interface RollLeg {
  label: string            // e.g. "5y10y"
  weight: number           // -1 / +1 for curves, -1 / +2 / -1 for flies
  tenor: number
  start: number
  rate: number             // forward rate today, %
  rolled_label: string     // where it sits in 1y, e.g. "4y10y" or "10y spot"
  rolled_rate: number      // %, read off today's curve
  contribution_bps: number // weight × (rate − rolled_rate) × 100
}

export interface CurveData {
  par_quotes: { tenor: number; rate: number }[]
  par_fitted: { tenor: number; rate: number }[]
  forwards: Record<string, { start: number; rate: number }[]>   // keyed by tenor
}

const MONO = "'Geist Mono', ui-monospace, monospace"

const fmtSigned = (v: number, dp = 1) => `${v > 0 ? '+' : ''}${v.toFixed(dp)}`
const signColor = (v: number) => v > 0 ? '#6fc2a2' : v < 0 ? '#e2826f' : '#c6ced8'

// Y domain fitted to the points in view, padded so markers don't sit on the frame
function fitDomain(values: number[]): [number, number] {
  const lo = Math.min(...values), hi = Math.max(...values)
  const pad = Math.max((hi - lo) * 0.12, 0.02)
  return [lo - pad, hi + pad]
}

// Line from today's point to the rolled point, with an arrowhead at the rolled end
function RollArrow(color: string) {
  return function Arrow(props: { x1?: number; y1?: number; x2?: number; y2?: number }) {
    const { x1 = 0, y1 = 0, x2 = 0, y2 = 0 } = props
    const dx = x2 - x1, dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len, uy = dy / len
    const tipX = x2 - ux * 5, tipY = y2 - uy * 5      // stop short of the hollow marker
    const head = 6
    const p1 = `${tipX},${tipY}`
    const p2 = `${tipX - ux * head - uy * head * 0.6},${tipY - uy * head + ux * head * 0.6}`
    const p3 = `${tipX - ux * head + uy * head * 0.6},${tipY - uy * head - ux * head * 0.6}`
    return (
      <g>
        <line x1={x1} y1={y1} x2={tipX} y2={tipY} stroke={color} strokeWidth={1.5} />
        <polygon points={`${p1} ${p2} ${p3}`} fill={color} />
      </g>
    )
  }
}

function Panel({ title, sub, right, children }: { title: string; sub: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'rgba(200,220,240,0.02)', border: '1px solid rgba(200,220,240,0.06)',
      borderRadius: 6, padding: '12px 16px', minWidth: 0,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
        <div>
          <div style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{title}</div>
          <div style={{ color: '#77828f', fontSize: 11, marginTop: 2 }}>{sub}</div>
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CurveRolldown({ curve, legs, carryBps, asOf }: {
  curve: CurveData
  legs: RollLeg[]
  carryBps: number
  asOf: string
}) {
  const [zoom, setZoom] = useState<'full' | 'legs'>('full')

  // One forward curve per distinct leg tenor, coloured consistently
  const tenors = useMemo(() => [...new Set(legs.map(l => l.tenor))].sort((a, b) => a - b), [legs])
  const tenorColor = (t: number) => palette[tenors.indexOf(t) % palette.length]

  const xDomain: [number, number] = useMemo(() => {
    if (zoom === 'full') return [0, 30]
    const lo = Math.min(...legs.map(l => l.start - 1)), hi = Math.max(...legs.map(l => l.start))
    return [Math.max(0, lo - 2), Math.min(30, hi + 2)]
  }, [zoom, legs])

  const fwdRows = useMemo(() => {
    const byStart = new Map<number, Record<string, number>>()
    for (const t of tenors) {
      for (const p of curve.forwards[String(t)] ?? []) {
        if (p.start < xDomain[0] || p.start > xDomain[1]) continue
        const row = byStart.get(p.start) ?? { start: p.start }
        // Forwards ending past 30y lean on the flat extrapolation: plotted as a dashed tail
        if (p.start + t <= 30) row[`t${t}`] = p.rate
        if (p.start + t >= 30) row[`t${t}x`] = p.rate
        byStart.set(p.start, row)
      }
    }
    return [...byStart.values()].sort((a, b) => a.start - b.start)
  }, [curve.forwards, tenors, xDomain])

  const fwdDomain = useMemo(
    () => fitDomain(fwdRows.flatMap(r => tenors.flatMap(t => [r[`t${t}`], r[`t${t}x`]]).filter((v): v is number => v !== undefined))),
    [fwdRows, tenors],
  )
  const parDomain = useMemo(
    () => fitDomain([...curve.par_fitted.map(p => p.rate), ...curve.par_quotes.map(p => p.rate)]),
    [curve],
  )

  // Spread level today and after a year's roll on an unchanged curve, from the same legs
  const levelNow = legs.reduce((a, l) => a + l.weight * l.rate * 100, 0)
  const levelRolled = legs.reduce((a, l) => a + l.weight * l.rolled_rate * 100, 0)

  const zoomBtn = (key: 'full' | 'legs', text: string) => (
    <button
      key={key}
      onClick={() => setZoom(key)}
      style={{
        background: zoom === key ? 'rgba(106,169,204,0.16)' : 'transparent',
        border: `1px solid ${zoom === key ? 'rgba(106,169,204,0.35)' : 'rgba(200,220,240,0.09)'}`,
        color: zoom === key ? '#e4eaf1' : '#9aa5b1',
        borderRadius: 5, padding: '2px 8px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >{text}</button>
  )

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Curve &amp; roll-down</div>
      <div style={{ color: '#8995a2', fontSize: 12, marginBottom: 12 }}>
        Curve as of {asOf}. Carry assumes this curve stays unchanged for a year: each leg slides one year
        down its own forward curve (start s → s−1).
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12 }}>
        <Panel title="Par OIS curve" sub="Dots: Bloomberg par quotes · line: cubic-spline fit used for discounting (flat beyond 30y)">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={curve.par_fitted} margin={{ top: 8, right: 12, bottom: 16, left: 0 }}>
              <CartesianGrid {...chart.grid} />
              <XAxis dataKey="tenor" type="number" domain={[0, 30]} ticks={[1, 2, 5, 10, 15, 20, 25, 30]} {...chart.axis}
                label={{ value: 'Tenor (y)', position: 'insideBottom', offset: -8, fill: fg[4], fontSize: 10 }} />
              <YAxis domain={parDomain} tickFormatter={(v: number) => v.toFixed(2)} width={44} {...chart.axis} />
              <Tooltip {...chart.tooltip}
                labelFormatter={(v) => `${v}y`}
                formatter={(v: number, name: string) => [`${v.toFixed(3)}%`, name]} />
              <Line dataKey="rate" name="Fitted par" stroke="#86c0de" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Scatter data={curve.par_quotes} dataKey="rate" name="Quote" fill="#e4eaf1" isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>

        <Panel
          title="Forward curves · roll-down"
          sub="f(s, tenor) by forward start s · filled dot: leg today · arrow: where it rolls in 1y · dashed: needs par rates beyond 30y"
          right={<div style={{ display: 'flex', gap: 4 }}>{zoomBtn('full', 'Full')}{zoomBtn('legs', 'Around legs')}</div>}
        >
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={fwdRows} margin={{ top: 8, right: 12, bottom: 16, left: 0 }}>
              <CartesianGrid {...chart.grid} />
              <XAxis dataKey="start" type="number" domain={xDomain} allowDecimals={false} {...chart.axis}
                ticks={zoom === 'full' ? [0, 5, 10, 15, 20, 25, 30] : undefined}
                label={{ value: 'Forward start s (y)', position: 'insideBottom', offset: -8, fill: fg[4], fontSize: 10 }} />
              <YAxis domain={fwdDomain} tickFormatter={(v: number) => v.toFixed(2)} width={44} {...chart.axis} allowDataOverflow />
              <Tooltip {...chart.tooltip}
                labelFormatter={(v) => `start ${v}y`}
                formatter={(v: number, name: string) => [`${v.toFixed(3)}%`, name]} />
              {tenors.map(t => (
                <Line key={t} dataKey={`t${t}`} name={`${t}y forwards`} stroke={tenorColor(t)}
                  strokeWidth={1.5} dot={false} isAnimationActive={false} />
              ))}
              {tenors.map(t => (
                <Line key={`${t}x`} dataKey={`t${t}x`} name={`${t}y fwd (extrap.)`} stroke={tenorColor(t)}
                  strokeWidth={1.2} strokeDasharray="3 3" strokeOpacity={0.6} dot={false} isAnimationActive={false} />
              ))}
              {legs.map(l => (
                <ReferenceLine key={`arrow-${l.label}`} ifOverflow="hidden"
                  segment={[{ x: l.start, y: l.rate }, { x: l.start - 1, y: l.rolled_rate }]}
                  shape={RollArrow(tenorColor(l.tenor))} />
              ))}
              {legs.map(l => (
                <ReferenceDot key={`rolled-${l.label}`} x={l.start - 1} y={l.rolled_rate} r={4}
                  fill="#0b0f14" stroke={tenorColor(l.tenor)} strokeWidth={1.5} ifOverflow="hidden" />
              ))}
              {legs.map(l => (
                <ReferenceDot key={`now-${l.label}`} x={l.start} y={l.rate} r={4.5}
                  fill={tenorColor(l.tenor)} stroke="#0b0f14" ifOverflow="hidden"
                  label={{ value: `${l.weight > 0 ? '+' : ''}${l.weight}× ${l.label}`, position: 'right', offset: 8, fill: fg[2], fontSize: 10, fontFamily: MONO }} />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div style={{ overflowX: 'auto', marginTop: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: '#9aa5b1', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {['Leg', 'Weight', 'Rate today', 'Rolls to', 'Rate in 1y', 'Roll-down (bp)', 'Contribution (bp)'].map((h, i) => (
                <th key={h} style={{ textAlign: i === 0 || i === 3 ? 'left' : 'right', padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody style={{ fontFamily: MONO }}>
            {legs.map(l => {
              const roll = (l.rate - l.rolled_rate) * 100
              return (
                <tr key={l.label} style={{ borderTop: '1px solid rgba(200,220,240,0.05)' }}>
                  <td style={{ padding: '6px 10px', color: '#e4eaf1' }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: tenorColor(l.tenor), marginRight: 8 }} />
                    {l.label}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#c6ced8' }}>{l.weight > 0 ? '+' : ''}{l.weight}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#c6ced8' }}>{l.rate.toFixed(3)}%</td>
                  <td style={{ padding: '6px 10px', color: '#9aa5b1' }}>{l.rolled_label}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#c6ced8' }}>{l.rolled_rate.toFixed(3)}%</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#c6ced8' }}>{fmtSigned(roll, 2)}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: signColor(l.contribution_bps) }}>{fmtSigned(l.contribution_bps, 2)}</td>
                </tr>
              )
            })}
            <tr style={{ borderTop: '1px solid rgba(200,220,240,0.14)' }}>
              <td colSpan={6} style={{ padding: '7px 10px', color: '#9aa5b1', fontFamily: 'inherit' }}>
                Carry (1y) = Σ contributions · spread {levelNow.toFixed(1)} bp → {levelRolled.toFixed(1)} bp in 1y on an unchanged curve
              </td>
              <td style={{ padding: '7px 10px', textAlign: 'right', color: signColor(carryBps), fontWeight: 600 }}>{fmtSigned(carryBps, 2)}</td>
            </tr>
          </tbody>
        </table>
        <div style={{ color: '#77828f', fontSize: 11, marginTop: 6 }}>
          Roll-down = rate today − rate in 1y (positive: the rate rolls lower, good for a receiver). Contribution = weight × roll-down;
          positive total carry favours the receiver of the structure (flattener for curves).
        </div>
      </div>
    </div>
  )
}
