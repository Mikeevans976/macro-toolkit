import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'

// ─── Constants ────────────────────────────────────────────────────────────────

const BG = '#080d1a'
const MUTED = '#475569'

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: '16px 20px',
}

type Region    = 'EUR' | 'GBP' | 'USD'
type EurSubtab = 'index-levels' | 'fixings'

const REGION_COLORS: Record<Region, string> = { EUR: '#6366f1', GBP: '#38bdf8', USD: '#f59e0b' }
const REGION_LABELS: Record<Region, string>  = { EUR: 'Euro Area', GBP: 'United Kingdom', USD: 'United States' }

// ─── RNG ──────────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Piecewise linear interpolation ──────────────────────────────────────────

function interp(pts: [number, number][], t: number): number {
  if (t <= pts[0][0]) return pts[0][1]
  if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
      return y0 + (y1 - y0) * (t - x0) / (x1 - x0)
    }
  }
  return 2.0
}

// ─── HICP index generation ────────────────────────────────────────────────────
//  month 0 = Jan 2000 · month 305 = Jun 2025  ·  base 2015 = 100

const HEADLINE_YOY: [number, number][] = [
  [0, 2.0], [95, 3.1], [101, 4.0], [107, 1.6], [113, -0.1],
  [131, 2.2], [141, 3.0], [179, -0.2], [239, 1.3], [243, 0.3],
  [263, 5.0], [273, 10.6], [287, 2.9], [305, 2.2],
]
const CORE_YOY: [number, number][] = [
  [0, 1.5], [95, 1.9], [101, 1.9], [113, 1.3], [131, 1.5],
  [179, 0.8], [239, 1.2], [243, 0.9], [263, 2.6], [278, 5.7],
  [287, 3.4], [305, 2.7],
]
const ENERGY_YOY: [number, number][] = [
  [0, 7.0], [11, 12.0], [23, -4.0], [71, 8.0],
  [101, 17.0], [107, -8.0], [113, -14.0],
  [131, 7.0], [149, 8.0], [179, -6.0],
  [192, -8.0], [203, 1.0],
  [243, -12.0], [251, -8.0],
  [263, 26.0], [266, 44.0], [279, -6.0], [287, -6.0],
  [305, 0.5],
]

interface HicpPoint {
  date: string
  headline: number
  core:     number
  energy:   number
}

function generateHicpLevels(): HicpPoint[] {
  const rngH = mulberry32(0xdeadbeef)
  const rngC = mulberry32(0xcafebabe)
  const rngE = mulberry32(0x12345678)

  let headline = 84.5, core = 85.5, energy = 62.0
  const points: HicpPoint[] = []

  for (let t = 0; t < 306; t++) {
    headline *= (1 + interp(HEADLINE_YOY, t) / 1200 + (rngH() - 0.5) * 0.0008)
    core     *= (1 + interp(CORE_YOY,    t) / 1200 + (rngC() - 0.5) * 0.0005)
    energy   *= (1 + interp(ENERGY_YOY,  t) / 1200 + (rngE() - 0.5) * 0.0025)
    points.push({
      date:     new Date(2000, t, 1).toISOString().slice(0, 7),
      headline: +headline.toFixed(2),
      core:     +core.toFixed(2),
      energy:   +energy.toFixed(2),
    })
  }
  return points
}

// ─── STL decomposition ────────────────────────────────────────────────────────
//  Locally-weighted regression (Loess) + seasonal sub-series smoothing.
//  Operates on log levels so multiplicative seasonality is handled correctly.

function loess(xi: number[], y: number[], bw: number): number[] {
  const n = xi.length
  const h = Math.max(4, Math.round(bw * n))
  const out = new Array<number>(n)

  for (let i = 0; i < n; i++) {
    // Distance from xi[i] to every other point
    const dists = xi.map(v => Math.abs(v - xi[i]))
    const sorted = [...dists].sort((a, b) => a - b)
    const maxD   = sorted[Math.min(h, n) - 1] || 1e-10

    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0
    for (let j = 0; j < n; j++) {
      const u = dists[j] / maxD
      if (u >= 1) continue
      const w = Math.pow(1 - u * u * u, 3)
      sw += w; swx += w * xi[j]; swy += w * y[j]
      swxx += w * xi[j] * xi[j]; swxy += w * xi[j] * y[j]
    }

    const det = sw * swxx - swx * swx
    out[i] = Math.abs(det) < 1e-12
      ? swy / (sw || 1)
      : (swxx * swy - swx * swxy) / det + ((sw * swxy - swx * swy) / det) * xi[i]
  }
  return out
}

