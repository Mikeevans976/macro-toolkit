import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  ComposedChart, Area, Label,
} from 'recharts'
import Glyph from '../../components/Glyph'
import {
  type Series, ACCENT, AMBER, FG2, FG3, FG4, GREEN, MUTED, NUM, RED, REGIME_HELP, SPEED_COLORS,
  cardStyle, divergingFill, eyebrow, fmtChg, fmtCount, fmtLast, fmtSigned, fmtUsd, regimeStyle,
} from './format'

export interface SeriesRequest { ticker: string; kind: 'auto' | 'price' | 'level'; nonce: number }

const inputStyle: React.CSSProperties = {
  background: 'rgba(200,220,240,0.06)', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6,
  padding: '6px 10px', color: '#eef2f6', fontSize: 13, outline: 'none',
}
const labelStyle: React.CSSProperties = { fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em' }
const PCTILE_WINDOWS: [number, string][] = [[0, 'All'], [1, '1y'], [3, '3y'], [5, '5y'], [10, '10y']]

function ChartTooltip({ active, payload, label, dp = 2, suffix = '' }: {
  active?: boolean; payload?: { name: string; value: number | null; color: string }[]; label?: string; dp?: number; suffix?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6, padding: '8px 12px', fontSize: 12, fontFamily: NUM }}>
      <div style={{ color: FG2, marginBottom: 4 }}>{label}</div>
      {payload.filter(p => p.value != null && !p.name.startsWith('_')).map(p => (
        <div key={p.name} style={{ color: p.color || '#eef2f6' }}>{p.name}: {p.value!.toFixed(dp)}{suffix}</div>
      ))}
    </div>
  )
}

