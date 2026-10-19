import { useMemo, useState } from 'react'
import { CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { londonNow, snapToSession, toDateInput, toTimeInput } from '../model/calendar'
import { extractDistribution, toAxis } from '../model/distribution'
import type { AxisMode } from '../model/distribution'
import { PACKS } from '../model/types'
import type { DistResult, DistStats, Market } from '../model/types'
import { BORDER, Chip, FG1, FG2, FG3, FG4, Label, MONO, axisProps, card, inputStyle, niceTicks, pdfAxis, peakOf, sourceNote } from '../ui'
import { useMarketsAt } from '../useMarket'

// ─── Tab 2 — Cross-time comparisons ───────────────────────────────────────────

export interface CrossTimeState {
  contractId: string | null
  expiryId: string | null
  dates: string[] | null        // comparison snapshots "YYYY-MM-DDTHH:MM" (London); null → defaults
}

const MAX_DATES = 6             // including the reference snapshot
const PRESETS: { key: string; label: string; shift: (d: Date) => void }[] = [
  { key: '1D', label: '−1D', shift: d => d.setUTCDate(d.getUTCDate() - 1) },
  { key: '1W', label: '−1W', shift: d => d.setUTCDate(d.getUTCDate() - 7) },
  { key: '1M', label: '−1M', shift: d => d.setUTCMonth(d.getUTCMonth() - 1) },
  { key: '3M', label: '−3M', shift: d => d.setUTCMonth(d.getUTCMonth() - 3) },
  { key: '6M', label: '−6M', shift: d => d.setUTCMonth(d.getUTCMonth() - 6) },
]

const toKey = (d: Date) => d.toISOString().slice(0, 16)
const fromKey = (k: string) => new Date(`${k}:00Z`)

function presetKey(ref: Date, key: string): string {
  const d = new Date(ref)
  PRESETS.find(p => p.key === key)!.shift(d)
  return toKey(d)
}

// Single-hue (glacier) ramp: oldest faint → reference brightest
function timeRamp(n: number): string[] {
  const a = [0x3f, 0x5b, 0x6e], b = [0xa9, 0xd8, 0xef]
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 1 : i / (n - 1)
    return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * t).toString(16).padStart(2, '0')).join('')
  })
}

const fmtShort = (d: Date) =>
  `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' })} ` +
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