interface StlResult { sa: number[] }

function stl(values: number[], period = 12, nInner = 3): StlResult {
  const n    = values.length
  const logY = values.map(Math.log)
  const idx  = Array.from({ length: n }, (_, i) => i)
  let seasonal = new Array<number>(n).fill(0)

  for (let iter = 0; iter < nInner; iter++) {
    // Deseasonalize → trend
    const des   = logY.map((v, i) => v - seasonal[i])
    const trend = loess(idx, des, 0.25)

    // Detrend → seasonal sub-series smoothing per month
    const det    = logY.map((v, i) => v - trend[i])
    const newSea = new Array<number>(n).fill(0)

    for (let m = 0; m < period; m++) {
      const subIdx: number[] = [], subVal: number[] = []
      for (let i = m; i < n; i += period) { subIdx.push(i); subVal.push(det[i]) }
      const subXi  = Array.from({ length: subIdx.length }, (_, k) => k)
      const smooth = subIdx.length >= 4 ? loess(subXi, subVal, 0.75) : subVal
      subIdx.forEach((origI, k) => { newSea[origI] = smooth[k] })
    }

    // Normalize: force each complete cycle to sum to zero
    const nCycles = Math.floor(n / period)
    for (let c = 0; c < nCycles; c++) {
      let sum = 0
      for (let m = 0; m < period; m++) sum += newSea[c * period + m]
      const mean = sum / period
      for (let m = 0; m < period; m++) newSea[c * period + m] -= mean
    }
    seasonal = newSea
  }

  // SA = exp(log_level − seasonal)
  return { sa: logY.map((v, i) => Math.exp(v - seasonal[i])) }
}

// ─── Series config ────────────────────────────────────────────────────────────

const HICP_SERIES = [
  { key: 'headline' as const, label: 'HICP Headline', color: '#6366f1', ticker: 'EUHICP Index'    },
  { key: 'core'     as const, label: 'HICP Core',     color: '#38bdf8', ticker: 'EUHICPXFE Index' },
  { key: 'energy'   as const, label: 'HICP Energy',   color: '#f59e0b', ticker: 'EUHICPEN Index'  },
]

// ─── Derived metrics ──────────────────────────────────────────────────────────

interface SeriesMetrics {
  date:    string
  level:   number
  yoy:     number | null
  mom:     number | null
  momSA:   number | null
}

