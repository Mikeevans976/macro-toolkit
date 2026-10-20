import { Fragment, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  type Monitor, type MonitorRow, ACCENT, AMBER, FG2, FG3, FG4, GREEN, MUTED, NUM, RED,
  REGIME_HELP, SPEED_COLORS, cardStyle, divergingFill, eyebrow, fmtChg, fmtCount, fmtLast,
  fmtSigned, fmtUsd, regimeStyle,
} from './format'

type SortKey = 'group' | 'position' | 'position_chg_1w' | 'flip_sigma' | 'flow_flat_1w' | 'chg_1w'

const th: React.CSSProperties = {
  textAlign: 'right', fontWeight: 500, color: MUTED, fontSize: 10.5, padding: '6px 8px',
  textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap',
  borderBottom: '1px solid rgba(200,220,240,0.09)', position: 'sticky', top: 37, background: '#090c10', zIndex: 2,
}
const td: React.CSSProperties = {
  textAlign: 'right', padding: '5px 8px', fontFamily: NUM, fontSize: 12, whiteSpace: 'nowrap',
  borderBottom: '1px solid rgba(200,220,240,0.04)',
}

function PositionBar({ v }: { v: number }) {
  const w = Math.min(100, Math.abs(v)) / 2
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
      <div style={{ position: 'relative', width: 90, height: 8, background: 'rgba(200,220,240,0.05)', borderRadius: 2 }}>
        <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'rgba(200,220,240,0.25)' }} />
        <div style={{
          position: 'absolute', top: 0, bottom: 0, borderRadius: 2,
          left: v >= 0 ? '50%' : `${50 - w}%`, width: `${w}%`, background: v >= 0 ? GREEN : RED, opacity: 0.8,
        }} />
      </div>
      <span style={{ width: 38, color: v >= 0 ? GREEN : RED }}>{fmtSigned(v)}</span>
    </div>
  )
}

function Spark({ data }: { data: (number | null)[] }) {
  const pts = data.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null)
  if (pts.length < 2) return null
  const W = 64, H = 18
  const x = (i: number) => (i / (data.length - 1)) * W
  const y = (v: number) => H / 2 - (v / 100) * (H / 2)
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const last = pts[pts.length - 1][1]
  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="rgba(200,220,240,0.15)" />
      <path d={d} fill="none" stroke={last >= 0 ? GREEN : RED} strokeWidth={1.2} />
    </svg>
  )
}

function RegimeChip({ row }: { row: Pick<MonitorRow, 'regime' | 'direction' | 'stretched'> }) {
  const { color, text } = regimeStyle(row.regime, row.direction)
  return (
    <span title={REGIME_HELP[row.regime] + (row.stretched ? ' Stretched: average signal beyond 2σ.' : '')}
      style={{
        display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontSize: 11, fontFamily: "'Geist', sans-serif",
        color, border: `1px solid ${color}55`, background: `${color}14`,
      }}>
      {text}{row.stretched ? ' · stretched' : ''}
    </span>
  )
}