export default function CrossTimeTab({ market, h, axis, setAxis, controls, state, setState }: {
  market: Market; h: number
  axis: AxisMode; setAxis: (a: AxisMode) => void
  controls: React.ReactNode
  state: CrossTimeState; setState: (f: (s: CrossTimeState) => CrossTimeState) => void
}) {
  const [draftDate, setDraftDate] = useState('')
  const { contracts, snap } = market
  const sim = market.source === 'simulation'
  const [draftTime, setDraftTime] = useState(toTimeInput(snap))

  const contract = contracts.find(c => c.id === state.contractId) ?? contracts[1]
  const expiries = useMemo(() => market.expiries(contract), [market, contract])
  const expiry   = expiries.find(e => e.id === state.expiryId) ?? expiries[Math.min(2, expiries.length - 1)] ?? null

  const compKeys = state.dates ?? ['1W', '1M', '3M'].map(k => presetKey(snap, k))

  // Comparison moments: the simulation snaps each to a trading moment; live data are daily
  // settlements, resolved by the backend to the last trading day on or before each date
  const moments = useMemo(() => {
    const now = londonNow()
    return compKeys.map(k => ({ key: k, raw: fromKey(k) })).filter(m => !isNaN(m.raw.getTime()))
      .map(m => ({ key: m.key, at: sim ? snapToSession(m.raw > now ? now : m.raw) : m.raw }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compKeys.join(','), sim])
  const others = useMarketsAt(market.source, moments.map(m => m.at))
  const pending = others.filter(m => !m).length

  // Re-extract the same contract × expiry in each market; keep those before the expiry, dedupe, sort
  const series = useMemo(() => {
    if (!expiry) return []
    const seen = new Map<number, { at: Date; key: string | null; dist: DistResult }>()
    const add = (mk: Market, key: string | null) => {
      const at = mk.snap
      if (at >= expiry.date || seen.has(at.getTime())) return
      const c = mk.contracts.find(x => x.id === contract.id)
      const e = c && mk.expiries(c).find(x => x.id === expiry.id)
      const ch = c && e ? mk.chain(c, e) : null
      if (ch) seen.set(at.getTime(), { at, key, dist: extractDistribution(ch, h) })
    }
    add(market, null)
    others.forEach((mk, i) => { if (mk) add(mk, moments[i].key) })
    const list = [...seen.values()].sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-MAX_DATES)
    const colors = timeRamp(list.length)
    return list.map(({ at, key, dist }, i) => ({
      id: String(at.getTime()), key, at, isRef: key === null,
      name: key === null ? `${fmtShort(at)} (ref)` : fmtShort(at),
      color: colors[i], dist,
    }))
  }, [market, others, moments, contract, expiry, h])

  const merged = useMemo(() => {
    const rows = new Map<number, Record<string, number>>()
    series.forEach(s => toAxis(s.dist.points, axis).forEach(p => {
      const x = +p.x.toFixed(6)
      const row = rows.get(x) ?? { x }
      row[`${s.id}_pdf`] = p.pdf
      row[`${s.id}_cdf`] = p.cdf
      rows.set(x, row)
    }))
    return [...rows.values()].sort((a, b) => a.x - b.x)
  }, [series, axis])

  const fmtX   = (v: number) => v.toFixed(axis === 'price' ? 3 : 2)
  const xTicks = merged.length ? niceTicks(merged[0].x, merged[merged.length - 1].x) : []
  const ref    = series.find(s => s.isRef)

  const setDates = (f: (keys: string[]) => string[]) => setState(s => ({ ...s, dates: f(compKeys) }))
  const addKey = (k: string) => setDates(keys => keys.includes(k) || keys.length >= MAX_DATES - 1 ? keys : [...keys, k])
  const full   = compKeys.length >= MAX_DATES - 1

  // Stats in axis units: price quantile p ↔ rate quantile 1−p
  const median = (st: DistStats) => axis === 'price' ? st.q50 : 100 - st.q50
  const band   = (st: DistStats) => axis === 'price' ? [st.q05, st.q95] : [100 - st.q95, 100 - st.q05]
  const fwd    = (F: number) => axis === 'price' ? F : 100 - F
  const dBp    = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}`

  const chart = (kind: 'pdf' | 'cdf') => (
    <div style={{ ...card, padding: '16px 16px 8px' }}>
      <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>
        {kind === 'pdf' ? 'Probability density' : 'Cumulative distribution'}
      </div>
      <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
        {expiry?.code} options on {contract.label} · {series.length} snapshots
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={merged} margin={{ top: 10, right: 16, left: 4, bottom: 24 }}>
          <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
          <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps}
            label={{ value: axis === 'price' ? 'Futures price at expiry' : 'Implied rate at expiry (%)', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
          <YAxis width={40} {...axisProps}
            {...(kind === 'cdf'
              ? { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1], tickFormatter: (v: number) => `${(v * 100).toFixed(0)}%` }
              : { ...pdfAxis(peakOf(merged, '_pdf')), tickFormatter: (v: number) => (+v.toFixed(2)).toString() })} />
          <Tooltip
            contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
            labelFormatter={(v: number) => fmtX(Number(v))}
            formatter={(v: number, name: string) => [kind === 'cdf' ? `${(v * 100).toFixed(1)}%` : v.toFixed(3), name]}
          />
          {ref && (
            <ReferenceLine x={fwd(ref.dist.F)} stroke="rgba(200,220,240,0.35)" strokeDasharray="5 3"
              label={{ value: `F ref ${fmtX(fwd(ref.dist.F))}`, position: kind === 'pdf' ? 'insideTopRight' : 'insideTopLeft', fill: FG3, fontSize: 10 }} />
          )}
          {series.map(s => (
            <Line key={s.id} type="monotone" dataKey={`${s.id}_${kind}`} name={s.name} stroke={s.color}
              strokeWidth={s.isRef ? 2.5 : 1.6} dot={false} connectNulls isAnimationActive={false} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )

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
                  <Chip key={c.id} active={c.id === contract.id}
                    onClick={() => setState(s => ({ ...s, contractId: c.id, expiryId: null }))}>{c.label}</Chip>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Expiry</Label></span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
            {expiries.map(e => (
              <Chip key={e.id} active={e.id === expiry?.id} onClick={() => setState(s => ({ ...s, expiryId: e.id }))}
                title={`${e.code} · ${e.kind} · expires ${e.date.toISOString().slice(0, 10)} 10:00 London`}>
                <span style={{ fontFamily: MONO }}>{e.code}</span>
                <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{e.label}</span>
              </Chip>
            ))}
          </div>
        </div>
        {controls}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Compare to</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {series.map(s => (
                <span key={s.id} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 10px', borderRadius: 6,
                  border: `1px solid ${BORDER}`, background: 'rgba(200,220,240,0.03)', fontSize: 12, fontFamily: MONO, color: FG2,
                }}>
                  <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke={s.color} strokeWidth={s.isRef ? 3 : 2} /></svg>
                  {s.name}
                  {s.isRef
                    ? <span style={{ color: FG4, fontSize: 10, padding: '0 4px', fontFamily: 'inherit' }} title="Set by the snapshot control above">fixed</span>
                    : <button onClick={() => setDates(keys => keys.filter(k => k !== s.key))} title="Remove"
                        style={{ background: 'none', border: 'none', color: FG3, cursor: 'pointer', fontSize: 13, padding: '0 4px' }}>×</button>}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {PRESETS.map(p => (
                <Chip key={p.key} active={false} onClick={() => addKey(presetKey(snap, p.key))}
                  title={full ? `Up to ${MAX_DATES} snapshots` : `Add the snapshot ${p.label.slice(1)} before the reference`}>
                  {p.label}
                </Chip>
              ))}
              <span style={{ width: 8 }} />
              <input type="date" value={draftDate} max={toDateInput(snap)} onChange={e => setDraftDate(e.target.value)} style={inputStyle} />
              {sim && <input type="time" value={draftTime} step={300} onChange={e => e.target.value && setDraftTime(e.target.value)} style={inputStyle} />}
              <button disabled={!draftDate || full} onClick={() => { addKey(`${draftDate}T${sim ? draftTime : toTimeInput(snap)}`); setDraftDate('') }}
                style={{ ...inputStyle, background: 'rgba(200,220,240,0.05)', border: `1px solid ${BORDER}`, color: FG2,
                  cursor: draftDate && !full ? 'pointer' : 'default', opacity: draftDate && !full ? 1 : 0.5, fontFamily: 'inherit' }}>
                Add date
              </button>
              {full && <span style={{ color: FG4, fontSize: 11 }}>Max {MAX_DATES} snapshots — remove one to add another</span>}
              {pending > 0 && <span style={{ color: FG3, fontSize: 11 }}>Loading {pending} snapshot{pending > 1 ? 's' : ''} from Bloomberg…</span>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Label>Axis</Label>
          <Chip active={axis === 'price'} onClick={() => setAxis('price')}>Futures price</Chip>
          <Chip active={axis === 'rate'} onClick={() => setAxis('rate')}>Implied rate</Chip>
        </div>
      </div>

      {!expiry || series.length === 0 ? (
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>
          No option expiries for {contract.label} at the reference snapshot.
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, marginBottom: 16 }}>
            {chart('pdf')}
            {chart('cdf')}
          </div>
          <div style={{ ...card, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: FG3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {['Snapshot', 'Futures', 'Days', 'ATM vol', 'Std dev', 'Skew', 'Median', '5–95%', 'Median Δ since', 'Std Δ since'].map((c, i) => (
                    <th key={c} style={{ padding: '10px 14px', textAlign: i === 0 ? 'left' : 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {series.map(({ id, name, color, isRef, dist }) => {
                  const st = dist.stats
                  const [lo, hi] = band(st)
                  const dMed = ref ? median(ref.dist.stats) - median(st) : 0
                  const dStd = ref ? ref.dist.stats.std - st.std : 0
                  const td: React.CSSProperties = { padding: '8px 14px', textAlign: 'right', color: FG2, whiteSpace: 'nowrap' }
                  return (
                    <tr key={id} style={{ borderTop: `1px solid ${BORDER}`, fontFamily: MONO }}>
                      <td style={{ ...td, textAlign: 'left', color: FG1 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth={isRef ? 3 : 2} /></svg>{name}
                        </span>
                      </td>
                      <td style={td}>{fmtX(fwd(dist.F))}</td>
                      <td style={td}>{(dist.T * 365).toFixed(0)}</td>
                      <td style={td}>{(dist.atmVol * 100).toFixed(0)} bp</td>
                      <td style={td}>{(st.std * 100).toFixed(1)} bp</td>
                      <td style={td}>{(axis === 'price' ? st.skew : -st.skew).toFixed(2)}</td>
                      <td style={td}>{fmtX(median(st))}</td>
                      <td style={td}>{fmtX(lo)}–{fmtX(hi)}</td>
                      <td style={{ ...td, color: isRef ? FG4 : FG2 }}>{isRef ? '—' : `${dBp(dMed)} bp`}</td>
                      <td style={{ ...td, color: isRef ? FG4 : FG2 }}>{isRef ? '—' : `${dBp(dStd)} bp`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ color: FG4, fontSize: 10, marginTop: 10 }}>
            Each snapshot re-extracts the same {expiry.code} options on {contract.label} with that day's forward, vol and time to expiry.
            {sim ? 'Snapshots outside trading hours snap to the previous close.' : 'Past snapshots use that day’s settlement (the last trading day on or before the date).'}
            {' '}“Δ since” = reference minus that snapshot, i.e. how far it has moved since then, in {axis === 'price' ? 'price' : 'rate'} terms. {sourceNote(market)}.
          </p>
        </>
      )}
    </>
  )
}
