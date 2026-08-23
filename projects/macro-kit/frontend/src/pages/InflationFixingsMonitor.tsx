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
// HICP ex Tobacco — very close to headline (tobacco weight ~1%); used by fixings
const HICP_XT_YOY: [number, number][] = [
  [0, 1.9], [95, 3.0], [101, 3.9], [107, 1.5], [113, -0.1],
  [131, 2.1], [141, 2.9], [179, -0.2], [239, 1.2], [243, 0.3],
  [263, 4.9], [273, 10.5], [287, 2.8], [305, 2.1],
]
const CORE_YOY: [number, number][] = [
  [0, 1.5], [95, 1.9], [101, 1.9], [113, 1.3], [131, 1.5],
  [179, 0.8], [239, 1.2], [243, 0.9], [263, 2.6], [278, 5.7],
  [287, 3.4], [305, 2.7],
]
// Non-energy industrial goods: low-inflation, peaked around 6% in 2022
const CORE_GOODS_YOY: [number, number][] = [
  [0, 0.5], [131, 0.8], [179, 0.2], [239, 0.4], [243, 0.2],
  [263, 3.0], [275, 6.2], [287, 2.8], [300, 0.6], [305, 0.8],
]
// Services: sticky, historically ~1.5–2.5%, peaked ~5.5%, slow to fall
const SERVICES_YOY: [number, number][] = [
  [0, 1.5], [95, 2.2], [131, 1.8], [179, 1.1], [239, 1.4],
  [243, 1.2], [263, 2.4], [278, 5.6], [287, 5.2], [298, 4.8],
  [305, 4.0],
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
// Food incl. alcohol & tobacco: volatile, tracked commodity surge in 2022
const FOOD_YOY: [number, number][] = [
  [0, 1.5], [95, 2.0], [107, 0.5], [131, 2.5],
  [179, 0.6], [239, 1.8], [243, 0.8],
  [263, 7.0], [271, 16.5], [283, 10.0], [293, 4.2],
  [305, 3.0],
]

interface HicpPoint {
  date:      string
  headline:  number
  hicpXT:    number
  core:      number
  coreGoods: number
  services:  number
  energy:    number
  food:      number
}

function generateHicpLevels(): HicpPoint[] {
  const rngH  = mulberry32(0xdeadbeef)
  const rngXT = mulberry32(0xfeedface)
  const rngC  = mulberry32(0xcafebabe)
  const rngCG = mulberry32(0xabcdef01)
  const rngSv = mulberry32(0x87654321)
  const rngE  = mulberry32(0x12345678)
  const rngF  = mulberry32(0x11223344)

  // Starting levels (2015 = 100; lower inflation → higher starting ratio back to 2000)
  let headline  = 84.5
  let hicpXT    = 84.3   // slightly lower than headline (tobacco excluded)
  let core      = 85.5
  let coreGoods = 91.0   // NEIG — low inflation historically
  let services  = 77.0   // services — higher inflation historically
  let energy    = 62.0
  let food      = 82.0

  const points: HicpPoint[] = []

  for (let t = 0; t < 306; t++) {
    headline  *= (1 + interp(HEADLINE_YOY,   t) / 1200 + (rngH()  - 0.5) * 0.0008)
    hicpXT    *= (1 + interp(HICP_XT_YOY,    t) / 1200 + (rngXT() - 0.5) * 0.0008)
    core      *= (1 + interp(CORE_YOY,       t) / 1200 + (rngC()  - 0.5) * 0.0005)
    coreGoods *= (1 + interp(CORE_GOODS_YOY, t) / 1200 + (rngCG() - 0.5) * 0.0005)
    services  *= (1 + interp(SERVICES_YOY,   t) / 1200 + (rngSv() - 0.5) * 0.0004)
    energy    *= (1 + interp(ENERGY_YOY,     t) / 1200 + (rngE()  - 0.5) * 0.0025)
    food      *= (1 + interp(FOOD_YOY,       t) / 1200 + (rngF()  - 0.5) * 0.0015)

    points.push({
      date:      new Date(2000, t, 1).toISOString().slice(0, 7),
      headline:  +headline.toFixed(2),
      hicpXT:    +hicpXT.toFixed(2),
      core:      +core.toFixed(2),
      coreGoods: +coreGoods.toFixed(2),
      services:  +services.toFixed(2),
      energy:    +energy.toFixed(2),
      food:      +food.toFixed(2),
    })
  }
  return points
}

// ─── STL decomposition ────────────────────────────────────────────────────────

function loess(xi: number[], y: number[], bw: number): number[] {
  const n = xi.length
  const h = Math.max(4, Math.round(bw * n))
  const out = new Array<number>(n)

  for (let i = 0; i < n; i++) {
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

function stl(values: number[], period = 12, nInner = 3): { sa: number[] } {
  const n    = values.length
  const logY = values.map(Math.log)
  const idx  = Array.from({ length: n }, (_, i) => i)
  let seasonal = new Array<number>(n).fill(0)

  for (let iter = 0; iter < nInner; iter++) {
    const des   = logY.map((v, i) => v - seasonal[i])
    const trend = loess(idx, des, 0.25)
    const det    = logY.map((v, i) => v - trend[i])
    const newSea = new Array<number>(n).fill(0)

    for (let m = 0; m < period; m++) {
      const subIdx: number[] = [], subVal: number[] = []
      for (let i = m; i < n; i += period) { subIdx.push(i); subVal.push(det[i]) }
      const subXi  = Array.from({ length: subIdx.length }, (_, k) => k)
      const smooth = subIdx.length >= 4 ? loess(subXi, subVal, 0.75) : subVal
      subIdx.forEach((origI, k) => { newSea[origI] = smooth[k] })
    }

    const nCycles = Math.floor(n / period)
    for (let c = 0; c < nCycles; c++) {
      let sum = 0
      for (let m = 0; m < period; m++) sum += newSea[c * period + m]
      const mean = sum / period
      for (let m = 0; m < period; m++) newSea[c * period + m] -= mean
    }
    seasonal = newSea
  }

  return { sa: logY.map((v, i) => Math.exp(v - seasonal[i])) }
}

// ─── Series config ────────────────────────────────────────────────────────────

type HicpKey = 'headline' | 'hicpXT' | 'core' | 'coreGoods' | 'services' | 'energy' | 'food'

interface HicpSeriesDef {
  key:        HicpKey
  label:      string
  color:      string
  ticker:     string
  blockStart: boolean   // true → thick colored left border in table (new visual block)
  inChart:    boolean   // true → shown in the index-levels chart
}

const HICP_SERIES: HicpSeriesDef[] = [
  { key: 'headline',  label: 'HICP Headline',    color: '#6366f1', ticker: 'EUHICP Index',    blockStart: true,  inChart: true  },
  { key: 'hicpXT',   label: 'HICP ex Tobacco',   color: '#818cf8', ticker: 'EUHICPXT Index',  blockStart: false, inChart: false },
  { key: 'core',      label: 'HICP Core',         color: '#38bdf8', ticker: 'EUHICPXFE Index', blockStart: true,  inChart: true  },
  { key: 'coreGoods', label: 'Core Goods',        color: '#7dd3fc', ticker: 'EUHICPIG Index',  blockStart: false, inChart: false },
  { key: 'services',  label: 'Services',          color: '#a5b4fc', ticker: 'EUHICPSER Index', blockStart: false, inChart: false },
  { key: 'energy',    label: 'HICP Energy',       color: '#f59e0b', ticker: 'EUHICPEN Index',  blockStart: true,  inChart: true  },
  { key: 'food',      label: 'Food incl. A&T',    color: '#22c55e', ticker: 'EUHICPF Index',   blockStart: true,  inChart: true  },
]

// ─── Derived metrics ──────────────────────────────────────────────────────────

interface SeriesMetrics {
  date:  string
  level: number
  yoy:   number | null
  mom:   number | null
  momSA: number | null
}

function computeMetrics(dates: string[], vals: number[]): SeriesMetrics[] {
  const { sa } = stl(vals)
  return dates.map((date, t) => ({
    date,
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
  const metrics = useMemo(() => {
    const m: Partial<Record<HicpKey, SeriesMetrics[]>> = {}
    for (const s of HICP_SERIES) m[s.key] = computeMetrics(data.map(d => d.date), data.map(d => d[s.key]))
    return m as Record<HicpKey, SeriesMetrics[]>
  }, [data])

  const latest = data[data.length - 1]
  const prev12 = data[data.length - 13]

  const xTicks = data
    .filter(d => d.date.endsWith('-01') && +d.date.slice(0, 4) % 2 === 0)
    .map(d => d.date)

  const tableRows = data.slice(-24).reverse()

  const chartSeries = HICP_SERIES.filter(s => s.inChart)

  // ── Table cell styles ───────────────────────────────────────────────────────

  const th: React.CSSProperties = {
    padding: '5px 10px', color: MUTED, fontWeight: 500, fontSize: 10,
    textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'right',
    whiteSpace: 'nowrap',
  }

  // First column of a block gets a colored left border; sub-components get a subtle one
  const thFirst = (s: HicpSeriesDef): React.CSSProperties => ({
    ...th,
    borderLeft: s.blockStart
      ? `2px solid ${s.color}88`
      : `1px solid rgba(255,255,255,0.06)`,
  })

  const td = (color?: string): React.CSSProperties => ({
    padding: '5px 10px', fontSize: 11, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums', color: color ?? '#f1f5f9',
  })

  const tdFirst = (s: HicpSeriesDef, color?: string): React.CSSProperties => ({
    ...td(color),
    borderLeft: s.blockStart
      ? `2px solid ${s.color}66`
      : `1px solid rgba(255,255,255,0.05)`,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Summary cards — 2 rows of 3 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {HICP_SERIES.map(s => {
          const level = latest[s.key]
          const yoy   = (level / prev12[s.key] - 1) * 100
          const isMain = s.blockStart
          return (
            <div key={s.key} style={{
              ...cardStyle,
              borderLeft: `3px solid ${s.color}99`,
              paddingLeft: isMain ? 16 : 14,
              opacity: isMain ? 1 : 0.85,
            }}>
              <div style={{ fontSize: 9, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                {!s.blockStart && <span style={{ color: s.color, marginRight: 4 }}>↳</span>}
                {s.label}
              </div>
              <div style={{ fontSize: isMain ? 22 : 18, fontWeight: 800, color: s.color, letterSpacing: '-0.02em' }}>
                {level.toFixed(2)}
              </div>
              <div style={{ fontSize: 11, color: yoy >= 0 ? '#22c55e' : '#ef4444', marginTop: 2 }}>
                {yoy >= 0 ? '+' : ''}{yoy.toFixed(1)}% YoY
              </div>
              <div style={{ fontSize: 9, color: '#334155', marginTop: 3 }}>
                {s.ticker} · {latest.date}
              </div>
            </div>
          )
        })}
      </div>

      {/* Chart — 4 main series */}
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
        <ResponsiveContainer width="100%" height={320}>
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
            {chartSeries.map(s => (
              <Line key={s.key} type="monotone" dataKey={s.key}
                name={s.label} stroke={s.color} strokeWidth={1.5} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 20, marginTop: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
          {chartSeries.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
              <div style={{ width: 22, height: 2, background: s.color, borderRadius: 1, flexShrink: 0 }} />
              {s.label}
            </div>
          ))}
          <div style={{ fontSize: 10, color: '#334155', alignSelf: 'center' }}>
            Core Goods &amp; Services shown in table only
          </div>
        </div>
      </div>

      {/* Data table */}
      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Recent Prints
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 14 }}>
          MoM SA computed via STL decomposition (Loess, period = 12) · ↳ = sub-component of the block above
        </div>

        {/* Block legend */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          {HICP_SERIES.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
              <div style={{
                width: s.blockStart ? 10 : 6,
                height: s.blockStart ? 10 : 6,
                borderRadius: 2,
                background: s.color,
                opacity: s.blockStart ? 1 : 0.7,
                flexShrink: 0,
              }} />
              <span style={{ color: s.blockStart ? '#94a3b8' : '#64748b' }}>
                {!s.blockStart && '↳ '}{s.label}
              </span>
            </div>
          ))}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              {/* Block headers */}
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <th style={{ ...th, textAlign: 'left', width: 72 }} rowSpan={2}>Date</th>
                {HICP_SERIES.map(s => (
                  <th key={s.key} colSpan={4}
                    style={{
                      ...th,
                      textAlign: 'center',
                      color: s.color,
                      paddingBottom: 4,
                      borderBottom: `2px solid ${s.color}${s.blockStart ? 'bb' : '55'}`,
                      borderLeft: s.blockStart ? `2px solid ${s.color}88` : `1px solid rgba(255,255,255,0.06)`,
                      background: `${s.color}08`,
                      fontSize: s.blockStart ? 10 : 9,
                    }}>
                    {!s.blockStart && <span style={{ opacity: 0.7 }}>↳ </span>}{s.label}
                  </th>
                ))}
              </tr>
              {/* Sub-headers */}
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.09)' }}>
                {HICP_SERIES.map(s => (
                  ['Level', 'YoY', 'MoM', 'SA'].map((h, hi) => (
                    <th key={`${s.key}-${h}`} style={{
                      ...th,
                      ...(hi === 0 ? thFirst(s) : {}),
                    }}>{h}</th>
                  ))
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((pt, i) => {
                const rowMetrics = {} as Record<HicpKey, SeriesMetrics>
                for (const s of HICP_SERIES) {
                  rowMetrics[s.key] = metrics[s.key].find(m => m.date === pt.date)!
                }

                return (
                  <tr key={pt.date}
                    style={{
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                      background: i === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                    }}>
                    <td style={{ ...td(), textAlign: 'left', color: i === 0 ? '#f1f5f9' : '#94a3b8', fontWeight: i === 0 ? 600 : 400 }}>
                      {new Date(pt.date + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
                      {i === 0 && <span style={{ marginLeft: 6, fontSize: 9, color: '#6366f1' }}>latest</span>}
                    </td>
                    {HICP_SERIES.map(s => {
                      const m = rowMetrics[s.key]
                      return [
                        <td key={`${s.key}-lv`} style={tdFirst(s)}>{m.level.toFixed(2)}</td>,
                        <td key={`${s.key}-yy`} style={td(pctColor(m.yoy))}>{fmtPct(m.yoy, 1)}</td>,
                        <td key={`${s.key}-mm`} style={td(pctColor(m.mom))}>{fmtPct(m.mom)}</td>,
                        <td key={`${s.key}-sa`} style={td(pctColor(m.momSA))}>{fmtPct(m.momSA)}</td>,
                      ]
                    })}
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
  calendar_month: string
  yoy_implied:    number | null
  level:          number | null
  mom_nsa:        number | null
  mom_sa:         number | null
}

interface HicpXtHistory {
  month: string
  level: number
}

interface FixingsResponse {
  data_source:        string
  as_of_date:         string
  last_known_hicp_xt: number
  hicp_xt_history:    HicpXtHistory[]
  fixings:            FixingRow[]
}

function EurFixings() {
  const navigate = useNavigate()
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
      .then(r => {
        if (r.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
          throw new Error('Session expired')
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: FixingsResponse) => { setData(d); setLoading(false) })
      .catch((e: Error) => { setError(e.message); setLoading(false) })
  }, [navigate])

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

  const { fixings, as_of_date, data_source, last_known_hicp_xt, hicp_xt_history } = data

  // Build continuous chart data: last 24 months of EUHICPXT history + 24 forward fixings
  type ChartPoint = { label: string; histLevel?: number; fixLevel?: number; isForward: boolean }
  const chartData: ChartPoint[] = [
    ...hicp_xt_history.map(h => ({
      label:     new Date(h.month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      histLevel: h.level,
      isForward: false,
    })),
    // Bridge point — last historical level also plotted on fixing series so lines connect
    {
      label:     new Date(hicp_xt_history[hicp_xt_history.length - 1]?.month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      histLevel: last_known_hicp_xt,
      fixLevel:  last_known_hicp_xt,
      isForward: false,
    },
    ...fixings.map(f => ({
      label:    new Date(f.calendar_month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      fixLevel: f.level ?? undefined,
      isForward: true,
    })),
  ]

  const fmtMom = (v: number | null) =>
    v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`

  const momColor = (v: number | null) =>
    v == null ? MUTED : v > 0.05 ? '#22c55e' : v < -0.05 ? '#ef4444' : '#94a3b8'

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ fontSize: 11, color: '#334155' }}>As of {as_of_date}</div>
        <div style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 4,
          background: data_source === 'bloomberg' ? 'rgba(34,197,94,0.12)' : 'rgba(251,191,36,0.10)',
          color:      data_source === 'bloomberg' ? '#22c55e' : '#fbbf24',
          border:    `1px solid ${data_source === 'bloomberg' ? 'rgba(34,197,94,0.25)' : 'rgba(251,191,36,0.2)'}`,
        }}>
          {data_source === 'bloomberg' ? 'Live · Bloomberg' : 'Simulated'}
        </div>
        <div style={{ fontSize: 10, color: '#334155' }}>
          Last EUHICPXT: <span style={{ color: '#818cf8', fontWeight: 600 }}>{last_known_hicp_xt.toFixed(2)}</span>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            HICP-XT — History &amp; Implied Fixing Curve
          </div>
          <div style={{ fontSize: 10, color: '#334155' }}>Index level (2015 = 100)</div>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 16 }}>
          EUHICPXT Index (history) · EUSWIF1–12 &amp; EUSWIT1–12 Comdty (YoY → reconstructed levels)
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} interval={5} />
            <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} width={48} domain={['auto', 'auto']} tickFormatter={(v: number) => v.toFixed(1)} />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                const pt = payload[0].payload as ChartPoint
                const level = pt.histLevel ?? pt.fixLevel
                return (
                  <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                    <div style={{ color: '#94a3b8', marginBottom: 4 }}>{label}</div>
                    <div style={{ color: pt.isForward ? '#6366f1' : '#818cf8' }}>
                      {pt.isForward ? 'Implied' : 'Actual'}: <strong>{level?.toFixed(2) ?? '—'}</strong>
                    </div>
                    {pt.isForward && <div style={{ color: '#334155', fontSize: 10, marginTop: 2 }}>Reconstructed from YoY fixing</div>}
                  </div>
                )
              }}
            />
            <Line type="monotone" dataKey="histLevel" name="EUHICPXT"
              stroke="#818cf8" strokeWidth={1.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="fixLevel" name="Implied (fixings)"
              stroke="#6366f1" strokeWidth={2} strokeDasharray="4 2"
              dot={{ r: 2, fill: '#6366f1' }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 20, marginTop: 12, justifyContent: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
            <div style={{ width: 22, height: 2, background: '#818cf8', borderRadius: 1 }} />
            EUHICPXT history
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
            <div style={{ width: 22, height: 2, background: '#6366f1', borderRadius: 1, borderTop: '2px dashed #6366f1' }} />
            Reconstructed fixings
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Fixing Detail
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 14 }}>
          Level reconstructed from YoY rate × EUHICPXT base · MoM SA = MoM NSA − seasonal factor
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['#', 'Month', 'BBG Ticker', 'YoY', 'Level', 'MoM NSA', 'MoM SA'].map(h => (
                  <th key={h} style={{ ...th, textAlign: h === 'BBG Ticker' || h === 'Month' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fixings.map((f, i) => (
                <tr key={`${f.ticker}-${i}`}
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                  <td style={{ ...td('#475569'), textAlign: 'right', width: 32 }}>{i + 1}</td>
                  <td style={{ ...td(), textAlign: 'left' }}>
                    {new Date(f.calendar_month + '-02').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
                    {i === 0 && <span style={{ marginLeft: 6, fontSize: 9, color: '#6366f1' }}>nearest</span>}
                    {i === 12 && <span style={{ marginLeft: 6, fontSize: 9, color: '#475569' }}>T-series</span>}
                  </td>
                  <td style={{ padding: '5px 12px', fontSize: 10, color: '#475569', fontFamily: 'monospace', textAlign: 'left' }}>
                    {f.ticker}
                  </td>
                  <td style={td(momColor(f.yoy_implied))}>
                    {f.yoy_implied != null ? `${f.yoy_implied >= 0 ? '+' : ''}${f.yoy_implied.toFixed(2)}%` : '—'}
                  </td>
                  <td style={td()}>{f.level != null ? f.level.toFixed(2) : '—'}</td>
                  <td style={td(momColor(f.mom_nsa))}>{fmtMom(f.mom_nsa)}</td>
                  <td style={td(momColor(f.mom_sa))}>{fmtMom(f.mom_sa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginTop: 10 }}>
          Months 1–12: EUSWIF series · Months 13–24: EUSWIT series (T-series base = reconstructed F-series)
        </div>
      </div>

    </div>
  )
}

// ─── GBP · RPI Fixings component ─────────────────────────────────────────────

interface GbpFixingsResponse {
  data_source:    string
  as_of_date:     string
  last_known_rpi: number
  rpi_history:    { month: string; level: number }[]
  fixings:        FixingRow[]
}

function GbpFixings() {
  const navigate = useNavigate()
  const [data,    setData]    = useState<GbpFixingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const token = localStorage.getItem('access_token')
    fetch('/api/tools/inflation-fixings/gbp', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => {
        if (r.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
          throw new Error('Session expired')
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: GbpFixingsResponse) => { setData(d); setLoading(false) })
      .catch((e: Error) => { setError(e.message); setLoading(false) })
  }, [navigate])

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

  const { fixings, as_of_date, data_source, last_known_rpi, rpi_history } = data

  // Build continuous chart data: last 24 months of UKCERPI history + 24 forward fixings
  type ChartPoint = { label: string; histLevel?: number; fixLevel?: number; isForward: boolean }
  const chartData: ChartPoint[] = [
    ...rpi_history.map(h => ({
      label:     new Date(h.month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      histLevel: h.level,
      isForward: false,
    })),
    // Bridge point — last historical level also plotted on fixing series so lines connect
    {
      label:     new Date(rpi_history[rpi_history.length - 1]?.month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      histLevel: last_known_rpi,
      fixLevel:  last_known_rpi,
      isForward: false,
    },
    ...fixings.map(f => ({
      label:    new Date(f.calendar_month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      fixLevel: f.level ?? undefined,
      isForward: true,
    })),
  ]

  const fmtMom = (v: number | null) =>
    v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`

  const momColor = (v: number | null) =>
    v == null ? MUTED : v > 0.05 ? '#22c55e' : v < -0.05 ? '#ef4444' : '#94a3b8'

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ fontSize: 11, color: '#334155' }}>As of {as_of_date}</div>
        <div style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 4,
          background: data_source === 'bloomberg' ? 'rgba(34,197,94,0.12)' : 'rgba(251,191,36,0.10)',
          color:      data_source === 'bloomberg' ? '#22c55e' : '#fbbf24',
          border:    `1px solid ${data_source === 'bloomberg' ? 'rgba(34,197,94,0.25)' : 'rgba(251,191,36,0.2)'}`,
        }}>
          {data_source === 'bloomberg' ? 'Live · Bloomberg' : 'Simulated'}
        </div>
        <div style={{ fontSize: 10, color: '#334155' }}>
          Last RPI: <span style={{ color: '#fbbf24', fontWeight: 600 }}>{last_known_rpi.toFixed(2)}</span>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            RPI — History &amp; Implied Fixing Curve
          </div>
          <div style={{ fontSize: 10, color: '#334155' }}>Index level</div>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 16 }}>
          UKCERPI Index (history) · UKRPIF1–12 &amp; UKRPIT1–12 Comdty (YoY → reconstructed levels)
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} interval={5} />
            <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} width={48} domain={['auto', 'auto']} tickFormatter={(v: number) => v.toFixed(1)} />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                const pt = payload[0].payload as ChartPoint
                const level = pt.histLevel ?? pt.fixLevel
                return (
                  <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                    <div style={{ color: '#94a3b8', marginBottom: 4 }}>{label}</div>
                    <div style={{ color: pt.isForward ? '#fbbf24' : '#fcd34d' }}>
                      {pt.isForward ? 'Implied' : 'Actual'}: <strong>{level?.toFixed(2) ?? '—'}</strong>
                    </div>
                    {pt.isForward && <div style={{ color: '#334155', fontSize: 10, marginTop: 2 }}>Reconstructed from YoY fixing</div>}
                  </div>
                )
              }}
            />
            <Line type="monotone" dataKey="histLevel" name="RPI history"
              stroke="#fcd34d" strokeWidth={1.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="fixLevel" name="Implied (fixings)"
              stroke="#fbbf24" strokeWidth={2} strokeDasharray="4 2"
              dot={{ r: 2, fill: '#fbbf24' }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 20, marginTop: 12, justifyContent: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
            <div style={{ width: 22, height: 2, background: '#fcd34d', borderRadius: 1 }} />
            RPI history
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
            <div style={{ width: 22, height: 2, background: '#fbbf24', borderRadius: 1, borderTop: '2px dashed #fbbf24' }} />
            Implied (fixings)
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Fixing Detail
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 14 }}>
          Level reconstructed from YoY rate × UKCERPI base · MoM SA = MoM NSA − seasonal factor
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['#', 'Month', 'BBG Ticker', 'YoY', 'Level', 'MoM NSA', 'MoM SA'].map(h => (
                  <th key={h} style={{ ...th, textAlign: h === 'BBG Ticker' || h === 'Month' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fixings.map((f, i) => (
                <tr key={`${f.ticker}-${i}`}
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                  <td style={{ ...td('#475569'), textAlign: 'right', width: 32 }}>{i + 1}</td>
                  <td style={{ ...td(), textAlign: 'left' }}>
                    {new Date(f.calendar_month + '-02').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
                    {i === 0 && <span style={{ marginLeft: 6, fontSize: 9, color: '#fbbf24' }}>nearest</span>}
                    {i === 12 && <span style={{ marginLeft: 6, fontSize: 9, color: '#475569' }}>T-series</span>}
                  </td>
                  <td style={{ padding: '5px 12px', fontSize: 10, color: '#475569', fontFamily: 'monospace', textAlign: 'left' }}>
                    {f.ticker}
                  </td>
                  <td style={td(momColor(f.yoy_implied))}>
                    {f.yoy_implied != null ? `${f.yoy_implied >= 0 ? '+' : ''}${f.yoy_implied.toFixed(2)}%` : '—'}
                  </td>
                  <td style={td()}>{f.level != null ? f.level.toFixed(2) : '—'}</td>
                  <td style={td(momColor(f.mom_nsa))}>{fmtMom(f.mom_nsa)}</td>
                  <td style={td(momColor(f.mom_sa))}>{fmtMom(f.mom_sa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginTop: 10 }}>
          Months 1–12: UKRPIF series · Months 13–24: UKRPIT series (T-series base = reconstructed F-series)
        </div>
      </div>

    </div>
  )
}

// ─── UK · CPI / RPI data ─────────────────────────────────────────────────────
//  month 0 = Jan 2000 · month 305 = Jun 2025 · base 2015 = 100

const UK_RPI_YOY: [number, number][] = [
  [0, 2.4], [72, 3.8], [96, 5.0], [108, -1.4], [120, 5.3],
  [132, 5.2], [144, 3.3], [180, 2.0], [228, 2.7], [240, 1.5],
  [252, 1.2], [258, 3.5], [264, 8.5], [270, 12.0], [273, 12.6],
  [276, 13.4], [282, 9.1], [288, 5.3], [294, 3.0], [300, 3.4], [305, 3.1],
]
const UK_CPI_YOY: [number, number][] = [
  [0, 0.8], [72, 1.8], [96, 5.2], [108, 1.1], [120, 3.7],
  [132, 5.2], [144, 2.7], [180, 1.5], [228, 2.1], [240, 0.7],
  [252, 0.9], [258, 2.5], [264, 6.2], [270, 10.1], [273, 11.1],
  [276, 10.4], [282, 6.8], [288, 4.0], [294, 2.2], [300, 2.5], [305, 2.0],
]
const UK_CORE_YOY: [number, number][] = [
  [0, 1.2], [96, 2.2], [108, 1.7], [132, 3.1], [144, 2.4],
  [180, 1.5], [228, 1.9], [240, 1.3], [252, 1.2], [258, 2.1],
  [264, 4.5], [270, 6.4], [276, 6.2], [282, 6.9], [288, 5.1],
  [294, 3.5], [300, 3.4], [305, 3.5],
]
const UK_SERVICES_YOY: [number, number][] = [
  [0, 2.8], [96, 3.8], [108, 2.5], [132, 4.5], [144, 3.4],
  [180, 2.5], [228, 2.3], [240, 1.8], [252, 1.5], [258, 3.0],
  [264, 5.2], [270, 7.0], [276, 7.0], [282, 6.9], [288, 6.1],
  [294, 5.7], [300, 5.2], [305, 5.5],
]
const UK_GOODS_YOY: [number, number][] = [
  [0, -0.5], [96, 0.8], [108, 0.9], [132, 1.4], [144, 1.2],
  [180, 0.0], [228, 0.9], [240, 0.4], [252, 0.8], [258, 1.3],
  [264, 3.8], [270, 5.8], [276, 5.5], [282, 4.1], [288, 1.2],
  [294, 0.9], [300, 0.8], [305, 0.5],
]
const UK_ENERGY_YOY: [number, number][] = [
  [0, 5.0], [96, 20.0], [108, -12.0], [120, 8.0], [132, 10.0],
  [144, 6.0], [180, -5.0], [240, -8.0], [252, 5.0], [258, 20.0],
  [264, 52.0], [270, 70.0], [273, 70.0], [276, 26.0], [282, -20.0],
  [288, -8.0], [294, 3.0], [305, 2.0],
]
const UK_FOOD_YOY: [number, number][] = [
  [0, 2.5], [96, 9.0], [108, 1.5], [132, 6.0], [144, 3.5],
  [180, 1.5], [228, 2.0], [240, 0.8], [252, 1.0], [258, 4.0],
  [264, 10.0], [271, 18.2], [276, 19.1], [282, 15.0], [288, 7.0],
  [294, 2.5], [300, 2.8], [305, 3.0],
]

interface CpiPoint {
  date:      string
  rpi:       number
  cpi:       number
  cpiCore:   number
  services:  number
  goods:     number
  energy:    number
  food:      number
}

type CpiKey = 'rpi' | 'cpi' | 'cpiCore' | 'services' | 'goods' | 'energy' | 'food'

interface CpiSeriesDef {
  key:        CpiKey
  label:      string
  color:      string
  ticker:     string
  blockStart: boolean
  inChart:    boolean
}

const GBP_SERIES: CpiSeriesDef[] = [
  { key: 'rpi',      label: 'RPI',                  color: '#fbbf24', ticker: 'UKCERPI Index',   blockStart: true,  inChart: true  },
  { key: 'cpi',      label: 'CPI',                  color: '#6366f1', ticker: 'UKRPCJPA Index',  blockStart: true,  inChart: true  },
  { key: 'cpiCore',  label: 'CPI Core',              color: '#38bdf8', ticker: 'UKCRCORE Index',  blockStart: true,  inChart: true  },
  { key: 'services', label: 'CPI Services',          color: '#a5b4fc', ticker: 'UKRPCJSR Index',  blockStart: false, inChart: false },
  { key: 'goods',    label: 'CPI Core Goods',        color: '#7dd3fc', ticker: 'UKRPCJCG Index',  blockStart: false, inChart: false },
  { key: 'energy',   label: 'CPI Energy',            color: '#f97316', ticker: 'UKRPCJEN Index',  blockStart: true,  inChart: true  },
  { key: 'food',     label: 'Food, Alc. & Tobacco',  color: '#22c55e', ticker: 'UKRPCJFT Index',  blockStart: true,  inChart: false },
]

function generateCpiLevels(): CpiPoint[] {
  const rngR  = mulberry32(0xaa55aa55)
  const rngC  = mulberry32(0xdeadbeef)
  const rngCo = mulberry32(0xcafebabe)
  const rngSv = mulberry32(0x87654321)
  const rngG  = mulberry32(0xabcdef01)
  const rngE  = mulberry32(0x12345678)
  const rngF  = mulberry32(0x11223344)

  // Starting levels Jan 2000 (2015 = 100)
  let rpi      = 72.0   // RPI (higher methodology, starts slightly lower/higher)
  let cpi      = 79.5
  let cpiCore  = 81.0
  let services = 68.0   // high historical services inflation → lower start
  let goods    = 92.0   // near-deflation goods → high start
  let energy   = 50.0
  let food     = 74.0

  const points: CpiPoint[] = []
  for (let t = 0; t < 306; t++) {
    rpi      *= (1 + interp(UK_RPI_YOY,      t) / 1200 + (rngR()  - 0.5) * 0.0012)
    cpi      *= (1 + interp(UK_CPI_YOY,      t) / 1200 + (rngC()  - 0.5) * 0.0008)
    cpiCore  *= (1 + interp(UK_CORE_YOY,     t) / 1200 + (rngCo() - 0.5) * 0.0005)
    services *= (1 + interp(UK_SERVICES_YOY, t) / 1200 + (rngSv() - 0.5) * 0.0004)
    goods    *= (1 + interp(UK_GOODS_YOY,    t) / 1200 + (rngG()  - 0.5) * 0.0005)
    energy   *= (1 + interp(UK_ENERGY_YOY,   t) / 1200 + (rngE()  - 0.5) * 0.0030)
    food     *= (1 + interp(UK_FOOD_YOY,     t) / 1200 + (rngF()  - 0.5) * 0.0015)
    points.push({
      date:     new Date(2000, t, 1).toISOString().slice(0, 7),
      rpi:      +rpi.toFixed(2),
      cpi:      +cpi.toFixed(2),
      cpiCore:  +cpiCore.toFixed(2),
      services: +services.toFixed(2),
      goods:    +goods.toFixed(2),
      energy:   +energy.toFixed(2),
      food:     +food.toFixed(2),
    })
  }
  return points
}

// ─── UK · Index Levels component ─────────────────────────────────────────────

function GbpIndexLevels({ data }: { data: CpiPoint[] }) {
  const metrics = useMemo(() => {
    const m: Partial<Record<CpiKey, SeriesMetrics[]>> = {}
    for (const s of GBP_SERIES) m[s.key] = computeMetrics(data.map(d => d.date), data.map(d => d[s.key]))
    return m as Record<CpiKey, SeriesMetrics[]>
  }, [data])

  const latest  = data[data.length - 1]
  const prev12  = data[data.length - 13]
  const xTicks  = data.filter(d => d.date.endsWith('-01') && +d.date.slice(0, 4) % 2 === 0).map(d => d.date)
  const tableRows   = data.slice(-24).reverse()
  const chartSeries = GBP_SERIES.filter(s => s.inChart)

  const th: React.CSSProperties = {
    padding: '5px 10px', color: MUTED, fontWeight: 500, fontSize: 10,
    textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'right',
    whiteSpace: 'nowrap',
  }
  const thFirst = (s: CpiSeriesDef): React.CSSProperties => ({
    ...th,
    borderLeft: s.blockStart ? `2px solid ${s.color}88` : `1px solid rgba(255,255,255,0.06)`,
  })
  const td = (color?: string): React.CSSProperties => ({
    padding: '5px 10px', fontSize: 11, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums', color: color ?? '#f1f5f9',
  })
  const tdFirst = (s: CpiSeriesDef, color?: string): React.CSSProperties => ({
    ...td(color),
    borderLeft: s.blockStart ? `2px solid ${s.color}66` : `1px solid rgba(255,255,255,0.05)`,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {GBP_SERIES.map(s => {
          const level = latest[s.key]
          const yoy   = (level / prev12[s.key] - 1) * 100
          const isMain = s.blockStart
          return (
            <div key={s.key} style={{
              ...cardStyle,
              borderLeft: `3px solid ${s.color}99`,
              paddingLeft: isMain ? 16 : 14,
              opacity:     isMain ? 1 : 0.85,
            }}>
              <div style={{ fontSize: 9, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                {!s.blockStart && <span style={{ color: s.color, marginRight: 4 }}>↳</span>}
                {s.label}
              </div>
              <div style={{ fontSize: isMain ? 22 : 18, fontWeight: 800, color: s.color, letterSpacing: '-0.02em' }}>
                {level.toFixed(2)}
              </div>
              <div style={{ fontSize: 11, color: yoy >= 0 ? '#22c55e' : '#ef4444', marginTop: 2 }}>
                {yoy >= 0 ? '+' : ''}{yoy.toFixed(1)}% YoY
              </div>
              <div style={{ fontSize: 9, color: '#334155', marginTop: 3 }}>
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
            CPI / RPI Index Levels — United Kingdom
          </div>
          <div style={{ fontSize: 10, color: '#334155' }}>2015 = 100</div>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 16 }}>
          Jan 2000 – Jun 2025 · Simulated
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={data} margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="date" ticks={xTicks} tickFormatter={d => d.slice(0, 4)}
              tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false}
              width={44} tickFormatter={(v: number) => v.toFixed(0)} />
            <Tooltip content={<IndexTooltip />} />
            {chartSeries.map(s => (
              <Line key={s.key} type="monotone" dataKey={s.key}
                name={s.label} stroke={s.color} strokeWidth={1.5} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 20, marginTop: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
          {chartSeries.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
              <div style={{ width: 22, height: 2, background: s.color, borderRadius: 1, flexShrink: 0 }} />
              {s.label}
            </div>
          ))}
          <div style={{ fontSize: 10, color: '#334155', alignSelf: 'center' }}>
            Services, Core Goods &amp; Food shown in table only
          </div>
        </div>
      </div>

      {/* Data table */}
      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Recent Prints
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 14 }}>
          MoM SA computed via STL decomposition (Loess, period = 12) · ↳ = sub-component of the block above
        </div>

        {/* Block legend */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          {GBP_SERIES.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
              <div style={{
                width: s.blockStart ? 10 : 6, height: s.blockStart ? 10 : 6,
                borderRadius: 2, background: s.color,
                opacity: s.blockStart ? 1 : 0.7, flexShrink: 0,
              }} />
              <span style={{ color: s.blockStart ? '#94a3b8' : '#64748b' }}>
                {!s.blockStart && '↳ '}{s.label}
              </span>
            </div>
          ))}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <th style={{ ...th, textAlign: 'left', width: 72 }} rowSpan={2}>Date</th>
                {GBP_SERIES.map(s => (
                  <th key={s.key} colSpan={4} style={{
                    ...th, textAlign: 'center', color: s.color, paddingBottom: 4,
                    borderBottom: `2px solid ${s.color}${s.blockStart ? 'bb' : '55'}`,
                    borderLeft: s.blockStart ? `2px solid ${s.color}88` : `1px solid rgba(255,255,255,0.06)`,
                    background: `${s.color}08`,
                    fontSize: s.blockStart ? 10 : 9,
                  }}>
                    {!s.blockStart && <span style={{ opacity: 0.7 }}>↳ </span>}{s.label}
                  </th>
                ))}
              </tr>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.09)' }}>
                {GBP_SERIES.map(s => (
                  ['Level', 'YoY', 'MoM', 'SA'].map((h, hi) => (
                    <th key={`${s.key}-${h}`} style={{ ...th, ...(hi === 0 ? thFirst(s) : {}) }}>{h}</th>
                  ))
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((pt, i) => {
                const rowMetrics = {} as Record<CpiKey, SeriesMetrics>
                for (const s of GBP_SERIES) rowMetrics[s.key] = metrics[s.key].find(m => m.date === pt.date)!
                return (
                  <tr key={pt.date} style={{
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: i === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                  }}>
                    <td style={{ ...td(), textAlign: 'left', color: i === 0 ? '#f1f5f9' : '#94a3b8', fontWeight: i === 0 ? 600 : 400 }}>
                      {new Date(pt.date + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
                      {i === 0 && <span style={{ marginLeft: 6, fontSize: 9, color: '#38bdf8' }}>latest</span>}
                    </td>
                    {GBP_SERIES.map(s => {
                      const m = rowMetrics[s.key]
                      return [
                        <td key={`${s.key}-lv`} style={tdFirst(s)}>{m.level.toFixed(2)}</td>,
                        <td key={`${s.key}-yy`} style={td(pctColor(m.yoy))}>{fmtPct(m.yoy, 1)}</td>,
                        <td key={`${s.key}-mm`} style={td(pctColor(m.mom))}>{fmtPct(m.mom)}</td>,
                        <td key={`${s.key}-sa`} style={td(pctColor(m.momSA))}>{fmtPct(m.momSA)}</td>,
                      ]
                    })}
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

// ─── USD · CPI data ──────────────────────────────────────────────────────────
//  month 0 = Jan 2000 · month 305 = Jun 2025 · base 1982-84 = 100

const US_CPI_NSA_YOY: [number, number][] = [
  [0, 2.7], [60, 3.4], [96, 4.3], [108, -0.4], [120, 1.5],
  [132, 3.2], [144, 2.1], [180, 1.8], [228, 2.1], [240, 1.2],
  [252, 1.4], [258, 2.6], [264, 7.0], [270, 9.1], [273, 8.5],
  [276, 7.1], [282, 4.0], [288, 3.2], [294, 2.7], [300, 2.9], [305, 2.7],
]
const US_CORE_YOY: [number, number][] = [
  [0, 2.4], [96, 2.5], [108, 1.7], [120, 0.9], [132, 2.3],
  [144, 2.0], [180, 1.7], [228, 2.2], [240, 2.0], [252, 1.6],
  [258, 2.0], [264, 5.0], [270, 5.9], [276, 6.3], [280, 6.6],
  [282, 5.5], [288, 3.8], [294, 3.4], [300, 3.3], [305, 3.2],
]
const US_CORE_GOODS_YOY: [number, number][] = [
  [0, 0.0], [96, 0.8], [108, -0.5], [132, 0.5], [144, -0.5],
  [180, -1.0], [228, -0.2], [240, -1.5], [252, -0.5], [258, 1.5],
  [264, 7.0], [270, 12.3], [274, 7.6], [282, 0.2], [288, -1.8],
  [294, -2.2], [300, -1.0], [305, 0.0],
]
const US_CORE_SERVICES_YOY: [number, number][] = [
  [0, 3.5], [96, 3.5], [108, 2.5], [132, 3.0], [144, 2.8],
  [180, 2.5], [228, 2.8], [240, 3.2], [252, 3.0], [258, 2.8],
  [264, 3.6], [270, 5.1], [276, 7.2], [282, 7.8], [286, 8.2],
  [288, 6.2], [294, 5.0], [300, 4.4], [305, 4.0],
]

interface UsdCpiPoint {
  date:         string
  cpiNsa:       number
  cpiSa:        number    // STL-derived seasonal adjustment
  cpiCore:      number
  coreGoods:    number
  coreServices: number
}

type UsdCpiKey = 'cpiNsa' | 'cpiSa' | 'cpiCore' | 'coreGoods' | 'coreServices'

interface UsdSeriesDef {
  key:        UsdCpiKey
  label:      string
  color:      string
  ticker:     string
  blockStart: boolean
  inChart:    boolean
}

const USD_SERIES: UsdSeriesDef[] = [
  { key: 'cpiNsa',       label: 'CPI (NSA)',       color: '#f59e0b', ticker: 'CPURNSA Index',   blockStart: true,  inChart: true  },
  { key: 'cpiSa',        label: 'CPI (SA)',         color: '#fbbf24', ticker: 'CPURNSA Index†',  blockStart: false, inChart: true  },
  { key: 'cpiCore',      label: 'Core CPI',         color: '#38bdf8', ticker: 'CPUPAXFE Index',  blockStart: true,  inChart: true  },
  { key: 'coreGoods',    label: 'Core Goods',       color: '#7dd3fc', ticker: 'CPUPAXFEG Index', blockStart: false, inChart: false },
  { key: 'coreServices', label: 'Core Services',    color: '#a5b4fc', ticker: 'CPUPAXFES Index', blockStart: false, inChart: false },
]

function generateUsdCpiLevels(): UsdCpiPoint[] {
  const rngN  = mulberry32(0xf59e0b00)
  const rngC  = mulberry32(0x38bdf800)
  const rngCG = mulberry32(0x7dd3fc00)
  const rngCS = mulberry32(0xa5b4fc00)

  // Starting levels Jan 2000 (1982-84 = 100 base)
  let cpiNsa       = 168.0
  let cpiCore      = 162.0
  let coreGoods    = 152.0   // near-deflation goods historically
  let coreServices = 166.0   // higher inflation services

  const nsaLevels: number[] = []

  for (let t = 0; t < 306; t++) {
    cpiNsa       *= (1 + interp(US_CPI_NSA_YOY,      t) / 1200 + (rngN()  - 0.5) * 0.0010)
    cpiCore      *= (1 + interp(US_CORE_YOY,          t) / 1200 + (rngC()  - 0.5) * 0.0005)
    coreGoods    *= (1 + interp(US_CORE_GOODS_YOY,    t) / 1200 + (rngCG() - 0.5) * 0.0006)
    coreServices *= (1 + interp(US_CORE_SERVICES_YOY, t) / 1200 + (rngCS() - 0.5) * 0.0004)
    nsaLevels.push(cpiNsa)
  }

  // Run STL on NSA series to get SA values
  const { sa: saLevels } = stl(nsaLevels)

  // Reset accumulators for final push
  let cpiNsa2       = 168.0
  let cpiCore2      = 162.0
  let coreGoods2    = 152.0
  let coreServices2 = 166.0
  const rngN2  = mulberry32(0xf59e0b00)
  const rngC2  = mulberry32(0x38bdf800)
  const rngCG2 = mulberry32(0x7dd3fc00)
  const rngCS2 = mulberry32(0xa5b4fc00)

  const points: UsdCpiPoint[] = []
  for (let t = 0; t < 306; t++) {
    cpiNsa2       *= (1 + interp(US_CPI_NSA_YOY,      t) / 1200 + (rngN2()  - 0.5) * 0.0010)
    cpiCore2      *= (1 + interp(US_CORE_YOY,          t) / 1200 + (rngC2()  - 0.5) * 0.0005)
    coreGoods2    *= (1 + interp(US_CORE_GOODS_YOY,    t) / 1200 + (rngCG2() - 0.5) * 0.0006)
    coreServices2 *= (1 + interp(US_CORE_SERVICES_YOY, t) / 1200 + (rngCS2() - 0.5) * 0.0004)
    points.push({
      date:         new Date(2000, t, 1).toISOString().slice(0, 7),
      cpiNsa:       +cpiNsa2.toFixed(2),
      cpiSa:        +saLevels[t].toFixed(2),
      cpiCore:      +cpiCore2.toFixed(2),
      coreGoods:    +coreGoods2.toFixed(2),
      coreServices: +coreServices2.toFixed(2),
    })
  }
  return points
}

// ─── USD · Index Levels component ────────────────────────────────────────────

function UsdIndexLevels({ data }: { data: UsdCpiPoint[] }) {
  const metrics = useMemo(() => {
    const m: Partial<Record<UsdCpiKey, SeriesMetrics[]>> = {}
    for (const s of USD_SERIES) m[s.key] = computeMetrics(data.map(d => d.date), data.map(d => d[s.key]))
    return m as Record<UsdCpiKey, SeriesMetrics[]>
  }, [data])

  const latest  = data[data.length - 1]
  const prev12  = data[data.length - 13]
  const xTicks  = data.filter(d => d.date.endsWith('-01') && +d.date.slice(0, 4) % 2 === 0).map(d => d.date)
  const tableRows   = data.slice(-24).reverse()
  const chartSeries = USD_SERIES.filter(s => s.inChart)

  const th: React.CSSProperties = {
    padding: '5px 10px', color: MUTED, fontWeight: 500, fontSize: 10,
    textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'right',
    whiteSpace: 'nowrap',
  }
  const thFirst = (s: UsdSeriesDef): React.CSSProperties => ({
    ...th,
    borderLeft: s.blockStart ? `2px solid ${s.color}88` : `1px solid rgba(255,255,255,0.06)`,
  })
  const td = (color?: string): React.CSSProperties => ({
    padding: '5px 10px', fontSize: 11, textAlign: 'right',
    fontVariantNumeric: 'tabular-nums', color: color ?? '#f1f5f9',
  })
  const tdFirst = (s: UsdSeriesDef, color?: string): React.CSSProperties => ({
    ...td(color),
    borderLeft: s.blockStart ? `2px solid ${s.color}66` : `1px solid rgba(255,255,255,0.05)`,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Summary cards — 3 cols, 2 rows */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {USD_SERIES.map(s => {
          const level = latest[s.key]
          const yoy   = (level / prev12[s.key] - 1) * 100
          const isMain = s.blockStart
          return (
            <div key={s.key} style={{
              ...cardStyle,
              borderLeft: `3px solid ${s.color}99`,
              paddingLeft: isMain ? 16 : 14,
              opacity:     isMain ? 1 : 0.85,
            }}>
              <div style={{ fontSize: 9, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                {!s.blockStart && <span style={{ color: s.color, marginRight: 4 }}>↳</span>}
                {s.label}
              </div>
              <div style={{ fontSize: isMain ? 22 : 18, fontWeight: 800, color: s.color, letterSpacing: '-0.02em' }}>
                {level.toFixed(2)}
              </div>
              <div style={{ fontSize: 11, color: yoy >= 0 ? '#22c55e' : '#ef4444', marginTop: 2 }}>
                {yoy >= 0 ? '+' : ''}{yoy.toFixed(1)}% YoY
              </div>
              <div style={{ fontSize: 9, color: '#334155', marginTop: 3 }}>
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
            CPI Index Levels — United States
          </div>
          <div style={{ fontSize: 10, color: '#334155' }}>1982-84 = 100</div>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 16 }}>
          Jan 2000 – Jun 2025 · 1982-84 = 100 · Simulated
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={data} margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="date" ticks={xTicks} tickFormatter={d => d.slice(0, 4)}
              tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false}
              width={44} tickFormatter={(v: number) => v.toFixed(0)} />
            <Tooltip content={<IndexTooltip />} />
            {chartSeries.map(s => (
              <Line key={s.key} type="monotone" dataKey={s.key}
                name={s.label} stroke={s.color} strokeWidth={1.5} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 20, marginTop: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
          {chartSeries.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
              <div style={{ width: 22, height: 2, background: s.color, borderRadius: 1, flexShrink: 0 }} />
              {s.label}
            </div>
          ))}
          <div style={{ fontSize: 10, color: '#334155', alignSelf: 'center' }}>
            Core Goods &amp; Services shown in table only
          </div>
        </div>
      </div>

      {/* Data table */}
      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Recent Prints
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 14 }}>
          MoM SA computed via STL decomposition (Loess, period = 12) · ↳ = sub-component of the block above
        </div>

        {/* Block legend */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
          {USD_SERIES.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
              <div style={{
                width: s.blockStart ? 10 : 6, height: s.blockStart ? 10 : 6,
                borderRadius: 2, background: s.color,
                opacity: s.blockStart ? 1 : 0.7, flexShrink: 0,
              }} />
              <span style={{ color: s.blockStart ? '#94a3b8' : '#64748b' }}>
                {!s.blockStart && '↳ '}{s.label}
              </span>
            </div>
          ))}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <th style={{ ...th, textAlign: 'left', width: 72 }} rowSpan={2}>Date</th>
                {USD_SERIES.map(s => (
                  <th key={s.key} colSpan={4} style={{
                    ...th, textAlign: 'center', color: s.color, paddingBottom: 4,
                    borderBottom: `2px solid ${s.color}${s.blockStart ? 'bb' : '55'}`,
                    borderLeft: s.blockStart ? `2px solid ${s.color}88` : `1px solid rgba(255,255,255,0.06)`,
                    background: `${s.color}08`,
                    fontSize: s.blockStart ? 10 : 9,
                  }}>
                    {!s.blockStart && <span style={{ opacity: 0.7 }}>↳ </span>}{s.label}
                  </th>
                ))}
              </tr>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.09)' }}>
                {USD_SERIES.map(s => (
                  ['Level', 'YoY', 'MoM', 'SA'].map((h, hi) => (
                    <th key={`${s.key}-${h}`} style={{ ...th, ...(hi === 0 ? thFirst(s) : {}) }}>{h}</th>
                  ))
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((pt, i) => {
                const rowMetrics = {} as Record<UsdCpiKey, SeriesMetrics>
                for (const s of USD_SERIES) rowMetrics[s.key] = metrics[s.key].find(m => m.date === pt.date)!
                return (
                  <tr key={pt.date} style={{
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: i === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                  }}>
                    <td style={{ ...td(), textAlign: 'left', color: i === 0 ? '#f1f5f9' : '#94a3b8', fontWeight: i === 0 ? 600 : 400 }}>
                      {new Date(pt.date + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
                      {i === 0 && <span style={{ marginLeft: 6, fontSize: 9, color: '#f59e0b' }}>latest</span>}
                    </td>
                    {USD_SERIES.map(s => {
                      const m = rowMetrics[s.key]
                      return [
                        <td key={`${s.key}-lv`} style={tdFirst(s)}>{m.level.toFixed(2)}</td>,
                        <td key={`${s.key}-yy`} style={td(pctColor(m.yoy))}>{fmtPct(m.yoy, 1)}</td>,
                        <td key={`${s.key}-mm`} style={td(pctColor(m.mom))}>{fmtPct(m.mom)}</td>,
                        <td key={`${s.key}-sa`} style={td(pctColor(m.momSA))}>{fmtPct(m.momSA)}</td>,
                      ]
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginTop: 10 }}>
          † CPI SA computed via STL seasonal decomposition
        </div>
      </div>

    </div>
  )
}

// ─── USD · Fixings component ──────────────────────────────────────────────────

interface UsdFixingsResponse {
  data_source:    string
  as_of_date:     string
  last_known_cpi: number
  cpi_history:    { month: string; level: number }[]
  fixings:        FixingRow[]
}

function UsdFixings() {
  const navigate = useNavigate()
  const [data,    setData]    = useState<UsdFixingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const token = localStorage.getItem('access_token')
    fetch('/api/tools/inflation-fixings/usd', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => {
        if (r.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
          throw new Error('Session expired')
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: UsdFixingsResponse) => { setData(d); setLoading(false) })
      .catch((e: Error) => { setError(e.message); setLoading(false) })
  }, [navigate])

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

  const { fixings, as_of_date, data_source, last_known_cpi, cpi_history } = data

  // Build continuous chart data: last 24 months of CPURNSA history + 24 forward fixings
  type ChartPoint = { label: string; histLevel?: number; fixLevel?: number; isForward: boolean }
  const chartData: ChartPoint[] = [
    ...cpi_history.map(h => ({
      label:     new Date(h.month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      histLevel: h.level,
      isForward: false,
    })),
    // Bridge point — last historical level also plotted on fixing series so lines connect
    {
      label:     new Date(cpi_history[cpi_history.length - 1]?.month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      histLevel: last_known_cpi,
      fixLevel:  last_known_cpi,
      isForward: false,
    },
    ...fixings.map(f => ({
      label:    new Date(f.calendar_month + '-02').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      fixLevel: f.level ?? undefined,
      isForward: true,
    })),
  ]

  const fmtMom = (v: number | null) =>
    v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`

  const momColor = (v: number | null) =>
    v == null ? MUTED : v > 0.05 ? '#22c55e' : v < -0.05 ? '#ef4444' : '#94a3b8'

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ fontSize: 11, color: '#334155' }}>As of {as_of_date}</div>
        <div style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 4,
          background: data_source === 'bloomberg' ? 'rgba(34,197,94,0.12)' : 'rgba(251,191,36,0.10)',
          color:      data_source === 'bloomberg' ? '#22c55e' : '#fbbf24',
          border:    `1px solid ${data_source === 'bloomberg' ? 'rgba(34,197,94,0.25)' : 'rgba(251,191,36,0.2)'}`,
        }}>
          {data_source === 'bloomberg' ? 'Live · Bloomberg' : 'Simulated'}
        </div>
        <div style={{ fontSize: 10, color: '#334155' }}>
          Last CPI: <span style={{ color: '#f59e0b', fontWeight: 600 }}>{last_known_cpi.toFixed(2)}</span>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            CPI (NSA) — History &amp; Implied Fixing Curve
          </div>
          <div style={{ fontSize: 10, color: '#334155' }}>Index level (1982-84 = 100)</div>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 16 }}>
          CPURNSA Index (history) · USCPIF1–12 &amp; USCPIT1–12 Comdty (YoY → reconstructed levels)
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} interval={5} />
            <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} width={48} domain={['auto', 'auto']} tickFormatter={(v: number) => v.toFixed(1)} />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                const pt = payload[0].payload as ChartPoint
                const level = pt.histLevel ?? pt.fixLevel
                return (
                  <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                    <div style={{ color: '#94a3b8', marginBottom: 4 }}>{label}</div>
                    <div style={{ color: pt.isForward ? '#f59e0b' : '#fbbf24' }}>
                      {pt.isForward ? 'Implied' : 'Actual'}: <strong>{level?.toFixed(2) ?? '—'}</strong>
                    </div>
                    {pt.isForward && <div style={{ color: '#334155', fontSize: 10, marginTop: 2 }}>Reconstructed from YoY fixing</div>}
                  </div>
                )
              }}
            />
            <Line type="monotone" dataKey="histLevel" name="CPI (NSA) history"
              stroke="#fbbf24" strokeWidth={1.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="fixLevel" name="Implied (fixings)"
              stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 2"
              dot={{ r: 2, fill: '#f59e0b' }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 20, marginTop: 12, justifyContent: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
            <div style={{ width: 22, height: 2, background: '#fbbf24', borderRadius: 1 }} />
            CPI (NSA) history
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#94a3b8' }}>
            <div style={{ width: 22, height: 2, background: '#f59e0b', borderRadius: 1, borderTop: '2px dashed #f59e0b' }} />
            Implied (fixings)
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Fixing Detail
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginBottom: 14 }}>
          Level reconstructed from YoY rate × CPURNSA base · MoM SA = MoM NSA − seasonal factor
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                {['#', 'Month', 'BBG Ticker', 'YoY', 'Level', 'MoM NSA', 'MoM SA'].map(h => (
                  <th key={h} style={{ ...th, textAlign: h === 'BBG Ticker' || h === 'Month' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fixings.map((f, i) => (
                <tr key={`${f.ticker}-${i}`}
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                  <td style={{ ...td('#475569'), textAlign: 'right', width: 32 }}>{i + 1}</td>
                  <td style={{ ...td(), textAlign: 'left' }}>
                    {new Date(f.calendar_month + '-02').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
                    {i === 0 && <span style={{ marginLeft: 6, fontSize: 9, color: '#f59e0b' }}>nearest</span>}
                    {i === 12 && <span style={{ marginLeft: 6, fontSize: 9, color: '#475569' }}>T-series</span>}
                  </td>
                  <td style={{ padding: '5px 12px', fontSize: 10, color: '#475569', fontFamily: 'monospace', textAlign: 'left' }}>
                    {f.ticker}
                  </td>
                  <td style={td(momColor(f.yoy_implied))}>
                    {f.yoy_implied != null ? `${f.yoy_implied >= 0 ? '+' : ''}${f.yoy_implied.toFixed(2)}%` : '—'}
                  </td>
                  <td style={td()}>{f.level != null ? f.level.toFixed(2) : '—'}</td>
                  <td style={td(momColor(f.mom_nsa))}>{fmtMom(f.mom_nsa)}</td>
                  <td style={td(momColor(f.mom_sa))}>{fmtMom(f.mom_sa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginTop: 10 }}>
          Months 1–12: USCPIF series · Months 13–24: USCPIT series (T-series base = reconstructed F-series)
        </div>
        <div style={{ fontSize: 10, color: '#334155', marginTop: 4 }}>
          † Live Bloomberg: use USSWIT&#123;n&#125; Curncy interpolated to calendar months
        </div>
      </div>

    </div>
  )
}

// ─── USD subtab config ────────────────────────────────────────────────────────

type UsdSubtab = 'index-levels' | 'fixings'

const USD_SUBTABS: { id: UsdSubtab; label: string }[] = [
  { id: 'index-levels', label: 'Historical' },
  { id: 'fixings',      label: 'Fixings'    },
]

// ─── EUR subtab config ────────────────────────────────────────────────────────

const EUR_SUBTABS: { id: EurSubtab; label: string }[] = [
  { id: 'index-levels', label: 'Historical' },
  { id: 'fixings',      label: 'Fixings'    },
]

// ─── GBP subtab config ────────────────────────────────────────────────────────

type GbpSubtab = 'index-levels' | 'fixings'

const GBP_SUBTABS: { id: GbpSubtab; label: string }[] = [
  { id: 'index-levels', label: 'Historical' },
  { id: 'fixings',      label: 'Fixings'    },
]

// ─── Main component ───────────────────────────────────────────────────────────

export default function InflationFixingsMonitor() {
  const navigate = useNavigate()
  const [region,    setRegion]    = useState<Region>('EUR')
  const [eurSubtab, setEurSubtab] = useState<EurSubtab>('index-levels')
  const [gbpSubtab, setGbpSubtab] = useState<GbpSubtab>('index-levels')
  const [usdSubtab, setUsdSubtab] = useState<UsdSubtab>('index-levels')

  const hicpData    = useMemo(() => generateHicpLevels(), [])
  const cpiData     = useMemo(() => generateCpiLevels(),  [])
  const usdData     = useMemo(() => generateUsdCpiLevels(), [])
  const regionColor = REGION_COLORS[region]

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#f1f5f9', fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' }}>

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

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, zIndex: 10, background: BG }}>
        {(['EUR', 'GBP', 'USD'] as Region[]).map(r => (
          <button key={r} onClick={() => setRegion(r)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 18px', fontSize: 13, fontWeight: 500, color: region === r ? REGION_COLORS[r] : '#64748b', borderBottom: region === r ? `2px solid ${REGION_COLORS[r]}` : '2px solid transparent', marginBottom: -1, transition: 'color 0.15s' }}>
            {REGION_LABELS[r]}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 20 }}>

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

        {region === 'GBP' && (
          <>
            <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              {GBP_SUBTABS.map(st => (
                <button key={st.id} onClick={() => setGbpSubtab(st.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 14px', fontSize: 12, fontWeight: 500, color: gbpSubtab === st.id ? regionColor : '#64748b', borderBottom: gbpSubtab === st.id ? `2px solid ${regionColor}` : '2px solid transparent', marginBottom: -1 }}>
                  {st.label}
                </button>
              ))}
            </div>
            {gbpSubtab === 'index-levels' && <GbpIndexLevels data={cpiData} />}
            {gbpSubtab === 'fixings'      && <GbpFixings />}
          </>
        )}

        {region === 'USD' && (
          <>
            <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              {USD_SUBTABS.map(st => (
                <button key={st.id} onClick={() => setUsdSubtab(st.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 14px', fontSize: 12, fontWeight: 500, color: usdSubtab === st.id ? regionColor : '#64748b', borderBottom: usdSubtab === st.id ? `2px solid ${regionColor}` : '2px solid transparent', marginBottom: -1 }}>
                  {st.label}
                </button>
              ))}
            </div>
            {usdSubtab === 'index-levels' && <UsdIndexLevels data={usdData} />}
            {usdSubtab === 'fixings'      && <UsdFixings />}
          </>
        )}

      </div>
    </div>
  )
}