export default function MonitorView({ aumBn, onOpen }: { aumBn: number; onOpen: (row: MonitorRow) => void }) {
  const [data, setData] = useState<Monitor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [group, setGroup] = useState<string>('All')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'group', desc: false })

  async function load(refresh = false) {
    setLoading(true)
    setError(null)
    try {
      const res = await axios.get('/api/tools/momentum/monitor', { params: { aum_bn: aumBn, refresh } })
      if (!Array.isArray(res.data?.rows)) throw new Error('Unexpected response: restart the backend to pick up the new Momentum API')
      setData(res.data)
    } catch (e: unknown) {
      setError(axios.isAxiosError(e) ? String(e.response?.data?.detail ?? e.message) : String(e))
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [aumBn])

  const rows = useMemo(() => {
    if (!data) return []
    const r = data.rows.filter(x => group === 'All' || x.group === group)
    const key = sort.key
    if (key === 'group') return r
    // flip distance: nearest first; everything else by signed value
    return [...r].sort((a, b) => {
      const va = a[key], vb = b[key]
      if (va == null) return 1
      if (vb == null) return -1
      if (key === 'flip_sigma') return Math.abs(va) - Math.abs(vb)
      return sort.desc ? vb - va : va - vb
    })
  }, [data, group, sort])

  const headers: [string, SortKey | null, string][] = [
    ['Market', null, 'left'], ['Last', null, 'right'], ['1w', 'chg_1w', 'right'], ['Regime', null, 'left'],
    ['Speeds (σ)', null, 'center'], ['CTA position', 'position', 'right'], ['Δ1w', 'position_chg_1w', 'right'],
    ['6m', null, 'center'], ['Flip at', 'flip_sigma', 'right'], ['Flat 1w flow', 'flow_flat_1w', 'right'],
    ['Notional', null, 'right'], ['Flow / ADV', null, 'right'],
  ]

  const renderRow = (r: MonitorRow) => (
    <tr key={r.id} onClick={() => onOpen(r)} style={{ cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(200,220,240,0.03)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <td style={{ ...td, textAlign: 'left', fontFamily: "'Geist', sans-serif" }}>
        <div style={{ color: '#eef2f6', fontSize: 12.5 }}>{r.label}</div>
        <div style={{ color: FG4, fontSize: 10.5, fontFamily: NUM }}>{r.ticker}</div>
      </td>
      <td style={{ ...td, color: FG2 }}>{fmtLast(r.last, r.unit)}</td>
      <td style={{ ...td, color: (r.chg_1w ?? 0) >= 0 ? '#9dd6bd' : '#ecaa9c' }}>{fmtChg(r.chg_1w, r.unit)}</td>
      <td style={{ ...td, textAlign: 'left' }}><RegimeChip row={r} /></td>
      <td style={{ ...td, textAlign: 'center' }}>
        <div style={{ display: 'inline-flex', gap: 2 }}>
          {data!.speeds.map(s => (
            <div key={s} title={`${s}: ${fmtSigned(r.signals[s], 2, 'σ')}`} style={{
              width: 22, height: 16, borderRadius: 2, background: divergingFill(r.signals[s], 2.5),
              fontSize: 9, lineHeight: '16px', textAlign: 'center', color: '#eef2f6',
            }}>{r.signals[s] == null ? '' : Math.abs(r.signals[s]!) >= 0.95 ? r.signals[s]!.toFixed(0) : ''}</div>
          ))}
        </div>
      </td>
      <td style={td}><PositionBar v={r.position} /></td>
      <td style={{ ...td, color: (r.position_chg_1w ?? 0) >= 0 ? '#9dd6bd' : '#ecaa9c' }}>{fmtSigned(r.position_chg_1w)}</td>
      <td style={{ ...td, textAlign: 'center' }}><Spark data={r.spark} /></td>
      <td style={td} title="Next close that flips the composite position, and that move in daily σ">
        {r.flip_price == null
          ? <span style={{ color: FG4 }}>&gt;10σ</span>
          : <><span style={{ color: FG2 }}>{fmtLast(r.flip_price, r.unit)}</span>
            <span style={{ color: Math.abs(r.flip_sigma!) < 1.5 ? AMBER : FG4, marginLeft: 6 }}>{fmtSigned(r.flip_sigma, 1, 'σ')}</span></>}
      </td>
      <td style={td} title="Change in position over 1 week if the price does not move">
        <span style={{ color: r.flow_flat_1w >= 0 ? '#9dd6bd' : '#ecaa9c' }}>{fmtSigned(r.flow_flat_1w)}</span>
        {r.cta && <span style={{ color: FG3, marginLeft: 6 }}>{fmtUsd(r.flow_flat_1w_usd)}</span>}
      </td>
      <td style={{ ...td, color: FG3 }}>{r.cta ? fmtUsd(r.notional_usd) : ''}</td>
      <td style={{ ...td, color: (r.flow_adv_pct ?? 0) > 10 ? AMBER : FG3 }}
        title={r.flow_flat_1w_contracts != null ? `${fmtCount(r.flow_flat_1w_contracts)} contracts` : undefined}>
        {r.flow_adv_pct == null ? '' : `${r.flow_adv_pct.toFixed(0)}%`}
      </td>
    </tr>
  )

  const live = data?.data_source === 'bloomberg'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {data && (
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 4,
            background: live ? 'rgba(88,173,142,0.15)' : 'rgba(214,173,102,0.15)',
            color: live ? '#6fc2a2' : '#dfbb78',
            border: `1px solid ${live ? 'rgba(88,173,142,0.3)' : 'rgba(214,173,102,0.3)'}`,
          }}>{live ? 'Live · Bloomberg' : 'Simulated data'}</span>
        )}
        {data && <span style={{ fontSize: 12, color: FG3 }}>as of <span style={{ fontFamily: NUM }}>{data.as_of}</span></span>}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginLeft: 8 }}>
          {['All', ...(data?.groups ?? [])].map(g => (
            <button key={g} onClick={() => setGroup(g)} style={{
              fontSize: 11.5, padding: '3px 9px', borderRadius: 4, cursor: 'pointer',
              background: group === g ? 'rgba(139,143,216,0.18)' : 'transparent',
              color: group === g ? '#c9cbf2' : FG3,
              border: `1px solid ${group === g ? 'rgba(139,143,216,0.4)' : 'rgba(200,220,240,0.1)'}`,
            }}>{g}</button>
          ))}
        </div>
        <button onClick={() => load(true)} disabled={loading} style={{
          marginLeft: 'auto', fontSize: 12, padding: '4px 12px', borderRadius: 4, cursor: loading ? 'wait' : 'pointer',
          background: 'transparent', color: FG2, border: '1px solid rgba(200,220,240,0.15)',
        }}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {data?.note && <div style={{ fontSize: 12, color: '#dfbb78' }}>{data.note}</div>}
      {error && <div style={{ ...cardStyle, color: RED, fontSize: 13 }}>{error}</div>}
      {!data && loading && <div style={{ color: FG4, fontSize: 13 }}>Computing signals for the universe…</div>}

      {data && (
        <>
          {/* Summary table */}
          <div style={{ ...cardStyle, padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {headers.map(([h, key, align]) => (
                    <th key={h} onClick={key ? () => setSort(s => ({ key, desc: s.key === key ? !s.desc : true })) : undefined}
                      style={{ ...th, textAlign: align as 'left' | 'right' | 'center', cursor: key ? 'pointer' : 'default',
                        color: sort.key === key ? '#c9cbf2' : MUTED }}>
                      {h}{sort.key === key ? (key === 'flip_sigma' ? ' ↑' : sort.desc ? ' ↓' : ' ↑') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sort.key === 'group'
                  ? data.groups.filter(g => group === 'All' || g === group).map(g => {
                    const gr = rows.filter(r => r.group === g)
                    if (!gr.length) return null
                    return (
                      <Fragment key={g}>
                        <tr><td colSpan={headers.length} style={{
                          padding: '10px 8px 4px', fontSize: 11, color: ACCENT, textTransform: 'uppercase',
                          letterSpacing: '0.06em', borderBottom: '1px solid rgba(200,220,240,0.06)',
                        }}>{g}</td></tr>
                        {gr.map(renderRow)}
                      </Fragment>
                    )
                  })
                  : rows.map(renderRow)}
              </tbody>
            </table>
            <div style={{ padding: '8px 12px', fontSize: 11, color: FG4, lineHeight: 1.6 }}>
              Speeds: EWMA crossovers {data.speeds.join(', ')} days on vol-adjusted prices, in σ. CTA position: model trend follower,
              % of max ({data.model.response} response, {data.model.calibrated ? 'speed weights fitted to the SG Trend Index' : 'equal speed weights'}).
              Yields and curves show the series' own direction (yields up = long). Click a row for detail; click a header to sort.
              {sort.key !== 'group' && <span onClick={() => setSort({ key: 'group', desc: false })}
                style={{ color: ACCENT, cursor: 'pointer', marginLeft: 6 }}>Back to grouped view</span>}
            </div>
          </div>

          {data.missing.length > 0 && (
            <div style={{ fontSize: 12, color: FG4 }}>
              Not shown: {data.missing.map(x => `${x.label} (${x.reason})`).join(', ')}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 20 }}>
            <SectorCard data={data} />
            <CalibrationCard data={data} />
          </div>
          <PnlCard data={data} />
        </>
      )}
    </div>
  )
}

function SectorCard({ data }: { data: Monitor }) {
  const shocks = Object.keys(data.sectors[0]?.flows_1w ?? {})
  return (
    <div style={cardStyle}>
      <div style={eyebrow}>Model CTA by sector · AUM ${data.model.aum_bn.toFixed(0)}bn</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            {['Sector', 'Position', 'Net notional', ...shocks.map(s => `${s}σ 1w`)].map((h, i) => (
              <th key={h} style={{ ...th, position: 'static', textAlign: i ? 'right' : 'left', background: 'transparent' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.sectors.map(s => (
            <tr key={s.sector}>
              <td style={{ ...td, textAlign: 'left', fontFamily: "'Geist', sans-serif", color: FG2, textTransform: 'capitalize' }}>
                {s.sector} <span style={{ color: FG4, fontSize: 10.5 }}>({s.markets})</span>
              </td>
              <td style={{ ...td, color: s.position >= 0 ? GREEN : RED }}>{fmtSigned(s.position)}%</td>
              <td style={{ ...td, color: FG2 }}>{fmtUsd(s.net_notional_usd)}</td>
              {shocks.map(k => (
                <td key={k} style={{ ...td, background: divergingFill(s.flows_1w[k], Math.abs(s.net_notional_usd) || 1), color: '#eef2f6' }}>
                  {fmtUsd(s.flows_1w[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: FG4, marginTop: 10, lineHeight: 1.6 }}>
        Flows: notional the model buys (+) or sells over one week if every market in the sector moves by the
        given number of σ (its own 1-week vol). The 0σ column is the flat-price drift as the signals age.
      </div>
    </div>
  )
}

function CalibrationCard({ data }: { data: Monitor }) {
  const c = data.calibration
  const m = data.model
  const stat = (label: string, v: string, help?: string) => (
    <div title={help}>
      <div style={{ fontSize: 10.5, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontFamily: NUM, fontSize: 15, color: '#eef2f6', marginTop: 2 }}>{v}</div>
    </div>
  )
  return (
    <div style={cardStyle}>
      <div style={eyebrow}>Model vs SG Trend Index</div>
      {c?.ok ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          {stat('R²', c.r2!.toFixed(2), `Weekly returns, last ${c.weeks} weeks`)}
          {stat('R² out of sample', c.r2_oos == null ? '—' : c.r2_oos.toFixed(2), 'Fitted on the 3 years before the last year, scored on the last 52 weeks')}
          {stat('Correlation', c.corr!.toFixed(2))}
          {stat('Tracking error', `${(100 * c.tracking_error!).toFixed(1)}%`, `Index vol ${(100 * c.index_vol!).toFixed(1)}%`)}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: '#dfbb78', marginBottom: 14 }}>
          Not calibrated{c?.reason ? `: ${c.reason}` : ' (no index data)'}. Using equal speed weights and a 12% vol target.
        </div>
      )}
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 6 }}>Speed weights</div>
      <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
        {Object.entries(m.speed_weights).map(([k, w], i) => (
          <div key={k} title={`${k}: ${(100 * w).toFixed(0)}%`} style={{ width: `${100 * w}%`, background: SPEED_COLORS[i], opacity: 0.8 }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: FG3, fontFamily: NUM }}>
        {Object.entries(m.speed_weights).map(([k, w], i) => (
          <span key={k}><span style={{ color: SPEED_COLORS[i] }}>■</span> {k} {(100 * w).toFixed(0)}%</span>
        ))}
      </div>
      {c?.tested?.length ? (
        <div style={{ fontSize: 11, color: FG4, marginTop: 12, lineHeight: 1.6 }}>
          Response <span style={{ color: FG2 }}>{m.response}</span> (best fit of{' '}
          {c.tested.map(t => `${t.response} ${t.r2.toFixed(2)}`).join(', ')}).
          Leverage {m.leverage?.toFixed(2)}: a full position in one market carries AUM × leverage × its risk weight of annual vol.
        </div>
      ) : null}
    </div>
  )
}

function PnlCard({ data }: { data: Monitor }) {
  const rows = data.pnl.dates.map((d, i) => ({
    date: d, model: data.pnl.model[i], index: data.pnl.index?.[i] ?? null, dd: data.pnl.drawdown[i],
  }))
  return (
    <div style={cardStyle}>
      <div style={{ ...eyebrow, display: 'flex', gap: 16 }}>
        <span>Model CTA P&amp;L, 5y (cumulative %)</span>
        <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontFamily: NUM, color: FG3 }}>
          1m {fmtSigned(data.pnl.model_1m, 1, '%')} · 3m {fmtSigned(data.pnl.model_3m, 1, '%')}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={rows} margin={{ top: 8, right: 20, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="rgba(200,220,240,0.04)" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false}
            interval={Math.floor(rows.length / 6)} tickFormatter={(d: string) => d.slice(0, 7)} />
          <YAxis yAxisId="l" tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} width={44}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
          <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} width={44}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
          <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6, fontSize: 12, fontFamily: NUM }}
            formatter={(v: number) => `${v.toFixed(1)}%`} />
          <ReferenceLine yAxisId="l" y={0} stroke="rgba(200,220,240,0.15)" />
          <Area yAxisId="r" dataKey="dd" name="Model drawdown" fill={RED} fillOpacity={0.12} stroke="none" />
          <Line yAxisId="l" dataKey="model" name="Model" stroke={ACCENT} dot={false} strokeWidth={1.5} />
          {data.pnl.index && <Line yAxisId="l" dataKey="index" name="SG Trend Index" stroke={AMBER} dot={false} strokeWidth={1.2} />}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, color: FG4, marginTop: 6 }}>
        Weekly, before costs. Shaded: model drawdown (right axis). A deep drawdown usually means trend followers are cutting risk.
      </div>
    </div>
  )
}
