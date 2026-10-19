import { useMemo, useState } from 'react'
import { Area, Brush, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { extractDistribution } from '../model/distribution'
import type { AxisMode } from '../model/distribution'
import { PACKS } from '../model/types'
import type { Contract, DistResult, DistStats, Market, OptionExpiry } from '../model/types'
import { BORDER, Chip, FG1, FG2, FG3, FG4, Label, MONO, axisProps, card, inputStyle, niceTicks, pdfAxis, sourceNote } from '../ui'

// ─── Tab 3 — Cross-section ────────────────────────────────────────────────────
//
// One snapshot, many (underlying, expiry) pairs: a base PDF (shaded) against
// overlays that can differ in expiry, underlying, or both — plus each overlay's
// difference from the base. "Centred" puts every distribution on its own
// forward (bp from F) so shapes can be compared across underlyings.

interface SeriesRef { contractId: string; expiryId: string }

export interface CrossSectionState {
  base: SeriesRef | null           // null → 2nd contract, its standard expiry
  overlays: SeriesRef[] | null     // null → the two expiries before the base, same underlying
  centred: boolean
  measure: 'pdf' | 'cdf'
}

const MAX_OVERLAYS = 4
// Fixed categorical order for overlays (base is the glacier fill)
const OVERLAY_COLORS = ['#d6ad66', '#6fc2a2', '#b79fdb', '#dd8a7d']

const seriesName = (c: Contract, e: OptionExpiry) => (e.code === c.id ? c.id : `${e.code} on ${c.id}`)

function defaultExpiry(exps: OptionExpiry[]): OptionExpiry | undefined {
  return exps.find(e => e.kind === 'standard') ?? exps[exps.length - 1]
}

type AxisPoint = { x: number; pdf: number; cdf: number }

// Points on the chosen axis; centred → bp from the series' own forward.
// CDF is P(price ≤ x) on the price axis and P(rate ≤ x) on the rate axis.
function axisPoints(dist: DistResult, axis: AxisMode, centred: boolean): AxisPoint[] {
  const pts = dist.points.map(p => {
    const x = centred
      ? (axis === 'price' ? (p.strike - dist.F) * 100 : (dist.F - p.strike) * 100)
      : (axis === 'price' ? p.strike : p.rate)
    return { x, pdf: p.pdf, cdf: axis === 'price' ? p.cdf : 1 - p.cdf }
  })
  return pts.sort((a, b) => a.x - b.x)
}

// Linear interpolation; outside a series' grid the PDF is 0 and the CDF is 0 / 1
function interpAt(pts: AxisPoint[], x: number, field: 'pdf' | 'cdf'): number {
  if (!pts.length) return 0
  if (x < pts[0].x) return 0
  if (x > pts[pts.length - 1].x) return field === 'cdf' ? 1 : 0
  const k = pts.findIndex(p => p.x >= x)
  if (k <= 0) return pts[0][field]
  const a = pts[k - 1], b = pts[k]
  return a[field] + (b[field] - a[field]) * (x - a.x) / (b.x - a.x)
}

export default function CrossSectionTab({ market, h, axis, setAxis, controls, state, setState }: {
  market: Market; h: number
  axis: AxisMode; setAxis: (a: AxisMode) => void
  controls: React.ReactNode
  state: CrossSectionState; setState: (f: (s: CrossSectionState) => CrossSectionState) => void
}) {
  const { contracts } = market
  const expOf = useMemo(() => {
    const m = new Map<string, OptionExpiry[]>()
    contracts.forEach(c => m.set(c.id, market.expiries(c)))
    return m
  }, [market, contracts])
  const distOf = (c: Contract, e: OptionExpiry): DistResult | null => {
    const ch = market.chain(c, e)
    return ch ? extractDistribution(ch, h) : null
  }

  // Resolve a reference to live (contract, expiry), or null if it has rolled off
  const resolve = (r: SeriesRef | null) => {
    if (!r) return null
    const c = contracts.find(x => x.id === r.contractId)
    const e = c && expOf.get(c.id)!.find(x => x.id === r.expiryId)
    return c && e ? { c, e } : null
  }

  const base = resolve(state.base) ?? (() => {
    const c = contracts[1], e = defaultExpiry(expOf.get(c.id)!)
    return e ? { c, e } : null
  })()

  const overlays = (() => {
    if (!base) return []
    const refs = state.overlays ?? (() => {
      const exps = expOf.get(base.c.id)!
      const i = exps.indexOf(base.e)
      return exps.slice(Math.max(0, i - 2), i).map(e => ({ contractId: base.c.id, expiryId: e.id }))
    })()
    return refs.map(resolve)
      .filter((x): x is { c: Contract; e: OptionExpiry } => !!x && !(x.c.id === base.c.id && x.e.id === base.e.id))
      .slice(0, MAX_OVERLAYS)
  })()
  const overlayRefs = overlays.map(o => ({ contractId: o.c.id, expiryId: o.e.id }))
  const setOverlays = (refs: SeriesRef[]) => setState(s => ({ ...s, overlays: refs }))
  const setBase = (r: SeriesRef) => setState(s => ({ ...s, base: r, overlays: s.overlays ?? overlayRefs }))

  // "Add" picker: underlying + expiry
  const [pickC, setPickC] = useState<string>('')
  const [pickE, setPickE] = useState<string>('')
  const addC = contracts.find(c => c.id === pickC) ?? base?.c ?? contracts[0]
  const addExps = (expOf.get(addC.id) ?? []).filter(e =>
    !(addC.id === base?.c.id && e.id === base?.e.id) && !overlayRefs.some(r => r.contractId === addC.id && r.expiryId === e.id))
  const addE = addExps.find(e => e.id === pickE) ?? defaultExpiry(addExps)
  const full = overlays.length >= MAX_OVERLAYS

  const baseDist = useMemo(() => base ? distOf(base.c, base.e) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base?.c.id, base?.e.id, market, h])
  const series = useMemo(() => overlays.flatMap((o, i) => {
    const dist = distOf(o.c, o.e)
    return dist ? [{
      key: `o${i}`, c: o.c, e: o.e, name: seriesName(o.c, o.e),
      color: OVERLAY_COLORS[i % OVERLAY_COLORS.length], dist,
    }] : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [overlays.map(o => `${o.c.id}:${o.e.id}`).join(','), market, h])

  // Common grid: strike spacing (level) or h in bp (centred)
  const centred = state.centred
  const measure = state.measure
  const isCdf   = measure === 'cdf'
  const merged = useMemo(() => {
    if (!baseDist) return []
    const all = [{ key: 'base', pts: axisPoints(baseDist, axis, centred) },
      ...series.map(s => ({ key: s.key, pts: axisPoints(s.dist, axis, centred) }))]
    const step = centred ? h * 100 : h
    const lo = Math.min(...all.map(a => a.pts[0].x)), hi = Math.max(...all.map(a => a.pts[a.pts.length - 1].x))
    const rows: Record<string, number>[] = []
    for (let x = Math.ceil(lo / step - 1e-9) * step; x <= hi + 1e-9; x += step) {
      const row: Record<string, number> = { x: +x.toFixed(6) }
      all.forEach(a => { row[a.key] = interpAt(a.pts, x, measure) })
      series.forEach(s => { row[`${s.key}_diff`] = row[s.key] - row.base })
      rows.push(row)
    }
    return rows
  }, [baseDist, series, axis, centred, measure, h])

  // Strike-range zoom shared by both charts (indices into `merged`)
  const [range, setRange] = useState<[number, number] | null>(null)
  const lo = range && range[1] < merged.length ? range[0] : 0
  const hi = range && range[1] < merged.length ? range[1] : merged.length - 1
  const view = merged.slice(lo, hi + 1)

  const fmtX   = (v: number) => centred ? `${v > 0 ? '+' : ''}${v.toFixed(0)}` : v.toFixed(axis === 'price' ? 3 : 2)
  const xTicks = view.length ? niceTicks(view[0].x, view[view.length - 1].x) : []
  const fwdX   = (F: number) => centred ? 0 : axis === 'price' ? F : 100 - F
  const xLabel = centred
    ? `Distance from each forward (bp, ${axis === 'price' ? 'price' : 'rate'} terms)`
    : axis === 'price' ? 'Strike (futures price at expiry)' : 'Implied rate at expiry (%)'

  const pdfPeak  = Math.max(0, ...view.map(r => Math.max(r.base ?? 0, ...series.map(s => r[s.key] ?? 0))))
  const diffMax  = Math.max(1e-9, ...view.flatMap(r => series.map(s => Math.abs(r[`${s.key}_diff`] ?? 0))))
  const diffAxis = pdfAxis(diffMax)
  const fmtVal   = (v: number) => isCdf ? `${(v * 100).toFixed(1)}%` : v.toFixed(3)
  const fmtDiff  = (v: number) => isCdf ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}pp` : `${v > 0 ? '+' : ''}${v.toFixed(3)}`
  const cdfLabel = axis === 'price' ? 'P(price ≤ x)' : 'P(rate ≤ x)'
  const diffTicks = [...diffAxis.ticks.slice(1).map(t => -t).reverse(), ...diffAxis.ticks]

  const median = (st: DistStats) => axis === 'price' ? st.q50 : 100 - st.q50
  const band   = (st: DistStats) => axis === 'price' ? [st.q05, st.q95] : [100 - st.q95, 100 - st.q05]
  const fmtLvl = (v: number) => v.toFixed(axis === 'price' ? 3 : 2)

  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer', fontFamily: MONO }
  const resetZoom = () => setRange(null)

  return (
    <>
      <div style={{ ...card, padding: '16px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Base */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Base</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {PACKS.map(pk => (
              <div key={pk.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: pk.shades[2], fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', width: 46 }}>{pk.label}</span>
                {contracts.filter(c => c.pack === pk.id).map(c => (
                  <Chip key={c.id} active={c.id === base?.c.id}
                    onClick={() => {
                      const e = defaultExpiry(expOf.get(c.id)!)
                      if (e) { setBase({ contractId: c.id, expiryId: e.id }); resetZoom() }
                    }}>{c.label}</Chip>
                ))}
              </div>
            ))}
            {base && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                <span style={{ color: FG3, fontSize: 11, width: 46 }}>expiry</span>
                <select value={base.e.id} style={selectStyle}
                  onChange={ev => setBase({ contractId: base.c.id, expiryId: ev.target.value })}>
                  {expOf.get(base.c.id)!.map(e => <option key={e.id} value={e.id}>{e.code} · {e.label}{e.kind === 'standard' ? ' · standard' : ''}</option>)}
                </select>
                <span style={{ color: FG4, fontSize: 11 }}>shaded</span>
              </div>
            )}
          </div>
        </div>

        {/* Overlays */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Overlays</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minHeight: 28 }}>
              {series.length === 0 && <span style={{ color: FG4, fontSize: 12 }}>None — add an expiry or another underlying below</span>}
              {series.map((s, i) => (
                <span key={s.key} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 10px', borderRadius: 6,
                  border: `1px solid ${BORDER}`, background: 'rgba(200,220,240,0.03)', fontSize: 12, color: FG2,
                }}>
                  <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={s.color} strokeWidth="2" /><circle cx="9" cy="4" r="3" fill={s.color} /></svg>
                  <span style={{ fontFamily: MONO }}>{s.name}</span>
                  <span style={{ color: FG3, fontSize: 11 }}>{s.e.label}</span>
                  <button onClick={() => setOverlays(overlayRefs.filter((_, j) => j !== i))} title="Remove"
                    style={{ background: 'none', border: 'none', color: FG3, cursor: 'pointer', fontSize: 13, padding: '0 4px' }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={addC.id} onChange={ev => { setPickC(ev.target.value); setPickE('') }} style={selectStyle} disabled={full}>
                {PACKS.map(pk => (
                  <optgroup key={pk.id} label={pk.label}>
                    {contracts.filter(c => c.pack === pk.id).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </optgroup>
                ))}
              </select>
              <select value={addE?.id ?? ''} onChange={ev => setPickE(ev.target.value)} style={selectStyle} disabled={full || !addExps.length}>
                {addExps.map(e => <option key={e.id} value={e.id}>{e.code} · {e.label}{e.kind === 'standard' ? ' · standard' : ''}</option>)}
              </select>
              <button
                disabled={full || !addE}
                onClick={() => addE && setOverlays([...overlayRefs, { contractId: addC.id, expiryId: addE.id }])}
                title={full ? `Up to ${MAX_OVERLAYS} overlays` : 'Add this underlying / expiry'}
                style={{ ...inputStyle, cursor: !full && addE ? 'pointer' : 'default', opacity: !full && addE ? 1 : 0.5, fontFamily: 'inherit' }}>
                + Add
              </button>
              {series.length > 0 && (
                <button onClick={() => setOverlays([])} title="Remove all overlays"
                  style={{ ...inputStyle, background: 'rgba(217,112,94,0.08)', border: '1px solid rgba(217,112,94,0.25)', color: '#e2826f', cursor: 'pointer', fontFamily: 'inherit' }}>
                  Clear
                </button>
              )}
              {full && <span style={{ color: FG4, fontSize: 11 }}>Max {MAX_OVERLAYS} overlays</span>}
            </div>
          </div>
        </div>
        {controls}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Label>Axis</Label>
          <Chip active={axis === 'price'} onClick={() => { setAxis('price'); resetZoom() }}>Futures price</Chip>
          <Chip active={axis === 'rate'} onClick={() => { setAxis('rate'); resetZoom() }}>Implied rate</Chip>
          <span style={{ width: 12 }} />
          <Chip active={!centred} onClick={() => { setState(s => ({ ...s, centred: false })); resetZoom() }}>Level</Chip>
          <Chip active={centred} onClick={() => { setState(s => ({ ...s, centred: true })); resetZoom() }}
            title="Plot each distribution against its distance from its own forward, to compare shapes across underlyings">
            Centred on forward
          </Chip>
          <span style={{ width: 12 }} />
          <Chip active={!isCdf} onClick={() => setState(s => ({ ...s, measure: 'pdf' }))}>PDF</Chip>
          <Chip active={isCdf} onClick={() => setState(s => ({ ...s, measure: 'cdf' }))}>CDF</Chip>
        </div>
      </div>

      {!base || !baseDist ? (
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>
          No option expiries for the base underlying at this snapshot.
        </div>
      ) : (
        <>
          <div style={{ ...card, padding: '16px 16px 8px', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Cross-section {isCdf ? `CDF · ${cdfLabel}` : 'PDF'}</div>
              <div style={{ color: FG3, fontSize: 11 }}>
                base {seriesName(base.c, base.e)} ({base.e.label}) shaded · overlays dotted
                {centred ? ' · centred on each forward' : ''}
              </div>
              {range && (
                <button onClick={resetZoom} style={{ marginLeft: 'auto', ...inputStyle, background: 'rgba(200,220,240,0.05)', border: `1px solid ${BORDER}`, color: FG2, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Reset range
                </button>
              )}
            </div>
            {/* Legend */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '10px 0 4px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: FG2, fontSize: 12 }}>
                <svg width="22" height="10"><rect x="0" y="2" width="22" height="8" rx="2" fill="#86c0de" fillOpacity="0.3" /><line x1="0" y1="2" x2="22" y2="2" stroke="#86c0de" strokeWidth="2" /></svg>
                <span style={{ fontFamily: MONO }}>{seriesName(base.c, base.e)}</span> base
              </span>
              {series.map(s => (
                <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, color: FG2, fontSize: 12 }}>
                  <svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke={s.color} strokeWidth="2" /><circle cx="11" cy="5" r="3" fill={s.color} /></svg>
                  <span style={{ fontFamily: MONO }}>{s.name}</span>
                </span>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={view} margin={{ top: 18, right: 16, left: 4, bottom: 8 }}>
                <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps} allowDataOverflow />
                <YAxis width={40} {...axisProps}
                  {...(isCdf
                    ? { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1], tickFormatter: (v: number) => `${(v * 100).toFixed(0)}%` }
                    : { ...pdfAxis(pdfPeak), tickFormatter: (v: number) => (+v.toFixed(2)).toString() })} />
                <Tooltip
                  contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                  labelFormatter={(v: number) => centred ? `${fmtX(Number(v))} bp from F` : fmtX(Number(v))}
                  formatter={(v: number, name: string) => [fmtVal(v), name]}
                />
                {isCdf && [0.05, 0.5, 0.95].map(p => (
                  <ReferenceLine key={p} y={p} stroke="rgba(150,178,205,0.16)" strokeDasharray="2 4" />
                ))}
                <ReferenceLine x={fwdX(baseDist.F)} stroke="#e2826f" strokeOpacity={0.7} strokeDasharray="4 3"
                  label={{ value: centred ? 'Forward' : `ATM ${fmtLvl(fwdX(baseDist.F))}`, position: 'top', fill: '#e2826f', fontSize: 10 }} />
                {!centred && series.filter(s => s.c.id !== base.c.id).map(s => (
                  <ReferenceLine key={`f${s.key}`} x={fwdX(s.dist.F)} stroke={s.color} strokeOpacity={0.6} strokeDasharray="2 3" />
                ))}
                <Area type="monotone" dataKey="base" name={`${seriesName(base.c, base.e)} (base)`} stroke="#86c0de" fill="#86c0de"
                  fillOpacity={0.22} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                {series.map(s => (
                  <Line key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2}
                    dot={{ r: 2.5, fill: s.color, stroke: s.color }} activeDot={{ r: 4 }} isAnimationActive={false} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>

            {/* Range slider (drives both charts) */}
            <div style={{ padding: '4px 20px 4px 48px' }}>
              <ResponsiveContainer width="100%" height={34}>
                <ComposedChart data={merged} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <XAxis dataKey="x" hide />
                  <Area type="monotone" dataKey="base" stroke="none" fill="#86c0de" fillOpacity={0.12} isAnimationActive={false} />
                  <Brush dataKey="x" height={30} stroke="rgba(134,192,222,0.5)" fill="rgba(200,220,240,0.03)"
                    travellerWidth={8} startIndex={lo} endIndex={hi} tickFormatter={(v: number) => fmtX(Number(v))}
                    onChange={(r: { startIndex?: number; endIndex?: number }) => {
                      if (r.startIndex === undefined || r.endIndex === undefined) return
                      setRange(r.startIndex === 0 && r.endIndex === merged.length - 1 ? null : [r.startIndex, r.endIndex])
                    }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Difference vs base */}
            <div style={{ color: FG2, fontSize: 12, fontWeight: 600, margin: '14px 0 2px' }}>
              Difference vs base <span style={{ color: FG4, fontWeight: 400 }}>· overlay − {seriesName(base.c, base.e)}, {isCdf ? 'cumulative probability (pp)' : 'density'}</span>
            </div>
            {series.length === 0 ? (
              <div style={{ color: FG4, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Add an overlay to compare against the base.</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={view} margin={{ top: 8, right: 16, left: 4, bottom: 24 }}>
                  <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                  <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps} allowDataOverflow
                    label={{ value: xLabel, position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                  <YAxis domain={[-diffAxis.domain[1], diffAxis.domain[1]]} ticks={diffTicks}
                    tickFormatter={(v: number) => isCdf ? `${+(v * 100).toFixed(1)}` : (+v.toFixed(2)).toString()} width={40} {...axisProps} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                    labelFormatter={(v: number) => centred ? `${fmtX(Number(v))} bp from F` : fmtX(Number(v))}
                    formatter={(v: number, name: string) => [fmtDiff(v), name]}
                  />
                  <ReferenceLine y={0} stroke="rgba(200,220,240,0.35)" />
                  <ReferenceLine x={fwdX(baseDist.F)} stroke="#e2826f" strokeOpacity={0.5} strokeDasharray="4 3" />
                  {series.map(s => (
                    <Line key={s.key} type="linear" dataKey={`${s.key}_diff`} name={`${s.name} − base`} stroke={s.color}
                      strokeWidth={2} dot={{ r: 2.5, fill: s.color, stroke: s.color }} activeDot={{ r: 4 }} isAnimationActive={false} />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Summary */}
          <div style={{ ...card, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: FG3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {['Series', 'Futures', 'Expires', 'Days', 'Std dev', 'Std vs base', 'Skew', 'Median', '5–95%', isCdf ? 'Largest Δ prob.' : 'Largest Δ density'].map((c, i) => (
                    <th key={c} style={{ padding: '10px 14px', textAlign: i === 0 ? 'left' : 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[{ key: 'base', name: seriesName(base.c, base.e), e: base.e, color: '#86c0de', dist: baseDist, isBase: true },
                  ...series.map(s => ({ ...s, isBase: false }))].map(({ key, name, e, color, dist, isBase }) => {
                  const st = dist.stats
                  const [b5, b95] = band(st)
                  let peak = { x: 0, v: 0 }
                  if (!isBase) merged.forEach(r => { const v = r[`${key}_diff`] ?? 0; if (Math.abs(v) > Math.abs(peak.v)) peak = { x: r.x, v } })
                  const td: React.CSSProperties = { padding: '8px 14px', textAlign: 'right', color: FG2, whiteSpace: 'nowrap' }
                  return (
                    <tr key={key} style={{ borderTop: `1px solid ${BORDER}`, fontFamily: MONO }}>
                      <td style={{ ...td, textAlign: 'left', color: FG1 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {isBase
                            ? <svg width="18" height="10"><rect x="0" y="2" width="18" height="8" rx="2" fill={color} fillOpacity="0.35" /></svg>
                            : <svg width="18" height="10"><line x1="0" y1="5" x2="18" y2="5" stroke={color} strokeWidth="2" /><circle cx="9" cy="5" r="3" fill={color} /></svg>}
                          {name}{isBase && <span style={{ color: FG4, fontSize: 10 }}>base</span>}
                        </span>
                      </td>
                      <td style={td}>{fmtLvl(axis === 'price' ? dist.F : 100 - dist.F)}</td>
                      <td style={td}>{e.label}</td>
                      <td style={td}>{(dist.T * 365).toFixed(0)}</td>
                      <td style={td}>{(st.std * 100).toFixed(1)} bp</td>
                      <td style={{ ...td, color: isBase ? FG4 : FG2 }}>{isBase ? '—' : `${((st.std - baseDist.stats.std) * 100) > 0 ? '+' : ''}${((st.std - baseDist.stats.std) * 100).toFixed(1)} bp`}</td>
                      <td style={td}>{(axis === 'price' ? st.skew : -st.skew).toFixed(2)}</td>
                      <td style={td}>{fmtLvl(median(st))}</td>
                      <td style={td}>{fmtLvl(b5)}–{fmtLvl(b95)}</td>
                      <td style={{ ...td, color: isBase ? FG4 : FG2 }}>
                        {isBase ? '—' : `${isCdf ? fmtDiff(peak.v) : `${peak.v > 0 ? '+' : ''}${peak.v.toFixed(2)}`} @ ${fmtX(peak.x)}${centred ? ' bp' : ''}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ color: FG4, fontSize: 10, marginTop: 10 }}>
            All series at the same snapshot and strike width (h = {h.toFixed(4)}), interpolated onto a common grid for the difference panel.
            Same-underlying overlays show how the distribution builds with time to expiry; other underlyings sit around their own
            forwards (dotted lines) — use “Centred on forward” to compare shapes. {sourceNote(market)}.
          </p>
        </>
      )}
    </>
  )
}
