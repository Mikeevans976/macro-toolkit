import { useEffect, useMemo, useState } from 'react'
import PageTitle from '../components/PageTitle'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TableRow {
  country: string
  is_dm: boolean
  actual: number
  model: number
  last: number    // current residual (bps)
  avg: number     // 1y mean of residual (bps)
  stdev: number   // 1y std of residual (bps)
  z_score: number // (last - avg) / stdev over 1y
}

interface GlobalYieldsData {
  dates: string[]
  factors: { Global: number[]; DM: number[]; EM: number[] }
  explained_var: { Global: number; DM: number; EM: number }
  residuals: { US: number[]; Japan: number[]; UK: number[]; Germany: number[]; France: number[] }
  table: TableRow[]
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const BG = '#07090c'

const cardStyle: React.CSSProperties = {
  background: 'rgba(200,220,240,0.03)',
  border: '1px solid rgba(200,220,240,0.07)',
  borderRadius: 6,
  padding: 20,
}

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#9aa5b1',
  marginBottom: 12,
}

// ─── Colour palette ──────────────────────────────────────────────────────────

const RESID_COLORS: Record<string, string> = {
  US:      '#d9705e',
  Japan:   '#6aa9cc',
  UK:      '#d48853',
  Germany: '#c6ced8',
  France:  '#b49fdb',
}

const FACTOR_COLORS: Record<string, string> = {
  Global: '#eef2f6',
  DM:     '#86c0de',
  EM:     '#dfbb78',
}

// ─── Z-Score cell colour ─────────────────────────────────────────────────────

function zColor(z: number): { bg: string; text: string } {
  if (z >= 1.5)  return { bg: 'rgba(95,181,146,0.25)',  text: '#76c8a7' }
  if (z >= 0.5)  return { bg: 'rgba(95,181,146,0.10)',  text: '#9dd6bd' }
  if (z <= -1.5) return { bg: 'rgba(217,112,94,0.25)',  text: '#e2826f' }
  if (z <= -0.5) return { bg: 'rgba(217,112,94,0.10)',  text: '#ecaa9c' }
  return { bg: 'transparent', text: '#c6ced8' }
}

// ─── X-axis tick helper ───────────────────────────────────────────────────────

function fmtTick(dateStr: string): string {
  const d = new Date(dateStr)
  const m = d.getMonth()
  const y = String(d.getFullYear()).slice(2)
  const names = ['Jan','','','Apr','','','Jul','','','Oct','','']
  return names[m] ? `${names[m]} '${y}` : ''
}

