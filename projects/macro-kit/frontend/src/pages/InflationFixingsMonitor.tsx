import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'

// ─── Constants ────────────────────────────────────────────────────────────────

const BG = '#080d1a'
const GREEN = '#22c55e'
const RED = '#ef4444'
const MUTED = '#475569'

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: '16px 20px',
}

type Region = 'EUR' | 'GBP' | 'USD'

interface Measure { id: string; label: string; bbgTicker: string }

const REGION_CONFIG: Record<Region, {
  label: string; color: string
  measures: Measure[]
  // Piecewise YoY trajectory: [monthIdx, yoy%][] — month 0 = Jan 2022
  trajectory: [number, number][]
}> = {
  EUR: {
    label: 'Euro Area', color: '#6366f1',
    measures: [
      { id: 'hicp',      label: 'HICP Headline', bbgTicker: 'ECCPEMUY Index'  },
      { id: 'hicp-core', label: 'HICP Core',     bbgTicker: 'ECCPEXFD Index'  },
      { id: 'hicp-svcs', label: 'HICP Services', bbgTicker: 'ECCPSRVY Index'  },
    ],
    trajectory: [[0, 5.0], [9, 10.6], [15, 9.2], [24, 2.9], [36, 2.3], [42, 2.1]],
  },
  GBP: {
    label: 'UK', color: '#38bdf8',
    measures: [
      { id: 'cpi',      label: 'CPI Headline', bbgTicker: 'UKRPIYOY Index' },
      { id: 'cpi-core', label: 'CPI Core',     bbgTicker: 'UKCPIXFE Index' },
      { id: 'rpi',      label: 'RPI',          bbgTicker: 'UKRPI Index'    },
    ],
    trajectory: [[0, 5.5], [9, 11.1], [16, 9.1], [24, 4.0], [36, 2.3], [42, 2.1]],
  },
  USD: {
    label: 'US', color: '#f59e0b',
    measures: [
      { id: 'cpi',      label: 'CPI Headline', bbgTicker: 'CPI YOY Index'   },
      { id: 'cpi-core', label: 'CPI Core',     bbgTicker: 'CPUPXCHG Index'  },
      { id: 'pce',      label: 'PCE Core',     bbgTicker: 'PCE CYOY Index'  },
    ],
    trajectory: [[0, 7.5], [5, 9.1], [16, 6.5], [24, 3.4], [36, 3.2], [42, 2.8]],
  },
}

// ─── RNG ──────────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function strSeed(s: string): number {
  let h = 0
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

// ─── Trajectory interpolation ─────────────────────────────────────────────────

