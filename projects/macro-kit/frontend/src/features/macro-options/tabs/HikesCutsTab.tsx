import { useMemo } from 'react'
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fmtDay } from '../model/calendar'
import { extractDistribution, normPdf } from '../model/distribution'
import { DELTA_MAX_BP, DELTA_PRIOR_SD_BP, OPT_TICK, fitOutcomes } from '../model/outcomes'
import type { OutcomeFit } from '../model/outcomes'
import { ECB_CONFIRMED_THROUGH } from '../model/simulation'
import { PACKS } from '../model/types'
import type { Market } from '../model/types'
import { BORDER, Chip, FG1, FG2, FG3, FG4, Label, MONO, Stat, axisProps, card, inputStyle, niceTicks, pdfAxis, sourceNote } from '../ui'

// ─── Tab 4 — Hikes & cuts (options-implied ECB outcomes, see model/outcomes.ts) ─

// Diverging: cuts cool, hold neutral, hikes warm (deeper = larger move)
function moveColor(bp: number): string {
  if (bp <= -50) return '#5b93b3'
  if (bp < 0) return '#86c0de'
  if (bp === 0) return 'rgba(150,178,205,0.45)'
  if (bp < 50) return '#dd8a7d'
  return '#c8695a'
}

const sbp = (v: number, dp = 1) => `${v > 0.05 ? '+' : v < -0.05 ? '−' : ''}${Math.abs(v).toFixed(dp)}`
const moveLabel = (bp: number) => bp === 0 ? 'Hold' : `${bp > 0 ? '+' : '−'}${Math.abs(bp)}`

function OutcomeBar({ moves, probs, width = 200 }: { moves: number[]; probs: number[]; width?: number }) {
  return (
    <div style={{ display: 'flex', height: 10, width, borderRadius: 2, overflow: 'hidden', background: 'rgba(150,178,205,0.06)' }}>
      {moves.map((m, j) => probs[j] > 0.002 && (
        <div key={m} title={`${moveLabel(m)}: ${(probs[j] * 100).toFixed(0)}%`} style={{ width: `${probs[j] * 100}%`, background: moveColor(m) }} />
      ))}
    </div>
  )
}

export interface HikesState { contractId: string | null; expiryId: string | null }

