import { useMemo } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fmtSnap } from '../model/calendar'
import { extractDistribution, toAxis } from '../model/distribution'
import type { AxisMode } from '../model/distribution'
import { PACKS } from '../model/types'
import type { Contract, Market } from '../model/types'
import { Chip, FG1, FG2, FG3, FG4, Label, MONO, Stat, axisProps, card, niceTicks, pdfAxis, sourceNote } from '../ui'

// ─── Tab 1 — PDF & CDF ────────────────────────────────────────────────────────

function DistTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, padding: '8px 12px', fontSize: 11, fontFamily: MONO }}>
      <div style={{ color: FG1, marginBottom: 4 }}>K {d.strike.toFixed(4)} · {d.rate.toFixed(3)}%</div>
      <div style={{ color: FG3 }}>PDF <span style={{ color: FG1 }}>{d.pdf.toFixed(3)}</span></div>
      <div style={{ color: FG3 }}>CDF <span style={{ color: FG1 }}>{(d.cdf * 100).toFixed(1)}%</span></div>
    </div>
  )
}

export default function DistributionTab({ market, contract, setContract, expiryId, setExpiryId, h, axis, setAxis, controls }: {
  market: Market
  contract: Contract; setContract: (c: Contract) => void
  expiryId: string | null; setExpiryId: (id: string) => void
  h: number
  axis: AxisMode; setAxis: (a: AxisMode) => void
  controls: React.ReactNode
}) {
  const { contracts, snap } = market
  const expiries = useMemo(() => market.expiries(contract), [market, contract])
  const expiry   = expiries.find(e => e.id === expiryId) ?? expiries[0] ?? null
  const chain    = expiry ? market.chain(contract, expiry) : null
  const dist     = useMemo(() => chain ? extractDistribution(chain, h) : null, [chain, h])
  const data     = useMemo(() => dist ? toAxis(dist.points, axis) : [], [dist, axis])

  const atmX   = dist ? (axis === 'price' ? dist.F : 100 - dist.F) : 0
  const xTicks = useMemo(() => data.length ? niceTicks(data[0].x, data[data.length - 1].x) : [], [data])
  const fmtX   = (v: number) => v.toFixed(axis === 'price' ? 3 : 2)
  const xLabel = axis === 'price' ? 'Futures price at expiry' : 'Implied 3m Euribor at expiry (%)'
  const s      = dist?.stats
  const pX     = (q: number) => axis === 'price' ? q : 100 - q          // price quantile → axis units

  // Rate-space quantiles: the p-quantile of the rate is 100 − the (1−p)-quantile of the price
  const rq = s ? { q05: 100 - s.q95, q25: 100 - s.q75, q50: 100 - s.q50, q75: 100 - s.q25, q95: 100 - s.q05 } : null

  return (
    <>
      <div style={{ ...card, padding: '16px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Underlying</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {PACKS.map(pk => (
            <div key={pk.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ color: pk.shades[2], fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', width: 46 }}>{pk.label}</span>
              {contracts.filter(c => c.pack === pk.id).map(c => {
                const F = market.F(c)
                return (
                  <Chip key={c.id} active={c.id === contract.id} onClick={() => setContract(c)}>
                    {c.label}<span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11, fontFamily: MONO }}>{F.toFixed(3)}</span>
                  </Chip>
                )
              })}
            </div>
          ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Expiry</Label></span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
          {expiries.length === 0 && <span style={{ color: FG3, fontSize: 12 }}>No live option expiries for {contract.label} at this snapshot</span>}
          {expiries.map(e => (
            <Chip key={e.id} active={e.id === expiry?.id} onClick={() => setExpiryId(e.id)}
              title={`${e.code} · ${e.kind} · expires ${e.date.toISOString().slice(0, 10)} 10:00 London`}>
              <span style={{ fontFamily: MONO }}>{e.code}</span>
              <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{e.label}</span>
              <span style={{ marginLeft: 5, opacity: 0.5, fontSize: 10 }}>{e.kind === 'serial' ? 'S' : e.kind === 'quarterly' ? 'Q' : '●'}</span>
            </Chip>
          ))}
        </div>
        </div>
        {controls}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Label>Axis</Label>
          <Chip active={axis === 'price'} onClick={() => setAxis('price')}>Futures price</Chip>
          <Chip active={axis === 'rate'} onClick={() => setAxis('rate')}>Implied rate</Chip>
        </div>
      </div>

      {dist && s && expiry ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, marginBottom: 16 }}>
            {/* PDF */}
            <div style={{ ...card, padding: '16px 16px 8px' }}>
              <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Probability density</div>
              <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                {expiry.code} ({expiry.label}) options on {contract.label} · butterfly / h²
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={data} margin={{ top: 10, right: 16, left: 4, bottom: 24 }}>
                  <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                  <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps}
                    label={{ value: xLabel, position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                  <YAxis {...pdfAxis(Math.max(...data.map(d => d.pdf)))} tickFormatter={(v: number) => (+v.toFixed(2)).toString()} width={40} {...axisProps} />
                  <Tooltip content={<DistTooltip />} cursor={{ stroke: 'rgba(200,220,240,0.25)' }} />
                  <ReferenceLine y={0} stroke="rgba(150,178,205,0.2)" />
                  <ReferenceLine x={atmX} stroke="rgba(200,220,240,0.45)" strokeDasharray="5 3"
                    label={{ value: `F ${fmtX(atmX)}`, position: 'insideTopRight', fill: FG2, fontSize: 10 }} />
                  <Area type="monotone" dataKey="pdf" stroke={contract.color} fill={contract.color} fillOpacity={0.18}
                    strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* CDF */}
            <div style={{ ...card, padding: '16px 16px 8px' }}>
              <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Cumulative distribution</div>
              <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                {axis === 'price' ? 'P(price ≤ x)' : 'P(rate ≤ x)'} · 1 + call spread / h
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={data} margin={{ top: 10, right: 16, left: 4, bottom: 24 }}>
                  <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                  <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps}
                    label={{ value: xLabel, position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                  <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} width={40} {...axisProps} />
                  <Tooltip content={<DistTooltip />} cursor={{ stroke: 'rgba(200,220,240,0.25)' }} />
                  {[0.05, 0.5, 0.95].map(p => (
                    <ReferenceLine key={p} y={p} stroke="rgba(150,178,205,0.16)" strokeDasharray="2 4" />
                  ))}
                  <ReferenceLine x={atmX} stroke="rgba(200,220,240,0.45)" strokeDasharray="5 3"
                    label={{ value: `F ${fmtX(atmX)}`, position: 'insideTopLeft', fill: FG2, fontSize: 10 }} />
                  <Line type="monotone" dataKey="cdf" stroke={contract.color} strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Summary */}
          <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
            <Stat label="Futures" value={dist.F.toFixed(3)} sub={`${(100 - dist.F).toFixed(3)}%`} />
            <Stat label="Time to expiry" value={`${(dist.T * 365).toFixed(1)} d`} sub={`${dist.T.toFixed(3)} y`} />
            <Stat label="ATM normal vol" value={`${(dist.atmVol * 100).toFixed(0)} bp`} sub="annualised" />
            <Stat label="Mean" value={fmtX(pX(s.mean))} sub={`vs F ${((s.mean - dist.F) * 100).toFixed(1)} bp`} />
            <Stat label="Std dev" value={`${(s.std * 100).toFixed(1)} bp`} />
            <Stat label="Skew" value={(axis === 'price' ? s.skew : -s.skew).toFixed(2)} sub={axis === 'price' ? 'price space' : 'rate space'} />
            <Stat label="Median" value={fmtX(axis === 'price' ? s.q50 : rq!.q50)} />
            <Stat label="25–75%" value={axis === 'price' ? `${fmtX(s.q25)}–${fmtX(s.q75)}` : `${fmtX(rq!.q25)}–${fmtX(rq!.q75)}`} />
            <Stat label="5–95%" value={axis === 'price' ? `${fmtX(s.q05)}–${fmtX(s.q95)}` : `${fmtX(rq!.q05)}–${fmtX(rq!.q95)}`} />
            <Stat label="Mass captured" value={`${(s.mass * 100).toFixed(1)}%`}
              sub={s.negDensity ? `${s.negDensity} neg. density pts` : 'no neg. density'} />
          </div>
          <p style={{ color: FG4, fontSize: 10, marginTop: 10 }}>
            Snapshot {fmtSnap(snap)} · {expiry.code} expiry {expiry.date.toISOString().slice(0, 10)} 10:00 London ·
            {' '}{dist.points.length} strikes at h = {h.toFixed(4)}. Risk-neutral (no risk-premium adjustment).
            Options premium-margined, so undiscounted. {sourceNote(market)}.
            {chain?.flags.map(f => <span key={f} style={{ color: '#dfbb78' }}> {f}</span>)}
          </p>
        </>
      ) : (
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>
          No option expiries available for {contract.label} at this snapshot.
        </div>
      )}
    </>
  )
}
