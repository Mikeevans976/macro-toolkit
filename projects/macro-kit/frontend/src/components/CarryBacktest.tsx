import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, ReferenceArea, Legend,
} from 'recharts'
import { chart, fg } from '../theme'

// ─── Types (from /api/tools/swaps-rv/carry-backtest) ──────────────────────────

type Window = '1y' | '2y' | 'all'

interface BtStats {
  predicted_bp: number   // carry strategy: avg |carry| it was promised, bp/yr
  realised_bp: number    // what that strategy actually earned, bp/yr
  delivered: number | null
  hit_rate: number
  slope: number | null
}

interface BtStructure {
  label: string
  group: string
  avg_carry_bp: number
  avg_realised_bp: number
  hit_rate: number
  delivered: number | null
  slope: number | null
}

interface BtPoint {
  start: string
  end: string | null
  carry: number
  realised: number | null
  fwd_err: number | null
}

interface BacktestData {
  as_of: string
  window: Window
  n_starts: number
  first_end: string | null
  last_end: string | null
  summary: (BtStats & { rank_corr: number }) | null
  structures: BtStructure[]
  series?: BtPoint[]
}

const MONO = "'Geist Mono', ui-monospace, monospace"
const WINDOWS: [Window, string][] = [['1y', '1Y'], ['2y', '2Y'], ['all', 'All']]
const fmtPct = (v: number | null) => v === null ? '—' : `${Math.round(v * 100)}%`
const fmtBp = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
const deliveredColor = (v: number | null) =>
  v === null ? '#8995a2' : v >= 0.75 ? '#6fc2a2' : v >= 0.25 ? '#dfbb78' : '#e2826f'

function useCarryBacktest(currency: string, asOf: string, dataStamp: string | null | undefined, window: Window,
                          label?: string, universe: string = 'core') {
  const [data, setData] = useState<BacktestData | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setError(null)
    const params = new URLSearchParams({ currency, date: asOf, window, universe })
    if (label) params.set('label', label)
    axios
      .get<BacktestData>(`/api/tools/swaps-rv/carry-backtest?${params}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('access_token') ?? ''}` },
      })
      .then(res => { if (!cancelled) setData(res.data) })
      .catch(err => {
        if (cancelled) return
        const detail = axios.isAxiosError(err) ? (err.response?.data as { detail?: unknown } | undefined)?.detail : undefined
        setError(typeof detail === 'string' ? detail : 'Could not load the carry backtest.')
      })
    return () => { cancelled = true }
  }, [currency, asOf, dataStamp, window, label, universe])
  return { data, error }
}