export default function HikesCutsTab({ market, h, controls, dfr, setDfr, offset, setOffset, state, setState }: {
  market: Market; h: number; controls: React.ReactNode
  dfr: number; setDfr: (v: number) => void
  offset: number; setOffset: (v: number) => void
  state: HikesState; setState: (f: (s: HikesState) => HikesState) => void
}) {
  const { contracts } = market
  const sim = market.source === 'simulation'
  const contract = contracts.find(c => c.id === state.contractId) ?? contracts[0]
  const expiries = useMemo(() => market.expiries(contract), [market, contract])
  // Default: the contract's own (standard) expiry, else the last listed
  const expiry = expiries.find(e => e.id === state.expiryId)
    ?? expiries.find(e => e.kind === 'standard') ?? expiries[expiries.length - 1] ?? null

  const chain = expiry ? market.chain(contract, expiry) : null
  const fit = useMemo(() => expiry && chain ? fitOutcomes(contract, chain, expiry, market.path, dfr, offset) : null,
    [market, contract, chain, expiry, dfr, offset])

  // Term structure across this contract's expiries (coarser grid for speed)
  const term = useMemo(() => expiries.map(e => {
    const ch = market.chain(contract, e)
    return ch ? fitOutcomes(contract, ch, e, market.path, dfr, offset, true) : null
  }).filter((f): f is OutcomeFit => !!f && f.moves.length > 0), [market, contract, expiries, dfr, offset])

  // Market density (Breeden–Litzenberger, rate axis) vs fitted mixture
  const density = useMemo(() => {
    if (!fit || !fit.moves.length || !chain) return []
    const dist = extractDistribution(chain, h)
    const s = fit.noiseBp / 100
    const market = new Map(dist.points.map(p => [+p.rate.toFixed(6), p.pdf]))
    const lo = Math.min(...dist.points.map(p => p.rate)), hi = Math.max(...dist.points.map(p => p.rate))
    const rows: { x: number; market?: number; mixture: number }[] = []
    const sub = Math.max(1, Math.round(h / 0.0125))           // fine grid that still lands on every strike
    for (let i = 0; lo + i * h / sub <= hi + 1e-9; i++) {
      const xr = +(lo + i * h / sub).toFixed(6)
      rows.push({ x: xr, market: market.get(xr), mixture: fit.mus.reduce((a, mu, j) => a + fit.probs[j] * normPdf((xr - mu) / s) / s, 0) })
    }
    return rows
  }, [fit, chain, h])

  const numInput = (value: number, onChange: (v: number) => void, step: number) => (
    <input type="number" value={value} step={step} onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v) }}
      style={{ ...inputStyle, width: 72 }} />
  )

  const ok = fit && fit.moves.length > 0
  const pCut  = ok ? fit.probs.reduce((a, p, j) => a + (fit.moves[j] < 0 ? p : 0), 0) : 0
  const pHold = ok ? fit.probs.reduce((a, p, j) => a + (fit.moves[j] === 0 ? p : 0), 0) : 0
  const pHike = ok ? fit.probs.reduce((a, p, j) => a + (fit.moves[j] > 0 ? p : 0), 0) : 0
  const densPeak = Math.max(0, ...density.map(r => Math.max(r.market ?? 0, r.mixture)))
  const xTicksD = density.length ? niceTicks(density[0].x, density[density.length - 1].x) : []
  const quoteTicks = ok ? niceTicks(fit.quotes[0].strike, fit.quotes[fit.quotes.length - 1].strike) : []

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
                    onClick={() => setState(() => ({ contractId: c.id, expiryId: null }))}>{c.label}</Chip>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Label>Assumptions</Label>
          <span style={{ color: FG3, fontSize: 12 }}>Current DFR</span>
          {numInput(dfr, setDfr, 0.25)}<span style={{ color: FG4, fontSize: 11 }}>%</span>
          {market.dfr !== null && dfr !== market.dfr && (
            <button onClick={() => setDfr(market.dfr!)} title="Reset to the ECB deposit rate (EUORDEPO Index) at the snapshot"
              style={{ ...inputStyle, background: 'rgba(200,220,240,0.05)', border: `1px solid ${BORDER}`, color: FG2, cursor: 'pointer', fontFamily: 'inherit' }}>
              Market {market.dfr.toFixed(2)}%
            </button>
          )}
          <span style={{ width: 12 }} />
          <span style={{ color: FG3, fontSize: 12 }}>Basis offset prior</span>
          {numInput(offset, setOffset, 1)}<span style={{ color: FG4, fontSize: 11 }}>bp</span>
          <span style={{ color: FG4, fontSize: 11 }}>(ESTR − DFR) + (3m Euribor − ESTR); the fit corrects it by δ within ±{DELTA_MAX_BP} bp</span>
        </div>
      </div>

      {!expiry || !fit ? (
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>Not enough option quotes for this expiry.</div>
      ) : (
        <>
          {fit.flags.length > 0 && (
            <div style={{ ...card, padding: '10px 16px', marginBottom: 16, borderColor: 'rgba(214,173,102,0.35)', background: 'rgba(214,173,102,0.06)' }}>
              {fit.flags.map(f => <div key={f} style={{ color: '#dfbb78', fontSize: 12, lineHeight: 1.6 }}>{f}</div>)}
            </div>
          )}

          {ok && (
            <>
              {/* Headline */}
              <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 16 }}>
                <Stat label={`${expiry.code} options on ${contract.label}`} value={expiry.label}
                  sub={`${fit.realised.length} meeting${fit.realised.length > 1 ? 's' : ''} resolved`} />
                <Stat label="P(cut)" value={`${(pCut * 100).toFixed(0)}%`} sub="any cumulative cut" />
                <Stat label="P(hold)" value={`${(pHold * 100).toFixed(0)}%`} sub="no net change" />
                <Stat label="P(hike)" value={`${(pHike * 100).toFixed(0)}%`} sub="any cumulative hike" />
                <Stat label="Options-implied E[Δ]" value={`${sbp(fit.expectedBp)} bp`} sub={`${sim ? 'OIS (sim.)' : '€STR OIS'} ${sbp(fit.oisBp)} bp`} />
                <Stat label="Fit" value={`${fit.rmseTicks.toFixed(2)} ticks`} sub={`noise ${fit.noiseBp.toFixed(1)} bp · δ ${sbp(fit.deltaBp)} bp`} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, marginBottom: 16 }}>
                {/* Outcome probabilities */}
                <div style={{ ...card, padding: '16px 16px 8px' }}>
                  <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Probability by cumulative DFR change</div>
                  <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                    Meetings resolved before {fmtDay(expiry.date)}: {fit.realised.map(m => fmtDay(m.decision)).join(', ')}
                  </div>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={fit.moves.map((m, j) => ({ label: moveLabel(m), m, p: fit.probs[j] }))}
                      margin={{ top: 22, right: 16, left: 4, bottom: 8 }} barCategoryGap="22%">
                      <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="label" {...axisProps} />
                      <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} width={40} {...axisProps} />
                      <Tooltip cursor={{ fill: 'rgba(200,220,240,0.04)' }}
                        contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                        formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, 'Probability']}
                        labelFormatter={(l: string) => `${l === 'Hold' ? 'Hold' : `${l} bp`} → DFR ${(dfr + (fit.moves[fit.moves.findIndex(m => moveLabel(m) === l)] ?? 0) / 100).toFixed(2)}%`} />
                      <Bar dataKey="p" isAnimationActive={false} radius={[3, 3, 0, 0]}
                        label={{ position: 'top', fill: FG2, fontSize: 11, fontFamily: MONO, formatter: (v: number) => v >= 0.005 ? `${(v * 100).toFixed(0)}%` : '' }}>
                        {fit.moves.map(m => <Cell key={m} fill={moveColor(m)} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Density: market vs mixture */}
                <div style={{ ...card, padding: '16px 16px 8px' }}>
                  <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Implied rate density at expiry</div>
                  <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                    Shaded = market (Breeden–Litzenberger) · line = fitted outcome mixture · dotted = scenario centres
                  </div>
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={density} margin={{ top: 22, right: 16, left: 4, bottom: 20 }}>
                      <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                      <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicksD} tickFormatter={(v: number) => v.toFixed(2)} {...axisProps}
                        label={{ value: 'Implied 3m Euribor at expiry (%)', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                      <YAxis {...pdfAxis(densPeak)} tickFormatter={(v: number) => (+v.toFixed(1)).toString()} width={40} {...axisProps} />
                      <Tooltip
                        contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                        labelFormatter={(v: number) => `${Number(v).toFixed(3)}%`}
                        formatter={(v: number, name: string) => [v.toFixed(2), name]} />
                      {fit.mus.map((mu, j) => fit.probs[j] > 0.01 && (
                        <ReferenceLine key={j} x={mu} stroke="rgba(150,178,205,0.35)" strokeDasharray="2 3"
                          label={{ value: moveLabel(fit.moves[j]), position: 'top', fill: FG3, fontSize: 10 }} />
                      ))}
                      <ReferenceLine x={100 - fit.F} stroke="#e2826f" strokeOpacity={0.6} strokeDasharray="4 3" />
                      <Area type="monotone" dataKey="market" name="Market" stroke="#86c0de" fill="#86c0de" fillOpacity={0.2}
                        strokeWidth={1.2} dot={false} connectNulls isAnimationActive={false} />
                      <Line type="monotone" dataKey="mixture" name="Mixture fit" stroke="#d6ad66" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Term structure across expiries */}
              <div style={{ ...card, overflowX: 'auto', marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '12px 14px 4px', flexWrap: 'wrap' }}>
                  <span style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Outcomes by option expiry · {contract.label}</span>
                  {[-50, -25, 0, 25, 50].map(m => (
                    <span key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: FG3, fontSize: 11 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: moveColor(m) }} />{moveLabel(m)}{Math.abs(m) === 50 ? ' or more' : ''}
                    </span>
                  ))}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: FG3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {['Expiry', 'Expires', 'Meetings resolved', 'P(cut)', 'P(hold)', 'P(hike)', 'E[Δ] options', 'E[Δ] OIS', 'Noise', 'Distribution'].map((c, i) => (
                        <th key={c} style={{ padding: '8px 14px', textAlign: i < 3 || i === 9 ? 'left' : 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {term.map(t => {
                      const td: React.CSSProperties = { padding: '7px 14px', textAlign: 'right', color: FG2, whiteSpace: 'nowrap' }
                      const sum = (pred: (m: number) => boolean) => t.probs.reduce((a, p, j) => a + (pred(t.moves[j]) ? p : 0), 0)
                      const sel = t.expiry.id === expiry.id
                      return (
                        <tr key={t.expiry.id} onClick={() => setState(s => ({ ...s, expiryId: t.expiry.id }))}
                          style={{ borderTop: `1px solid ${BORDER}`, fontFamily: MONO, cursor: 'pointer', background: sel ? 'rgba(106,169,204,0.07)' : 'transparent' }}>
                          <td style={{ ...td, textAlign: 'left', color: FG1 }}>{t.expiry.code}</td>
                          <td style={{ ...td, textAlign: 'left', color: FG3 }}>{t.expiry.label}</td>
                          <td style={{ ...td, textAlign: 'left', color: FG3 }}>{t.realised.length}</td>
                          <td style={td}>{(sum(m => m < 0) * 100).toFixed(0)}%</td>
                          <td style={td}>{(sum(m => m === 0) * 100).toFixed(0)}%</td>
                          <td style={td}>{(sum(m => m > 0) * 100).toFixed(0)}%</td>
                          <td style={td}>{sbp(t.expectedBp)} bp</td>
                          <td style={{ ...td, color: FG3 }}>{sbp(t.oisBp)} bp</td>
                          <td style={{ ...td, color: t.flags.some(f => f.startsWith('Noise')) ? '#dfbb78' : FG3 }}>{t.noiseBp.toFixed(1)} bp</td>
                          <td style={{ ...td, textAlign: 'left' }}><OutcomeBar moves={t.moves} probs={t.probs} /></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Fit quality */}
              <div style={{ ...card, padding: '16px 16px 8px' }}>
                <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Fit to OTM premia</div>
                <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                  Dots = market (puts below F, calls above) · line = mixture model · RMSE {fit.rmseTicks.toFixed(2)} ticks over {fit.quotes.length} quotes
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={fit.quotes.map(q => ({ ...q, mktT: q.market / OPT_TICK, mdlT: q.model / OPT_TICK }))}
                    margin={{ top: 10, right: 16, left: 4, bottom: 20 }}>
                    <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                    <XAxis type="number" dataKey="strike" domain={['dataMin', 'dataMax']} ticks={quoteTicks} tickFormatter={(v: number) => v.toFixed(3)} {...axisProps}
                      label={{ value: 'Futures strike', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                    <YAxis tickFormatter={(v: number) => v.toFixed(0)} width={40} {...axisProps}
                      label={{ value: 'ticks', angle: -90, position: 'insideLeft', offset: 14, fill: FG3, fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                      labelFormatter={(v: number) => `K ${Number(v).toFixed(4)}`}
                      formatter={(v: number, name: string) => [`${v.toFixed(2)} ticks`, name]} />
                    <ReferenceLine x={fit.F} stroke="#e2826f" strokeOpacity={0.6} strokeDasharray="4 3" />
                    <Line type="monotone" dataKey="mdlT" name="Model" stroke="#d6ad66" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="mktT" name="Market" stroke="none" dot={{ r: 3, fill: '#86c0de', stroke: '#86c0de' }} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          <p style={{ color: FG4, fontSize: 10, marginTop: 10, lineHeight: 1.5 }}>
            Method: the rate at option expiry is a mixture of normals, one per cumulative DFR outcome from meetings decided before expiry,
            μ = DFR + outcome + offset + δ + window-weighted OIS expectations of later meetings. Weights (the probabilities), noise and δ are
            fitted to OTM premia (non-negative least squares, Σw = 1, mixture mean = futures rate; δ penalised with a {DELTA_PRIOR_SD_BP} bp prior).
            Probabilities are risk-neutral. When the market density is smooth rather than lumpy, outcome weights are weakly identified and lean on
            the priors — see any warnings above. {sim
              ? 'OIS meeting expectations and the option chain are simulated'
              : `OIS meeting expectations are fitted to €STR OIS (1m–3y) as a step path at the ECB effective dates, with €STR − DFR held at today's spread; ${sourceNote(market).toLowerCase()}`};
            {' '}ECB dates after {ECB_CONFIRMED_THROUGH} are estimated.
          </p>
        </>
      )}
    </>
  )
}
