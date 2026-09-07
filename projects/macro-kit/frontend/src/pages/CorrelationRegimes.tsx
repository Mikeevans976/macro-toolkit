import { Component, useEffect, useMemo, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  ComposedChart, Line, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Legend,
} from 'recharts'

// ─── Error boundary ───────────────────────────────────────────────────────────

class CRErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[CorrelationRegimes] render error:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', background: '#080d1a', color: '#f87171',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <div style={{ maxWidth: 700, fontFamily: 'monospace' }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Correlation Regimes — Render Error</div>
            <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', color: '#fca5a5',
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 8, padding: 16 }}>
              {this.state.error.message}{'\n\n'}{this.state.error.stack}
            </pre>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SeriesMeta {
  id: string
  label: string
  asset_class: string
  units: string
  transform: string
}

interface PairRow {
  x: string
  y: string
  x_label: string
  y_label: string
  x_class: string
  y_class: string
  rho_long: number
  rho_short: number
  delta: number
  z_break: number
  sign_flip: boolean
  beta_long: number
  beta_short: number
  days_since: number
}

interface ScanResponse {
  data_source: string
  as_of: string
  n_obs: number
  long_window: number
  short_window: number
  min_abs_corr: number
  windows: {
    regime: { start: string; end: string }
    recent: { start: string; end: string }
  }
  series: SeriesMeta[]
  n_pairs_total: number
  n_pairs_qualified: number
  pairs: PairRow[]
  matrix: {
    ids: string[]
    labels: string[]
    rho_long: number[][]
    rho_short: number[][]
  }
}

interface PairDetail {
  data_source: string
  x: string
  y: string
  x_label: string
  y_label: string
  x_units: string
  y_units: string
  long_window: number
  short_window: number
  rolling: { date: string; rho_short: number | null; rho_long: number | null; beta_short: number | null }[]
  scatter: {
    regime: { x: number; y: number }[]
    recent: { x: number; y: number }[]
    fit_regime: { slope: number; intercept: number }
    fit_recent: { slope: number; intercept: number }
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BG = '#080d1a'

const CLASS_COLORS: Record<string, string> = {
  Rates: '#6366f1',
  FX: '#38bdf8',
  Equity: '#22c55e',
  Volatility: '#f472b6',
  Commodities: '#f59e0b',
  Inflation: '#f97316',
  Credit: '#a855f7',
}

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: '20px 24px',
  marginBottom: 20,
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  color: '#e2e8f0',
  padding: '6px 10px',
  fontSize: 13,
  width: 80,
  fontFamily: 'monospace',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function corrColor(v: number): string {
  // diverging: -1 red → 0 dark → +1 green
  const t = Math.max(-1, Math.min(1, v))
  if (t >= 0) return `rgba(34,197,94,${(0.08 + t * 0.55).toFixed(3)})`
  return `rgba(239,68,68,${(0.08 - t * 0.55).toFixed(3)})`
}

function fmtRho(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2)
}

function classBadge(cls: string): React.CSSProperties {
  const color = CLASS_COLORS[cls] ?? '#94a3b8'
  return {
    display: 'inline-block', padding: '1px 7px', borderRadius: 10,
    fontSize: 10, fontWeight: 700, background: `${color}22`,
    color, border: `1px solid ${color}44`, whiteSpace: 'nowrap',
  }
}

function zBadge(z: number, flip: boolean): React.CSSProperties {
  const color = flip ? '#f472b6' : z >= 1.96 ? '#ef4444' : z >= 1.0 ? '#fbbf24' : '#94a3b8'
  return {
    display: 'inline-block', padding: '2px 8px', borderRadius: 12,
    fontSize: 11, fontWeight: 700, background: `${color}22`, color,
    border: `1px solid ${color}44`, fontFamily: 'monospace',
  }
}

function SimpleTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'rgba(8,13,26,0.96)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#64748b', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color ?? '#e2e8f0' }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(3) : p.value}
        </div>
      ))}
    </div>
  )
}