function interpYoY(pts: [number, number][], t: number): number {
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

// ─── Data generation ──────────────────────────────────────────────────────────

interface FixingPoint {
  date: string      // YYYY-MM
  mom: number       // MoM %
  yoy: number       // YoY %
  consensus: number // Consensus MoM
  surprise: number  // mom - consensus
}

const N_MONTHS = 42  // ~3.5 years starting Jan 2022

function generateFixings(region: Region, measureId: string): FixingPoint[] {
  const cfg = REGION_CONFIG[region]
  // Each measure gets a slightly different seed so they diverge believably
  const rng = mulberry32(strSeed(region + measureId + '_fixings'))
  // Core/services measures run ~1–1.5 pp below headline at peak, stickier on the way down
  const coreOffset = measureId.includes('core') || measureId.includes('svcs') ? 0.5 : 0
  const coreSticky = measureId.includes('core') || measureId.includes('svcs') ? 0.6 : 1.0
  // RPI runs ~2 pp above CPI historically
  const rpiOffset  = measureId === 'rpi' ? 2.0 : 0

  const points: FixingPoint[] = []
  // Start from Jan 2022 (month index 0)
  const startYear = 2022, startMonth = 0 // Jan

  for (let t = 0; t < N_MONTHS; t++) {
    const baseYoY = interpYoY(cfg.trajectory, t)
    const adjustedYoY = (baseYoY - coreOffset * coreSticky + rpiOffset) + (rng() - 0.5) * 0.5
    const yoy = Math.max(0.5, adjustedYoY)

    // MoM ≈ YoY/12 with seasonal variation + noise
    const monthOfYear = (startMonth + t) % 12
    const seasonal    = 0.08 * Math.sin(2 * Math.PI * (monthOfYear - 2) / 12)
    const mom = +(yoy / 12 + seasonal + (rng() - 0.5) * 0.18).toFixed(2)

    const consensus = +(mom - (rng() - 0.5) * 0.14).toFixed(2)
    const surprise  = +(mom - consensus).toFixed(2)

    const d = new Date(startYear, startMonth + t, 1)
    points.push({ date: d.toISOString().slice(0, 7), mom, yoy: +yoy.toFixed(2), consensus, surprise })
  }
  return points
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function SimpleTooltip({ active, payload, label }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#94a3b8', marginBottom: 4 }}>{label}</div>
      {payload.filter(p => p.value != null).map((p, i) => (
        <div key={i} style={{ color: p.color || '#f1f5f9' }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(2) + '%' : p.value}
        </div>
      ))}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function InflationFixingsMonitor() {
  const navigate = useNavigate()
  const [region, setRegion]   = useState<Region>('EUR')
  const [measure, setMeasure] = useState<string>('hicp')

  const cfg = REGION_CONFIG[region]
  const measureCfg = cfg.measures.find(m => m.id === measure) ?? cfg.measures[0]

  // Reset measure to first when switching region
  const handleRegion = (r: Region) => { setRegion(r); setMeasure(REGION_CONFIG[r].measures[0].id) }

  const data: FixingPoint[] = useMemo(() => generateFixings(region, measure), [region, measure])

  const latest  = data[data.length - 1]
  const prev    = data[data.length - 2]
  const last12  = data.slice(-12)

  const momColor  = (v: number) => v >= 0 ? GREEN : RED
  const surpriseColor = (v: number) => Math.abs(v) < 0.05 ? '#94a3b8' : v > 0 ? GREEN : RED

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#f1f5f9', fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button onClick={() => navigate('/')}
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, padding: '6px 14px', color: '#94a3b8', fontSize: 13, cursor: 'pointer' }}>
          ← Back
        </button>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>Fixings Monitor</div>
          <div style={{ color: MUTED, fontSize: 11, marginTop: 1 }}>Inflation Markets · Simulated data</div>
        </div>
      </div>

      {/* Region tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 0, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, zIndex: 10, background: BG }}>
        {(Object.keys(REGION_CONFIG) as Region[]).map(r => (
          <button key={r} onClick={() => handleRegion(r)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 16px', fontSize: 13, fontWeight: 500, color: region === r ? REGION_CONFIG[r].color : '#64748b', borderBottom: region === r ? `2px solid ${REGION_CONFIG[r].color}` : '2px solid transparent', marginBottom: -1, transition: 'color 0.15s' }}>
            {REGION_CONFIG[r].label}
          </button>
        ))}
      </div>

      {/* Measure selector */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, marginBottom: 20, flexWrap: 'wrap' }}>
        {cfg.measures.map(m => (
          <button key={m.id} onClick={() => setMeasure(m.id)}
            style={{ background: measure === m.id ? `${cfg.color}22` : 'rgba(255,255,255,0.04)', border: `1px solid ${measure === m.id ? cfg.color + '55' : 'rgba(255,255,255,0.08)'}`, borderRadius: 6, padding: '5px 12px', fontSize: 12, color: measure === m.id ? cfg.color : '#64748b', cursor: 'pointer', fontWeight: measure === m.id ? 600 : 400 }}>
            {m.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#334155', alignSelf: 'center' }}>
          BBG: {measureCfg.bbgTicker}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Summary cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
          {[
            { label: 'Latest YoY', value: `${latest.yoy.toFixed(1)}%`, color: cfg.color },
            { label: 'Latest MoM', value: `${latest.mom >= 0 ? '+' : ''}${latest.mom.toFixed(2)}%`, color: momColor(latest.mom) },
            { label: 'Prev MoM',   value: `${prev.mom >= 0 ? '+' : ''}${prev.mom.toFixed(2)}%`,   color: momColor(prev.mom) },
            { label: 'MoM Surprise', value: `${latest.surprise >= 0 ? '+' : ''}${latest.surprise.toFixed(2)}%`, color: surpriseColor(latest.surprise) },
          ].map(card => (
            <div key={card.label} style={cardStyle}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{card.label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: card.color }}>{card.value}</div>
              <div style={{ fontSize: 10, color: '#334155', marginTop: 3 }}>as of {latest.date}</div>
            </div>
          ))}
        </div>

        {/* YoY chart */}
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {measureCfg.label} — YoY %
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data} margin={{ top: 8, right: 20, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false}
                interval={Math.floor(data.length / 6)} />
              <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} width={42}
                tickFormatter={(v: number) => v.toFixed(1) + '%'} />
              <ReferenceLine y={2} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" label={{ value: '2%', position: 'right', style: { fontSize: 9, fill: '#475569' } }} />
              <Tooltip content={<SimpleTooltip />} />
              <Line type="monotone" dataKey="yoy" stroke={cfg.color} strokeWidth={2} dot={false} name="YoY" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* MoM bar chart */}
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {measureCfg.label} — MoM % (last 24 months)
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data.slice(-24)} margin={{ top: 8, right: 20, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false}
                interval={3} />
              <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} width={42}
                tickFormatter={(v: number) => v.toFixed(1) + '%'} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
              <Tooltip content={<SimpleTooltip />} />
              <Bar dataKey="mom" name="MoM" maxBarSize={18}>
                {data.slice(-24).map((entry, i) => (
                  <Cell key={i} fill={entry.mom >= 0 ? GREEN : RED} fillOpacity={0.75} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Recent prints table */}
        <div style={cardStyle}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 14, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Recent Prints — {measureCfg.label}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  {['Date', 'MoM Act.', 'MoM Cons.', 'Surprise', 'YoY'].map(h => (
                    <th key={h} style={{ textAlign: 'right', padding: '6px 12px', color: MUTED, fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...last12].reverse().map((pt, i) => (
                  <tr key={pt.date} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                    <td style={{ padding: '7px 12px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                      {new Date(pt.date + '-01').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
                      {i === 0 && <span style={{ marginLeft: 6, fontSize: 10, color: cfg.color }}>latest</span>}
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 12px', color: momColor(pt.mom), fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {pt.mom >= 0 ? '+' : ''}{pt.mom.toFixed(2)}%
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 12px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                      {pt.consensus >= 0 ? '+' : ''}{pt.consensus.toFixed(2)}%
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 12px', color: surpriseColor(pt.surprise), fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {pt.surprise >= 0 ? '+' : ''}{pt.surprise.toFixed(2)}%
                    </td>
                    <td style={{ textAlign: 'right', padding: '7px 12px', color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' }}>
                      {pt.yoy.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: '#334155', marginTop: 10 }}>
            Consensus = simulated. Swap for BBG consensus data (e.g. {measureCfg.bbgTicker}) when live feed is available.
          </div>
        </div>

      </div>
    </div>
  )
}
