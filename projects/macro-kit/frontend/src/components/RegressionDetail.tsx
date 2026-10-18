import { useEffect, useState } from 'react'
import axios from 'axios'
import {
  LineChart, Line, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { chart, series as palette, fg } from '../theme'

// ─── Types (from /api/tools/swaps-rv/regression) ──────────────────────────────

interface FactorRow {
  name: string
  beta: number
  se: number
  t: number
  factor_vol_bp: number   // daily std of the factor, bp
  beta_x_vol_bp: number   // β × factor σ: bp/day of the structure per 1σ factor day
  vif: number
}

interface RegressionData {
  label: string
  as_of: string
  factors: FactorRow[]
  excluded_factors?: string[]   // factors that are the structure itself, left out of its regression
  intercept: { beta: number; se: number; t: number }
  n_obs: number
  r2: number
  adj_r2: number
  resid_vol_bp: number
  residual_zscore: number
  cum_resid_mean: number
  cum_resid_std: number
  rolling_window: number
  rolling: Record<string, number | string>[]       // date, r2, one beta per factor
  residuals: { date: string; actual: number; fitted: number; resid: number; cum: number }[]
  attribution: Record<string, number | string>[]   // date, actual, intercept, residual, one per factor
}

const MONO = "'Geist Mono', ui-monospace, monospace"
const factorName = (f: string) => f.replace('_fwd', ' fwd').replace('_vol', ' vol')
const fmtDate = (d: string) => d.slice(0, 7)

function Panel({ title, sub, right, children }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'rgba(200,220,240,0.02)', border: '1px solid rgba(200,220,240,0.06)',
      borderRadius: 6, padding: '12px 16px', minWidth: 0,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{title}</div>
          {sub && <div style={{ color: '#77828f', fontSize: 11, marginTop: 2 }}>{sub}</div>}
        </div>
        {right}
      </div>
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  )
}

function Chip({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span style={{
      display: 'inline-flex', gap: 6, alignItems: 'baseline', padding: '3px 9px', borderRadius: 5,
      background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)',
    }}>
      <span style={{ color: '#9aa5b1', fontSize: 11 }}>{label}</span>
      <span style={{ color: color ?? '#e4eaf1', fontSize: 12, fontFamily: MONO }}>{value}</span>
    </span>
  )
}

const tColor = (t: number) => Math.abs(t) >= 2 ? '#e4eaf1' : '#77828f'       // dim when not significant
const vifColor = (v: number) => v >= 5 ? '#e2826f' : v >= 2.5 ? '#dfbb78' : '#c6ced8'
const zColor = (z: number) => Math.abs(z) >= 2 ? (z > 0 ? '#e2826f' : '#6fc2a2') : Math.abs(z) >= 1 ? '#dfbb78' : '#c6ced8'

// ─── Component ────────────────────────────────────────────────────────────────

