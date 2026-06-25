import { useEffect, useMemo, useState } from 'react'
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
  coef_names: string[]
  coef_series: Record<string, number[]>
  latest_coefs: Record<string, number>
  scatter: { residuals: number[]; fwd20d: number[]; fwd200d: number[]; fwd400d: number[] }
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

const BG = '#080d1a'

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: 20,
}

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#64748b',
  marginBottom: 12,
}

// ─── Colour palettes ──────────────────────────────────────────────────────────

const COEF_COLORS = [
  '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#64748b', '#a78bfa',
  '#fbbf24', '#34d399', '#60a5fa', '#fb923c', '#c084fc',
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
      background: 'rgba(8,13,26,0.95)',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8,
      padding: '8px 12px',
      fontSize: 12,
    }}>
      <div style={{ color: '#64748b', marginBottom: 4 }}>{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color, display: 'flex', gap: 10, justifyContent: 'space-between' }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
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
  const scatter20 = useMemo(() => {
    if (!model) return []
    return model.scatter.residuals
      .map((r, i) => ({ x: r, y: model.scatter.fwd20d[i] }))
      .filter(p => p.y !== null && p.y !== undefined)
  }, [model])

  const scatter200 = useMemo(() => {
    if (!model) return []
    return model.scatter.residuals
      .map((r, i) => ({ x: r, y: model.scatter.fwd200d[i] }))
      .filter(p => p.y !== null && p.y !== undefined)
  }, [model])

  const scatter400 = useMemo(() => {
    if (!model) return []
    return model.scatter.residuals
      .map((r, i) => ({ x: r, y: model.scatter.fwd400d[i] }))
      .filter(p => p.y !== null && p.y !== undefined)
  }, [model])

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ background: BG, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#475569', fontSize: 14 }}>Loading fair value models…</div>
      </div>
    )
  }

  if (!data || !model) {
    return (
      <div style={{ background: BG, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#ef4444', fontSize: 14 }}>Failed to load data.</div>
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
        background: 'radial-gradient(ellipse at 50% -10%, rgba(59,130,246,0.05) 0%, transparent 55%)',
      }} />

      {/* Header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px',
        background: 'rgba(8,13,26,0.90)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        backdropFilter: 'blur(12px)',
        flexWrap: 'wrap',
        gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
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
              HICPxT Inflation Fair Value Models
            </div>
            <div style={{ color: '#475569', fontSize: 11, marginTop: 1 }}>
              Rolling Elastic Net — {dateRange}
            </div>
          </div>
        </div>

        {/* Model selector tabs — two rows, one per group */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.groups.map(group => (
            <div key={group.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: '#475569',
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
                      background: isActive ? 'rgba(249,115,22,0.20)' : 'rgba(255,255,255,0.05)',
                      border: `1px solid ${isActive ? 'rgba(249,115,22,0.55)' : 'rgba(255,255,255,0.08)'}`,
                      borderRadius: 7,
                      padding: '4px 11px',
                      color: isActive ? '#fb923c' : '#64748b',
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
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={fitData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="date"
                  ticks={xTicks}
                  tickFormatter={fmtTick}
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(255,255,255,0.10)' }}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                <Line
                  type="monotone"
                  dataKey="actual"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="fitted"
                  stroke="#f97316"
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
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={residData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="date"
                  ticks={xTicks}
                  tickFormatter={fmtTick}
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(255,255,255,0.10)' }}
                />
                <Line type="monotone" dataKey="residual" stroke="#ef4444" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} />
                <Line type="monotone" dataKey="s1hi" stroke="rgba(255,255,255,0.35)" strokeWidth={1} strokeDasharray="4 2" dot={false} legendType="none" />
                <Line type="monotone" dataKey="s1lo" stroke="rgba(255,255,255,0.35)" strokeWidth={1} strokeDasharray="4 2" dot={false} legendType="none" />
                <Line type="monotone" dataKey="s2hi" stroke="rgba(255,255,255,0.20)" strokeWidth={1} strokeDasharray="2 2" dot={false} legendType="none" />
                <Line type="monotone" dataKey="s2lo" stroke="rgba(255,255,255,0.20)" strokeWidth={1} strokeDasharray="2 2" dot={false} legendType="none" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Panel 3: Mean Reversion Scatter */}
          <div style={cardStyle}>
            <div style={sectionLabel}>Mean Reversion Test (premium vs forward return)</div>
            <ResponsiveContainer width="100%" height={220}>
              <ScatterChart margin={{ top: 4, right: 8, bottom: 20, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="Residual"
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                  tickLine={false}
                  label={{ value: 'Residual', position: 'insideBottom', offset: -12, fill: '#475569', fontSize: 10 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="Fwd Return"
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <ZAxis range={[20, 20]} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const p = payload[0]
                    return (
                      <div style={{
                        background: 'rgba(8,13,26,0.95)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 8, padding: '8px 12px', fontSize: 12,
                      }}>
                        <div style={{ color: p.color }}>
                          <div>Residual: <span style={{ fontFamily: 'monospace' }}>{(p.payload.x as number).toFixed(4)}</span></div>
                          <div>Fwd Return: <span style={{ fontFamily: 'monospace' }}>{(p.payload.y as number).toFixed(4)}</span></div>
                        </div>
                      </div>
                    )
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                <Scatter name="20d fwd" data={scatter20} fill="#3b82f6" opacity={0.5} />
                <Scatter name="200d fwd" data={scatter200} fill="#f97316" opacity={0.5} />
                <Scatter name="400d fwd" data={scatter400} fill="#22c55e" opacity={0.5} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          {/* Panel 4: Elastic Net Coefficients */}
          <div style={cardStyle}>
            <div style={sectionLabel}>Elastic Net Coefficients (Rolling)</div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={coefData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="date"
                  ticks={xTicks}
                  tickFormatter={fmtTick}
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.10)" strokeDasharray="4 4" />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(255,255,255,0.10)' }}
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
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={r2Data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="date"
                  ticks={xTicks}
                  tickFormatter={fmtTick}
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 1]}
                  tickFormatter={v => v.toFixed(1)}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(255,255,255,0.10)' }}
                />
                <Line
                  type="monotone"
                  dataKey="r2"
                  stroke="#60a5fa"
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
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={latestCoefData}
                margin={{ top: 4, right: 8, bottom: 60, left: -12 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: '#475569', fontSize: 9 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                  tickLine={false}
                  interval={0}
                  angle={-45}
                  textAnchor="end"
                />
                <YAxis
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.20)" />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const p = payload[0]
                    const val = p.value as number
                    return (
                      <div style={{
                        background: 'rgba(8,13,26,0.95)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 8, padding: '8px 12px', fontSize: 12,
                      }}>
                        <div style={{ color: '#64748b', marginBottom: 4 }}>{p.payload.name}</div>
                        <div style={{ color: val >= 0 ? '#3b82f6' : '#ef4444', fontFamily: 'monospace', fontWeight: 600 }}>
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
                      fill={entry.value >= 0 ? '#3b82f6' : '#ef4444'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

        </div>
      </main>
    </div>
  )
}
