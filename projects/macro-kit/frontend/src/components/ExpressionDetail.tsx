// Shared drill-down for an RV expression: time series with σ bands, level
// distribution, and summary statistics over a selectable lookback.
// Used by the Swap RV and EGB RV monitors.

import { useMemo, useState, type ReactNode } from 'react'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'

export interface SeriesPoint {
  date: string
  value: number
}

export interface StatItem {
  label: string
  value: ReactNode
  color?: string
  sub?: string
}

export interface StatGroupDef {
  title: string
  items: StatItem[]
}

const MONO = "'Geist Mono', ui-monospace, monospace"

const LOOKBACKS: { key: string; n: number }[] = [
  { key: '3M',  n: 63 },
  { key: '6M',  n: 126 },
  { key: '1Y',  n: 252 },
  { key: '2Y',  n: 504 },
  { key: '5Y',  n: 1260 },
  { key: 'All', n: Infinity },
]

// ─── Colour helpers (same scales as the monitor tables) ──────────────────────

function zscoreColor(z: number): string {
  if (z > 1.5)   return '#e2826f'
  if (z > 0.75)  return '#dfbb78'
  if (z < -1.5)  return '#6fc2a2'
  if (z < -0.75) return '#8fd1b6'
  return '#c6ced8'
}

function pctileColor(p: number): string {
  if (p > 75) return '#e2826f'
  if (p < 25) return '#6fc2a2'
  return '#dfbb78'
}