function WindowToggle({ value, onChange }: { value: Window; onChange: (w: Window) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {WINDOWS.map(([w, txt]) => (
        <button key={w} onClick={() => onChange(w)} style={{
          background: value === w ? 'rgba(106,169,204,0.16)' : 'transparent',
          border: `1px solid ${value === w ? 'rgba(106,169,204,0.35)' : 'rgba(200,220,240,0.09)'}`,
          color: value === w ? '#e4eaf1' : '#9aa5b1',
          borderRadius: 5, padding: '2px 8px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
        }}>{txt}</button>
      ))}
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

const windowText = (d: BacktestData) => d.first_end
  ? `holding periods ending ${d.first_end} → ${d.last_end} (${d.n_starts} start dates)`
  : 'no completed 1y holding periods in this window'

// ─── Currency-level summary (overview page) ───────────────────────────────────

type SortKey = 'label' | 'avg_carry_bp' | 'avg_realised_bp' | 'hit_rate' | 'delivered'

export function CarryRealisationSummary({ currency, universe, asOf, dataStamp, selected, onSelect }: {
  currency: string
  universe: string
  asOf: string
  dataStamp?: string | null
  selected: string | null
  onSelect: (label: string) => void
}) {
  const [win, setWin] = useState<Window>('1y')
  const [sortKey, setSortKey] = useState<SortKey>('delivered')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const { data, error } = useCarryBacktest(currency, asOf, dataStamp, win, undefined, universe)

  const rows = useMemo(() => {
    const r = [...(data?.structures ?? [])]
    r.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av === null) return 1
      if (bv === null) return -1
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)
      return sortDir === 'asc' ? cmp : -cmp
    })
    return r
  }, [data, sortKey, sortDir])

  const sortBy = (k: SortKey) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('desc') }
  }
  const th = (k: SortKey, text: string, align: 'left' | 'right' = 'right') => (
    <th onClick={() => sortBy(k)} style={{
      textAlign: align, padding: '8px 12px', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer',
      color: sortKey === k ? '#e4eaf1' : '#9aa5b1',
    }}>{text}{sortKey === k ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}</th>
  )
  const s = data?.summary

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ color: '#eef2f6', fontSize: 16, fontWeight: 600, margin: 0 }}>Carry Realisation</h2>
          <p style={{ color: '#8995a2', fontSize: 12, marginTop: 4 }}>
            Did the 1y roll-down promised by an unchanged curve get delivered? Each day, every structure is held for a year
            {data ? ` · ${windowText(data)}` : ''}
          </p>
        </div>
        <WindowToggle value={win} onChange={setWin} />
      </div>

      {error && <div style={{ color: '#e2826f', fontSize: 12 }}>{error}</div>}
      {!error && !data && <div style={{ color: '#8995a2', fontSize: 12 }}>Loading backtest…</div>}

      {s && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
            <Chip label="Carry strategy · promised" value={`${fmtBp(s.predicted_bp)} bp/yr`} />
            <Chip label="earned" value={`${fmtBp(s.realised_bp)} bp/yr`} color={s.realised_bp >= 0 ? '#6fc2a2' : '#e2826f'} />
            <Chip label="Delivered" value={fmtPct(s.delivered)} color={deliveredColor(s.delivered)} />
            <Chip label="Sign right" value={fmtPct(s.hit_rate)} />
            <Chip label="Rank corr. carry → P&L" value={s.rank_corr.toFixed(2)} />
            <Chip label="Slope P&L ~ carry" value={s.slope === null ? '—' : s.slope.toFixed(2)} />
          </div>
          <div style={{ color: '#77828f', fontSize: 11, marginBottom: 12 }}>
            Carry strategy: receive every structure with positive carry, pay every one with negative carry. Delivered = earned ÷ promised.
            Rank corr.: across structures on each start date, did higher carry mean higher P&L (averaged)? Slope 1 = carry delivered one-for-one.
            Start dates overlap, so one year of them is roughly one independent outcome per structure.
          </div>
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#10161d', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <tr>
                  {th('label', 'Structure', 'left')}
                  {th('avg_carry_bp', 'Avg carry (bp)')}
                  {th('avg_realised_bp', 'Avg 1y P&L (bp)')}
                  {th('hit_rate', 'Sign right')}
                  {th('delivered', 'Delivered')}
                </tr>
              </thead>
              <tbody style={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>
                {rows.map(r => (
                  <tr key={r.label} onClick={() => onSelect(r.label)} style={{
                    cursor: 'pointer', borderTop: '1px solid rgba(200,220,240,0.04)',
                    background: r.label === selected ? 'rgba(106,169,204,0.08)' : undefined,
                  }}>
                    <td style={{ padding: '6px 12px', color: '#e4eaf1' }}>{r.label}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', color: '#c6ced8' }}>{fmtBp(r.avg_carry_bp)}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', color: r.avg_realised_bp >= 0 ? '#6fc2a2' : '#e2826f' }}>{fmtBp(r.avg_realised_bp)}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', color: '#c6ced8' }}>{fmtPct(r.hit_rate)}</td>
                    <td style={{ padding: '6px 12px', textAlign: 'right', color: deliveredColor(r.delivered) }}>{fmtPct(r.delivered)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {data && !s && <div style={{ color: '#8995a2', fontSize: 12 }}>Not enough history for this window.</div>}
    </div>
  )
}

// ─── One structure (detail view) ──────────────────────────────────────────────

export function CarryRealisationDetail({ currency, label, asOf, dataStamp }: {
  currency: string
  label: string
  asOf: string
  dataStamp?: string | null
}) {
  const [win, setWin] = useState<Window>('1y')
  const { data, error } = useCarryBacktest(currency, asOf, dataStamp, win, label)
  const row = data?.structures.find(r => r.label === label)
  const series = useMemo(() => data?.series ?? [], [data])

  // Start dates whose holding period ends inside the evaluation window, shaded on the chart
  const shade = useMemo(() => {
    if (!data?.first_end) return null
    const inside = series.filter(p => p.end !== null && p.end >= data.first_end! && p.end <= data.last_end!)
    return inside.length ? [inside[0].start, inside[inside.length - 1].start] : null
  }, [data, series])
  const tickEvery = Math.max(1, Math.floor(series.length / 6))

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Carry realisation · 1y horizon</div>
          <div style={{ color: '#8995a2', fontSize: 12 }}>
            On each entry date: the carry that day's curve promised vs the P&L of holding the structure for a year
            (receiver of the structure; bp). The gap is how far the rolled forwards moved from where the curve put them.
          </div>
        </div>
        <WindowToggle value={win} onChange={setWin} />
      </div>

      {error && <div style={{ color: '#e2826f', fontSize: 12 }}>{error}</div>}
      {!error && !data && <div style={{ color: '#8995a2', fontSize: 12 }}>Loading backtest…</div>}

      {data && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            {row ? (
              <>
                <Chip label="Avg carry" value={`${fmtBp(row.avg_carry_bp)} bp`} />
                <Chip label="Avg 1y P&L" value={`${fmtBp(row.avg_realised_bp)} bp`} color={row.avg_realised_bp >= 0 ? '#6fc2a2' : '#e2826f'} />
                <Chip label="Sign right" value={fmtPct(row.hit_rate)} />
                <Chip label="Delivered (carry strategy)" value={fmtPct(row.delivered)} color={deliveredColor(row.delivered)} />
              </>
            ) : <span style={{ color: '#8995a2', fontSize: 12 }}>Not enough history for this window.</span>}
            <span style={{ color: '#77828f', fontSize: 11, alignSelf: 'center' }}>{windowText(data)}</span>
          </div>

          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid {...chart.grid} />
              <XAxis dataKey="start" {...chart.axis} interval={tickEvery} tickFormatter={(d: string) => d.slice(0, 7)} />
              <YAxis width={44} {...chart.axis} tickFormatter={(v: number) => v.toFixed(0)} />
              <Tooltip {...chart.tooltip}
                labelFormatter={(d) => {
                  const p = series.find(x => x.start === d)
                  return p?.end ? `entry ${d} → exit ${p.end}` : `entry ${d} (outcome not known yet)`
                }}
                formatter={(v: number, n: string) => [`${v > 0 ? '+' : ''}${v.toFixed(2)} bp`, n]} />
              <Legend wrapperStyle={{ fontSize: 10, color: fg[3] }} />
              {shade && <ReferenceArea x1={shade[0]} x2={shade[1]} fill="rgba(134,192,222,0.06)" strokeOpacity={0} />}
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.25)" />
              <Line dataKey="carry" name="Promised carry" stroke="#86c0de" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line dataKey="realised" name="Realised 1y P&L" stroke="#e4eaf1" strokeWidth={1.3} dot={false} isAnimationActive={false} />
              <Line dataKey="fwd_err" name="Curve move (P&L − carry)" stroke="#d59fbf" strokeDasharray="3 3" strokeWidth={1} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ color: '#77828f', fontSize: 11, marginTop: 6 }}>
            Shaded: entry dates in the selected window. Realised P&L stops a year before the as-of date (later outcomes are not known yet).
          </div>
        </>
      )}
    </div>
  )
}
