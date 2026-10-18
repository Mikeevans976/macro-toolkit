import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend, ReferenceArea,
} from 'recharts'
import { chart, series as palette, fg } from '../theme'

// ─── Types (from /api/tools/swaps-rv/neutral) ─────────────────────────────────

type FactorName = 'level' | 'slope' | 'curvature'
type Exposure = Record<FactorName, number>

interface StructureStats {
  value_bps: number
  zscore_1y: number
  pctile_1y: number
  vol3m_bps: number
  ivol_bps: number | null          // null: no swaption vol grid for this currency
  carry1y_bps: number
  carry_vol_ratio: number | null
  carry_ivol_ratio: number | null
  exposure: Exposure   // bp per 1σ factor day
}

interface NeutralData {
  label: string
  group: 'curve' | 'fly'
  as_of: string
  window_days: number
  hedged: FactorName[]
  factors: { name: FactorName; variance_share: number; loadings: { tenor: number; loading: number }[] }[]
  legs: { label: string; weight: number; neutral_weight: number | null; carry1y_bps: number; exposure: Exposure }[]
  factor_share: number
  unstable: boolean | null
  standard: StructureStats
  neutral: StructureStats | null
  history: { date: string; standard: number; neutral: number | null }[]
}

const MONO = "'Geist Mono', ui-monospace, monospace"
const FACTORS: FactorName[] = ['level', 'slope', 'curvature']
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const signed = (v: number, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`
const zColor = (z: number) => Math.abs(z) >= 2 ? (z > 0 ? '#e2826f' : '#6fc2a2') : Math.abs(z) >= 1 ? '#dfbb78' : '#c6ced8'
const STD_COLOR = '#9aa5b1'
const NEU_COLOR = '#86c0de'

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
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  )
}

const LOOKBACKS = [[252, '1Y'], [504, '2Y'], [0, 'All']] as const

// ─── Component ────────────────────────────────────────────────────────────────

export default function FactorNeutral({ currency, label, asOf, dataStamp }: {
  currency: string
  label: string
  asOf: string
  dataStamp?: string | null
}) {
  const [data, setData] = useState<NeutralData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lookback, setLookback] = useState<number>(252)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    const params = new URLSearchParams({ currency, label, date: asOf })
    axios
      .get<NeutralData>(`/api/tools/swaps-rv/neutral?${params}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('access_token') ?? ''}` },
      })
      .then(res => {
        if (cancelled) return
        // Anything but the expected JSON (e.g. the SPA's index.html from an older server) is an error, not data
        const d = res.data as Partial<NeutralData> | undefined
        if (d && typeof d === 'object' && Array.isArray(d.history) && Array.isArray(d.legs) && d.standard) setData(d as NeutralData)
        else setError('The factor-neutral version is not available from this server.')
      })
      .catch(err => {
        if (cancelled) return
        const detail = axios.isAxiosError(err) ? (err.response?.data as { detail?: unknown } | undefined)?.detail : undefined
        setError(typeof detail === 'string' ? detail : 'Could not load the factor-neutral version.')
      })
    return () => { cancelled = true }
  }, [currency, label, asOf, dataStamp])

  // Both structures relative to their own mean over the estimation year, so they share one axis
  const chartData = useMemo(() => {
    if (!data) return []
    const h = data.history
    const yr = h.slice(-data.window_days)
    const mean = (k: 'standard' | 'neutral') => {
      const v = yr.map(p => p[k]).filter((x): x is number => x !== null)
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0
    }
    const ms = mean('standard'), mn = mean('neutral')
    return (lookback ? h.slice(-lookback) : h).map(p => ({
      date: p.date,
      standard: +(p.standard - ms).toFixed(2),
      neutral: p.neutral === null ? null : +(p.neutral - mn).toFixed(2),
    }))
  }, [data, lookback])

  const isFly = data?.group === 'fly'
  const header = (
    <>
      <div style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Factor-neutral version</div>
      <div style={{ color: '#8995a2', fontSize: 12, marginBottom: 12 }}>
        {isFly ? 'Belly kept at 2; wings re-weighted so the fly has no level or slope exposure.'
               : data ? 'Back leg kept at 1; front leg re-weighted so the curve has no level exposure.'
               : 'Curves hedged for level, flies for level and slope.'}
        {' '}Factors are the first three principal components of daily par swap changes (1y–30y) over the last year;
        the weights are estimated on that year and applied to the whole history.
      </div>
    </>
  )

  if (error) return <div style={{ marginTop: 20 }}>{header}<div style={{ color: '#e2826f', fontSize: 12 }}>{error}</div></div>
  if (!data) return <div style={{ marginTop: 20 }}>{header}<div style={{ color: '#8995a2', fontSize: 12 }}>Loading factor-neutral version…</div></div>

  const { standard: s, neutral: n } = data
  const hedgedTxt = data.hedged.join(' and ')
  const th: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontFamily: MONO, color: '#c6ced8' }
  const rowLine: React.CSSProperties = { borderTop: '1px solid rgba(200,220,240,0.05)' }
  const expCell = (e: Exposure, f: FactorName, bold = false) => (
    <td key={f} style={{
      ...td,
      color: data.hedged.includes(f) && Math.abs(e[f]) < 0.005 ? '#77828f' : bold ? '#e4eaf1' : '#c6ced8',
    }}>{signed(e[f])}</td>
  )
  const ticks = Math.max(1, Math.floor(chartData.length / 6))

  return (
    <div style={{ marginTop: 20 }}>
      {header}

      {data.unstable && (
        <div style={{
          color: '#dfbb78', fontSize: 12, marginBottom: 12, padding: '6px 10px', borderRadius: 6,
          background: 'rgba(214,173,102,0.08)', border: '1px solid rgba(214,173,102,0.2)',
        }}>
          Unstable hedge: a hedge leg flips sign or scales outside 0.25–2.5× its standard size. The factors barely
          separate these legs, so the neutral version is close to an outright position. Read its Z-score with care.
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <Chip label={`${cap(hedgedTxt)} share of daily variance`} value={`${Math.round(data.factor_share * 100)}%`}
          color={data.factor_share >= 0.3 ? '#dfbb78' : undefined} />
        <Chip label="Z-score 1y" value={`${signed(s.zscore_1y)} → ${n ? signed(n.zscore_1y) : '—'}`} />
        {n && <Chip label="Carry 1y" value={`${signed(s.carry1y_bps, 1)} → ${signed(n.carry1y_bps, 1)} bp`} />}
        {n && <Chip label="3m RVol" value={`${s.vol3m_bps.toFixed(1)} → ${n.vol3m_bps.toFixed(1)} bp`} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(480px, 1fr))', gap: 12 }}>
        <Panel title="Weights and factor exposures" sub="Exposure: bp move per 1σ daily move of the factor, over the last year">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#9aa5b1', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <th style={{ ...th, textAlign: 'left' }}>Leg</th>
                  <th style={th}>Std w</th>
                  <th style={th}>Neutral w</th>
                  {FACTORS.map(f => <th key={f} style={th}>{cap(f)}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.legs.map(l => (
                  <tr key={l.label} style={rowLine}>
                    <td style={{ ...td, textAlign: 'left', color: '#e4eaf1' }}>{l.label}</td>
                    <td style={td}>{signed(l.weight)}</td>
                    <td style={{ ...td, color: '#e4eaf1' }}>{l.neutral_weight === null ? '—' : signed(l.neutral_weight)}</td>
                    {FACTORS.map(f => <td key={f} style={td}>{signed(l.exposure[f])}</td>)}
                  </tr>
                ))}
                <tr style={{ borderTop: '1px solid rgba(200,220,240,0.14)' }}>
                  <td style={{ ...td, textAlign: 'left', color: STD_COLOR }} colSpan={3}>Standard structure</td>
                  {FACTORS.map(f => expCell(s.exposure, f))}
                </tr>
                {n && (
                  <tr style={rowLine}>
                    <td style={{ ...td, textAlign: 'left', color: NEU_COLOR }} colSpan={3}>Neutral structure</td>
                    {FACTORS.map(f => expCell(n.exposure, f, true))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 12 }}>
            <thead>
              <tr style={{ color: '#9aa5b1', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <th style={{ ...th, textAlign: 'left' }}></th>
                <th style={th}>Value (bp)</th>
                <th style={th}>Z 1y</th>
                <th style={th}>%ile</th>
                <th style={th}>3m RVol</th>
                <th style={th}>IVol</th>
                <th style={th}>Carry 1y</th>
                <th style={th}>C/RVol</th>
                <th style={th}>C/IVol</th>
              </tr>
            </thead>
            <tbody>
              {([['Standard', s, STD_COLOR], ['Neutral', n, NEU_COLOR]] as const).map(([name, st, c]) => st && (
                <tr key={name} style={rowLine}>
                  <td style={{ ...td, textAlign: 'left', color: c }}>{name}</td>
                  <td style={td}>{st.value_bps.toFixed(1)}</td>
                  <td style={{ ...td, color: zColor(st.zscore_1y) }}>{signed(st.zscore_1y)}</td>
                  <td style={td}>{st.pctile_1y.toFixed(0)}</td>
                  <td style={td}>{st.vol3m_bps.toFixed(1)}</td>
                  <td style={td}>{st.ivol_bps == null ? '—' : st.ivol_bps.toFixed(1)}</td>
                  <td style={{ ...td, color: st.carry1y_bps > 0 ? '#6fc2a2' : st.carry1y_bps < 0 ? '#e2826f' : '#c6ced8' }}>
                    {signed(st.carry1y_bps, 1)}
                  </td>
                  <td style={td}>{st.carry_vol_ratio == null ? '—' : signed(st.carry_vol_ratio, 2)}</td>
                  <td style={td}>{st.carry_ivol_ratio == null ? '—' : signed(st.carry_ivol_ratio, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: '#77828f', fontSize: 11, marginTop: 6 }}>
            The neutral structure's level in bp depends on the weights and has no meaning by itself; compare Z-scores and moves.
          </div>
        </Panel>

        <Panel
          title="Standard vs neutral · bp from 1y mean"
          sub="Each structure relative to its own mean over the estimation year (shaded)"
          right={
            <div style={{ display: 'flex', gap: 4 }}>
              {LOOKBACKS.map(([nDays, txt]) => (
                <button key={txt} onClick={() => setLookback(nDays)} style={{
                  background: lookback === nDays ? 'rgba(106,169,204,0.16)' : 'transparent',
                  border: `1px solid ${lookback === nDays ? 'rgba(106,169,204,0.35)' : 'rgba(200,220,240,0.09)'}`,
                  color: lookback === nDays ? '#e4eaf1' : '#9aa5b1',
                  borderRadius: 5, padding: '2px 8px', fontSize: 11, cursor: 'pointer',
                }}>{txt}</button>
              ))}
            </div>
          }
        >
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid {...chart.grid} />
              <XAxis dataKey="date" {...chart.axis} interval={ticks} tickFormatter={(d: string) => d.slice(0, 7)} />
              <YAxis width={44} {...chart.axis} tickFormatter={(v: number) => v.toFixed(0)} />
              <Tooltip {...chart.tooltip} formatter={(v: number, nm: string) => [`${signed(v, 1)} bp`, nm]} />
              <Legend wrapperStyle={{ fontSize: 10, color: fg[3] }} />
              {data.history.length > data.window_days && chartData.length > data.window_days && (
                <ReferenceArea x1={data.history[data.history.length - data.window_days].date} x2={data.as_of}
                  fill="rgba(200,220,240,0.04)" stroke="none" />
              )}
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.25)" />
              <Line dataKey="standard" name="Standard" stroke={STD_COLOR} strokeWidth={1.2} dot={false} isAnimationActive={false} />
              {n && <Line dataKey="neutral" name="Neutral" stroke={NEU_COLOR} strokeWidth={1.8} dot={false} isAnimationActive={false} />}
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Curve factors · loadings by tenor" sub="First three principal components of daily par swap changes, last year; share of variance in brackets">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid {...chart.grid} />
              <XAxis dataKey="tenor" type="number" domain={[1, 30]} ticks={[1, 2, 5, 10, 15, 20, 25, 30]}
                {...chart.axis} tickFormatter={(t: number) => `${t}y`} allowDuplicatedCategory={false} />
              <YAxis width={44} {...chart.axis} tickFormatter={(v: number) => v.toFixed(1)} />
              <Tooltip {...chart.tooltip} labelFormatter={(t: number) => `${t}y`} formatter={(v: number, nm: string) => [v.toFixed(3), nm]} />
              <Legend wrapperStyle={{ fontSize: 10, color: fg[3] }} />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.25)" />
              {data.factors.map((f, i) => (
                <Line key={f.name} data={f.loadings} dataKey="loading"
                  name={`${cap(f.name)} (${(f.variance_share * 100).toFixed(f.variance_share < 0.1 ? 1 : 0)}%)`}
                  stroke={palette[i % palette.length]} strokeWidth={1.4}
                  strokeDasharray={data.hedged.includes(f.name) ? undefined : '4 3'}
                  dot={{ r: 2 }} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      </div>
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
