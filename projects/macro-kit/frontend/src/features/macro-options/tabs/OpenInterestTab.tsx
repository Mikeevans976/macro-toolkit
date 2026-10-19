import { useEffect, useMemo, useRef, useState } from 'react'
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { isBusinessDay } from '../model/calendar'
import { PACKS } from '../model/types'
import type { Market, OISeries } from '../model/types'
import { BORDER, Chip, FG1, FG2, FG3, FG4, Label, MONO, Stat, axisProps, card, niceTicks } from '../ui'
import { useOpenInterest } from '../useMarket'

// ─── Tab 5 — Open interest ────────────────────────────────────────────────────
//
// End-of-day open interest by strike for one option series (underlying × expiry).
// ICE publishes OI the following morning, so the latest available day is the last
// business day *before* the snapshot date. Live: Bloomberg OPEN_INT by day and strike;
// otherwise simulated (see model/simulation.ts).

// Strike at which option holders' total payout would be smallest
function maxPain(strikes: number[], calls: number[], puts: number[]): number {
  let best = strikes[0], bestPay = Infinity
  strikes.forEach(S => {
    const pay = strikes.reduce((a, K, i) => a + calls[i] * Math.max(S - K, 0) + puts[i] * Math.max(K - S, 0), 0)
    if (pay < bestPay) { bestPay = pay; best = S }
  })
  return best
}

type OIMeasure = 'total' | 'calls' | 'puts' | 'net'
type OILookback = '1M' | '3M' | '6M' | 'All'
type OICompare = '1D' | '1W' | '1M' | 'start'

export interface OIState {
  contractId: string | null
  expiryId: string | null
  lookback: OILookback
  measure: OIMeasure
  compare: OICompare
  dayIdx: number | null      // index into the series; null → latest
}