// ─── Breakdown table ──────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  textAlign: 'right', padding: '8px 10px', color: '#64748b',
  fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
  borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap',
}

const tdStyle: React.CSSProperties = {
  textAlign: 'right', padding: '7px 10px', fontSize: 13,
  fontFamily: 'monospace', color: '#cbd5e1',
  borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap',
}

function BreakdownTable({ pairs, selected, onSelect }: {
  pairs: PairRow[]
  selected: PairRow | null
  onSelect: (p: PairRow) => void
}) {
  if (!pairs.length) {
    return <div style={{ color: '#64748b', fontSize: 13, padding: 12 }}>
      No qualified pairs at the current threshold.
    </div>
  }
  return (
    <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }}>Pair</th>
            <th style={{ ...thStyle, textAlign: 'left' }}>Classes</th>
            <th style={thStyle}>ρ regime</th>
            <th style={thStyle}>ρ recent</th>
            <th style={thStyle}>Δρ</th>
            <th style={thStyle}>z-break</th>
            <th style={thStyle}>β regime</th>
            <th style={thStyle}>β recent</th>
            <th style={thStyle}>Days broken</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map(p => {
            const isSel = selected != null && selected.x === p.x && selected.y === p.y
            return (
              <tr key={`${p.x}|${p.y}`}
                onClick={() => onSelect(p)}
                style={{ cursor: 'pointer',
                  background: isSel ? 'rgba(99,102,241,0.12)' : undefined }}>
                <td style={{ ...tdStyle, textAlign: 'left', fontFamily: 'inherit', color: '#e2e8f0', fontWeight: 600 }}>
                  {p.x_label} <span style={{ color: '#475569' }}>vs</span> {p.y_label}
                  {p.sign_flip && <span style={{ marginLeft: 8, ...zBadge(p.z_break, true) }}>FLIP</span>}
                </td>
                <td style={{ ...tdStyle, textAlign: 'left' }}>
                  <span style={classBadge(p.x_class)}>{p.x_class}</span>{' '}
                  <span style={classBadge(p.y_class)}>{p.y_class}</span>
                </td>
                <td style={{ ...tdStyle, color: p.rho_long >= 0 ? '#22c55e' : '#ef4444' }}>{fmtRho(p.rho_long)}</td>
                <td style={{ ...tdStyle, color: p.rho_short >= 0 ? '#22c55e' : '#ef4444' }}>{fmtRho(p.rho_short)}</td>
                <td style={tdStyle}>{fmtRho(p.delta)}</td>
                <td style={tdStyle}><span style={zBadge(p.z_break, p.sign_flip)}>{p.z_break.toFixed(2)}</span></td>
                <td style={tdStyle}>{p.beta_long.toFixed(2)}</td>
                <td style={tdStyle}>{p.beta_short.toFixed(2)}</td>
                <td style={tdStyle}>{p.days_since}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Pair drilldown ───────────────────────────────────────────────────────────

function RollingCorrChart({ detail, threshold }: { detail: PairDetail; threshold: number }) {
  const data = detail.rolling
  const recentStart = data.length > detail.short_window
    ? data[data.length - detail.short_window].date : undefined
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
        <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }} minTickGap={60} />
        <YAxis domain={[-1, 1]} tick={{ fill: '#64748b', fontSize: 11 }} />
        <Tooltip content={<SimpleTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {recentStart && (
          <ReferenceArea x1={recentStart} x2={data[data.length - 1].date}
            fill="#f59e0b" fillOpacity={0.07} />
        )}
        <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
        <ReferenceLine y={threshold} stroke="#22c55e" strokeDasharray="4 4" strokeOpacity={0.5} />
        <ReferenceLine y={-threshold} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.5} />
        <Line dataKey="rho_long" name={`ρ ${detail.long_window}d`} stroke="#6366f1"
          dot={false} strokeWidth={2} connectNulls />
        <Line dataKey="rho_short" name={`ρ ${detail.short_window}d`} stroke="#f59e0b"
          dot={false} strokeWidth={1.5} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function RegimeScatter({ detail }: { detail: PairDetail }) {
  const { regime, recent, fit_regime, fit_recent } = detail.scatter
  const allX = [...regime, ...recent].map(p => p.x)
  const xMin = Math.min(...allX)
  const xMax = Math.max(...allX)
  const pad = (xMax - xMin) * 0.05
  const x0 = xMin - pad
  const x1 = xMax + pad

  const fitLine = (fit: { slope: number; intercept: number }, key: string) => ([
    { x: x0, [key]: fit.intercept + fit.slope * x0 },
    { x: x1, [key]: fit.intercept + fit.slope * x1 },
  ])

  // merge datasets: scatter points carry their own y keys
  const data = [
    ...regime.map(p => ({ x: p.x, yRegime: p.y })),
    ...recent.map(p => ({ x: p.x, yRecent: p.y })),
    ...fitLine(fit_regime, 'fitRegime'),
    ...fitLine(fit_recent, 'fitRecent'),
  ]

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
        <XAxis dataKey="x" type="number" domain={[x0, x1]}
          tick={{ fill: '#64748b', fontSize: 10 }}
          tickFormatter={(v: number) => v.toFixed(1)}
          label={{ value: `Δ ${detail.x_label} (${detail.x_units})`, position: 'insideBottom',
            offset: -2, fill: '#64748b', fontSize: 11 }} />
        <YAxis tick={{ fill: '#64748b', fontSize: 10 }}
          tickFormatter={(v: number) => v.toFixed(1)}
          label={{ value: `Δ ${detail.y_label} (${detail.y_units})`, angle: -90,
            position: 'insideLeft', fill: '#64748b', fontSize: 11 }} />
        <Tooltip content={<SimpleTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Scatter dataKey="yRegime" name="Regime window" fill="#64748b" fillOpacity={0.5} />
        <Scatter dataKey="yRecent" name="Recent window" fill="#f59e0b" />
        <Line dataKey="fitRegime" name="Regime fit" stroke="#6366f1" dot={false}
          strokeWidth={2} connectNulls legendType="plainline" />
        <Line dataKey="fitRecent" name="Recent fit" stroke="#f59e0b" dot={false}
          strokeWidth={2} strokeDasharray="6 4" connectNulls legendType="plainline" />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function PairDrilldown({ pair, longWindow, shortWindow, threshold }: {
  pair: PairRow
  longWindow: number
  shortWindow: number
  threshold: number
}) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<PairDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const token = localStorage.getItem('access_token')
    if (!token) { navigate('/login', { replace: true }); return }
    setDetail(null)
    setError(null)
    axios.get('/api/tools/correlation-regimes/pair', {
      headers: { Authorization: `Bearer ${token}` },
      params: { x: pair.x, y: pair.y, long_window: longWindow, short_window: shortWindow },
    })
      .then(res => setDetail(res.data))
      .catch(err => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        } else {
          setError(err.response?.data?.detail ?? err.message ?? 'Unknown error')
        }
      })
  }, [pair.x, pair.y, longWindow, shortWindow])

  if (error) return <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>
  if (!detail) return <div style={{ color: '#64748b', fontSize: 13 }}>Loading pair detail…</div>

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      <div>
        <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          Rolling correlation — recent window shaded
        </div>
        <RollingCorrChart detail={detail} threshold={threshold} />
      </div>
      <div>
        <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          Daily changes — regime vs recent window
        </div>
        <RegimeScatter detail={detail} />
      </div>
    </div>
  )
}