export default function RegressionDetail({ currency, label, asOf, dataStamp, apiBase = '/api/tools/swaps-rv', query = '' }: {
  currency?: string
  label: string
  asOf: string
  dataStamp?: string | null   // changes on a data refresh, so the regression reloads too
  apiBase?: string            // tool whose /regression route serves the payload
  query?: string              // extra query parameters, e.g. "use_individual_bonds=false"
}) {
  const [data, setData] = useState<RegressionData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rollWindow, setRollWindow] = useState(63)

  // A new structure clears the old one's charts; a new rolling window keeps them until it loads
  useEffect(() => { setData(null) }, [currency, label])

  useEffect(() => {
    let cancelled = false
    setError(null)
    const params = new URLSearchParams(query)
    if (currency) params.set('currency', currency)
    params.set('label', label)
    params.set('date', asOf)
    params.set('window', String(rollWindow))
    axios
      .get<RegressionData>(`${apiBase}/regression?${params}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('access_token') ?? ''}` },
      })
      .then(res => {
        if (cancelled) return
        // Anything but the expected JSON (e.g. the SPA's index.html from an older server) is an error, not data
        const d = res.data as Partial<RegressionData> | undefined
        if (d && typeof d === 'object' && Array.isArray(d.factors) && Array.isArray(d.residuals)) setData(d as RegressionData)
        else setError('The regression is not available from this server.')
      })
      .catch(err => {
        if (cancelled) return
        const detail = axios.isAxiosError(err) ? (err.response?.data as { detail?: unknown } | undefined)?.detail : undefined
        setError(typeof detail === 'string' ? detail : 'Could not load the regression.')
      })
    return () => { cancelled = true }
  }, [currency, label, asOf, dataStamp, rollWindow, apiBase, query])

  const header = (
    <>
      <div style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Regression vs factors</div>
      <div style={{ color: '#8995a2', fontSize: 12, marginBottom: 12 }}>
        OLS of the structure's daily change (bp) on the factors' daily changes (bp), with an intercept, over the last 1y —
        the Beta Monitor regression.
      </div>
    </>
  )

  if (error) return <div style={{ marginTop: 20 }}>{header}<div style={{ color: '#e2826f', fontSize: 12 }}>{error}</div></div>
  if (!data) return <div style={{ marginTop: 20 }}>{header}<div style={{ color: '#8995a2', fontSize: 12 }}>Loading regression…</div></div>

  const factors = data.factors.map(f => f.name)
  const colorOf = (f: string) => palette[factors.indexOf(f) % palette.length]
  const m = data.cum_resid_mean, sd = data.cum_resid_std
  const fitLim = Math.ceil(Math.max(...data.residuals.flatMap(r => [Math.abs(r.actual), Math.abs(r.fitted)])))
  const fitMin = -fitLim, fitMax = fitLim
  const fitTicks = [-fitLim, -fitLim / 2, 0, fitLim / 2, fitLim]
  const rollTicks = Math.max(1, Math.floor(data.rolling.length / 6))
  const winTicks = Math.max(1, Math.floor(data.residuals.length / 6))

  const th: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontFamily: MONO, color: '#c6ced8' }

  return (
    <div style={{ marginTop: 20 }}>
      {header}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <Chip label="R²" value={`${Math.round(data.r2 * 100)}%`} />
        <Chip label="Adj. R²" value={`${Math.round(data.adj_r2 * 100)}%`} />
        <Chip label="n" value={String(data.n_obs)} />
        <Chip label="Residual vol" value={`${data.resid_vol_bp.toFixed(2)} bp/day`} />
        <Chip label="Residual Z" value={data.residual_zscore.toFixed(2)} color={zColor(data.residual_zscore)} />
      </div>

      <div style={{ overflowX: 'auto', marginBottom: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: '#9aa5b1', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <th style={{ ...th, textAlign: 'left' }}>Factor</th>
              <th style={th}>β</th>
              <th style={th}>Std err</th>
              <th style={th}>t-stat</th>
              <th style={th}>Factor σ (bp/day)</th>
              <th style={th}>β × σ (bp/day)</th>
              <th style={th}>VIF</th>
            </tr>
          </thead>
          <tbody>
            {data.factors.map(f => (
              <tr key={f.name} style={{ borderTop: '1px solid rgba(200,220,240,0.05)' }}>
                <td style={{ padding: '6px 10px', color: '#e4eaf1', fontFamily: MONO }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: colorOf(f.name), marginRight: 8 }} />
                  {factorName(f.name)}
                </td>
                <td style={{ ...td, color: '#e4eaf1' }}>{f.beta > 0 ? '+' : ''}{f.beta.toFixed(3)}</td>
                <td style={td}>{f.se.toFixed(3)}</td>
                <td style={{ ...td, color: tColor(f.t) }}>{f.t.toFixed(1)}</td>
                <td style={td}>{f.factor_vol_bp.toFixed(2)}</td>
                <td style={td}>{f.beta_x_vol_bp > 0 ? '+' : ''}{f.beta_x_vol_bp.toFixed(2)}</td>
                <td style={{ ...td, color: vifColor(f.vif) }}>{f.vif.toFixed(1)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid rgba(200,220,240,0.05)' }}>
              <td style={{ padding: '6px 10px', color: '#9aa5b1', fontFamily: MONO }}>intercept (bp/day)</td>
              <td style={td}>{data.intercept.beta > 0 ? '+' : ''}{data.intercept.beta.toFixed(3)}</td>
              <td style={td}>{data.intercept.se.toFixed(3)}</td>
              <td style={{ ...td, color: tColor(data.intercept.t) }}>{data.intercept.t.toFixed(1)}</td>
              <td style={td} colSpan={3} />
            </tr>
          </tbody>
        </table>
        <div style={{ color: '#77828f', fontSize: 11, marginTop: 6 }}>
          {data.excluded_factors?.length ? <>
            Left out: {data.excluded_factors.map(factorName).join(', ')}. That factor is this structure, so the regression
            shows how much of it the other factors explain.{' '}
          </> : null}
          β: bp move in the structure per 1 bp factor move, others held fixed. t-stat dimmed when |t| &lt; 2.
          β × σ puts rate and vol factors on one scale: the structure's move on a typical (1σ) day of that factor.
          VIF: how much a factor overlaps with the others (amber ≥ 2.5, red ≥ 5); high VIFs make the individual βs unstable.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(480px, 1fr))', gap: 12 }}>
        <Panel
          title={`Rolling betas · ${data.rolling_window}d window`}
          sub="Each point re-estimates the regression on the preceding window; dashed: rolling R² (right axis)"
          right={
            <div style={{ display: 'flex', gap: 4 }}>
              {[[63, '3M'], [126, '6M'], [252, '1Y']].map(([n, txt]) => (
                <button key={n} onClick={() => setRollWindow(n as number)} style={{
                  background: rollWindow === n ? 'rgba(106,169,204,0.16)' : 'transparent',
                  border: `1px solid ${rollWindow === n ? 'rgba(106,169,204,0.35)' : 'rgba(200,220,240,0.09)'}`,
                  color: rollWindow === n ? '#e4eaf1' : '#9aa5b1',
                  borderRadius: 5, padding: '2px 8px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
                }}>{txt}</button>
              ))}
            </div>
          }
        >
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.rolling} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid {...chart.grid} />
              <XAxis dataKey="date" {...chart.axis} interval={rollTicks} tickFormatter={fmtDate} />
              <YAxis yAxisId="b" width={44} {...chart.axis} tickFormatter={(v: number) => v.toFixed(2)} />
              <YAxis yAxisId="r2" orientation="right" domain={[0, 1]} width={34} {...chart.axis} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
              <Tooltip {...chart.tooltip} formatter={(v: number, n: string) => [n === 'R²' ? `${Math.round(v * 100)}%` : v.toFixed(3), n]} />
              <Legend wrapperStyle={{ fontSize: 10, color: fg[3] }} />
              <ReferenceLine yAxisId="b" y={0} stroke="rgba(200,220,240,0.25)" />
              {factors.map(f => (
                <Line key={f} yAxisId="b" dataKey={f} name={factorName(f)} stroke={colorOf(f)} strokeWidth={1.3} dot={false} isAnimationActive={false} />
              ))}
              <Line yAxisId="r2" dataKey="r2" name="R²" stroke="#8995a2" strokeDasharray="3 3" strokeWidth={1} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Cumulative residual · 1y" sub="The factor-hedged structure (bp). Residual Z compares today's point with this path's mean; with an intercept the path ends at 0 by construction">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.residuals} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid {...chart.grid} />
              <XAxis dataKey="date" {...chart.axis} interval={winTicks} tickFormatter={fmtDate} />
              <YAxis width={44} {...chart.axis} tickFormatter={(v: number) => v.toFixed(1)} />
              <Tooltip {...chart.tooltip} formatter={(v: number, n: string) => [`${v.toFixed(2)} bp`, n]} />
              <ReferenceLine y={m + 2 * sd} stroke="#d9705e" strokeDasharray="2 4" label={{ value: '+2σ', fill: fg[4], fontSize: 9, position: 'insideRight' }} />
              <ReferenceLine y={m + sd} stroke="#d6ad66" strokeDasharray="2 4" label={{ value: '+1σ', fill: fg[4], fontSize: 9, position: 'insideRight' }} />
              <ReferenceLine y={m} stroke="rgba(200,220,240,0.45)" label={{ value: 'mean', fill: fg[4], fontSize: 9, position: 'insideRight' }} />
              <ReferenceLine y={m - sd} stroke="#58ad8e" strokeDasharray="2 4" label={{ value: '−1σ', fill: fg[4], fontSize: 9, position: 'insideRight' }} />
              <ReferenceLine y={m - 2 * sd} stroke="#6fc2a2" strokeDasharray="2 4" label={{ value: '−2σ', fill: fg[4], fontSize: 9, position: 'insideRight' }} />
              <Line dataKey="cum" name="Cum. residual" stroke="#86c0de" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Actual vs fitted · daily changes (bp)" sub={`Each dot is one day; on the diagonal the factors explain the move fully. Gold: latest day (${data.residuals[data.residuals.length - 1]?.date ?? '—'})`}>
          <ResponsiveContainer width="100%" height={240}>
            <ScatterChart margin={{ top: 4, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid {...chart.grid} vertical />
              <XAxis dataKey="fitted" type="number" name="Fitted" domain={[fitMin, fitMax]} ticks={fitTicks} {...chart.axis}
                tickFormatter={(v: number) => v.toFixed(1)}
                label={{ value: 'Fitted', position: 'insideBottom', offset: -4, fill: fg[4], fontSize: 10 }} />
              <YAxis dataKey="actual" type="number" name="Actual" domain={[fitMin, fitMax]} ticks={fitTicks} width={44} {...chart.axis}
                tickFormatter={(v: number) => v.toFixed(1)} />
              <Tooltip cursor={false} content={({ active, payload }) => {
                const d = active && payload?.[0]?.payload as RegressionData['residuals'][number] | undefined
                if (!d) return null
                return (
                  <div style={chart.tooltip.contentStyle}>
                    <div style={{ color: fg[3], marginBottom: 4 }}>{d.date}</div>
                    <div>Actual&nbsp;&nbsp;&nbsp;{d.actual > 0 ? '+' : ''}{d.actual.toFixed(2)} bp</div>
                    <div>Fitted&nbsp;&nbsp;&nbsp;{d.fitted > 0 ? '+' : ''}{d.fitted.toFixed(2)} bp</div>
                    <div style={{ color: fg[3] }}>Residual {d.resid > 0 ? '+' : ''}{d.resid.toFixed(2)} bp</div>
                  </div>
                )
              }} />
              <ReferenceLine segment={[{ x: fitMin, y: fitMin }, { x: fitMax, y: fitMax }]} stroke="rgba(200,220,240,0.3)" strokeDasharray="3 3" />
              <Scatter data={data.residuals.slice(0, -1)} fill="#86c0de" fillOpacity={0.55} isAnimationActive={false} />
              {/* Latest day, drawn last so it sits on top */}
              <Scatter data={data.residuals.slice(-1)} isAnimationActive={false}
                shape={({ cx, cy }: { cx?: number; cy?: number }) => (
                  <g>
                    <circle cx={cx} cy={cy} r={9} fill="none" stroke="#d6ad66" strokeOpacity={0.5} strokeWidth={1} />
                    <circle cx={cx} cy={cy} r={5} fill="#d6ad66" stroke="#0f1419" strokeWidth={1.5} />
                  </g>
                )} />
            </ScatterChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Attribution · cumulative over 1y (bp)" sub="Structure's cumulative move split into β × factor move, intercept drift and residual; they add up exactly">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.attribution} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid {...chart.grid} />
              <XAxis dataKey="date" {...chart.axis} interval={winTicks} tickFormatter={fmtDate} />
              <YAxis width={44} {...chart.axis} tickFormatter={(v: number) => v.toFixed(1)} />
              <Tooltip {...chart.tooltip} formatter={(v: number, n: string) => [`${v.toFixed(2)} bp`, n]} />
              <Legend wrapperStyle={{ fontSize: 10, color: fg[3] }} />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.25)" />
              <Line dataKey="actual" name="Actual" stroke="#e4eaf1" strokeWidth={2} dot={false} isAnimationActive={false} />
              {factors.map(f => (
                <Line key={f} dataKey={f} name={factorName(f)} stroke={colorOf(f)} strokeWidth={1.3} dot={false} isAnimationActive={false} />
              ))}
              <Line dataKey="intercept" name="Intercept" stroke="#77828f" strokeDasharray="4 3" strokeWidth={1} dot={false} isAnimationActive={false} />
              <Line dataKey="residual" name="Residual" stroke="#d59fbf" strokeDasharray="2 2" strokeWidth={1.2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      </div>
    </div>
  )
}