const OI_CALL = '#86c0de', OI_PUT = '#dd8a7d'
const fmtLots = (v: number) => Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}m` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`
const fmtSigned = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtLots(Math.abs(v))}`
const fmtDayShort = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' })

function lerpHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16))
  return '#' + pa.map((v, k) => Math.round(v + (pb[k] - v) * t).toString(16).padStart(2, '0')).join('')
}

// Measured width of an element (for the hand-drawn heatmap)
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(es => setW(es[0].contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function OIHeatmap({ series, start, measure, dayIdx, onDay }: {
  series: OISeries; start: number; measure: OIMeasure; dayIdx: number; onDay: (i: number) => void
}) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<{ t: number; i: number; x: number; y: number } | null>(null)

  // Only strikes that ever carry meaningful OI in the window, highest strike on top
  const value = (t: number, i: number) => {
    const c = series.calls[t][i], p = series.puts[t][i]
    return measure === 'calls' ? c : measure === 'puts' ? p : measure === 'net' ? p - c : c + p
  }
  const days = Array.from({ length: series.dates.length - start }, (_, k) => start + k)
  const peak = Math.max(1, ...days.flatMap(t => series.strikes.map((_, i) => series.calls[t][i] + series.puts[t][i])))
  const rows = series.strikes.map((_, i) => i).filter(i => days.some(t => series.calls[t][i] + series.puts[t][i] > peak * 0.01)).reverse()
  const vmax = Math.max(1, ...days.flatMap(t => rows.map(i => Math.abs(value(t, i)))))

  const ML = 58, MR = 10, MT = 6, MB = 26
  const H = Math.min(560, Math.max(260, rows.length * 13)) + MT + MB
  const cw = Math.max(0.5, (width - ML - MR) / days.length), ch = (H - MT - MB) / Math.max(1, rows.length)
  const x0 = (k: number) => ML + k * cw
  const yOfStrike = (K: number) => {
    const top = series.strikes[rows[0]], bot = series.strikes[rows[rows.length - 1]]
    return MT + ((top - K) / (top - bot || 1)) * (H - MT - MB - ch) + ch / 2
  }

  // Sequential ramp from the card surface; gamma < 1 keeps small positions visible without washing out
  const color = (v: number) => {
    const t = Math.pow(Math.min(1, Math.abs(v) / vmax), 0.65)
    if (measure === 'net') return lerpHex('#0f141a', v >= 0 ? OI_PUT : OI_CALL, t)
    return lerpHex('#0f141a', measure === 'puts' ? OI_PUT : measure === 'calls' ? OI_CALL : '#a9d8ef', t)
  }

  const labelEvery = Math.max(1, Math.ceil(rows.length / 18))
  const monthTicks = days.map((t, k) => ({ t, k })).filter(({ t }, j) => j === 0 || series.dates[t].getUTCMonth() !== series.dates[t - 1]?.getUTCMonth())
  const fPath = days.map((t, k) => `${k === 0 ? 'M' : 'L'}${(x0(k) + cw / 2).toFixed(1)},${yOfStrike(series.F[t]).toFixed(1)}`).join(' ')
  const selK = dayIdx - start

  const cellAt = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    const k = Math.floor((mx - ML) / cw), ri = Math.floor((my - MT) / ch)
    return k < 0 || k >= days.length || ri < 0 || ri >= rows.length ? null : { t: days[k], i: rows[ri], x: mx, y: my }
  }
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => setHover(cellAt(e))

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <svg width={width} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        onClick={e => { const c = cellAt(e); if (c) onDay(c.t) }} style={{ display: 'block', cursor: 'crosshair' }}>
        {rows.map((i, ri) => days.map((t, k) => {
          const v = value(t, i)
          if (measure !== 'net' && v <= 0) return null
          return <rect key={`${i}-${t}`} x={x0(k)} y={MT + ri * ch} width={cw + 0.5} height={ch + 0.5} fill={color(v)} shapeRendering="crispEdges" />
        }))}
        {/* Futures price through time */}
        <path d={fPath} fill="none" stroke="#f4f7fa" strokeOpacity={0.75} strokeWidth={1.4} strokeDasharray="4 3" />
        {/* Selected day */}
        {selK >= 0 && <rect x={x0(selK)} y={MT} width={Math.max(cw, 1.5)} height={H - MT - MB} fill="none" stroke="#f4f7fa" strokeWidth={1} />}
        {/* Strike labels */}
        {rows.map((i, ri) => ri % labelEvery === 0 && (
          <text key={i} x={ML - 6} y={MT + ri * ch + ch / 2} textAnchor="end" dominantBaseline="middle" fill={FG3} fontSize={10} fontFamily={MONO}>
            {series.strikes[i].toFixed(3)}
          </text>
        ))}
        {/* Month ticks */}
        {monthTicks.map(({ t, k }) => (
          <g key={t}>
            <line x1={x0(k)} x2={x0(k)} y1={H - MB} y2={H - MB + 4} stroke="rgba(150,178,205,0.3)" />
            <text x={x0(k) + 2} y={H - MB + 15} fill={FG3} fontSize={10} fontFamily={MONO}>
              {series.dates[t].toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })}
            </text>
          </g>
        ))}
      </svg>
      {hover && (
        <div style={{
          position: 'absolute', left: Math.min(hover.x + 14, width - 200), top: Math.max(0, hover.y - 70), pointerEvents: 'none',
          background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, padding: '8px 12px',
          fontSize: 11, fontFamily: MONO, color: FG2, whiteSpace: 'nowrap',
        }}>
          <div style={{ color: FG1, marginBottom: 3 }}>{fmtDayShort(series.dates[hover.t])} · K {series.strikes[hover.i].toFixed(4)}</div>
          <div>Calls <span style={{ color: OI_CALL }}>{fmtLots(series.calls[hover.t][hover.i])}</span>
            {'  '}Puts <span style={{ color: OI_PUT }}>{fmtLots(series.puts[hover.t][hover.i])}</span></div>
          <div style={{ color: FG3 }}>Futures {series.F[hover.t].toFixed(3)} · click to inspect day</div>
        </div>
      )}
    </div>
  )
}

export default function OpenInterestTab({ market, controls, state, setState }: {
  market: Market; controls: React.ReactNode
  state: OIState; setState: (f: (s: OIState) => OIState) => void
}) {
  const { contracts, snap } = market
  const contract = contracts.find(c => c.id === state.contractId) ?? contracts[1]
  const expiries = useMemo(() => market.expiries(contract), [market, contract])
  const expiry = expiries.find(e => e.id === state.expiryId)
    ?? expiries.find(e => e.kind === 'standard') ?? expiries[expiries.length - 1] ?? null

  // Latest published OI: the business day before the snapshot's date
  const through = useMemo(() => {
    const d = new Date(Date.UTC(snap.getUTCFullYear(), snap.getUTCMonth(), snap.getUTCDate(), 21))
    do d.setUTCDate(d.getUTCDate() - 1); while (!isBusinessDay(d))
    return d
  }, [snap])

  const { series, loading, note } = useOpenInterest(market, contract, expiry, through)
  if (!expiry || !series || series.dates.length < 2) {
    return (
      <>
        <div style={{ ...card, padding: '16px 20px', marginBottom: 16 }}>{controls}</div>
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>
          {loading ? `Loading ${expiry?.code ?? ''} open interest from Bloomberg…` : note ?? 'No open-interest history for this series yet.'}
        </div>
      </>
    )
  }

  const n = series.dates.length
  const lbDays = { '1M': 21, '3M': 63, '6M': 126, All: Infinity }[state.lookback]
  const start = Math.max(0, n - Math.min(n, lbDays))
  const day = state.dayIdx !== null && state.dayIdx >= start && state.dayIdx < n ? state.dayIdx : n - 1
  const cmpIdx = Math.max(0, state.compare === '1D' ? day - 1 : state.compare === '1W' ? day - 5 : state.compare === '1M' ? day - 21 : start)

  const sum = (row: number[]) => row.reduce((a, b) => a + b, 0)
  const totC = sum(series.calls[day]), totP = sum(series.puts[day])
  const tot = totC + totP
  const totAt = (t: number) => sum(series.calls[t]) + sum(series.puts[t])
  const d1 = day > 0 ? tot - totAt(day - 1) : 0
  const d5 = day >= 5 ? tot - totAt(day - 5) : 0
  const pain = maxPain(series.strikes, series.calls[day], series.puts[day])

  // Strikes worth showing in the profile: ≥ 0.5% of the day's largest strike OI (or that changed materially)
  const peakDay = Math.max(1, ...series.strikes.map((_, i) => series.calls[day][i] + series.puts[day][i]))
  const profile = series.strikes.map((K, i) => ({
    K, calls: series.calls[day][i], puts: -series.puts[day][i],
    dCalls: series.calls[day][i] - series.calls[cmpIdx][i], dPuts: series.puts[day][i] - series.puts[cmpIdx][i],
  })).filter(r => r.calls - r.puts > peakDay * 0.005 || Math.abs(r.dCalls) + Math.abs(r.dPuts) > peakDay * 0.01)

  const history = Array.from({ length: n - start }, (_, k) => {
    const t = start + k
    const c = sum(series.calls[t]), p = sum(series.puts[t])
    return { t: series.dates[t].getTime(), calls: c, puts: p, pcr: c > 0 ? p / c : 0 }
  })

  const top = series.strikes.flatMap((K, i) => [
    { K, type: 'Call' as const, oi: series.calls[day][i], d1: day > 0 ? series.calls[day][i] - series.calls[day - 1][i] : 0, d5: day >= 5 ? series.calls[day][i] - series.calls[day - 5][i] : 0 },
    { K, type: 'Put' as const, oi: series.puts[day][i], d1: day > 0 ? series.puts[day][i] - series.puts[day - 1][i] : 0, d5: day >= 5 ? series.puts[day][i] - series.puts[day - 5][i] : 0 },
  ]).sort((a, b) => b.oi - a.oi).slice(0, 10)

  const set = (patch: Partial<OIState>) => setState(s => ({ ...s, ...patch }))
  const xTicksStrike = profile.length ? niceTicks(profile[0].K, profile[profile.length - 1].K) : []
  const timeTicks = (() => {
    const out: number[] = []
    history.forEach((h, k) => { if (k > 0 && new Date(h.t).getUTCMonth() !== new Date(history[k - 1].t).getUTCMonth()) out.push(h.t) })
    const step = Math.ceil(out.length / 8)
    return out.filter((_, i) => i % step === 0)
  })()
  const tip = { background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }
  const cmpLabel = { '1D': '1 day', '1W': '1 week', '1M': '1 month', start: 'start of range' }[state.compare]

  return (
    <>
      <div style={{ ...card, padding: '16px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Underlying</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {PACKS.map(pk => (
              <div key={pk.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: pk.shades[2], fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', width: 46 }}>{pk.label}</span>
                {contracts.filter(c => c.pack === pk.id).map(c => (
                  <Chip key={c.id} active={c.id === contract.id} onClick={() => set({ contractId: c.id, expiryId: null, dayIdx: null })}>{c.label}</Chip>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Expiry</Label></span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
            {expiries.map(e => (
              <Chip key={e.id} active={e.id === expiry.id} onClick={() => set({ expiryId: e.id, dayIdx: null })}
                title={`${e.code} · ${e.kind} · expires ${e.date.toISOString().slice(0, 10)} 10:00 London`}>
                <span style={{ fontFamily: MONO }}>{e.code}</span>
                <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{e.label}</span>
              </Chip>
            ))}
          </div>
        </div>
        {controls}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Label>View</Label>
          {(['1M', '3M', '6M', 'All'] as OILookback[]).map(l => (
            <Chip key={l} active={state.lookback === l} onClick={() => set({ lookback: l })}>{l === 'All' ? 'Since listing' : l}</Chip>
          ))}
          <span style={{ width: 12 }} />
          {([['total', 'Total'], ['calls', 'Calls'], ['puts', 'Puts'], ['net', 'Puts − calls']] as [OIMeasure, string][]).map(([m, l]) => (
            <Chip key={m} active={state.measure === m} onClick={() => set({ measure: m })}>{l}</Chip>
          ))}
        </div>
      </div>

      {/* Headline */}
      <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 16 }}>
        <Stat label={`${expiry.code} on ${contract.label}`} value={fmtDayShort(series.dates[day])}
          sub={day === n - 1 ? 'latest close (published T+1)' : 'selected day'} />
        <Stat label="Total OI" value={`${fmtLots(tot)} lots`} />
        <Stat label="Calls / puts" value={`${fmtLots(totC)} / ${fmtLots(totP)}`} />
        <Stat label="Put / call ratio" value={totC > 0 ? (totP / totC).toFixed(2) : '—'} />
        <Stat label="Δ 1 day" value={fmtSigned(d1)} sub={tot - d1 > 0 ? `${((d1 / (tot - d1)) * 100).toFixed(1)}%` : undefined} />
        <Stat label="Δ 1 week" value={fmtSigned(d5)} sub={tot - d5 > 0 ? `${((d5 / (tot - d5)) * 100).toFixed(1)}%` : undefined} />
        <Stat label="Max pain" value={pain.toFixed(3)} sub={`futures ${series.F[day].toFixed(3)}`} />
      </div>

      {/* Heatmap */}
      <div style={{ ...card, padding: '16px 16px 10px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Open interest by strike and day</span>
          <span style={{ color: FG3, fontSize: 11 }}>
            {state.measure === 'net' ? 'Warm = more puts, cool = more calls' : `${state.measure === 'total' ? 'Calls + puts' : state.measure === 'calls' ? 'Calls' : 'Puts'}, brighter = larger`}
            {' '}· dashed = futures price · click a column to inspect that day
          </span>
        </div>
        <OIHeatmap series={series} start={start} measure={state.measure} dayIdx={day} onDay={i => set({ dayIdx: i })} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, marginBottom: 16 }}>
        {/* Profile for the selected day */}
        <div style={{ ...card, padding: '16px 16px 8px' }}>
          <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Strike profile · {fmtDayShort(series.dates[day])}</div>
          <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>Calls up, puts down · dashed = futures · dotted = max pain</div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={profile} margin={{ top: 10, right: 16, left: 4, bottom: 20 }} stackOffset="sign" barCategoryGap={1}>
              <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
              <XAxis type="number" dataKey="K" domain={['dataMin - 0.03', 'dataMax + 0.03']} ticks={xTicksStrike} tickFormatter={(v: number) => v.toFixed(3)} {...axisProps}
                label={{ value: 'Strike', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
              <YAxis tickFormatter={(v: number) => fmtLots(Math.abs(v))} width={48} {...axisProps} />
              <Tooltip cursor={{ fill: 'rgba(200,220,240,0.04)' }} contentStyle={tip}
                labelFormatter={(v: number) => `K ${Number(v).toFixed(4)}`}
                formatter={(v: number, name: string) => [`${fmtLots(Math.abs(v))} lots`, name]} />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.3)" />
              <ReferenceLine x={series.F[day]} stroke="#f4f7fa" strokeOpacity={0.6} strokeDasharray="4 3" />
              <ReferenceLine x={pain} stroke="#d6ad66" strokeOpacity={0.7} strokeDasharray="1 3" />
              <Bar dataKey="calls" name="Calls" stackId="oi" fill={OI_CALL} isAnimationActive={false} barSize={6} />
              <Bar dataKey="puts" name="Puts" stackId="oi" fill={OI_PUT} isAnimationActive={false} barSize={6} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Change by strike */}
        <div style={{ ...card, padding: '16px 16px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Change by strike</span>
            <span style={{ color: FG3, fontSize: 11 }}>vs {cmpLabel} earlier ({fmtDayShort(series.dates[cmpIdx])})</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {(['1D', '1W', '1M', 'start'] as OICompare[]).map(k => (
                <Chip key={k} active={state.compare === k} onClick={() => set({ compare: k })}>{k === 'start' ? 'Range' : k}</Chip>
              ))}
            </span>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={profile} margin={{ top: 10, right: 16, left: 4, bottom: 20 }} barCategoryGap={1}>
              <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
              <XAxis type="number" dataKey="K" domain={['dataMin - 0.03', 'dataMax + 0.03']} ticks={xTicksStrike} tickFormatter={(v: number) => v.toFixed(3)} {...axisProps}
                label={{ value: 'Strike', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
              <YAxis tickFormatter={(v: number) => fmtSigned(v)} width={52} {...axisProps} />
              <Tooltip cursor={{ fill: 'rgba(200,220,240,0.04)' }} contentStyle={tip}
                labelFormatter={(v: number) => `K ${Number(v).toFixed(4)}`}
                formatter={(v: number, name: string) => [`${fmtSigned(v)} lots`, name]} />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.3)" />
              <ReferenceLine x={series.F[day]} stroke="#f4f7fa" strokeOpacity={0.6} strokeDasharray="4 3" />
              <Bar dataKey="dCalls" name="Δ calls" fill={OI_CALL} isAnimationActive={false} barSize={4} />
              <Bar dataKey="dPuts" name="Δ puts" fill={OI_PUT} isAnimationActive={false} barSize={4} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, marginBottom: 16 }}>
        {/* Total OI over time */}
        <div style={{ ...card, padding: '16px 16px 8px' }}>
          <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Total open interest</div>
          <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>Calls and puts stacked · lots</div>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={history} margin={{ top: 10, right: 16, left: 4, bottom: 8 }}>
              <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
              <XAxis type="number" dataKey="t" domain={['dataMin', 'dataMax']} ticks={timeTicks} {...axisProps}
                tickFormatter={(t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })} />
              <YAxis tickFormatter={(v: number) => fmtLots(v)} width={48} {...axisProps} />
              <Tooltip contentStyle={tip} labelFormatter={(t: number) => fmtDayShort(new Date(t))}
                formatter={(v: number, name: string) => [`${fmtLots(v)} lots`, name]} />
              <ReferenceLine x={series.dates[day].getTime()} stroke="#f4f7fa" strokeOpacity={0.5} />
              <Area type="monotone" dataKey="calls" name="Calls" stackId="1" stroke={OI_CALL} fill={OI_CALL} fillOpacity={0.35} isAnimationActive={false} />
              <Area type="monotone" dataKey="puts" name="Puts" stackId="1" stroke={OI_PUT} fill={OI_PUT} fillOpacity={0.35} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Put / call ratio */}
        <div style={{ ...card, padding: '16px 16px 8px' }}>
          <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Put / call ratio</div>
          <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>Put OI ÷ call OI · above 1 = more downside-price (higher-rate) protection</div>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={history} margin={{ top: 10, right: 16, left: 4, bottom: 8 }}>
              <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
              <XAxis type="number" dataKey="t" domain={['dataMin', 'dataMax']} ticks={timeTicks} {...axisProps}
                tickFormatter={(t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })} />
              <YAxis domain={['auto', 'auto']} tickFormatter={(v: number) => v.toFixed(2)} width={44} {...axisProps} />
              <Tooltip contentStyle={tip} labelFormatter={(t: number) => fmtDayShort(new Date(t))}
                formatter={(v: number) => [v.toFixed(2), 'Put / call']} />
              <ReferenceLine y={1} stroke="rgba(200,220,240,0.3)" strokeDasharray="4 3" />
              <ReferenceLine x={series.dates[day].getTime()} stroke="#f4f7fa" strokeOpacity={0.5} />
              <Line type="monotone" dataKey="pcr" stroke="#d6ad66" strokeWidth={1.8} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top strikes */}
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={{ color: FG1, fontSize: 14, fontWeight: 600, padding: '12px 14px 4px' }}>Largest open interest · {fmtDayShort(series.dates[day])}</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: FG3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {['Strike', 'Type', 'Rate', 'Open interest', 'Share of total', 'Δ 1 day', 'Δ 1 week', 'vs futures'].map((c, i) => (
                <th key={c} style={{ padding: '8px 14px', textAlign: i < 2 ? 'left' : 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {top.map(r => {
              const td: React.CSSProperties = { padding: '7px 14px', textAlign: 'right', color: FG2, whiteSpace: 'nowrap' }
              return (
                <tr key={`${r.K}-${r.type}`} style={{ borderTop: `1px solid ${BORDER}`, fontFamily: MONO }}>
                  <td style={{ ...td, textAlign: 'left', color: FG1 }}>{r.K.toFixed(4)}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: r.type === 'Call' ? OI_CALL : OI_PUT }} />{r.type}
                    </span>
                  </td>
                  <td style={{ ...td, color: FG3 }}>{(100 - r.K).toFixed(3)}%</td>
                  <td style={td}>{fmtLots(r.oi)}</td>
                  <td style={td}>{((r.oi / tot) * 100).toFixed(1)}%</td>
                  <td style={td}>{fmtSigned(r.d1)}</td>
                  <td style={td}>{fmtSigned(r.d5)}</td>
                  <td style={{ ...td, color: FG3 }}>{`${((r.K - series.F[day]) * 100) > 0 ? '+' : ''}${((r.K - series.F[day]) * 100).toFixed(1)} bp`}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p style={{ color: FG4, fontSize: 10, marginTop: 10, lineHeight: 1.5 }}>
        End-of-day open interest in lots, by listed strike (0.0625). ICE publishes OI the next morning, so the latest day is the last business
        day before the snapshot date. Max pain = the settlement strike at which option holders' total intrinsic payout would be smallest.
        Puts on the future gain when rates rise. {market.simOpenInterest ? 'Simulated open interest.' : 'Bloomberg OPEN_INT by strike; strikes never holding open interest are left out.'}
      </p>
    </>
  )
}
