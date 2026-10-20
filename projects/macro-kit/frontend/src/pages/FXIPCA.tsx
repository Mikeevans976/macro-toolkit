import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import PageTitle, { headerBar } from '../components/PageTitle'
import { chart, series as palette } from '../theme'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Characteristic { id: string; label: string; description: string }

interface SelectionRow {
  k: number
  total_r2: number | null
  pred_r2: number | null
  total_r2_alpha: number | null
  pred_r2_alpha: number | null
}

interface PerfStats { mean_ann: number | null; vol_ann: number | null; sharpe: number | null; max_dd: number | null }

interface FactorStat extends PerfStats {
  name: string
  label: string
  corr_dollar: number | null
  corr_carry: number | null
}

interface CrossRow {
  code: string
  name: string
  bloc: string
  raw: Record<string, number | null>
  rank: Record<string, number | null>
  betas: (number | null)[]
  exp_ret_ann: number | null
  alpha_ann: number | null
  resid_last: number | null
  resid_z_3m: number | null
  ts_r2: number | null
  n_months: number
}

interface Strategy extends PerfStats { id: string; label: string }

interface Oos {
  available: boolean
  start?: string
  refit_every_months?: number
  min_train_months?: number
  pred_r2?: number | null
  pred_r2_alpha?: number | null
  strategies?: Strategy[]
  series?: Record<string, number | string | null>[]
}

interface IpcaResponse {
  data_source: string
  missing_series: string[]
  partial_month: boolean
  as_of: string
  start: string
  end: string
  n_months: number
  n_currencies: number
  n_obs: number
  k: number
  k_max: number
  converged: boolean
  characteristics: Characteristic[]
  model_selection: SelectionRow[]
  gamma_beta: (number | null)[][]
  gamma_alpha: (number | null)[]
  alpha_test: { wald: number; pvalue: number; n_boot: number } | null
  factors: { names: string[]; stats: FactorStat[]; lambda: (number | null)[]; series: Record<string, number | string | null>[] }
  cross_section: CrossRow[]
  oos: Oos
}

interface DetailResponse {
  code: string
  k: number
  series: Record<string, number | string | null>[]
}

// ─── Formatting / styles ──────────────────────────────────────────────────────

const MONO = "'Geist Mono', ui-monospace, monospace"
const POS = '#6fc2a2'
const NEG = '#e2826f'
const STRATEGY_COLORS: Record<string, string> = {
  ipca: '#86c0de', ipca_alpha: '#b79fdb', carry: '#d6ad66', dollar: '#77828f',
}

const pct = (x: number | null | undefined, dp = 1) => (x == null ? '–' : `${(x * 100).toFixed(dp)}%`)
const num = (x: number | null | undefined, dp = 2) => (x == null ? '–' : x.toFixed(dp))

const cardStyle: React.CSSProperties = {
  background: 'rgba(200,220,240,0.03)',
  border: '1px solid rgba(200,220,240,0.07)',
  borderRadius: 6,
  padding: '18px 22px',
  marginBottom: 20,
}
const th: React.CSSProperties = {
  textAlign: 'right', padding: '6px 10px', fontSize: 10, fontWeight: 500, color: '#9aa5b1',
  borderBottom: '1px solid rgba(150,178,205,0.12)', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em',
}
const td: React.CSSProperties = {
  textAlign: 'right', padding: '5px 10px', fontSize: 12, fontFamily: MONO, color: '#c6ced8',
  borderBottom: '1px solid rgba(150,178,205,0.05)', whiteSpace: 'nowrap',
}
const tdLeft: React.CSSProperties = { ...td, textAlign: 'left', fontFamily: 'inherit' }

function signed(x: number | null | undefined, scale: number): React.CSSProperties {
  if (x == null) return {}
  const a = Math.min(1, Math.abs(x) / scale)
  const c = x >= 0 ? POS : NEG
  return { background: `${c}${Math.round(a * 0x55).toString(16).padStart(2, '0')}`, color: a > 0.15 ? '#eef2f6' : '#c6ced8' }
}