export default function SeriesView({ aumBn, request }: { aumBn: number; request: SeriesRequest | null }) {
  const [ticker, setTicker] = useState(request?.ticker ?? '')
  const [kind, setKind] = useState<'auto' | 'price' | 'level'>(request?.kind ?? 'auto')
  const [startYear, setStartYear] = useState(2015)
  const [pctileYears, setPctileYears] = useState(0)
  const [invert, setInvert] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<Series | null>(null)

  const years = Array.from({ length: new Date().getFullYear() - 1999 }, (_, i) => 2000 + i)

  async function fetchSeries(t = ticker, k = kind) {
    if (!t.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await axios.get('/api/tools/momentum/cta-signals', {
        params: { ticker: t.trim(), start: `${startYear}-01-01`, kind: k, aum_bn: aumBn, pctile_years: pctileYears },
      })
      if (!res.data?.current?.regime) throw new Error('Unexpected response: restart the backend to pick up the new Momentum API')
      setData(res.data)
      if (res.data.kind === 'price') setInvert(false)
    } catch (e: unknown) {
      setError(axios.isAxiosError(e) ? String(e.response?.data?.detail ?? e.message) : String(e))
    } finally {
      setLoading(false)
    }
  }

  // A row clicked in the monitor arrives as a new request
  useEffect(() => {
    if (!request) return
    setTicker(request.ticker)
    setKind(request.kind)
    fetchSeries(request.ticker, request.kind)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce])

  // Refetch when the settings that change the payload move
  useEffect(() => {
    if (data) fetchSeries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aumBn, pctileYears])

  const flip = invert ? -1 : 1
  const unit = data?.unit ?? 'price'

  const chartData = useMemo(() => {
    if (!data) return []
    return data.dates.map((d, i) => {
      const p = data.position[i]
      return {
        date: d,
        series: data.series[i],
        position: p == null ? null : p * flip,
        _above: p == null ? null : Math.max(0, p * flip),
        _below: p == null ? null : Math.min(0, p * flip),
        ...Object.fromEntries(data.speeds.map(s => [s, data.signals[s][i] == null ? null : data.signals[s][i]! * flip])),
      }
    })
  }, [data, flip])

  const cur = data?.current
  const regime = cur ? regimeStyle(cur.regime, cur.direction * flip) : null
  const xInterval = Math.max(1, Math.floor(chartData.length / 6))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Inputs */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>Bloomberg ticker or expression</label>
            <input value={ticker} onChange={e => setTicker(e.target.value)} onKeyDown={e => e.key === 'Enter' && fetchSeries()}
              placeholder="e.g. RX1 Comdty, USGG10YR Index - USGG2YR Index" style={{ ...inputStyle, width: 330 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>Series type</label>
            <select value={kind} onChange={e => setKind(e.target.value as typeof kind)} style={{ ...inputStyle, background: '#0b0f14' }}>
              <option value="auto">Auto</option>
              <option value="price">Price (returns)</option>
              <option value="level">Level (yield, spread)</option>
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>Chart from</label>
            <select value={startYear} onChange={e => setStartYear(Number(e.target.value))} style={{ ...inputStyle, background: '#0b0f14' }}>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>Percentile over</label>
            <select value={pctileYears} onChange={e => setPctileYears(Number(e.target.value))} style={{ ...inputStyle, background: '#0b0f14' }}>
              {PCTILE_WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {data?.kind === 'level' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: FG2, paddingBottom: 6 }}
              title="Flip signs so a positive position means long bonds (yields falling)">
              <input type="checkbox" checked={invert} onChange={e => setInvert(e.target.checked)} style={{ accentColor: ACCENT }} />
              Bond-equivalent (invert)
            </label>
          )}
          <button onClick={() => fetchSeries()} disabled={loading || !ticker.trim()} style={{
            background: loading || !ticker.trim() ? 'rgba(139,143,216,0.3)' : ACCENT, border: 'none', borderRadius: 6,
            padding: '7px 18px', color: '#f4f7fa', fontSize: 13, fontWeight: 600,
            cursor: loading || !ticker.trim() ? 'not-allowed' : 'pointer',
          }}>{loading ? 'Loading…' : 'Fetch'}</button>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: FG4 }}>
          Any series works. Generic futures (TY1 Comdty, ES1 Index) are fetched roll-adjusted; yields and spreads are
          treated as levels (bp changes). Combine tickers with + / − and weights, e.g. 2 * USGG5YR Index - USGG2YR Index - USGG10YR Index.
        </div>
      </div>

      {error && <div style={{ ...cardStyle, borderColor: 'rgba(217,112,94,0.3)', color: RED, fontSize: 13 }}>{error}</div>}

      {data && cur && regime && (
        <>
          {/* Current state */}
          <div style={cardStyle}>
            <div style={{ ...eyebrow, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <span>{data.label}{invert ? ' · bond-equivalent' : ''}</span>
              <span style={{ color: data.data_source === 'bloomberg' ? '#6fc2a2' : '#dfbb78', textTransform: 'none' }}>
                {data.data_source === 'bloomberg' ? 'Live' : 'Simulated'}
                {data.roll_adjusted === false ? ' · not roll-adjusted' : data.roll_adjusted ? ' · roll-adjusted' : ''}
              </span>
              <span style={{ marginLeft: 'auto', textTransform: 'none', fontFamily: NUM }}>as of {cur.date}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap', marginBottom: 16 }}>
              <span style={{ fontSize: 26, fontWeight: 600, color: regime.color }} title={REGIME_HELP[cur.regime]}>
                {regime.text}{cur.stretched ? ' · stretched' : ''}
              </span>
              <span style={{ fontFamily: NUM, fontSize: 20, color: cur.position * flip >= 0 ? GREEN : RED }}>
                {fmtSigned(cur.position * flip)}% <span style={{ fontSize: 12, color: MUTED }}>of max</span>
              </span>
              <span style={{ fontFamily: NUM, fontSize: 13, color: FG3 }}>
                1w ago {fmtSigned(cur.position_1w_ago == null ? null : cur.position_1w_ago * flip)}%
              </span>
              <span style={{ fontFamily: NUM, fontSize: 13, color: FG3 }}>
                {Math.round(invert ? 100 - cur.position_pctile : cur.position_pctile)}th pctile
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
              {data.speeds.map((s, i) => {
                const y = cur.signals[s] == null ? null : cur.signals[s]! * flip
                const phi = cur.responses[s] == null ? null : cur.responses[s]! * flip
                return (
                  <div key={s} style={{ background: divergingFill(y, 6), border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: SPEED_COLORS[i] }}>{s} · {(100 * data.model.speed_weights[s]).toFixed(0)}%</div>
                    <div style={{ fontFamily: NUM, fontSize: 17, color: '#eef2f6', marginTop: 4 }}>{fmtSigned(y, 2, 'σ')}</div>
                    <div style={{ fontFamily: NUM, fontSize: 11, color: FG3, marginTop: 2 }}>position {fmtSigned(phi == null ? null : 100 * phi)}%</div>
                  </div>
                )
              })}
              <div style={{ border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '10px 12px', fontFamily: NUM, fontSize: 12, color: FG3, lineHeight: 1.7 }}>
                <div>last {fmtLast(cur.series_value, unit)}</div>
                <div>1w {fmtChg(cur.chg_1w, unit)}</div>
                <div>vol {cur.vol_ann?.toFixed(1)}{unit === 'price' ? '%' : unit === 'pct' ? 'bp' : ''}</div>
                <div title="3-month efficiency ratio: net move / path length">ER {cur.er?.toFixed(2) ?? '—'}</div>
              </div>
            </div>
            {data.sizing && (
              <div style={{ marginTop: 14, fontSize: 12, color: FG3, lineHeight: 1.7 }}>
                Model CTA holding at ${data.model.aum_bn.toFixed(0)}bn AUM:{' '}
                <span style={{ fontFamily: NUM, color: FG2 }}>
                  {data.sizing.notional_usd != null ? `${fmtUsd(data.sizing.notional_usd * flip)} notional` : `${fmtUsd(data.sizing.dv01_usd! * flip)}/bp DV01`}
                  {data.sizing.contracts != null ? ` · ${fmtCount(data.sizing.contracts * flip)} contracts` : ''}
                </span>
                {data.sizing.basis === 'typical' && (
                  <span style={{ color: FG4 }}> (not in the model universe: sized with a typical market's risk budget)</span>
                )}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 20 }}>
            <TriggerCard data={data} unit={unit} />
            <ScenarioCard data={data} flip={flip} />
          </div>

          {/* Series */}
          <div style={cardStyle}>
            <div style={eyebrow}>{data.ticker}</div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart syncId="momentum" data={chartData} margin={{ top: 8, right: 80, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(200,220,240,0.04)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} interval={xInterval}
                  tickFormatter={(d: string) => d.slice(0, 7)} />
                <YAxis tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} width={56} domain={['auto', 'auto']}
                  tickFormatter={(v: number) => fmtLast(v, unit)} />
                <Tooltip content={<ChartTooltip dp={3} />} />
                <Line dataKey="series" name="Level" stroke={ACCENT} strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Position */}
          <div style={cardStyle}>
            <div style={eyebrow}>Model CTA position, % of max{invert ? ' · bond-equivalent' : ''}</div>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart syncId="momentum" data={chartData} margin={{ top: 8, right: 80, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(200,220,240,0.04)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} interval={xInterval}
                  tickFormatter={(d: string) => d.slice(0, 7)} />
                <YAxis tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} width={56} domain={[-100, 100]}
                  ticks={[-100, -50, 0, 50, 100]} />
                <Tooltip content={<ChartTooltip dp={0} suffix="%" />} />
                <Area dataKey="_above" fill={GREEN} fillOpacity={0.2} stroke="none" />
                <Area dataKey="_below" fill={RED} fillOpacity={0.2} stroke="none" />
                <Line dataKey="position" name="Position" stroke={ACCENT} strokeWidth={1.5} dot={false} />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Speeds */}
          <div style={cardStyle}>
            <div style={eyebrow}>Trend strength by speed (σ){invert ? ' · bond-equivalent' : ''}</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart syncId="momentum" data={chartData} margin={{ top: 8, right: 80, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(200,220,240,0.04)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} interval={xInterval}
                  tickFormatter={(d: string) => d.slice(0, 7)} />
                <YAxis tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => v.toFixed(1)} />
                <Tooltip content={<ChartTooltip dp={2} suffix="σ" />} />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" />
                {[1.5, -1.5].map(v => (
                  <ReferenceLine key={v} y={v} stroke={v > 0 ? GREEN : RED} strokeDasharray="3 3" strokeOpacity={0.4}>
                    <Label value={`${v > 0 ? '+' : '−'}1.5σ`} position="right" style={{ fontSize: 10, fill: v > 0 ? GREEN : RED, fillOpacity: 0.7 }} />
                  </ReferenceLine>
                ))}
                {data.speeds.map((s, i) => <Line key={s} dataKey={s} name={s} stroke={SPEED_COLORS[i]} strokeWidth={1.2} dot={false} />)}
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
              {data.speeds.map((s, i) => (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 20, height: 2, background: SPEED_COLORS[i] }} />
                  <span style={{ fontSize: 11, color: FG3 }}>{s} days</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {!data && !loading && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '30vh', gap: 12 }}>
          <div style={{ color: FG4 }}><Glyph name="trend" size={32} /></div>
          <div style={{ color: FG4, fontSize: 14 }}>Enter any Bloomberg ticker or expression, or click a row in the monitor.</div>
        </div>
      )}
    </div>
  )
}