export const fmtBp = (v: number, dp = 1) => `${v.toFixed(dp)} bp`
export const fmtSignedBp = (v: number | null) => v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} bp`
export const signColor = (v: number | null) => v === null ? '#8995a2' : v > 0 ? '#e2826f' : v < 0 ? '#6fc2a2' : '#c6ced8'

// ─── Statistics ───────────────────────────────────────────────────────────────

interface WindowStats {
  current: number
  mean: number
  median: number
  std: number
  min: number
  minDate: string
  max: number
  maxDate: string
  zscore: number
  pctile: number
  rangePos: number
  rvolDaily: number   // std of daily changes; scaled by √t for longer horizons
  bigUp: number
  bigDown: number
  ar1: number | null
  halfLife: number | null
}

function computeWindowStats(pts: SeriesPoint[]): WindowStats {
  const v = pts.map(p => p.value)
  const n = v.length
  const current = v[n - 1]
  const mean = v.reduce((a, b) => a + b, 0) / n
  const std = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const sorted = [...v].sort((a, b) => a - b)
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  let iMin = 0, iMax = 0
  v.forEach((x, i) => { if (x < v[iMin]) iMin = i; if (x > v[iMax]) iMax = i })
  const min = v[iMin], max = v[iMax]

  const d = v.slice(1).map((x, i) => x - v[i])
  const dMean = d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0
  const dStd = d.length > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - dMean) ** 2, 0) / (d.length - 1)) : 0

  // AR(1) on levels: x_t = a + b·x_{t-1} → half-life = −ln2 / ln b
  let ar1: number | null = null
  let halfLife: number | null = null
  if (n > 10) {
    const x = v.slice(0, -1), y = v.slice(1)
    const mx = x.reduce((a, b) => a + b, 0) / x.length
    const my = y.reduce((a, b) => a + b, 0) / y.length
    let sxy = 0, sxx = 0
    for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2 }
    if (sxx > 0) {
      ar1 = sxy / sxx
      if (ar1 > 0 && ar1 < 1) halfLife = -Math.LN2 / Math.log(ar1)
    }
  }

  return {
    current, mean, median, std, min, max,
    minDate: pts[iMin].date, maxDate: pts[iMax].date,
    zscore: std > 0 ? (current - mean) / std : 0,
    pctile: (v.filter(x => x <= current).length / n) * 100,
    rangePos: max > min ? ((current - min) / (max - min)) * 100 : 50,
    rvolDaily: dStd,
    bigUp: d.length ? Math.max(...d) : 0,
    bigDown: d.length ? Math.min(...d) : 0,
    ar1, halfLife,
  }
}

function buildHistogram(values: number[], current: number, bins = 24) {
  const lo = Math.min(...values), hi = Math.max(...values)
  const width = (hi - lo) / bins || 1
  const counts = new Array(bins).fill(0)
  values.forEach(x => { counts[Math.min(bins - 1, Math.floor((x - lo) / width))]++ })
  const curBin = Math.min(bins - 1, Math.floor((current - lo) / width))
  return counts.map((c, i) => ({
    mid: lo + (i + 0.5) * width,
    lo: lo + i * width,
    hi: lo + (i + 1) * width,
    pct: (c / values.length) * 100,
    isCurrent: i === curBin,
  }))
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

const tooltipBox: React.CSSProperties = {
  background: 'rgba(7,9,12,0.96)',
  border: '1px solid rgba(200,220,240,0.12)',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 12,
}

function LineTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={tooltipBox}>
      <div style={{ color: '#9aa5b1', marginBottom: 2 }}>{d.date}</div>
      <div style={{ color: '#eef2f6', fontFamily: MONO }}>{(d.value as number).toFixed(1)} bp</div>
    </div>
  )
}

function HistTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={tooltipBox}>
      <div style={{ color: '#9aa5b1', marginBottom: 2, fontFamily: MONO }}>{d.lo.toFixed(1)} – {d.hi.toFixed(1)} bp</div>
      <div style={{ color: '#eef2f6', fontFamily: MONO }}>{d.pct.toFixed(1)}% of days</div>
    </div>
  )
}

const thCell: React.CSSProperties = {
  position: 'sticky', top: 0, background: '#0d1116', color: '#9aa5b1', fontSize: 10, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: '0.06em', padding: '8px 12px', textAlign: 'right',
  borderBottom: '1px solid rgba(200,220,240,0.08)',
}
const tdCell: React.CSSProperties = {
  padding: '5px 12px', fontSize: 12, fontFamily: MONO, textAlign: 'right',
  borderBottom: '1px solid rgba(200,220,240,0.04)',
}

// Same window as the chart, newest first; z-score is against the window's mean/std
function SeriesTable({ points, mean, std, height }: {
  points: SeriesPoint[]; mean: number; std: number; height: number
}) {
  const rows = useMemo(() => points.map((p, i) => ({
    ...p,
    d1: i > 0 ? p.value - points[i - 1].value : null,
    z: std > 0 ? (p.value - mean) / std : 0,
  })).reverse(), [points, mean, std])
  return (
    <div style={{ height, overflowY: 'auto', border: '1px solid rgba(200,220,240,0.06)', borderRadius: 6 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...thCell, textAlign: 'left' }}>Date</th>
            <th style={thCell}>Level (bp)</th>
            <th style={thCell}>Δ1d (bp)</th>
            <th style={thCell}>Z-score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.date}>
              <td style={{ ...tdCell, textAlign: 'left', color: '#c6ced8' }}>{r.date}</td>
              <td style={{ ...tdCell, color: '#eef2f6' }}>{r.value.toFixed(1)}</td>
              <td style={{ ...tdCell, color: signColor(r.d1) }}>{r.d1 === null ? '—' : `${r.d1 > 0 ? '+' : ''}${r.d1.toFixed(1)}`}</td>
              <td style={{ ...tdCell, color: zscoreColor(r.z) }}>{r.z.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function fmtAxisDate(d: string): string {
  const dt = new Date(d)
  return dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
}

// Realised vol scaled by √t to several horizons, each number under its horizon label
function VolHorizons({ daily }: { daily: number }) {
  const horizons: [string, number][] = [['ann', 252], ['3m', 63], ['1m', 21], ['1d', 1]]
  return (
    <span style={{ display: 'inline-flex', gap: 10 }}>
      {horizons.map(([tag, t]) => (
        <span key={tag} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.15 }}>
          <span style={{ color: '#77828f', fontSize: 9, fontFamily: MONO }}>{tag}</span>
          <span style={{ color: '#e4eaf1', fontSize: 12, fontFamily: MONO }}>{(daily * Math.sqrt(t)).toFixed(1)}</span>
        </span>
      ))}
    </span>
  )
}

function StatGroup({ title, items }: StatGroupDef) {
  return (
    <div style={{
      background: 'rgba(200,220,240,0.02)',
      border: '1px solid rgba(200,220,240,0.06)',
      borderRadius: 6, padding: '12px 16px',
    }}>
      <div style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, fontWeight: 600 }}>{title}</div>
      {items.map(({ label, value, color, sub }) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: typeof value === 'string' ? 'baseline' : 'center', padding: '4px 0', gap: 12 }}>
          <span style={{ color: '#9aa5b1', fontSize: 12, whiteSpace: 'nowrap' }}>{label}</span>
          <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
            <span style={{ color: color ?? '#e4eaf1', fontSize: 13, fontFamily: MONO }}>{value}</span>
            {sub && <span style={{ color: '#77828f', fontSize: 10, marginLeft: 6, fontFamily: MONO }}>{sub}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

const NO_EVENTS: { date: string; label: string }[] = []

export default function ExpressionDetail({
  history, header, extraGroups = [], footnote, lineColor = '#6aa9cc',
  lookback: lookbackProp, onLookbackChange, events = NO_EVENTS,
}: {
  history: SeriesPoint[]
  events?: { date: string; label: string }[]   // vertical markers, e.g. central-bank meetings
  header?: ReactNode            // rendered left of the lookback toggle
  extraGroups?: StatGroupDef[]  // page-specific stats (carry, betas, …)
  footnote?: ReactNode
  lineColor?: string
  lookback?: string             // optional controlled lookback, so it survives switching expressions
  onLookbackChange?: (key: string) => void
}) {
  const available = LOOKBACKS.filter(l => l.n === Infinity || l.n <= history.length * 1.05)
  const [ownLookback, setOwnLookback] = useState<string>('1Y')
  const wanted = lookbackProp ?? ownLookback
  const lookback = available.some(l => l.key === wanted) ? wanted : 'All'
  const setLookback = (key: string) => { setOwnLookback(key); onLookbackChange?.(key) }
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const lbN = LOOKBACKS.find(l => l.key === lookback)?.n ?? Infinity

  const windowData = useMemo(
    () => (lbN === Infinity ? history : history.slice(-lbN)),
    [history, lbN],
  )
  const s = useMemo(() => computeWindowStats(windowData), [windowData])
  const hist = useMemo(
    () => buildHistogram(windowData.map(p => p.value), s.current),
    [windowData, s.current],
  )

  // Point-in-time changes from the full history, independent of lookback
  const chgN = (k: number) => history.length > k
    ? history[history.length - 1].value - history[history.length - 1 - k].value
    : null

  const refLines = [
    { y: s.mean + 2 * s.std, color: '#d9705e', tag: '+2σ' },
    { y: s.mean + s.std,     color: '#d6ad66', tag: '+1σ' },
    { y: s.mean,             color: 'rgba(200,220,240,0.45)', tag: 'μ' },
    { y: s.mean - s.std,     color: '#58ad8e', tag: '-1σ' },
    { y: s.mean - 2 * s.std, color: '#6fc2a2', tag: '-2σ' },
  ]

  // Events inside the window, each on the first data date on or after it (meetings can fall on holidays)
  const eventMarks = useMemo(() => {
    if (!events.length || !windowData.length) return []
    const first = windowData[0].date, last = windowData[windowData.length - 1].date
    return events
      .filter(e => e.date >= first && e.date <= last)
      .map(e => ({ ...e, x: windowData.find(p => p.date >= e.date)?.date }))
      .filter((e): e is { date: string; label: string; x: string } => e.x !== undefined)
  }, [events, windowData])
  const labelEvents = windowData.length <= 520   // labels only up to ~2y, else they crowd

  const tickInterval = Math.max(1, Math.floor(windowData.length / 6))
  // Enough decimals that narrow ranges don't produce duplicate tick labels
  const axisDp = s.max - s.min < 5 ? 1 : 0

  const groups: StatGroupDef[] = [
    { title: `Level · ${lookback}`, items: [
      { label: 'Current',  value: fmtBp(s.current) },
      { label: 'Mean',     value: fmtBp(s.mean) },
      { label: 'Median',   value: fmtBp(s.median) },
      { label: 'Std dev',  value: fmtBp(s.std) },
      { label: 'Min',      value: fmtBp(s.min), sub: s.minDate },
      { label: 'Max',      value: fmtBp(s.max), sub: s.maxDate },
    ] },
    { title: `Mean reversion · ${lookback}`, items: [
      { label: 'Z-score',        value: s.zscore.toFixed(2), color: zscoreColor(s.zscore) },
      { label: 'Percentile',     value: `${s.pctile.toFixed(0)}%`, color: pctileColor(s.pctile) },
      { label: 'Range position', value: `${s.rangePos.toFixed(0)}%` },
      { label: 'Dist. to mean',  value: fmtSignedBp(s.current - s.mean), color: signColor(s.current - s.mean) },
      { label: 'AR(1) coef.',    value: s.ar1 === null ? '—' : s.ar1.toFixed(3) },
      { label: 'Half-life',      value: s.halfLife === null ? '—' : `${s.halfLife.toFixed(0)} d` },
    ] },
    { title: `Changes · vol ${lookback}`, items: [
      { label: 'Δ1d',  value: fmtSignedBp(chgN(1)),  color: signColor(chgN(1)) },
      { label: 'Δ1w',  value: fmtSignedBp(chgN(5)),  color: signColor(chgN(5)) },
      { label: 'Δ1m',  value: fmtSignedBp(chgN(21)), color: signColor(chgN(21)) },
      { label: 'Δ3m',  value: fmtSignedBp(chgN(63)), color: signColor(chgN(63)) },
      { label: 'RVol (bp)', value: <VolHorizons daily={s.rvolDaily} /> },
      { label: 'Max daily ±', value: `${s.bigUp >= 0 ? '+' : ''}${s.bigUp.toFixed(1)} / ${s.bigDown.toFixed(1)}` },
    ] },
    ...extraGroups,
  ]

  return (
    <div>
      {/* Header row: page controls + lookback */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {header}
        <div style={{
          marginLeft: 'auto', display: 'flex', gap: 2, padding: 3,
          background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6,
        }}>
          {(['chart', 'table'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, border: 'none',
              cursor: 'pointer', textTransform: 'capitalize',
              background: view === v ? 'rgba(106,169,204,0.25)' : 'transparent',
              color: view === v ? '#a9d2e8' : '#9aa5b1',
            }}>{v}</button>
          ))}
        </div>
        <div style={{
          display: 'flex', gap: 2, padding: 3,
          background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6,
        }}>
          {available.map(({ key }) => (
            <button key={key} onClick={() => setLookback(key)} style={{
              padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, border: 'none',
              cursor: 'pointer', fontFamily: MONO,
              background: lookback === key ? 'rgba(106,169,204,0.25)' : 'transparent',
              color: lookback === key ? '#a9d2e8' : '#9aa5b1',
            }}>{key}</button>
          ))}
        </div>
      </div>

      {/* Time series + distribution */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 1fr)', gap: 16 }}>
        <div>
          {view === 'table' ? (
            <SeriesTable points={windowData} mean={s.mean} std={s.std} height={320} />
          ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={windowData} margin={{ top: 10, right: 56, bottom: 24, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
              <XAxis
                dataKey="date" stroke="#8995a2" tick={{ fill: '#9aa5b1', fontSize: 10 }}
                tickFormatter={fmtAxisDate} interval={tickInterval}
              />
              <YAxis
                stroke="#8995a2" tick={{ fill: '#9aa5b1', fontSize: 11 }}
                tickFormatter={(v: number) => v.toFixed(axisDp)} domain={['auto', 'auto']} width={44}
                label={{ value: 'Level (bp)', angle: -90, position: 'insideLeft', offset: 4, fill: '#8995a2', fontSize: 11 }}
              />
              <Tooltip content={<LineTooltip />} />
              {eventMarks.map(e => (
                <ReferenceLine key={e.date} x={e.x} stroke="rgba(214,173,102,0.35)" strokeDasharray="2 3" strokeWidth={1}
                  label={labelEvents ? { value: e.label, position: 'insideTopLeft', fill: 'rgba(214,173,102,0.7)', fontSize: 9 } : undefined}
                />
              ))}
              {refLines.map(({ y, color, tag }) => (
                <ReferenceLine key={tag} y={y} stroke={color} strokeDasharray={tag === 'μ' ? '5 3' : '3 3'} strokeWidth={1.2}
                  label={{ value: tag, position: 'right', fill: color, fontSize: 9, fontWeight: 600 }}
                />
              ))}
              <Line type="monotone" dataKey="value" stroke={lineColor} strokeWidth={1.6} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          )}
        </div>

        <div>
          <div style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontWeight: 600 }}>
            Distribution · {lookback}
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={hist} margin={{ top: 6, right: 8, bottom: 24, left: 0 }} barCategoryGap={1}>
              <XAxis
                dataKey="mid" stroke="#8995a2" tick={{ fill: '#9aa5b1', fontSize: 10 }}
                tickFormatter={(v: number) => v.toFixed(axisDp)} interval={Math.floor(hist.length / 4)}
              />
              <YAxis hide />
              <Tooltip content={<HistTooltip />} cursor={{ fill: 'rgba(200,220,240,0.04)' }} />
              <Bar dataKey="pct" isAnimationActive={false}>
                {hist.map((b, i) => (
                  <Cell key={i} fill={b.isCurrent ? '#86c0de' : 'rgba(150,178,205,0.28)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ color: '#77828f', fontSize: 10, textAlign: 'center' }}>
            Highlighted bin = current level
          </div>
        </div>
      </div>

      {/* Summary statistics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 12, marginTop: 20 }}>
        {groups.map(g => <StatGroup key={g.title} {...g} />)}
      </div>
      {footnote && <p style={{ color: '#77828f', fontSize: 10, marginTop: 10 }}>{footnote}</p>}
    </div>
  )
}
