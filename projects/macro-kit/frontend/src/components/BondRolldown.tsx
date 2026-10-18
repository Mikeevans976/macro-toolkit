import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot, ReferenceLine, Legend,
} from 'recharts'
import { chart, series as palette, fg } from '../theme'
import { RollArrow } from './CurveRolldown'

// ─── Types (from /api/tools/egb-rv/rolldown) ──────────────────────────────────

interface RollLeg {
  label: string               // e.g. "OAT 10y" or "Bund ASW 10y"
  country: string
  kind: 'yield' | 'asw'
  tenor: number
  weight: number
  yield_pct: number
  repo_pct: number | null     // €STR + the repo bloc's assumed spread; null for ASW legs
  rolled_tenor: number        // T − 1 (0.5 at the short end)
  rolled_yield_pct: number    // read off today's curve
  duration: number | null     // null for ASW legs
  income_bps: number          // (y − repo) / duration, or the ASW level
  roll_bps: number            // (y_T − y_{T−1}) × 100
  contribution_bps: number    // weight × (income + roll)
}

interface RolldownData {
  label: string
  as_of: string
  estr_pct: number
  legs: RollLeg[]
  curves: {
    country: string
    label: string
    quotes: { tenor: number; yield_pct: number }[]
    fitted: { tenor: number; yield_pct: number }[]
  }[]
  carry1y_bps: number
}

const MONO = "'Geist Mono', ui-monospace, monospace"
const signed = (v: number, dp = 2) => `${v > 0 ? '+' : ''}${v.toFixed(dp)}`
const signColor = (v: number) => v > 0 ? '#6fc2a2' : v < 0 ? '#e2826f' : '#c6ced8'