function TriggerCard({ data, unit }: { data: Series; unit: string }) {
  const t = data.triggers
  const cell = (price: number | null | undefined, sigma: number | null | undefined) =>
    price == null ? <span style={{ color: FG4 }}>beyond 10σ</span> : (
      <>
        <span style={{ color: FG2 }}>{fmtLast(price, unit)}</span>
        <span style={{ color: Math.abs(sigma!) < 1.5 ? AMBER : FG4, marginLeft: 8 }}>{fmtSigned(sigma, 1, 'σ')}</span>
      </>
    )
  return (
    <div style={cardStyle}>
      <div style={eyebrow}>Trigger levels (next close)</div>
      <table style={{ width: '100%', fontSize: 12.5, fontFamily: NUM, borderCollapse: 'collapse' }}>
        <tbody>
          <tr>
            <td style={{ padding: '5px 0', color: '#eef2f6', fontFamily: "'Geist', sans-serif" }}>Composite flips sign</td>
            <td style={{ textAlign: 'right' }}>{cell(t.composite?.price, t.composite?.sigma)}</td>
          </tr>
          {t.speeds.map((s, i) => (
            <tr key={s.speed}>
              <td style={{ padding: '5px 0', color: SPEED_COLORS[i], fontFamily: "'Geist', sans-serif" }}>{s.speed} crossover</td>
              <td style={{ textAlign: 'right' }}>{cell(s.price, s.sigma)}</td>
            </tr>
          ))}
          <tr>
            <td style={{ padding: '5px 0', color: FG3, fontFamily: "'Geist', sans-serif" }}>If the price stays flat, flips in</td>
            <td style={{ textAlign: 'right', color: FG2 }}>{t.flat_days_to_flip == null ? '> 60 days' : `${t.flat_days_to_flip} days`}</td>
          </tr>
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: FG4, marginTop: 10 }}>
        Level the series must close at tomorrow for each signal to cross zero; σ is today's daily vol. Within 1.5σ in amber.
      </div>
    </div>
  )
}

