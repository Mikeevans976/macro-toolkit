import { useEffect, useMemo, useState } from 'react'
import PageTitle from '../components/PageTitle'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
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
  Legend,
  ScatterChart,
  Scatter,
  ZAxis,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ModelResult {
  title: string
  dates: string[]
  actual: number[]
  fitted: number[]
  residuals: number[]
  sigma1_hi: number[]
  sigma1_lo: number[]
  sigma2_hi: number[]
  sigma2_lo: number[]
  rolling_r2: number[]
  oos_r2: (number | null)[]
  bench_r2: (number | null)[]
  coef_names: string[]
  coef_series: Record<string, number[]>
  latest_coefs: Record<string, number>
  scatter: { residuals: number[]; fwd5d: (number | null)[]; fwd10d: (number | null)[]; fwd20d: (number | null)[]; fwd100d: (number | null)[] }
  scatter_trend: Record<string, { x: number[]; y: number[] }>
}

interface Group {
  id: string
  label: string
  model_ids: string[]
}

interface FairValueData {
  groups: Group[]
  model_ids: string[]
  models: Record<string, ModelResult>
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

// ─── Colour palettes ──────────────────────────────────────────────────────────

const COEF_COLORS = [
  '#d9705e', '#6aa9cc', '#5fb592', '#d6ad66', '#a08bd2',
  '#c98fb2', '#6fc0b4', '#d48853', '#9aa5b1', '#b49fdb',
  '#dfbb78', '#6fc2a2', '#86c0de', '#dd9562', '#c3a2dc',
]

// ─── X-axis tick helper ───────────────────────────────────────────────────────

function fmtTick(dateStr: string): string {
  const d = new Date(dateStr)
  const m = d.getMonth()
  const y = String(d.getFullYear()).slice(2)
  const names = ['Jan', '', '', 'Apr', '', '', 'Jul', '', '', 'Oct', '', '']
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
            {typeof p.value === 'number' ? p.value.toFixed(4) : p.value}{unit ? ` ${unit}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function FairValueModels() {
  const [data, setData] = useState<FairValueData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeModel, setActiveModel] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const token = localStorage.getItem('access_token')
    if (!token) { navigate('/login', { replace: true }); return }

    axios
      .get<FairValueData>('/api/tools/fair-value-models', {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then(res => {
        setData(res.data)
        if (res.data.model_ids.length > 0) {
          setActiveModel(res.data.model_ids[0])
        }
      })
      .catch(err => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        }
      })
      .finally(() => setLoading(false))
  }, [navigate])

  const model = useMemo(() => {
    if (!data || !activeModel) return null
    return data.models[activeModel] ?? null
  }, [data, activeModel])

  // Quarter-start ticks
  const xTicks = useMemo(() => {
    if (!model) return []
    const ticks: string[] = []
    for (const dt of model.dates) {
      const m = new Date(dt).getMonth()
      if (m === 0 || m === 3 || m === 6 || m === 9) {
        if (!ticks.includes(dt)) ticks.push(dt)
      }
    }
    return ticks
  }, [model])

  // Build chart data arrays
  const fitData = useMemo(() => {
    if (!model) return []
    return model.dates.map((d, i) => ({
      date: d,
      actual: model.actual[i],
      fitted: model.fitted[i],
    }))
  }, [model])

  const residData = useMemo(() => {
    if (!model) return []
    return model.dates.map((d, i) => ({
      date: d,
      residual: model.residuals[i],
      s1hi: model.sigma1_hi[i],
      s1lo: model.sigma1_lo[i],
      s2hi: model.sigma2_hi[i],
      s2lo: model.sigma2_lo[i],
    }))
  }, [model])

  const r2Data = useMemo(() => {
    if (!model) return []
    return model.dates.map((d, i) => ({
      date: d,
      r2: model.rolling_r2[i],
    }))
  }, [model])

  const oosR2Data = useMemo(() => {
    if (!model) return []
    return model.dates.map((d, i) => ({
      date: d,
      oos_r2: model.oos_r2[i],
      bench_r2: model.bench_r2[i],
      r2: model.rolling_r2[i],
    }))
  }, [model])

  const coefData = useMemo(() => {
    if (!model) return []
    return model.dates.map((d, i) => {
      const row: Record<string, number | string> = { date: d }
      for (const name of model.coef_names) {
        row[name] = model.coef_series[name][i]
      }
      return row
    })
  }, [model])

  const latestCoefData = useMemo(() => {
    if (!model) return []
    return model.coef_names.map(name => ({
      name,
      value: model.latest_coefs[name] ?? 0,
    }))
  }, [model])

  // Scatter data sets
  const scatter5 = useMemo(() => {
    if (!model) return []
    return model.scatter.residuals
      .map((r, i) => ({ x: r, y: model.scatter.fwd5d[i] }))
      .filter(p => p.y !== null && p.y !== undefined)
  }, [model])

  const scatter10 = useMemo(() => {
    if (!model) return []
    return model.scatter.residuals
      .map((r, i) => ({ x: r, y: model.scatter.fwd10d[i] }))
      .filter(p => p.y !== null && p.y !== undefined)
  }, [model])

  const scatter20 = useMemo(() => {
    if (!model) return []
    return model.scatter.residuals
      .map((r, i) => ({ x: r, y: model.scatter.fwd20d[i] }))
      .filter(p => p.y !== null && p.y !== undefined)
  }, [model])

  const scatter100 = useMemo(() => {
    if (!model) return []
    return model.scatter.residuals
      .map((r, i) => ({ x: r, y: model.scatter.fwd100d[i] }))
      .filter(p => p.y !== null && p.y !== undefined)
  }, [model])

  const trend5 = useMemo(() => {
    if (!model) return []
    const t = model.scatter_trend['5d']
    return t.x.map((x, i) => ({ x, y: t.y[i] }))
  }, [model])

  const trend10 = useMemo(() => {
    if (!model) return []
    const t = model.scatter_trend['10d']
    return t.x.map((x, i) => ({ x, y: t.y[i] }))
  }, [model])

  const trend20 = useMemo(() => {
    if (!model) return []
    const t = model.scatter_trend['20d']
    return t.x.map((x, i) => ({ x, y: t.y[i] }))
  }, [model])

  const trend100 = useMemo(() => {
    if (!model) return []
    const t = model.scatter_trend['100d']
    return t.x.map((x, i) => ({ x, y: t.y[i] }))
  }, [model])

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ background: BG, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#8995a2', fontSize: 14 }}>Loading fair value models…</div>
      </div>
    )
  }

  if (!data || !model) {
    return (
      <div style={{ background: BG, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#d9705e', fontSize: 14 }}>Failed to load data.</div>
      </div>
    )
  }

  const dateRange = `${model.dates[0]} → ${model.dates[model.dates.length - 1]}`

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: BG, minHeight: '100vh' }}>

      {/* Gradient overlay */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at 50% -10%, rgba(106,169,204,0.05) 0%, transparent 55%)',
      }} />

      {/* Header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px',
        background: 'rgba(7,9,12,0.90)',
        borderBottom: '1px solid rgba(200,220,240,0.07)',
        backdropFilter: 'blur(12px)',
        flexWrap: 'wrap',
        gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <PageTitle category="Inflation Markets" categoryId="inflation-markets" title={<>HICPxT Inflation Fair Value Models</>} subtitle={<>Rolling Elastic Net — {dateRange}</>} />
        </div>

        {/* Model selector tabs — two rows, one per group */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.groups.map(group => (
            <div key={group.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                fontSize: 10,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: '#8995a2',
                minWidth: 110,
                textAlign: 'right',
                paddingRight: 4,
              }}>
                {group.label}
              </div>
              {group.model_ids.map(id => {
                // Extract tenor label: "EUR 5Y HICPxT" → "5Y", "EUR 5Y5Y HICPxT" → "5Y5Y"
                const title = data.models[id]?.title ?? id
                const tenorMatch = title.match(/EUR\s+(\S+)\s+HICPxT/)
                const label = tenorMatch ? tenorMatch[1] : id
                const isActive = activeModel === id
                return (
                  <button
                    key={id}
                    onClick={() => setActiveModel(id)}
                    style={{
                      background: isActive ? 'rgba(212,136,83,0.20)' : 'rgba(200,220,240,0.05)',
                      border: `1px solid ${isActive ? 'rgba(212,136,83,0.55)' : 'rgba(200,220,240,0.08)'}`,
                      borderRadius: 7,
                      padding: '4px 11px',
                      color: isActive ? '#dd9562' : '#9aa5b1',
                      fontSize: 12,
                      fontWeight: isActive ? 700 : 400,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </header>

      {/* 2×3 grid */}
      <main style={{ padding: '20px 24px' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
        }}>

          {/* Panel 1: Actual vs Fitted */}
          <div style={cardStyle}>
            <div style={sectionLabel}>Actual vs In-Sample Fit</div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={fitData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
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
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(200,220,240,0.10)' }}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                <Line
                  type="monotone"
                  dataKey="actual"
                  stroke="#6aa9cc"
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="fitted"
                  stroke="#d48853"
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Panel 2: Residuals with sigma bands */}
          <div style={cardStyle}>
            <div style={sectionLabel}>Residuals ± 1σ / 2σ Rolling Bands</div>
            <ResponsiveContainer width="100%" height={300}>
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
                />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" strokeDasharray="4 4" />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(200,220,240,0.10)' }}
                />
                <Line type="monotone" dataKey="residual" stroke="#d9705e" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
                <Line type="monotone" dataKey="s1hi" stroke="rgba(200,220,240,0.35)" strokeWidth={1} strokeDasharray="4 2" dot={false} legendType="none" />
                <Line type="monotone" dataKey="s1lo" stroke="rgba(200,220,240,0.35)" strokeWidth={1} strokeDasharray="4 2" dot={false} legendType="none" />
                <Line type="monotone" dataKey="s2hi" stroke="rgba(200,220,240,0.20)" strokeWidth={1} strokeDasharray="2 2" dot={false} legendType="none" />
                <Line type="monotone" dataKey="s2lo" stroke="rgba(200,220,240,0.20)" strokeWidth={1} strokeDasharray="2 2" dot={false} legendType="none" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Panel 3: Mean Reversion Scatter */}
          <div style={cardStyle}>
            <div style={sectionLabel}>Mean Reversion Test (premium vs forward return)</div>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 4, right: 8, bottom: 20, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="Residual"
                  tick={{ fill: '#8995a2', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(200,220,240,0.08)' }}
                  tickLine={false}
                  label={{ value: 'Residual', position: 'insideBottom', offset: -12, fill: '#8995a2', fontSize: 10 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="Fwd Return"
                  tick={{ fill: '#8995a2', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <ZAxis range={[20, 20]} />
                <ReferenceLine x={0} stroke="rgba(200,220,240,0.15)" strokeDasharray="4 4" />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" strokeDasharray="4 4" />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const p = payload[0]
                    return (
                      <div style={{
                        background: 'rgba(7,9,12,0.95)',
                        border: '1px solid rgba(200,220,240,0.12)',
                        borderRadius: 6, padding: '8px 12px', fontSize: 12,
                      }}>
                        <div style={{ color: p.color }}>
                          <div>Residual: <span style={{ fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{(p.payload.x as number).toFixed(4)}</span></div>
                          <div>Fwd Return: <span style={{ fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{(p.payload.y as number).toFixed(4)}</span></div>
                        </div>
                      </div>
                    )
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                <Scatter name="5d fwd" data={scatter5} fill="#b49fdb" opacity={0.4} />
                <Scatter name="10d fwd" data={scatter10} fill="#6aa9cc" opacity={0.4} />
                <Scatter name="20d fwd" data={scatter20} fill="#d48853" opacity={0.4} />
                <Scatter name="100d fwd" data={scatter100} fill="#5fb592" opacity={0.4} />
                <Scatter name="5d trend" data={trend5} fill="transparent" line={{ stroke: '#b49fdb', strokeWidth: 1.5 }} shape={() => <g />} legendType="none" />
                <Scatter name="10d trend" data={trend10} fill="transparent" line={{ stroke: '#6aa9cc', strokeWidth: 1.5 }} shape={() => <g />} legendType="none" />
                <Scatter name="20d trend" data={trend20} fill="transparent" line={{ stroke: '#d48853', strokeWidth: 1.5 }} shape={() => <g />} legendType="none" />
                <Scatter name="100d trend" data={trend100} fill="transparent" line={{ stroke: '#5fb592', strokeWidth: 1.5 }} shape={() => <g />} legendType="none" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          {/* Panel 4: Elastic Net Coefficients */}
          <div style={cardStyle}>
            <div style={sectionLabel}>Elastic Net Coefficients (Rolling)</div>
            <ResponsiveContainer width="100%" height={340}>
              <LineChart data={coefData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
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
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.10)" strokeDasharray="4 4" />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(200,220,240,0.10)' }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 9, paddingTop: 8 }}
                  formatter={(val, _, idx) => (
                    <span style={{ color: COEF_COLORS[idx % COEF_COLORS.length] }}>{val}</span>
                  )}
                />
                {model.coef_names.map((name, i) => (
                  <Line
                    key={name}
                    type="monotone"
                    dataKey={name}
                    stroke={COEF_COLORS[i % COEF_COLORS.length]}
                    strokeWidth={1}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Panel 5: Rolling R² */}
          <div style={cardStyle}>
            <div style={sectionLabel}>Rolling R²</div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={r2Data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
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
                  domain={[0, 1]}
                  tickFormatter={v => v.toFixed(1)}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(200,220,240,0.10)' }}
                />
                <Line
                  type="monotone"
                  dataKey="r2"
                  stroke="#86c0de"
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Panel 6: Latest Elastic Net Coefficients (Bar) */}
          <div style={cardStyle}>
            <div style={sectionLabel}>Latest Elastic Net Coefficients</div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={latestCoefData}
                margin={{ top: 4, right: 8, bottom: 60, left: -12 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: '#8995a2', fontSize: 9 }}
                  axisLine={{ stroke: 'rgba(200,220,240,0.08)' }}
                  tickLine={false}
                  interval={0}
                  angle={-45}
                  textAnchor="end"
                />
                <YAxis
                  tick={{ fill: '#8995a2', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.20)" />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const p = payload[0]
                    const val = p.value as number
                    return (
                      <div style={{
                        background: 'rgba(7,9,12,0.95)',
                        border: '1px solid rgba(200,220,240,0.12)',
                        borderRadius: 6, padding: '8px 12px', fontSize: 12,
                      }}>
                        <div style={{ color: '#9aa5b1', marginBottom: 4 }}>{p.payload.name}</div>
                        <div style={{ color: val >= 0 ? '#6aa9cc' : '#d9705e', fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 600 }}>
                          {val.toFixed(4)}
                        </div>
                      </div>
                    )
                  }}
                />
                <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                  {latestCoefData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={entry.value >= 0 ? '#6aa9cc' : '#d9705e'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

        </div>

        {/* OOS R² panel — full width below the grid */}
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <div style={sectionLabel}>Rolling OOS R² vs In-Sample R² vs Random-Walk Benchmark (252-day window)</div>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 12 }}>
            OOS R²: model trained on [t−500, t−1], predicts t.&ensp;
            Benchmark: random walk (predict today = yesterday).&ensp;
            Values below 0 mean the model is worse than using the historical mean.
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={oosR2Data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
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
                domain={(['auto', 1] as [string, number])}
                tickFormatter={v => v.toFixed(2)}
              />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.25)" strokeDasharray="4 4" label={{ value: 'R²=0', position: 'insideTopLeft', fill: '#8995a2', fontSize: 10 }} />
              <ReferenceLine y={1} stroke="rgba(200,220,240,0.10)" strokeDasharray="2 2" />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(200,220,240,0.10)' }} />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
              <Line type="monotone" dataKey="oos_r2"   name="OOS R²"        stroke="#5fb592" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} connectNulls={false} />
              <Line type="monotone" dataKey="r2"       name="In-sample R²"  stroke="#d48853" strokeWidth={1}   dot={false} activeDot={{ r: 3 }} strokeDasharray="5 3" connectNulls={false} />
              <Line type="monotone" dataKey="bench_r2" name="RW benchmark"  stroke="#9aa5b1" strokeWidth={1}   dot={false} activeDot={{ r: 3 }} strokeDasharray="3 3" connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

      </main>
    </div>
  )
}