// Y domain fitted to the points in view, padded so markers don't sit on the frame
function fitDomain(values: number[]): [number, number] {
  const lo = Math.min(...values), hi = Math.max(...values)
  const pad = Math.max((hi - lo) * 0.12, 0.02)
  return [lo - pad, hi + pad]
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BondRolldown({ label, asOf, query = '', dataStamp }: {
  label: string
  asOf: string
  query?: string
  dataStamp?: string | number | null
}) {
  const [data, setData] = useState<RolldownData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    const params = new URLSearchParams(query)
    params.set('label', label)
    params.set('date', asOf)
    axios
      .get<RolldownData>(`/api/tools/egb-rv/rolldown?${params}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('access_token') ?? ''}` },
      })
      .then(res => {
        if (cancelled) return
        const d = res.data as Partial<RolldownData> | undefined
        if (d && typeof d === 'object' && Array.isArray(d.legs) && Array.isArray(d.curves)) setData(d as RolldownData)
        else setError('The roll-down is not available from this server.')
      })
      .catch(err => {
        if (cancelled) return
        const detail = axios.isAxiosError(err) ? (err.response?.data as { detail?: unknown } | undefined)?.detail : undefined
        setError(typeof detail === 'string' ? detail : 'Could not load the roll-down.')
      })
    return () => { cancelled = true }
  }, [label, asOf, query, dataStamp])

  const colorOf = useMemo(() => {
    const order = data?.curves.map(c => c.country) ?? []
    return (country: string) => palette[Math.max(order.indexOf(country), 0) % palette.length]
  }, [data])

  // One row per fitted tenor with a column per country, so every curve shares the x axis
  const rows = useMemo(() => {
    if (!data) return []
    const byTenor = new Map<number, Record<string, number>>()
    for (const c of data.curves) {
      for (const p of c.fitted) {
        const row = byTenor.get(p.tenor) ?? { tenor: p.tenor }
        row[c.country] = p.yield_pct
        byTenor.set(p.tenor, row)
      }
    }
    return [...byTenor.values()].sort((a, b) => a.tenor - b.tenor)
  }, [data])

  const header = (
    <>
      <div style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Curve &amp; roll-down</div>
      <div style={{ color: '#8995a2', fontSize: 12, marginBottom: 12 }}>
        Each country's yield curve on {data?.as_of ?? asOf} (cubic spline through the generic yields). Carry assumes the
        curves stay unchanged for a year: each bond earns its yield over repo per unit of duration, and rolls down its own
        curve as its maturity shortens by a year (T → T−1).
      </div>
    </>
  )

  if (error) return <div style={{ marginTop: 20 }}>{header}<div style={{ color: '#e2826f', fontSize: 12 }}>{error}</div></div>
  if (!data) return <div style={{ marginTop: 20 }}>{header}<div style={{ color: '#8995a2', fontSize: 12 }}>Loading roll-down…</div></div>

  const domain = fitDomain([
    ...data.curves.flatMap(c => [...c.fitted, ...c.quotes].map(p => p.yield_pct)),
    ...data.legs.map(l => l.rolled_yield_pct),
  ])
  const th: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', color: '#c6ced8' }

  return (
    <div style={{ marginTop: 20 }}>
      {header}

      <div style={{
        background: 'rgba(200,220,240,0.02)', border: '1px solid rgba(200,220,240,0.06)',
        borderRadius: 6, padding: '12px 16px',
      }}>
        <div style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          Yield curves · roll-down
        </div>
        <div style={{ color: '#77828f', fontSize: 11, marginTop: 2, marginBottom: 8 }}>
          Dots: generic yields · line: spline fit · filled marker: leg today · arrow: where it sits in 1y on an unchanged curve
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
            <CartesianGrid {...chart.grid} />
            <XAxis dataKey="tenor" type="number" domain={[0, 30]} ticks={[1, 2, 5, 7, 10, 15, 20, 30]} {...chart.axis}
              label={{ value: 'Maturity (y)', position: 'insideBottom', offset: -8, fill: fg[4], fontSize: 10 }} />
            <YAxis domain={domain} tickFormatter={(v: number) => v.toFixed(2)} width={44} {...chart.axis} />
            <Tooltip {...chart.tooltip} labelFormatter={(v) => `${v}y`}
              formatter={(v: number, name: string) => [`${v.toFixed(3)}%`, name]} />
            <Legend wrapperStyle={{ fontSize: 10, color: fg[3] }} />
            {data.curves.map(c => (
              <Line key={c.country} dataKey={c.country} name={c.label} stroke={colorOf(c.country)}
                strokeWidth={1.5} dot={false} isAnimationActive={false} />
            ))}
            {data.curves.map(c => (
              <Scatter key={`q-${c.country}`} data={c.quotes.map(q => ({ tenor: q.tenor, [c.country]: q.yield_pct }))}
                dataKey={c.country} legendType="none" name={`${c.label} quote`} fill={colorOf(c.country)} isAnimationActive={false} />
            ))}
            {data.legs.map(l => (
              <ReferenceLine key={`arrow-${l.label}`} ifOverflow="hidden"
                segment={[{ x: l.tenor, y: l.yield_pct }, { x: l.rolled_tenor, y: l.rolled_yield_pct }]}
                shape={RollArrow('#d6ad66')} />
            ))}
            {data.legs.map(l => (
              <ReferenceDot key={`rolled-${l.label}`} x={l.rolled_tenor} y={l.rolled_yield_pct} r={4}
                fill="#0b0f14" stroke="#d6ad66" strokeWidth={1.5} ifOverflow="hidden" />
            ))}
            {data.legs.map(l => (
              <ReferenceDot key={`now-${l.label}`} x={l.tenor} y={l.yield_pct} r={4.5}
                fill="#d6ad66" stroke="#0b0f14" ifOverflow="hidden"
                label={{ value: `${l.weight > 0 ? '+' : ''}${l.weight}× ${l.label}`, position: 'right', offset: 8, fill: fg[2], fontSize: 10, fontFamily: MONO }} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={{ overflowX: 'auto', marginTop: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: '#9aa5b1', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <th style={{ ...th, textAlign: 'left' }}>Leg</th>
              <th style={th}>Weight</th>
              <th style={th}>Yield today</th>
              <th style={th}>Repo</th>
              <th style={th}>Duration</th>
              <th style={th}>Income (bp)</th>
              <th style={{ ...th, textAlign: 'left' }}>Rolls to</th>
              <th style={th}>Yield in 1y</th>
              <th style={th}>Roll-down (bp)</th>
              <th style={th}>Contribution (bp)</th>
            </tr>
          </thead>
          <tbody style={{ fontFamily: MONO }}>
            {data.legs.map(l => (
              <tr key={l.label} style={{ borderTop: '1px solid rgba(200,220,240,0.05)' }}>
                <td style={{ ...td, textAlign: 'left', color: '#e4eaf1' }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: colorOf(l.country), marginRight: 8 }} />
                  {l.label}
                </td>
                <td style={td}>{signed(l.weight, 0)}</td>
                <td style={td}>{l.yield_pct.toFixed(3)}%</td>
                <td style={td}>{l.repo_pct === null ? '—' : `${l.repo_pct.toFixed(3)}%`}</td>
                <td style={td}>{l.duration === null ? '—' : l.duration.toFixed(2)}</td>
                <td style={td} title={l.kind === 'asw' ? 'ASW level' : undefined}>{signed(l.income_bps)}</td>
                <td style={{ ...td, textAlign: 'left', color: '#9aa5b1' }}>{l.rolled_tenor}y</td>
                <td style={td}>{l.rolled_yield_pct.toFixed(3)}%</td>
                <td style={td}>{signed(l.roll_bps)}</td>
                <td style={{ ...td, color: signColor(l.contribution_bps) }}>{signed(l.contribution_bps)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid rgba(200,220,240,0.14)' }}>
              <td colSpan={9} style={{ padding: '7px 10px', color: '#9aa5b1', fontFamily: 'inherit' }}>
                Carry + roll (1y) = Σ contributions · €STR {data.estr_pct.toFixed(3)}% plus your repo assumptions
              </td>
              <td style={{ ...td, color: signColor(data.carry1y_bps), fontWeight: 600 }}>{signed(data.carry1y_bps)}</td>
            </tr>
          </tbody>
        </table>
        <div style={{ color: '#77828f', fontSize: 11, marginTop: 6 }}>
          Income = (yield − repo) ÷ duration, the yield pick-up per unit of duration (ASW legs: the ASW level). Roll-down = yield today −
          yield one year shorter on today's curve. Contribution = weight × (income + roll-down); positive carry favours owning the
          +weight bonds. Repo = €STR plus your assumption for the bond's repo bloc, so the total matches the monitor's carry.
        </div>
      </div>
    </div>
  )
}