function computeMetrics(data: HicpPoint[], key: 'headline' | 'core' | 'energy'): SeriesMetrics[] {
  const vals = data.map(d => d[key])
  const { sa } = stl(vals)

  return data.map((d, t) => ({
    date:  d.date,
    level: vals[t],
    yoy:   t >= 12 ? (vals[t] / vals[t - 12] - 1) * 100 : null,
    mom:   t >= 1  ? (vals[t] / vals[t - 1]  - 1) * 100 : null,
    momSA: t >= 1  ? (sa[t]   / sa[t - 1]    - 1) * 100 : null,
  }))
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function IndexTooltip({ active, payload, label }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#94a3b8', marginBottom: 6 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <span style={{ fontWeight: 600 }}>{p.value.toFixed(2)}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

const fmtPct = (v: number | null, dp = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`

const pctColor = (v: number | null) =>
  v == null ? MUTED : v > 0.05 ? '#22c55e' : v < -0.05 ? '#ef4444' : '#94a3b8'

// ─── EUR · Index Levels subtab ────────────────────────────────────────────────

function EurIndexLevels({ data }: { data: HicpPoint[] }) {
  const metrics = useMemo(() => ({
    headline: computeMetrics(data, 'headline'),
    core:     computeMetrics(data, 'core'),
    energy:   computeMetrics(data, 'energy'),
  }), [data])

  const latest  = data[data.length - 1]
  const prev12  = data[data.length - 13]

  const summaryVals = {
    headline: { level: latest.headline, yoy: (latest.headline / prev12.headline - 1) * 100 },
    core:     { level: latest.core,     yoy: (latest.core     / prev12.core     - 1) * 100 },
    energy:   { level: latest.energy,   yoy: (latest.energy   / prev12.energy   - 1) * 100 },
  }

  // X-axis ticks: January of every even year
  const xTicks = data
    .filter(d => d.date.endsWith('-01') && +d.date.slice(0, 4) % 2 === 0)
    .map(d => d.date)

  // Table: last 24 months, newest first
  const tableRows = data.slice(-24).reverse()

  const th: React.CSSProperties = {
    padding: '5px 10px', color: MUTED, fontWeight: 500, fontSize: 10,
    textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'right',
    whiteSpace: 'nowrap',
  }
  const td = (color?: string): React.CSSProperties => ({
    padding: '5px 10px', fontSize: 11, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums', color: color ?? '#f1f5f9',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {HICP_SERIES.map(s => {
          const sv = summaryVals[s.key]
          return (
            <div key={s.key} style={cardStyle}>
              <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                {s.label}
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, color: s.color, letterSpacing: '-0.02em' }}>
                {sv.level.toFixed(2)}
              </div>
              <div style={{ fontSize: 11, color: sv.yoy >= 0 ? '#22c55e' : '#ef4444', marginTop: 3 }}>
                {sv.yoy >= 0 ? '+' : ''}{sv.yoy.toFixed(1)}% YoY
              </div>
              <div style={{ fontSize: 10, color: '#334155', marginTop: 4 }}>
                {s.ticker} · {latest.date}
              </div>
            </div>
          )
        })}
      </div>

      {/* Chart */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            HICP Index Levels — Euro Area
          </div>
          <div style={{ fontSize: 10, color: '#334155' }}>2015 = 100</div>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 16 }}>
          Jan 2000 – Jun 2025 · Simulated
        </div>
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={data} margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis
              dataKey="date"
              ticks={xTicks}
              tickFormatter={d => d.slice(0, 4)}
              tick={{ fontSize: 10, fill: '#475569' }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#475569' }}
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => v.toFixed(0)}
            />
            <Tooltip content={<IndexTooltip />} />
            {HICP_SERIES.map(s => (
              <Line key={s.key} type="monotone" dataKey={s.key}
                name={s.label} stroke={s.color} strokeWidth={1.5} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 24, marginTop: 14, justifyContent: 'center' }}>
          {HICP_SERIES.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
              <div style={{ width: 22, height: 2, background: s.color, borderRadius: 1, flexShrink: 0 }} />
              {s.label}
            </div>
          ))}
        </div>
      </div>

      {/* Data table */}
      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Recent Prints
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 14 }}>
          MoM SA computed via STL decomposition (Loess, period = 12)
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              {/* Group headers */}
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <th style={{ ...th, textAlign: 'left', width: 72 }} rowSpan={2}>Date</th>
                {HICP_SERIES.map(s => (
                  <th key={s.key} colSpan={4}
                    style={{ ...th, textAlign: 'center', color: s.color, paddingBottom: 2, borderBottom: `1px solid ${s.color}33` }}>
                    {s.label}
                  </th>
                ))}
              </tr>
              {/* Sub-headers */}
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {HICP_SERIES.map(s => (
                  ['Level', 'YoY', 'MoM', 'MoM SA'].map(h => (
                    <th key={`${s.key}-${h}`} style={th}>{h}</th>
                  ))
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((pt, i) => {
                const mH = metrics.headline.find(m => m.date === pt.date)!
                const mC = metrics.core.find(m => m.date === pt.date)!
                const mE = metrics.energy.find(m => m.date === pt.date)!

                return (
                  <tr key={pt.date}
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                    <td style={{ ...td(), textAlign: 'left', color: i === 0 ? '#f1f5f9' : '#94a3b8', fontWeight: i === 0 ? 600 : 400 }}>
                      {new Date(pt.date + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
                      {i === 0 && <span style={{ marginLeft: 6, fontSize: 9, color: '#6366f1' }}>latest</span>}
                    </td>
                    {/* Headline */}
                    <td style={td()}>{mH.level.toFixed(2)}</td>
                    <td style={td(pctColor(mH.yoy))}>{fmtPct(mH.yoy, 1)}</td>
                    <td style={td(pctColor(mH.mom))}>{fmtPct(mH.mom)}</td>
                    <td style={td(pctColor(mH.momSA))}>{fmtPct(mH.momSA)}</td>
                    {/* Core */}
                    <td style={td()}>{mC.level.toFixed(2)}</td>
                    <td style={td(pctColor(mC.yoy))}>{fmtPct(mC.yoy, 1)}</td>
                    <td style={td(pctColor(mC.mom))}>{fmtPct(mC.mom)}</td>
                    <td style={td(pctColor(mC.momSA))}>{fmtPct(mC.momSA)}</td>
                    {/* Energy */}
                    <td style={td()}>{mE.level.toFixed(2)}</td>
                    <td style={td(pctColor(mE.yoy))}>{fmtPct(mE.yoy, 1)}</td>
                    <td style={td(pctColor(mE.mom))}>{fmtPct(mE.mom)}</td>
                    <td style={td(pctColor(mE.momSA))}>{fmtPct(mE.momSA)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  )
}

// ─── EUR · Fixings subtab ─────────────────────────────────────────────────────

interface FixingRow {
  month_num:      number
  ticker:         string
  calendar_month: string  // YYYY-MM
  level:          number
  mom_implied:    number
}

interface FixingsResponse {
  data_source:     string
  as_of_date:      string
  last_known_hicp: number
  fixings:         FixingRow[]
}

function EurFixings() {
  const [data,    setData]    = useState<FixingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const token = localStorage.getItem('access_token')
    fetch('/api/tools/inflation-fixings/eur', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d: FixingsResponse) => { setData(d); setLoading(false) })
      .catch((e: Error) => { setError(e.message); setLoading(false) })
  }, [])

  if (loading) return (
    <div style={{ ...cardStyle, padding: 40, textAlign: 'center', color: MUTED }}>
      Loading fixings…
    </div>
  )
  if (error || !data) return (
    <div style={{ ...cardStyle, padding: 40, textAlign: 'center', color: '#ef4444' }}>
      Failed to load fixings: {error}
    </div>
  )

  const { fixings, as_of_date, data_source, last_known_hicp } = data

  // Chart data: include Month 0 (last known) as anchor point
  const chartData = [
    { label: 'Spot', level: last_known_hicp, ticker: 'Last known' },
    ...fixings.map(f => ({
      label:  new Date(f.calendar_month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      level:  f.level,
      ticker: f.ticker,
    })),
  ]

  const momColor = (v: number) => v > 0.05 ? '#22c55e' : v < -0.05 ? '#ef4444' : '#94a3b8'

  const th: React.CSSProperties = {
    padding: '5px 12px', color: MUTED, fontWeight: 500, fontSize: 10,
    textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'right',
    whiteSpace: 'nowrap',
  }
  const td = (color?: string): React.CSSProperties => ({
    padding: '5px 12px', fontSize: 11, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums', color: color ?? '#f1f5f9',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header row: metadata */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ fontSize: 11, color: '#334155' }}>
          As of {as_of_date}
        </div>
        <div style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 4,
          background: data_source === 'bloomberg' ? 'rgba(34,197,94,0.12)' : 'rgba(251,191,36,0.10)',
          color:      data_source === 'bloomberg' ? '#22c55e' : '#fbbf24',
          border:    `1px solid ${data_source === 'bloomberg' ? 'rgba(34,197,94,0.25)' : 'rgba(251,191,36,0.2)'}`,
        }}>
          {data_source === 'bloomberg' ? 'Live · Bloomberg' : 'Simulated'}
        </div>
      </div>

      {/* Fixing curve chart */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            HICP Fixing Curve — Euro Area
          </div>
          <div style={{ fontSize: 10, color: '#334155' }}>Index level (2015 = 100)</div>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 16 }}>
          EUSWIF1–12 &amp; EUSWIT1–12 Comdty · 24 monthly fixings
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: '#475569' }}
              tickLine={false}
              axisLine={false}
              interval={2}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#475569' }}
              tickLine={false}
              axisLine={false}
              width={48}
              domain={['auto', 'auto']}
              tickFormatter={(v: number) => v.toFixed(1)}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                const row = payload[0].payload as typeof chartData[0]
                return (
                  <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                    <div style={{ color: '#94a3b8', marginBottom: 4 }}>{label}</div>
                    <div style={{ color: '#6366f1' }}>Level: <strong>{(payload[0].value as number).toFixed(2)}</strong></div>
                    <div style={{ color: '#475569', fontSize: 10, marginTop: 2 }}>{row.ticker}</div>
                  </div>
                )
              }}
            />
            <Line type="monotone" dataKey="level" name="Fixing" stroke="#6366f1" strokeWidth={2} dot={{ r: 2, fill: '#6366f1' }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Fixings table */}
      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 14, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Fixing Levels
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['#', 'Month', 'BBG Ticker', 'Level', 'MoM Impl.'].map(h => (
                  <th key={h} style={{ ...th, textAlign: h === 'BBG Ticker' || h === 'Month' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fixings.map((f, i) => (
                <tr key={f.month_num}
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                  <td style={{ ...td('#475569'), textAlign: 'right', width: 32 }}>{f.month_num}</td>
                  <td style={{ ...td(), textAlign: 'left' }}>
                    {new Date(f.calendar_month + '-02').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
                    {i === 0 && <span style={{ marginLeft: 6, fontSize: 9, color: '#6366f1' }}>nearest</span>}
                  </td>
                  <td style={{ padding: '5px 12px', fontSize: 10, color: '#475569', fontFamily: 'monospace', textAlign: 'left' }}>
                    {f.ticker}
                  </td>
                  <td style={td()}>{f.level.toFixed(2)}</td>
                  <td style={td(momColor(f.mom_implied))}>
                    {f.mom_implied >= 0 ? '+' : ''}{f.mom_implied.toFixed(3)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Separator between F and T contracts */}
        <div style={{ fontSize: 10, color: '#334155', marginTop: 10 }}>
          Months 1–12: EUSWIF series · Months 13–24: EUSWIT series
        </div>
      </div>

    </div>
  )
}

// ─── EUR subtab config ────────────────────────────────────────────────────────

const EUR_SUBTABS: { id: EurSubtab; label: string }[] = [
  { id: 'index-levels', label: 'Historical' },
  { id: 'fixings',      label: 'Fixings'    },
]

// ─── Main component ───────────────────────────────────────────────────────────

export default function InflationFixingsMonitor() {
  const navigate = useNavigate()
  const [region,    setRegion]    = useState<Region>('EUR')
  const [eurSubtab, setEurSubtab] = useState<EurSubtab>('index-levels')

  const hicpData    = useMemo(() => generateHicpLevels(), [])
  const regionColor = REGION_COLORS[region]

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#f1f5f9', fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button onClick={() => navigate('/')}
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, padding: '6px 14px', color: '#94a3b8', fontSize: 13, cursor: 'pointer' }}>
          ← Back
        </button>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>Inflation Fixings Monitor</div>
          <div style={{ color: MUTED, fontSize: 11, marginTop: 1 }}>Inflation Markets · Simulated data</div>
        </div>
      </div>

      {/* Region tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, zIndex: 10, background: BG }}>
        {(['EUR', 'GBP', 'USD'] as Region[]).map(r => (
          <button key={r} onClick={() => setRegion(r)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 18px', fontSize: 13, fontWeight: 500, color: region === r ? REGION_COLORS[r] : '#64748b', borderBottom: region === r ? `2px solid ${REGION_COLORS[r]}` : '2px solid transparent', marginBottom: -1, transition: 'color 0.15s' }}>
            {REGION_LABELS[r]}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 20 }}>

        {/* ── Euro Area ─────────────────────────────────────────────────────── */}
        {region === 'EUR' && (
          <>
            <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              {EUR_SUBTABS.map(st => (
                <button key={st.id} onClick={() => setEurSubtab(st.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 14px', fontSize: 12, fontWeight: 500, color: eurSubtab === st.id ? regionColor : '#64748b', borderBottom: eurSubtab === st.id ? `2px solid ${regionColor}` : '2px solid transparent', marginBottom: -1 }}>
                  {st.label}
                </button>
              ))}
            </div>
            {eurSubtab === 'index-levels' && <EurIndexLevels data={hicpData} />}
            {eurSubtab === 'fixings'      && <EurFixings />}
          </>
        )}

        {/* ── Other regions — placeholder ───────────────────────────────────── */}
        {region !== 'EUR' && (
          <div style={{ ...cardStyle, textAlign: 'center', padding: '56px 24px', color: MUTED }}>
            <div style={{ fontSize: 14, marginBottom: 8, color: '#94a3b8' }}>{REGION_LABELS[region]} — Coming soon</div>
            <div style={{ fontSize: 12, color: '#334155' }}>Being built out. Start with Euro Area.</div>
          </div>
        )}

      </div>
    </div>
  )
}