// ─── Delta heatmap ────────────────────────────────────────────────────────────

function DeltaHeatmap({ matrix }: { matrix: ScanResponse['matrix'] }) {
  const { labels, rho_long, rho_short } = matrix
  const n = labels.length
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left', position: 'sticky', left: 0, background: BG }} />
            {labels.map(l => (
              <th key={l} style={{ padding: 2, height: 90, verticalAlign: 'bottom' }}>
                <div style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)',
                  color: '#64748b', fontSize: 9, whiteSpace: 'nowrap' }}>{l}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((rowLabel, i) => (
            <tr key={rowLabel}>
              <td style={{ color: '#94a3b8', fontSize: 10, padding: '1px 6px', whiteSpace: 'nowrap',
                position: 'sticky', left: 0, background: BG }}>{rowLabel}</td>
              {labels.map((colLabel, j) => {
                if (i === j) return <td key={colLabel} style={{ width: 18, height: 16, background: 'rgba(255,255,255,0.04)' }} />
                const d = rho_short[i][j] - rho_long[i][j]
                return (
                  <td key={colLabel}
                    title={`${rowLabel} vs ${colLabel}\nρ regime ${fmtRho(rho_long[i][j])} → ρ recent ${fmtRho(rho_short[i][j])} (Δ ${fmtRho(d)})`}
                    style={{ width: 18, height: 16, background: corrColor(d), cursor: 'default' }} />
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ color: '#475569', fontSize: 11, marginTop: 8 }}>
        Cell colour = Δρ (recent − regime): <span style={{ color: '#22c55e' }}>green = strengthened</span>,{' '}
        <span style={{ color: '#ef4444' }}>red = weakened / flipped</span>. Total {n}×{n} universe. Hover for values.
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

function CorrelationRegimesInner() {
  const navigate = useNavigate()
  const [data, setData] = useState<ScanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [longWindow, setLongWindow] = useState(126)
  const [shortWindow, setShortWindow] = useState(21)
  const [threshold, setThreshold] = useState(0.6)
  const [classFilter, setClassFilter] = useState<string>('All')
  const [selected, setSelected] = useState<PairRow | null>(null)
  const [showHeatmap, setShowHeatmap] = useState(false)

  function fetchScan() {
    const token = localStorage.getItem('access_token')
    if (!token) { navigate('/login', { replace: true }); return }
    setLoading(true)
    setError(null)
    axios.get('/api/tools/correlation-regimes/scan', {
      headers: { Authorization: `Bearer ${token}` },
      params: { long_window: longWindow, short_window: shortWindow, min_abs_corr: threshold },
    })
      .then(res => {
        if (!res.data || !Array.isArray(res.data.pairs) || !Array.isArray(res.data.series)) {
          setError('Unexpected response from /api/tools/correlation-regimes/scan — '
            + 'the backend is likely running an old version. Restart uvicorn and reload.')
          return
        }
        setData(res.data)
        const pairs: PairRow[] = res.data.pairs
        setSelected(pairs.length ? pairs[0] : null)
      })
      .catch(err => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        } else {
          setError(err.response?.data?.detail ?? err.message ?? 'Unknown error')
        }
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchScan() }, [])

  const assetClasses = useMemo(() => {
    const set = new Set<string>()
    data?.series?.forEach(s => set.add(s.asset_class))
    return ['All', ...Array.from(set)]
  }, [data])

  const filteredPairs = useMemo(() => {
    if (!data) return []
    if (classFilter === 'All') return data.pairs
    return data.pairs.filter(p => p.x_class === classFilter || p.y_class === classFilter)
  }, [data, classFilter])

  const nBroken = useMemo(() => filteredPairs.filter(p => p.z_break >= 1.96).length, [filteredPairs])
  const nFlips = useMemo(() => filteredPairs.filter(p => p.sign_flip).length, [filteredPairs])

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#e2e8f0', padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <button onClick={() => navigate('/')}
            style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer',
              fontSize: 13, padding: 0, marginBottom: 6 }}>
            ← Dashboard
          </button>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Correlation Regimes</h1>
          <div style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
            Cross-asset scan for strong relationships that have recently broken down —
            dual-window rolling correlations with Fisher-z breakdown scoring on daily changes.
          </div>
        </div>
        {data && (
          <div style={{ textAlign: 'right', fontSize: 12, color: '#64748b', fontFamily: 'monospace' }}>
            <div>as of {data.as_of}</div>
            <div>source: {data.data_source}</div>
            <div>regime {data.windows.regime.start} → {data.windows.regime.end}</div>
            <div>recent {data.windows.recent.start} → {data.windows.recent.end}</div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{ ...cardStyle, display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Regime window (days)</div>
          <input type="number" value={longWindow} min={40} max={500} style={inputStyle}
            onChange={e => setLongWindow(parseInt(e.target.value) || 126)} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Recent window (days)</div>
          <input type="number" value={shortWindow} min={10} max={90} style={inputStyle}
            onChange={e => setShortWindow(parseInt(e.target.value) || 21)} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Min |ρ| regime</div>
          <input type="number" value={threshold} min={0.3} max={0.95} step={0.05} style={inputStyle}
            onChange={e => setThreshold(parseFloat(e.target.value) || 0.6)} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Asset class</div>
          <select value={classFilter} onChange={e => setClassFilter(e.target.value)}
            style={{ ...inputStyle, width: 140 }}>
            {assetClasses.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button onClick={fetchScan} disabled={loading}
          style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8,
            padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            opacity: loading ? 0.5 : 1 }}>
          {loading ? 'Scanning…' : 'Run Scan'}
        </button>

        {data && (
          <div style={{ display: 'flex', gap: 20, marginLeft: 'auto', fontFamily: 'monospace' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0' }}>{data.n_pairs_qualified}</div>
              <div style={{ fontSize: 10, color: '#64748b' }}>strong pairs</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#ef4444' }}>{nBroken}</div>
              <div style={{ fontSize: 10, color: '#64748b' }}>broken (z ≥ 1.96)</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#f472b6' }}>{nFlips}</div>
              <div style={{ fontSize: 10, color: '#64748b' }}>sign flips</div>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div style={{ ...cardStyle, borderColor: 'rgba(239,68,68,0.3)', color: '#f87171', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Ranked table */}
      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Breakdown Ranking</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
          Pairs with |ρ| ≥ {threshold.toFixed(2)} in the regime window, ranked by Fisher-z breakdown score
          (z-break &gt; 0 = weakening; ≥ 1.96 significant at 5%). Click a row to drill down.
        </div>
        {loading
          ? <div style={{ color: '#64748b', fontSize: 13 }}>Scanning {data?.n_pairs_total ?? '…'} pairs…</div>
          : <BreakdownTable pairs={filteredPairs} selected={selected} onSelect={setSelected} />}
      </div>

      {/* Drilldown */}
      {selected && data && (
        <div style={cardStyle}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
            {selected.x_label} vs {selected.y_label}
            <span style={{ marginLeft: 12, ...zBadge(selected.z_break, selected.sign_flip) }}>
              ρ {fmtRho(selected.rho_long)} → {fmtRho(selected.rho_short)} · z {selected.z_break.toFixed(2)}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
            β {selected.beta_long.toFixed(2)} → {selected.beta_short.toFixed(2)} ·
            rolling {data.short_window}d correlation below threshold for {selected.days_since} consecutive days
          </div>
          <PairDrilldown pair={selected} longWindow={longWindow} shortWindow={shortWindow}
            threshold={threshold} />
        </div>
      )}

      {/* Heatmap */}
      {data && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Correlation Shift Heatmap (Δρ)</div>
            <button onClick={() => setShowHeatmap(v => !v)}
              style={{ background: 'rgba(255,255,255,0.06)', color: '#94a3b8',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
                padding: '5px 14px', fontSize: 12, cursor: 'pointer' }}>
              {showHeatmap ? 'Hide' : 'Show'}
            </button>
          </div>
          {showHeatmap && <div style={{ marginTop: 16 }}><DeltaHeatmap matrix={data.matrix} /></div>}
        </div>
      )}
    </div>
  )
}

export default function CorrelationRegimes() {
  return (
    <CRErrorBoundary>
      <CorrelationRegimesInner />
    </CRErrorBoundary>
  )
}