// ─── Custom tooltip ──────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, unit }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  unit?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'rgba(7,9,12,0.95)',
      border: '1px solid rgba(200,220,240,0.12)',
      borderRadius: 6,
      padding: '8px 12px',
      fontSize: 12,
    }}>
      <div style={{ color: '#9aa5b1', marginBottom: 4 }}>{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color, display: 'flex', gap: 10, justifyContent: 'space-between' }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 600 }}>
            {typeof p.value === 'number' ? p.value.toFixed(2) : p.value}{unit ? ` ${unit}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function GlobalYields() {
  const [data, setData] = useState<GlobalYieldsData | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    const token = localStorage.getItem('access_token')
    if (!token) { navigate('/login', { replace: true }); return }

    axios
      .get<GlobalYieldsData>('/api/tools/global-yields', {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then(res => setData(res.data))
      .catch(err => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        }
      })
      .finally(() => setLoading(false))
  }, [navigate])

  // ── Subsample series to weekly for chart perf ────────────────────────────
  const { residData, factorData, xTicks } = useMemo(() => {
    if (!data) return { residData: [], factorData: [], xTicks: [] }

    const STEP = 5   // every 5 business days ≈ weekly
    const indices: number[] = []
    for (let i = 0; i < data.dates.length; i += STEP) indices.push(i)
    if (indices[indices.length - 1] !== data.dates.length - 1)
      indices.push(data.dates.length - 1)

    const residData = indices.map(i => ({
      date: data.dates[i],
      US:      data.residuals.US[i],
      Japan:   data.residuals.Japan[i],
      UK:      data.residuals.UK[i],
      Germany: data.residuals.Germany[i],
      France:  data.residuals.France[i],
    }))

    const factorData = indices.map(i => ({
      date:   data.dates[i],
      Global: data.factors.Global[i],
      DM:     data.factors.DM[i],
      EM:     data.factors.EM[i],
    }))

    // Quarter-start ticks
    const xTicks: string[] = []
    for (const pt of residData) {
      const m = new Date(pt.date).getMonth()
      if (m === 0 || m === 3 || m === 6 || m === 9) {
        if (!xTicks.includes(pt.date)) xTicks.push(pt.date)
      }
    }

    return { residData, factorData, xTicks }
  }, [data])

  // ── Table rows: DM then EM ────────────────────────────────────────────────
  const { dmRows, emRows } = useMemo(() => {
    if (!data) return { dmRows: [], emRows: [] }
    return {
      dmRows: data.table.filter(r => r.is_dm),
      emRows: data.table.filter(r => !r.is_dm),
    }
  }, [data])

  const evPct = (k: keyof GlobalYieldsData['explained_var']) =>
    data ? `${(data.explained_var[k] * 100).toFixed(1)}%` : '—'

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ background: BG, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#8995a2', fontSize: 14 }}>Loading global yields model…</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ background: BG, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#d9705e', fontSize: 14 }}>Failed to load data.</div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: BG, minHeight: '100vh' }}>

      {/* Gradient overlay */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at 50% -10%, rgba(217,112,94,0.05) 0%, transparent 55%)',
      }} />

      {/* Header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px',
        background: 'rgba(7,9,12,0.90)',
        borderBottom: '1px solid rgba(200,220,240,0.07)',
        backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <PageTitle category="Market Structure & Analysis" categoryId="market-structure" title={<>Factor Model for Global Yields</>} subtitle={<>3-factor PCA on 10y government bond yields — {data.dates[data.dates.length - 1]}</>} />
        </div>

        {/* Explained variance badges */}
        <div style={{ display: 'flex', gap: 8 }}>
          {(['Global','DM','EM'] as const).map((f, i) => (
            <div key={f} style={{
              background: 'rgba(200,220,240,0.05)',
              border: '1px solid rgba(200,220,240,0.08)',
              borderRadius: 6, padding: '4px 12px',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
            }}>
              <span style={{ color: Object.values(FACTOR_COLORS)[i], fontSize: 11, fontWeight: 600 }}>{f}</span>
              <span style={{ color: '#9aa5b1', fontSize: 10 }}>PC{i + 1} · {evPct(f)}</span>
            </div>
          ))}
        </div>
      </header>

      {/* Main layout: table left, charts right */}
      <main style={{ padding: '20px 24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 16, alignItems: 'start' }}>

          {/* ── Left: fair-value table ─────────────────────────────────── */}
          <div style={cardStyle}>
            <div style={sectionLabel}>Global 10y Bond Fair Value</div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                {/* Group header row */}
                <tr>
                  <th colSpan={3} />
                  <th colSpan={4} style={{
                    textAlign: 'center',
                    fontSize: 9,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: '#8995a2',
                    paddingBottom: 3,
                    borderBottom: '1px solid rgba(200,220,240,0.12)',
                    borderLeft: '1px solid rgba(200,220,240,0.10)',
                  }}>
                    Intrinsic residual (bp) · 1y lookback
                  </th>
                </tr>
                {/* Column header row */}
                <tr style={{ borderBottom: '1px solid rgba(200,220,240,0.08)' }}>
                  {['Country','Actual','Model','Last','Avg','StDev','Z-Score'].map((h, i) => (
                    <th key={h} style={{
                      color: '#8995a2', fontSize: 10, fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      padding: '4px 6px', textAlign: h === 'Country' ? 'left' : 'right',
                      whiteSpace: 'nowrap',
                      borderLeft: i === 3 ? '1px solid rgba(200,220,240,0.10)' : undefined,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {/* DM block */}
                <tr>
                  <td colSpan={6} style={{
                    fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.08em', color: '#77828f',
                    padding: '8px 6px 3px',
                  }}>
                    Developed Markets
                  </td>
                </tr>
                {dmRows.map(row => <TableRowEl key={row.country} row={row} />)}

                {/* EM block */}
                <tr>
                  <td colSpan={6} style={{
                    fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.08em', color: '#77828f',
                    padding: '10px 6px 3px',
                    borderTop: '1px solid rgba(200,220,240,0.06)',
                  }}>
                    Emerging Markets
                  </td>
                </tr>
                {emRows.map(row => <TableRowEl key={row.country} row={row} />)}
              </tbody>
            </table>
          </div>

          {/* ── Right: charts ──────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Residuals chart */}
            <div style={cardStyle}>
              <div style={sectionLabel}>10Y Residuals vs Global Model (bp)</div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={residData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
                  <XAxis
                    dataKey="date"
                    ticks={xTicks}
                    tickFormatter={fmtTick}
                    tick={{ fill: '#8995a2', fontSize: 10 }}
                    axisLine={{ stroke: 'rgba(200,220,240,0.08)' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#8995a2', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={v => `${v}`}
                  />
                  <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" strokeDasharray="4 4" />
                  <Tooltip
                    content={<ChartTooltip unit="bp" />}
                    cursor={{ stroke: 'rgba(200,220,240,0.10)' }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                    formatter={(val) => <span style={{ color: RESID_COLORS[val] ?? '#c6ced8' }}>{val}</span>}
                  />
                  {Object.keys(RESID_COLORS).map(c => (
                    <Line
                      key={c}
                      type="monotone"
                      dataKey={c}
                      stroke={RESID_COLORS[c]}
                      strokeWidth={1.5}
                      dot={false}
                      activeDot={{ r: 3 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Factor dynamics chart */}
            <div style={cardStyle}>
              <div style={sectionLabel}>Factor Dynamics (standardised)</div>
              <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 10 }}>
                PC1 Global ({evPct('Global')}) · PC2 DM ({evPct('DM')}) · PC3 EM ({evPct('EM')})
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={factorData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
                  <XAxis
                    dataKey="date"
                    ticks={xTicks}
                    tickFormatter={fmtTick}
                    tick={{ fill: '#8995a2', fontSize: 10 }}
                    axisLine={{ stroke: 'rgba(200,220,240,0.08)' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#8995a2', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <ReferenceLine y={0} stroke="rgba(200,220,240,0.12)" strokeDasharray="4 4" />
                  <Tooltip
                    content={<ChartTooltip />}
                    cursor={{ stroke: 'rgba(200,220,240,0.10)' }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                    formatter={(val) => <span style={{ color: FACTOR_COLORS[val] ?? '#c6ced8' }}>{val}</span>}
                  />
                  {(['Global','DM','EM'] as const).map(f => (
                    <Line
                      key={f}
                      type="monotone"
                      dataKey={f}
                      stroke={FACTOR_COLORS[f]}
                      strokeWidth={f === 'Global' ? 2 : 1.5}
                      dot={false}
                      activeDot={{ r: 3 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

          </div>
        </div>
      </main>
    </div>
  )
}

// ─── Table row component ──────────────────────────────────────────────────────

function TableRowEl({ row }: { row: TableRow }) {
  const { bg, text } = zColor(row.z_score)
  const signColor = (v: number) => v > 0 ? '#76c8a7' : v < 0 ? '#e2826f' : '#c6ced8'

  return (
    <tr
      style={{ borderBottom: '1px solid rgba(200,220,240,0.04)' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(200,220,240,0.03)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <td style={{ padding: '4px 6px', color: '#c3ccd6', fontWeight: 500 }}>{row.country}</td>
      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }}>
        {row.actual.toFixed(2)}
      </td>
      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#c6ced8' }}>
        {row.model.toFixed(2)}
      </td>
      {/* Residual columns — all in bps, 1y lookback */}
      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: "'Geist Mono', ui-monospace, monospace", color: signColor(row.last), fontWeight: 600, borderLeft: '1px solid rgba(200,220,240,0.10)' }}>
        {row.last > 0 ? '+' : ''}{row.last.toFixed(1)}
      </td>
      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: "'Geist Mono', ui-monospace, monospace", color: signColor(row.avg) }}>
        {row.avg > 0 ? '+' : ''}{row.avg.toFixed(1)}
      </td>
      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#9aa5b1' }}>
        {row.stdev.toFixed(1)}
      </td>
      <td style={{ padding: '3px 6px', textAlign: 'right' }}>
        <span style={{
          display: 'inline-block',
          background: bg,
          color: text,
          fontFamily: "'Geist Mono', ui-monospace, monospace",
          fontWeight: 600,
          fontSize: 11,
          borderRadius: 4,
          padding: '1px 6px',
          minWidth: 40,
          textAlign: 'right',
        }}>
          {row.z_score > 0 ? '+' : ''}{row.z_score.toFixed(2)}
        </span>
      </td>
    </tr>
  )
}