function ScenarioCard({ data, flip }: { data: Series; flip: number }) {
  const shocks = [...new Set(data.scenarios.map(s => s.shock_sigma))]
  const horizons = [...new Set(data.scenarios.map(s => s.horizon_days))]
  const usdLabel = data.sizing?.notional_usd != null ? 'notional' : 'DV01/bp'
  return (
    <div style={cardStyle}>
      <div style={eyebrow}>Flow scenarios: position change</div>
      <table style={{ width: '100%', fontSize: 12, fontFamily: NUM, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', color: MUTED, fontWeight: 500, fontSize: 10.5, padding: '4px 0' }}>Move</th>
            {shocks.map(k => <th key={k} style={{ textAlign: 'right', color: MUTED, fontWeight: 500, fontSize: 10.5 }}>{fmtSigned(k, 0, 'σ')}</th>)}
          </tr>
        </thead>
        <tbody>
          {horizons.map(h => (
            <tr key={h}>
              <td style={{ color: FG2, padding: '6px 0', fontFamily: "'Geist', sans-serif" }}>{h === 5 ? '1 week' : h === 10 ? '2 weeks' : `${h}d`}</td>
              {shocks.map(k => {
                const s = data.scenarios.find(x => x.horizon_days === h && x.shock_sigma === k)!
                return (
                  <td key={k} style={{ textAlign: 'right', padding: '4px 4px', background: divergingFill(s.delta * flip, 60) }}>
                    <div style={{ color: '#eef2f6' }}>{fmtSigned(s.delta * flip)}</div>
                    {s.delta_usd != null && <div style={{ color: FG3, fontSize: 10.5 }}>{fmtUsd(s.delta_usd * flip)}</div>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: FG4, marginTop: 10 }}>
        Change in % of max position{data.sizing ? ` (and ${usdLabel})` : ''} if the series moves in a straight line by the given
        number of σ over the horizon (σ scaled by √days; moves in the series' own terms).
      </div>
    </div>
  )
}
