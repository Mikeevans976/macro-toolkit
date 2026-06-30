import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ComposedChart, Area,
  Label,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Current {
  date: string
  series_value: number
  composite: number
  composite_pctile: number
  label: string
  signals: Record<string, number | null>
  position: number
}

interface MomentumData {
  ticker: string
  dates: string[]
  series: (number | null)[]
  composite: (number | null)[]
  position: (number | null)[]
  signals: Record<string, (number | null)[]>
  current: Current
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BG = '#080d1a'
const ACCENT = '#6366f1'
const GREEN = '#22c55e'
const RED = '#ef4444'
const MUTED = '#475569'

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: '16px 20px',
}

const stickyBg = '#080d1a'

type Tab = 'cta-momentum'
const TABS: { id: Tab; label: string }[] = [
  { id: 'cta-momentum', label: 'CTA Momentum' },
]

const LOOKBACK_ORDER = ['1M', '3M', '6M', '12M']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLabel(composite: number | null, isYield: boolean): string {
  if (composite == null) return 'Neutral'
  const z = isYield ? -composite : composite
  if (z > 1.5) return 'Strong Long'
  if (z > 0.5) return 'Long'
  if (z > -0.5) return 'Neutral'
  if (z > -1.5) return 'Short'
  return 'Strong Short'
}

function labelColor(label: string): string {
  if (label === 'Strong Long') return GREEN
  if (label === 'Long') return '#86efac'
  if (label === 'Neutral') return '#94a3b8'
  if (label === 'Short') return '#fca5a5'
  if (label === 'Strong Short') return RED
  return '#94a3b8'
}

function fmtZ(v: number | null): string {
  if (v == null) return '—'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + 'σ'
}