function SectionTitle({ title, note }: { title: string; note?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="hub-eyebrow" style={{ fontSize: 10 }}>{title}</div>
      {note && <div style={{ fontSize: 11, color: '#9aa5b1', marginTop: 4, lineHeight: 1.5 }}>{note}</div>}
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ ...cardStyle, marginBottom: 0, padding: '14px 18px' }}>
      <div className="hub-eyebrow" style={{ fontSize: 9 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 22, color: '#eef2f6', marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9aa5b1', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type SortKey = 'code' | 'carry' | 'mom_3m' | 'mom_12m' | 'value' | 'ivol' | 'skew' | 'exp' | 'alpha' | 'resid' | 'r2' | `beta${number}`

export default function FXIPCA() {
  const navigate = useNavigate()
  const [k, setK] = useState(2)
  const [data, setData] = useState<IpcaResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'exp', desc: true })
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailResponse | null>(null)

  useEffect(() => {
    const token = localStorage.getItem('access_token')
    if (!token) { navigate('/login', { replace: true }); return }
    setLoading(true)
    axios.get<IpcaResponse>('/api/tools/fx-ipca', {
      headers: { Authorization: `Bearer ${token}` },
      params: { k, refresh: refreshKey > 0 },
    })
      .then(res => {
        if (!res.data || !Array.isArray(res.data.model_selection)) throw new Error('Unexpected response from /api/tools/fx-ipca')
        setData(res.data); setError(null)
      })
      .catch(err => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token'); navigate('/login', { replace: true }); return
        }
        setError(err.response?.data?.detail ?? err.message)
      })
      .finally(() => setLoading(false))
  }, [k, refreshKey, navigate])

  useEffect(() => {
    if (!selected || !data) { setDetail(null); return }
    const token = localStorage.getItem('access_token')
    if (!token) return
    let cancelled = false
    setDetail(null)
    axios.get<DetailResponse>(`/api/tools/fx-ipca/currency/${selected}`, {
      headers: { Authorization: `Bearer ${token}` }, params: { k: data.k },
    })
      .then(res => { if (!cancelled && Array.isArray(res.data?.series)) setDetail(res.data) })
      .catch(() => { /* detail is optional */ })
    return () => { cancelled = true }
  }, [selected, data])

  const sortedRows = useMemo(() => {
    if (!data) return []
    const val = (r: CrossRow): number | string => {
      const { key } = sort
      if (key === 'code') return r.code
      if (key === 'exp') return r.exp_ret_ann ?? -Infinity
      if (key === 'alpha') return r.alpha_ann ?? -Infinity
      if (key === 'resid') return r.resid_z_3m ?? -Infinity
      if (key === 'r2') return r.ts_r2 ?? -Infinity
      if (key.startsWith('beta')) return r.betas[Number(key.slice(4))] ?? -Infinity
      return r.raw[key] ?? -Infinity
    }
    return [...data.cross_section].sort((a, b) => {
      const va = val(a), vb = val(b)
      const c = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number)
      return sort.desc ? -c : c
    })
  }, [data, sort])

  const clickSort = (key: SortKey) => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'code' }))
  const sortHead = (key: SortKey, label: string, title?: string, left = false) => (
    <th style={{ ...th, cursor: 'pointer', textAlign: left ? 'left' : 'right', color: sort.key === key ? '#e4eaf1' : th.color }}
      title={title} onClick={() => clickSort(key)}>
      {label}{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </th>
  )

  const sel = data?.model_selection.find(r => r.k === data.k)
  const ipcaStrat = data?.oos.strategies?.find(s => s.id === 'ipca')
  const carryStrat = data?.oos.strategies?.find(s => s.id === 'carry')
  const live = data?.data_source === 'bloomberg'
  const maxGamma = data ? Math.max(0.05, ...data.gamma_beta.flat().map(v => Math.abs(v ?? 0))) : 1

  return (
    <div style={{ minHeight: '100vh', background: '#07090c', color: '#e4eaf1', paddingBottom: 80 }}>
      <div style={{ ...headerBar, padding: '12px 32px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <PageTitle category="Market Structure & Analysis" categoryId="market-structure" title="FX IPCA"
          subtitle={data
            ? `${data.n_currencies} currencies vs USD · monthly 1M excess returns · ${data.start} – ${data.end}`
            : 'Instrumented principal components on currency excess returns'} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#9aa5b1', marginRight: 4 }}>Factors</span>
          {[1, 2, 3, 4].map(n => (
            <button key={n} onClick={() => { setK(n); setSelected(null) }} disabled={loading}
              style={{
                fontFamily: MONO, fontSize: 12, width: 28, padding: '3px 0', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${k === n ? 'rgba(134,192,222,0.5)' : 'rgba(200,220,240,0.12)'}`,
                background: k === n ? 'rgba(134,192,222,0.15)' : 'rgba(200,220,240,0.04)',
                color: k === n ? '#a9d2e8' : '#9aa5b1',
              }}>{n}</button>
          ))}
        </div>
        <button onClick={() => setRefreshKey(x => x + 1)} disabled={loading} title="Re-pull data and refit (results are cached for 6 h)"
          style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1,
            border: '1px solid rgba(200,220,240,0.15)', background: 'rgba(200,220,240,0.05)', color: '#9aa5b1',
          }}>↻ Refresh</button>
        {data && (
          <span title={data.missing_series.length ? `No live data (dropped): ${data.missing_series.join(', ')}` : undefined}
            style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 6,
              background: live ? 'rgba(88,173,142,0.15)' : 'rgba(214,173,102,0.15)',
              color: live ? '#6fc2a2' : '#dfbb78',
              border: `1px solid ${live ? 'rgba(88,173,142,0.3)' : 'rgba(214,173,102,0.3)'}`,
            }}>
            {live ? 'Live · Bloomberg' : 'Simulated data'}
            {data.missing_series.length ? ` · ${data.missing_series.length} missing` : ''}
          </span>
        )}
      </div>

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '28px 32px 0' }}>
        {loading && <div style={{ textAlign: 'center', padding: 80, color: '#8995a2' }}>Fitting IPCA…</div>}
        {error && (
          <div style={{ color: '#e2826f', padding: 24, background: 'rgba(217,112,94,0.08)',
            border: '1px solid rgba(217,112,94,0.2)', borderRadius: 6 }}>Error: {error}</div>
        )}

        {data && !loading && (
          <>
            {/* Headline tiles */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 20 }}>
              <Tile label={`Total R² · K=${data.k}`} value={pct(sel?.total_r2)} sub={`${data.n_obs.toLocaleString()} currency-months`} />
              <Tile label="Predictive R² (in sample)" value={pct(sel?.pred_r2, 2)} sub={`with alpha ${pct(sel?.pred_r2_alpha, 2)}`} />
              <Tile label="Alpha test  Γα = 0" value={data.alpha_test ? `p = ${data.alpha_test.pvalue.toFixed(3)}` : '–'}
                sub={data.alpha_test ? `bootstrap, ${data.alpha_test.n_boot} draws · ${data.alpha_test.pvalue < 0.05 ? 'characteristics carry alpha' : 'betas explain returns'}` : undefined} />
              <Tile label="Out-of-sample predictive R²" value={data.oos.available ? pct(data.oos.pred_r2, 2) : '–'}
                sub={data.oos.available ? `from ${data.oos.start}, refit every ${data.oos.refit_every_months}m` : 'not enough history'} />
              <Tile label="OOS long-short Sharpe" value={num(ipcaStrat?.sharpe)} sub={`carry ranks ${num(carryStrat?.sharpe)}`} />
            </div>

            {/* Model selection + Gamma */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 7fr)', gap: 20 }}>
              <div style={cardStyle}>
                <SectionTitle title="Model selection"
                  note="Pooled R² across currency-months. Total uses realised factors; predictive uses factor means, i.e. how well characteristics explain expected returns." />
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: 'left' }}>K</th>
                      <th style={th}>Total R²</th><th style={th}>Pred R²</th>
                      <th style={th} title="Unrestricted model with Γα">Total R² (α)</th>
                      <th style={th} title="Unrestricted model with Γα">Pred R² (α)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.model_selection.map(r => (
                      <tr key={r.k} onClick={() => { setK(r.k); setSelected(null) }}
                        style={{ cursor: 'pointer', background: r.k === data.k ? 'rgba(134,192,222,0.08)' : undefined }}>
                        <td style={{ ...tdLeft, fontFamily: MONO, color: r.k === data.k ? '#a9d2e8' : '#c6ced8' }}>{r.k}</td>
                        <td style={td}>{pct(r.total_r2)}</td><td style={td}>{pct(r.pred_r2, 2)}</td>
                        <td style={td}>{pct(r.total_r2_alpha)}</td><td style={td}>{pct(r.pred_r2_alpha, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.converged && <div style={{ fontSize: 11, color: '#d6ad66', marginTop: 10 }}>ALS hit the iteration cap before converging.</div>}
              </div>

              <div style={cardStyle}>
                <SectionTitle title="Γβ: how characteristics map into factor betas"
                  note="β(i,t) = z(i,t)′ Γβ with ranked characteristics in [−0.5, 0.5]. Γα is the unrestricted model's alpha loading, in bp per month for a one-unit rank spread." />
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: 'left' }}>Characteristic</th>
                      {data.factors.names.map((n, j) => (
                        <th key={n} style={th}>{n}<div style={{ fontSize: 9, color: '#77828f', textTransform: 'none' }}>{data.factors.stats[j]?.label}</div></th>
                      ))}
                      <th style={th}>Γα (bp/m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.characteristics.map((c, i) => (
                      <tr key={c.id}>
                        <td style={tdLeft} title={c.description}>{c.label}</td>
                        {data.gamma_beta[i].map((v, j) => (
                          <td key={j} style={{ ...td, ...signed(v, maxGamma) }}>{num(v, 3)}</td>
                        ))}
                        <td style={{ ...td, ...signed(data.gamma_alpha[i], 0.003) }}>
                          {data.gamma_alpha[i] == null ? '–' : (data.gamma_alpha[i]! * 1e4).toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Factors */}
            <div style={cardStyle}>
              <SectionTitle title="Latent factor returns"
                note="Cumulative monthly factor returns against the equal-weight dollar factor and the top-minus-bottom-third carry factor. IPCA factors are identified only up to rotation; the labels come from their correlations." />
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 8fr) minmax(0, 5fr)', gap: 20, alignItems: 'start' }}>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={data.factors.series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid {...chart.grid} />
                    <XAxis dataKey="date" {...chart.axis} minTickGap={60} tickFormatter={d => String(d).slice(0, 7)} />
                    <YAxis {...chart.axis} width={48} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip {...chart.tooltip} formatter={(v: number) => pct(v)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {data.factors.names.map((n, j) => (
                      <Line key={n} dataKey={n} stroke={palette[j % palette.length]} dot={false} strokeWidth={1.6} isAnimationActive={false} />
                    ))}
                    <Line dataKey="dollar" name="Dollar" stroke="#77828f" strokeDasharray="4 3" dot={false} strokeWidth={1.2} isAnimationActive={false} />
                    <Line dataKey="carry" name="Carry HML" stroke="#9aa5b1" strokeDasharray="1 3" dot={false} strokeWidth={1.4} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: 'left' }}>Factor</th><th style={th}>Mean</th><th style={th}>Vol</th>
                      <th style={th}>Sharpe</th><th style={th}>ρ dollar</th><th style={th}>ρ carry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.factors.stats.map((s, j) => (
                      <tr key={s.name}>
                        <td style={tdLeft}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: palette[j % palette.length], marginRight: 7 }} />{s.name}</td>
                        <td style={td}>{pct(s.mean_ann)}</td><td style={td}>{pct(s.vol_ann)}</td><td style={td}>{num(s.sharpe)}</td>
                        <td style={{ ...td, ...signed(s.corr_dollar, 1) }}>{num(s.corr_dollar)}</td>
                        <td style={{ ...td, ...signed(s.corr_carry, 1) }}>{num(s.corr_carry)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Cross-section */}
            <div style={cardStyle}>
              <SectionTitle title={`Current cross-section · ${data.as_of}${data.partial_month ? ' (month to date)' : ''}`}
                note="Raw characteristics, conditional betas z′Γβ, model expected excess return z′Γβλ (annualised), the unrestricted alpha, and the last 3 months' residual as a z-score. Click a currency for its history." />
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {sortHead('code', 'Ccy', undefined, true)}
                      {sortHead('carry', 'Carry', 'Annualised forward discount vs USD')}
                      {sortHead('mom_3m', 'Mom 3M')}
                      {sortHead('mom_12m', 'Mom 12-1')}
                      {sortHead('value', 'Value', 'Minus the 5y excess return (skipping the last year)')}
                      {sortHead('ivol', 'Impl vol')}
                      {sortHead('skew', 'RR 25Δ', 'Positive = currency calls bid')}
                      {data.factors.names.map((n, j) => sortHead(`beta${j}`, `β ${n}`))}
                      {sortHead('exp', 'E[r] ann')}
                      {sortHead('alpha', 'α ann')}
                      {sortHead('resid', 'Resid z 3M')}
                      {sortHead('r2', 'TS R²', 'Share of the currency\'s return variance the model explains')}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map(r => (
                      <tr key={r.code} onClick={() => setSelected(s => (s === r.code ? null : r.code))}
                        style={{ cursor: 'pointer', background: selected === r.code ? 'rgba(134,192,222,0.08)' : undefined }}>
                        <td style={tdLeft}>
                          <span style={{ fontFamily: MONO, color: '#eef2f6' }}>{r.code}</span>
                          <span style={{ fontSize: 10, color: '#77828f', marginLeft: 8 }}>{r.bloc}</span>
                        </td>
                        <td style={td}>{pct(r.raw.carry)}</td>
                        <td style={td}>{pct(r.raw.mom_3m)}</td>
                        <td style={td}>{pct(r.raw.mom_12m)}</td>
                        <td style={td}>{pct(r.raw.value)}</td>
                        <td style={td}>{pct(r.raw.ivol)}</td>
                        <td style={td}>{r.raw.skew == null ? '–' : (r.raw.skew * 100).toFixed(2)}</td>
                        {r.betas.map((b, j) => <td key={j} style={td}>{num(b)}</td>)}
                        <td style={{ ...td, ...signed(r.exp_ret_ann, 0.08) }}>{pct(r.exp_ret_ann)}</td>
                        <td style={{ ...td, ...signed(r.alpha_ann, 0.04) }}>{pct(r.alpha_ann)}</td>
                        <td style={{ ...td, ...signed(r.resid_z_3m, 3) }}>{num(r.resid_z_3m)}</td>
                        <td style={td}>{pct(r.ts_r2, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selected && (
                <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(150,178,205,0.09)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                    <span style={{ fontFamily: MONO, fontSize: 14, color: '#eef2f6' }}>{selected}</span>
                    <span style={{ fontSize: 11, color: '#9aa5b1' }}>{data.cross_section.find(r => r.code === selected)?.name}</span>
                    <button onClick={() => setSelected(null)} style={{ marginLeft: 'auto', fontSize: 11, background: 'none', border: 'none', color: '#9aa5b1', cursor: 'pointer' }}>Close</button>
                  </div>
                  {!detail && <div style={{ fontSize: 12, color: '#8995a2', padding: 20 }}>Loading…</div>}
                  {detail && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                      <div>
                        <div className="hub-eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>Conditional betas</div>
                        <ResponsiveContainer width="100%" height={220}>
                          <LineChart data={detail.series} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                            <CartesianGrid {...chart.grid} />
                            <XAxis dataKey="date" {...chart.axis} minTickGap={60} tickFormatter={d => String(d).slice(0, 7)} />
                            <YAxis {...chart.axis} width={40} />
                            <Tooltip {...chart.tooltip} formatter={(v: number) => num(v)} />
                            <ReferenceLine y={0} stroke="rgba(150,178,205,0.2)" />
                            {data.factors.names.map((n, j) => (
                              <Line key={n} dataKey={`beta_${n}`} name={`β ${n}`} stroke={palette[j % palette.length]} dot={false} strokeWidth={1.5} isAnimationActive={false} />
                            ))}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                      <div>
                        <div className="hub-eyebrow" style={{ fontSize: 9, marginBottom: 6 }}>Monthly excess return: realised vs factor-fitted</div>
                        <ResponsiveContainer width="100%" height={220}>
                          <LineChart data={detail.series.slice(-60)} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                            <CartesianGrid {...chart.grid} />
                            <XAxis dataKey="date" {...chart.axis} minTickGap={50} tickFormatter={d => String(d).slice(0, 7)} />
                            <YAxis {...chart.axis} width={44} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                            <Tooltip {...chart.tooltip} formatter={(v: number) => pct(v, 2)} />
                            <ReferenceLine y={0} stroke="rgba(150,178,205,0.2)" />
                            <Line dataKey="ret" name="Realised" stroke="#e4eaf1" dot={false} strokeWidth={1.3} isAnimationActive={false} />
                            <Line dataKey="fitted" name="Fitted" stroke="#86c0de" dot={false} strokeWidth={1.3} strokeDasharray="4 2" isAnimationActive={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Out of sample */}
            {data.oos.available && data.oos.series && data.oos.strategies && (
              <div style={cardStyle}>
                <SectionTitle title="Out-of-sample backtest"
                  note={`Expanding window: Γ refit every ${data.oos.refit_every_months} months on data before each month, after ${data.oos.min_train_months} months of training. Long-short portfolios rank currencies by forecast (+1 gross long, −1 gross short), before costs. OOS predictive R²: ${pct(data.oos.pred_r2, 2)} restricted, ${pct(data.oos.pred_r2_alpha, 2)} with alpha.`} />
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 8fr) minmax(0, 5fr)', gap: 20, alignItems: 'start' }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={data.oos.series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                      <CartesianGrid {...chart.grid} />
                      <XAxis dataKey="date" {...chart.axis} minTickGap={60} tickFormatter={d => String(d).slice(0, 7)} />
                      <YAxis {...chart.axis} width={48} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                      <Tooltip {...chart.tooltip} formatter={(v: number) => pct(v)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {data.oos.strategies.map(s => (
                        <Line key={s.id} dataKey={s.id} name={s.label} stroke={STRATEGY_COLORS[s.id] ?? '#9aa5b1'}
                          strokeDasharray={s.id === 'dollar' ? '4 3' : undefined} dot={false} strokeWidth={1.5} isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, textAlign: 'left' }}>Strategy</th><th style={th}>Return</th><th style={th}>Vol</th>
                        <th style={th}>Sharpe</th><th style={th}>Max DD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.oos.strategies.map(s => (
                        <tr key={s.id}>
                          <td style={tdLeft}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: STRATEGY_COLORS[s.id] ?? '#9aa5b1', marginRight: 7 }} />{s.label}</td>
                          <td style={td}>{pct(s.mean_ann)}</td><td style={td}>{pct(s.vol_ann)}</td>
                          <td style={td}>{num(s.sharpe)}</td><td style={td}>{pct(s.max_dd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div style={{ fontSize: 11, color: '#77828f', lineHeight: 1.6, maxWidth: 900 }}>
              Kelly, Pruitt and Su (2019), <i>Characteristics are covariances</i>. Excess return = log(spot at t+1) − log(1M forward at t), long the currency against USD.
              Characteristics are ranked across live currencies each month, with missing values at the median. Estimation starts once every characteristic is observed.
              The alpha test bootstraps managed-portfolio residuals under Γα = 0.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