function ordinalSuffix(n: number): string {
  const abs = Math.round(n)
  const s = ['th', 'st', 'nd', 'rd']
  const v = abs % 100
  return abs + (s[(v - 20) % 10] || s[v] || s[0])
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface TooltipProps {
  active?: boolean
  payload?: { name: string; value: number | null; color: string }[]
  label?: string
}

function SimpleTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#94a3b8', marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        p.value != null && (
          <div key={i} style={{ color: p.color || '#f1f5f9' }}>
            {p.name}: {typeof p.value === 'number' ? p.value.toFixed(4) : p.value}
          </div>
        )
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Momentum() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<Tab>('cta-momentum')
  const [ticker, setTicker] = useState('')
  const [startYear, setStartYear] = useState(2010)
  const [isYieldSeries, setIsYieldSeries] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<MomentumData | null>(null)

  const currentYear = new Date().getFullYear()
  const years = Array.from({ length: currentYear - 1999 }, (_, i) => 2000 + i)

  async function handleFetch() {
    if (!ticker.trim()) return
    setLoading(true)
    setError(null)
    try {
      const token = localStorage.getItem('access_token')
      const res = await axios.get('/api/tools/momentum/cta-signals', {
        params: { ticker: ticker.trim(), start: `${startYear}-01-01` },
        headers: { Authorization: `Bearer ${token}` },
      })
      setData(res.data)
    } catch (e: unknown) {
      const msg = axios.isAxiosError(e) ? (e.response?.data?.detail ?? e.message) : String(e)
      setError(String(msg))
    } finally {
      setLoading(false)
    }
  }

  // ── Chart data ──────────────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    if (!data) return []
    const flip = isYieldSeries ? -1 : 1
    return data.dates.map((d, i) => ({
      date: d.slice(0, 7),
      series: data.series[i],
      composite: data.composite[i],
      above: data.composite[i] != null ? Math.max(0, data.composite[i]!) : null,
      below: data.composite[i] != null ? Math.min(0, data.composite[i]!) : null,
      position: data.position[i] != null
        ? (isYieldSeries ? -(data.position[i]!) : data.position[i])
        : null,
      // Individual signals (flipped for yield series so positive = bond long)
      ...Object.fromEntries(
        LOOKBACK_ORDER.map(lb => [
          lb,
          data.signals[lb]?.[i] != null ? (data.signals[lb][i]! * flip) : null,
        ])
      ),
    }))
  }, [data, isYieldSeries])

  // ── Effective current signal (respects isYieldSeries flip) ─────────────────
  const effectiveCurrent = useMemo(() => {
    if (!data) return null
    const c = data.current
    const flip = isYieldSeries ? -1 : 1
    return {
      ...c,
      composite: c.composite * flip,
      composite_pctile: isYieldSeries ? 100 - c.composite_pctile : c.composite_pctile,
      position: c.position * flip,
      signals: Object.fromEntries(
        Object.entries(c.signals).map(([k, v]) => [k, v != null ? v * flip : null])
      ),
    }
  }, [data, isYieldSeries])

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#f1f5f9', fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 8, padding: '6px 14px',
            color: '#94a3b8', fontSize: 13, cursor: 'pointer',
          }}
        >
          ← Back
        </button>
        <div>
          <div style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>
            Momentum
          </div>
          <div style={{ color: MUTED, fontSize: 11, marginTop: 1 }}>
            Technicals
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 20,
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        position: 'sticky', top: 0, zIndex: 10, background: stickyBg, paddingBottom: 0,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '8px 16px', fontSize: 13, fontWeight: 500,
              color: activeTab === tab.id ? ACCENT : '#64748b',
              borderBottom: activeTab === tab.id ? `2px solid ${ACCENT}` : '2px solid transparent',
              marginBottom: -1,
              transition: 'color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Input row */}
      <div style={{ ...cardStyle, marginBottom: 20 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          {/* Ticker */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Bloomberg Ticker
            </label>
            <input
              value={ticker}
              onChange={e => setTicker(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleFetch()}
              placeholder="e.g. GDBR10 Index"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6, padding: '6px 10px',
                color: '#f1f5f9', fontSize: 13, width: 200,
                outline: 'none',
              }}
            />
          </div>

          {/* Start year */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Start Year
            </label>
            <select
              value={startYear}
              onChange={e => setStartYear(Number(e.target.value))}
              style={{
                background: '#0f172a',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6, padding: '6px 10px',
                color: '#f1f5f9', fontSize: 13, cursor: 'pointer',
                outline: 'none',
              }}
            >
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {/* Yield series toggle */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'flex-end', paddingBottom: 2 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#94a3b8' }}>
              <input
                type="checkbox"
                checked={isYieldSeries}
                onChange={e => setIsYieldSeries(e.target.checked)}
                style={{ width: 14, height: 14, accentColor: ACCENT, cursor: 'pointer' }}
              />
              Yield series
            </label>
          </div>

          {/* Fetch button */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'flex-end' }}>
            <button
              onClick={handleFetch}
              disabled={loading || !ticker.trim()}
              style={{
                background: loading || !ticker.trim() ? 'rgba(99,102,241,0.3)' : ACCENT,
                border: 'none', borderRadius: 6, padding: '7px 18px',
                color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: loading || !ticker.trim() ? 'not-allowed' : 'pointer',
                transition: 'background 0.15s',
              }}
            >
              {loading ? 'Loading…' : 'Fetch'}
            </button>
          </div>
        </div>

        {/* Yield series hint */}
        {isYieldSeries && (
          <div style={{ marginTop: 10, fontSize: 11, color: '#64748b' }}>
            Yield series mode: positive composite = yields trending UP = bonds SHORT. Direction labels and position are flipped for display.
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{ ...cardStyle, borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.05)', color: RED, marginBottom: 20, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Results */}
      {effectiveCurrent && data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ── A. Current State Panel ─────────────────────────────────────── */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 14, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Current State — {data.ticker}
            </div>

            {/* Top row: label, z-score, percentile */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: labelColor(effectiveCurrent.label ?? '') }}>
                {effectiveCurrent.label}
              </span>
              <span style={{ fontSize: 20, fontWeight: 600, color: '#cbd5e1' }}>
                {fmtZ(effectiveCurrent.composite)}
              </span>
              <span style={{ fontSize: 14, color: MUTED }}>
                {ordinalSuffix(effectiveCurrent.composite_pctile)} pctile
              </span>
              <span style={{ fontSize: 12, color: '#64748b', marginLeft: 'auto' }}>
                as of {effectiveCurrent.date}
              </span>
            </div>

            {/* Percentile bar */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ height: 6, background: 'rgba(255,255,255,0.07)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.max(0, Math.min(100, effectiveCurrent.composite_pctile))}%`,
                  background: labelColor(effectiveCurrent.label ?? ''),
                  borderRadius: 3,
                  transition: 'width 0.4s ease',
                }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span style={{ fontSize: 10, color: '#334155' }}>0</span>
                <span style={{ fontSize: 10, color: '#334155' }}>50</span>
                <span style={{ fontSize: 10, color: '#334155' }}>100</span>
              </div>
            </div>

            {/* Four mini-cards: 1M / 3M / 6M / 12M */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
              {LOOKBACK_ORDER.map(lb => {
                const z = effectiveCurrent.signals[lb] as number | null
                const lbl = z != null ? getLabel(z, false) : 'Neutral'
                const col = labelColor(lbl)
                const arrow = lbl.includes('Long') ? '↑' : lbl.includes('Short') ? '↓' : '→'
                return (
                  <div key={lb} style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: `1px solid ${col}33`,
                    borderRadius: 8, padding: '10px 12px',
                  }}>
                    <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>{lb}</div>
                    <div style={{ fontSize: 17, fontWeight: 700, color: col }}>{fmtZ(z)}</div>
                    <div style={{ fontSize: 12, color: col, marginTop: 3 }}>
                      {arrow} {lbl}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Position summary */}
            <div style={{ marginTop: 14, fontSize: 12, color: '#64748b' }}>
              Vol-scaled position: <span style={{ color: effectiveCurrent.position >= 0 ? GREEN : RED, fontWeight: 600 }}>
                {effectiveCurrent.position >= 0 ? '+' : ''}{effectiveCurrent.position.toFixed(2)}
              </span>
              <span style={{ marginLeft: 6 }}>(10% vol target, clipped ±8)</span>
              {isYieldSeries && <span style={{ marginLeft: 6, color: '#475569' }}>[bond equivalent]</span>}
            </div>
          </div>

          {/* ── B. Series chart ────────────────────────────────────────────── */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {data.ticker}
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart syncId="momentum" data={chartData} margin={{ top: 8, right: 80, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#475569' }}
                  tickLine={false}
                  axisLine={false}
                  interval={Math.floor(chartData.length / 6)}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#475569' }}
                  tickLine={false}
                  axisLine={false}
                  width={50}
                  tickFormatter={(v: number) => v.toFixed(2)}
                />
                <Tooltip content={<SimpleTooltip />} />
                <Line
                  type="monotone"
                  dataKey="series"
                  stroke={ACCENT}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls={false}
                  name="Price"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* ── C. Composite signal chart ──────────────────────────────────── */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              CTA Composite Signal
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart syncId="momentum" data={chartData} margin={{ top: 8, right: 80, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#475569' }}
                  tickLine={false}
                  axisLine={false}
                  interval={Math.floor(chartData.length / 6)}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#475569' }}
                  tickLine={false}
                  axisLine={false}
                  width={50}
                  tickFormatter={(v: number) => v.toFixed(1)}
                />
                <Tooltip content={<SimpleTooltip />} />

                {/* Filled areas above/below zero */}
                <Area
                  type="monotone"
                  dataKey="above"
                  fill={GREEN}
                  fillOpacity={0.2}
                  stroke="none"
                  connectNulls={false}
                  name="Above 0"
                  legendType="none"
                />
                <Area
                  type="monotone"
                  dataKey="below"
                  fill={RED}
                  fillOpacity={0.2}
                  stroke="none"
                  connectNulls={false}
                  name="Below 0"
                  legendType="none"
                />

                {/* Composite line */}
                <Line
                  type="monotone"
                  dataKey="composite"
                  stroke={ACCENT}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls={false}
                  name="Composite"
                />

                {/* Reference lines */}
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
                <ReferenceLine y={1.5} stroke={GREEN} strokeDasharray="3 3" strokeOpacity={0.4}>
                  <Label value="Strong Long" position="right" style={{ fontSize: 10, fill: GREEN, fillOpacity: 0.7 }} />
                </ReferenceLine>
                <ReferenceLine y={0.5} stroke={GREEN} strokeDasharray="3 3" strokeOpacity={0.4}>
                  <Label value="Long" position="right" style={{ fontSize: 10, fill: GREEN, fillOpacity: 0.7 }} />
                </ReferenceLine>
                <ReferenceLine y={-0.5} stroke={RED} strokeDasharray="3 3" strokeOpacity={0.4}>
                  <Label value="Short" position="right" style={{ fontSize: 10, fill: RED, fillOpacity: 0.7 }} />
                </ReferenceLine>
                <ReferenceLine y={-1.5} stroke={RED} strokeDasharray="3 3" strokeOpacity={0.4}>
                  <Label value="Strong Short" position="right" style={{ fontSize: 10, fill: RED, fillOpacity: 0.7 }} />
                </ReferenceLine>
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* ── D. Individual signals chart ───────────────────────────── */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Individual Signals{isYieldSeries ? ' — Bond Equivalent' : ''}
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart syncId="momentum" data={chartData} margin={{ top: 8, right: 80, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#475569' }}
                  tickLine={false}
                  axisLine={false}
                  interval={Math.floor(chartData.length / 6)}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#475569' }}
                  tickLine={false}
                  axisLine={false}
                  width={50}
                  tickFormatter={(v: number) => v.toFixed(1)}
                />
                <Tooltip content={<SimpleTooltip />} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
                <ReferenceLine y={1.5} stroke={GREEN} strokeDasharray="3 3" strokeOpacity={0.4}>
                  <Label value="Strong Long" position="right" style={{ fontSize: 10, fill: GREEN, fillOpacity: 0.7 }} />
                </ReferenceLine>
                <ReferenceLine y={0.5} stroke={GREEN} strokeDasharray="3 3" strokeOpacity={0.3} />
                <ReferenceLine y={-0.5} stroke={RED} strokeDasharray="3 3" strokeOpacity={0.3} />
                <ReferenceLine y={-1.5} stroke={RED} strokeDasharray="3 3" strokeOpacity={0.4}>
                  <Label value="Strong Short" position="right" style={{ fontSize: 10, fill: RED, fillOpacity: 0.7 }} />
                </ReferenceLine>
                <Line type="monotone" dataKey="1M"  stroke="#f59e0b" strokeWidth={1.2} dot={false} connectNulls={false} name="1M"  />
                <Line type="monotone" dataKey="3M"  stroke="#38bdf8" strokeWidth={1.2} dot={false} connectNulls={false} name="3M"  />
                <Line type="monotone" dataKey="6M"  stroke="#a78bfa" strokeWidth={1.2} dot={false} connectNulls={false} name="6M"  />
                <Line type="monotone" dataKey="12M" stroke="#fb923c" strokeWidth={1.2} dot={false} connectNulls={false} name="12M" />
              </ComposedChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
              {([['1M', '#f59e0b'], ['3M', '#38bdf8'], ['6M', '#a78bfa'], ['12M', '#fb923c']] as [string, string][]).map(([lb, col]) => (
                <div key={lb} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 20, height: 2, background: col, borderRadius: 1 }} />
                  <span style={{ fontSize: 11, color: '#64748b' }}>{lb}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── E. Position chart ─────────────────────────────────────────── */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Vol-Scaled Position (10% vol target){isYieldSeries ? ' — Bond Equivalent' : ''}
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart syncId="momentum" data={chartData} margin={{ top: 8, right: 80, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#475569' }}
                  tickLine={false}
                  axisLine={false}
                  interval={Math.floor(chartData.length / 6)}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#475569' }}
                  tickLine={false}
                  axisLine={false}
                  width={50}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  domain={[-8.2, 8.2]}
                />
                <Tooltip content={<SimpleTooltip />} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
                <Bar dataKey="position" name="Position" maxBarSize={6}>
                  {chartData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={(entry.position ?? 0) >= 0 ? GREEN : RED}
                      fillOpacity={0.75}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 11, color: '#334155', marginTop: 8 }}>
              Position clipped to ±8. Each bar = 5-business-day interval.
            </div>
          </div>

        </div>
      )}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '40vh', gap: 12 }}>
          <div style={{ fontSize: 36, opacity: 0.3 }}>📈</div>
          <div style={{ color: '#334155', fontSize: 14 }}>Enter a Bloomberg ticker and click Fetch to compute CTA momentum signals.</div>
        </div>
      )}

    </div>
  )
}
