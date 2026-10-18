import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import PageTitle, { headerBar } from '../components/PageTitle'
import { authFetch } from '../api/client'
import type { components } from '../api/schema'
import { chart, fg, fontNum, line, line2, accent, pos, neg, warn, series } from '../theme'

// Swap Spreads & Basis — asset & basis-swap calculator (H&S Ch 16-17).
// The backend does all the maths (asset_basis_swap.py); this page only renders it.

type S = components['schemas']
type Payload = S['SwapSpreads']
type Bond = S['BondRow']
type Breakdown = S['BondBreakdown']

const TARGETS = ['USD', 'EUR', 'GBP', 'JPY'] as const
type Target = (typeof TARGETS)[number]

const BG = '#07090c'

const card: React.CSSProperties = {
  background: 'rgba(200,220,240,0.03)',
  border: `1px solid ${line}`,
  borderRadius: 6,
  padding: 16,
}

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: fg[3],
  marginBottom: 10,
}

const th: React.CSSProperties = {
  color: fg[4], fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: '0.05em', padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap',
}

const td: React.CSSProperties = {
  padding: '4px 6px', textAlign: 'right', fontFamily: fontNum, fontSize: 12, color: fg[2], whiteSpace: 'nowrap',
}

const fmt = (x: number, d = 2) => x.toFixed(d)
const fmtBp = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`
const bpColor = (x: number) => (x > 0.05 ? pos : x < -0.05 ? neg : fg[2])

function SourceBadge({ source }: { source: string }) {
  const live = source === 'live'
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
      padding: '3px 8px', borderRadius: 4,
      color: live ? pos : warn,
      border: `1px solid ${live ? pos : warn}55`,
    }}>
      {live ? 'Live' : 'Simulated'}
    </span>
  )
}

function TargetPicker({ value, onChange }: { value: Target; onChange: (t: Target) => void }) {
  return (
    <div role="radiogroup" aria-label="Target currency" style={{ display: 'flex', border: `1px solid ${line2}`, borderRadius: 6, overflow: 'hidden' }}>
      {TARGETS.map(t => (
        <button
          key={t}
          role="radio"
          aria-checked={t === value}
          onClick={() => onChange(t)}
          style={{
            background: t === value ? 'rgba(134,192,222,0.14)' : 'transparent',
            color: t === value ? accent : fg[3],
            border: 'none', padding: '5px 12px', fontSize: 12, fontFamily: fontNum, cursor: 'pointer',
          }}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

const TABS = [
  { id: 'calculator', label: 'Asset & basis-swap calculator' },
  { id: 'curve', label: 'Global ASW curve' },
  { id: 'funding', label: 'Fair-value inputs' },
] as const
type Tab = (typeof TABS)[number]['id']

function Tabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${line}` }}>
      {TABS.map(t => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 12px', fontSize: 12,
            color: t.id === value ? fg[1] : fg[3],
            borderBottom: `2px solid ${t.id === value ? accent : 'transparent'}`,
            marginBottom: -1,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ─── Bond table ───────────────────────────────────────────────────────────────

function BondTable({ bonds, target, targetRfr, selected, onSelect }: {
  bonds: Bond[]
  target: Target
  targetRfr: string
  selected: string | null
  onSelect: (id: string) => void
}) {
  const issuers = useMemo(() => [...new Set(bonds.map(b => b.issuer))], [bonds])
  return (
    <div style={card}>
      <div style={sectionLabel}>Benchmark bonds · converted to {target} {targetRfr}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${line2}` }}>
            <th style={{ ...th, textAlign: 'left' }}>Bond</th>
            <th style={th}>TTM</th>
            <th style={th}>Dirty</th>
            <th style={th}>YTM %</th>
            <th style={th} title="Par-par asset-swap spread over the bond's home RFR">Par ASW</th>
            <th style={th} title={`Spread over ${targetRfr} after the cross-currency basis swap`}>{target} spread</th>
            <th style={th} title={`Fixed coupon of the equivalent par bond in ${target}`}>{target} cpn %</th>
          </tr>
        </thead>
        <tbody>
          {issuers.map(issuer => (
            <IssuerRows key={issuer} rows={bonds.filter(b => b.issuer === issuer)} selected={selected} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: fg[4], marginTop: 10 }}>
        Spreads in bp, quoted as RFR + X: a richer bond has a lower spread. Click a bond for the step-by-step breakdown.
      </div>
    </div>
  )
}

function IssuerRows({ rows, selected, onSelect }: { rows: Bond[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <>
      <tr>
        <td colSpan={7} style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: fg[4], padding: '8px 6px 3px' }}>
          {rows[0].issuer} · {rows[0].ccy}
        </td>
      </tr>
      {rows.map(b => {
        const isSel = b.bond_id === selected
        return (
          <tr
            key={b.bond_id}
            onClick={() => onSelect(b.bond_id)}
            style={{ cursor: 'pointer', background: isSel ? 'rgba(134,192,222,0.08)' : undefined, borderBottom: `1px solid ${line}` }}
          >
            <td style={{ ...td, textAlign: 'left', fontFamily: undefined, color: isSel ? accent : fg[1] }}>{b.name}</td>
            <td style={td}>{fmt(b.ttm, 1)}</td>
            <td style={td}>{fmt(b.dirty, 3)}</td>
            <td style={td}>{fmt(b.ytm, 3)}</td>
            <td style={{ ...td, color: bpColor(b.par_asw_bp) }}>{fmtBp(b.par_asw_bp)}</td>
            <td style={{ ...td, color: bpColor(b.target_spread_bp), fontWeight: 600 }}>{fmtBp(b.target_spread_bp)}</td>
            <td style={td}>{fmt(b.synthetic_coupon, 3)}</td>
          </tr>
        )
      })}
    </>
  )
}

// ─── Step-by-step breakdown ───────────────────────────────────────────────────

function Row({ label, value, strong, hint }: { label: string; value: string; strong?: boolean; hint?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' }} title={hint}>
      <span style={{ fontSize: 12, color: strong ? fg[1] : fg[3] }}>{label}</span>
      <span style={{ fontFamily: fontNum, fontSize: 12, color: strong ? accent : fg[2], fontWeight: strong ? 600 : 400 }}>{value}</span>
    </div>
  )
}

function Step({ n, title, formula, children }: { n: number; title: string; formula: string; children: React.ReactNode }) {
  return (
    <div style={{ ...card, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontFamily: fontNum, fontSize: 11, color: accent }}>{n}</span>
        <span style={{ fontSize: 13, color: fg[1], fontWeight: 500 }}>{title}</span>
      </div>
      <div style={{ fontFamily: fontNum, fontSize: 11, color: fg[4], marginBottom: 8 }}>{formula}</div>
      {children}
    </div>
  )
}

function BreakdownPanel({ data }: { data: Breakdown }) {
  const { bond, steps: s, home_rfr: homeRfr, target_rfr: targetRfr, target_ccy: target } = data
  const cross = s.home_ccy !== s.target_ccy
  const [showCf, setShowCf] = useState(false)
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={card}>
        <div style={sectionLabel}>{bond.name}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', columnGap: 24 }}>
          <Row label="Coupon" value={`${fmt(bond.coupon, 3)}% · ${bond.coupon_freq}×/yr`} />
          <Row label="Maturity" value={bond.maturity} />
          <Row label="Clean / dirty" value={`${fmt(bond.clean, 3)} / ${fmt(bond.dirty, 3)}`} />
          <Row label="YTM" value={`${fmt(s.ytm, 3)}%`} />
          <Row label="Fisher–Weil dur." value={fmt(bond.fw_duration, 2)} />
          <Row label="BPV / 100" value={fmt(bond.bpv, 4)} />
        </div>
      </div>

      <Step n={1} title={`Par asset swap into ${homeRfr} + s`} formula="s = (PV on swap curve − dirty) / (100 · A_float)">
        <Row label="PV of bond flows on the swap curve" value={fmt(s.pv_on_swap_curve, 4)} />
        <Row label="Up-front paid (100 − dirty)" value={fmt(s.upfront, 4)} />
        <Row label={`${homeRfr} floating annuity`} value={fmt(s.home_float_annuity, 4)} />
        <Row label={`Par ASW over ${homeRfr}`} value={`${fmtBp(s.par_asw_bp)} bp`} strong />
        <div style={{ borderTop: `1px solid ${line}`, marginTop: 6, paddingTop: 6 }}>
          <Row label="Proceeds (market-value) ASW" value={`${fmtBp(s.market_value_asw_bp)} bp`}
               hint="Floating leg on the dirty price instead of par" />
          <Row label="Interpolated ASW (YTM − swap)" value={`${fmtBp(s.interpolated_asw_bp)} bp`}
               hint="Carries the coupon effect; H&S recommend the par ASW over the RFR for RV" />
        </div>
      </Step>

      <Step
        n={2}
        title={cross ? `Cross-currency basis swap into ${targetRfr}` : 'No basis swap (same currency)'}
        formula={cross ? 's_tgt = (s + ICBS − CCBS_home) / CF + CCBS_tgt,  CF = A_tgt / A_home' : 's_tgt = s'}
      >
        {cross ? (
          <>
            <Row label={`CCBS ${s.home_ccy} vs SOFR`} value={`${fmtBp(s.home_ccbs_bp)} bp`} />
            {s.target_ccy !== 'USD' && <Row label={`CCBS ${s.target_ccy} vs SOFR`} value={`${fmtBp(s.target_ccbs_bp)} bp`} />}
            {s.home_icbs_bp !== 0 && <Row label="ICBS (bond leg → RFR)" value={`${fmtBp(s.home_icbs_bp)} bp`} />}
            <Row label={`${s.target_ccy} floating annuity`} value={fmt(s.target_float_annuity, 4)} />
            <Row label="Conversion factor (BPV ratio)" value={fmt(s.conversion_factor, 4)} />
          </>
        ) : (
          <Row label="Conversion factor" value="1.0000" />
        )}
        <Row label={`Spread over ${targetRfr}`} value={`${fmtBp(s.target_spread_bp)} bp`} strong />
      </Step>

      <Step n={3} title={`Reverse asset swap into fixed ${target}`} formula="c = par swap rate + s_tgt · A_float / A_fixed">
        <Row label={`${target} par swap rate`} value={`${fmt(s.target_par_swap_rate, 4)}%`} />
        <Row label={`${target} fixed annuity`} value={fmt(s.target_fixed_annuity, 4)} />
        <Row label={`Synthetic ${target} fixed coupon`} value={`${fmt(s.synthetic_coupon, 4)}%`} strong />
        {cross && (
          <div style={{ fontSize: 11, color: fg[4], marginTop: 6 }}>
            Bond YTM {fmt(s.ytm, 3)}% in {s.home_ccy} becomes {fmt(s.synthetic_coupon, 3)}% in {target}.
          </div>
        )}
      </Step>

      <div style={card}>
        <button
          onClick={() => setShowCf(v => !v)}
          aria-expanded={showCf}
          style={{ ...sectionLabel, marginBottom: 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          {showCf ? '▾' : '▸'} Cash flows on the {homeRfr} curve ({data.cashflows.length})
        </button>
        {showCf && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${line2}` }}>
                {['t (yrs)', 'Amount', 'DF', 'PV'].map(h => <th key={h} style={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.cashflows.map(cf => (
                <tr key={cf.time} style={{ borderBottom: `1px solid ${line}` }}>
                  <td style={td}>{fmt(cf.time, 3)}</td>
                  <td style={td}>{fmt(cf.amount, 4)}</td>
                  <td style={td}>{fmt(cf.df, 5)}</td>
                  <td style={td}>{fmt(cf.pv, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Global ASW curve (H&S Fig 16.1) ──────────────────────────────────────────

// Issuer identity is colour + marker shape + an end-of-line label, never colour alone.
type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'wye' | 'star'
const SHAPES: MarkerShape[] = ['circle', 'square', 'diamond', 'triangle', 'wye', 'star']
const LOG_TICKS = [2, 3, 5, 7, 10, 20, 30]

// Fixed order so an issuer keeps its colour on every tab (colour follows the entity).
const ISSUER_ORDER = ['UST', 'Bund', 'OAT', 'BTP', 'Gilt', 'JGB']

function issuerStyle(issuer: string) {
  const i = Math.max(ISSUER_ORDER.indexOf(issuer), 0)
  return { color: series[i % series.length], shape: SHAPES[i % SHAPES.length] }
}

function LegendRow({ issuers }: { issuers: string[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 8 }}>
      {issuers.map(iss => {
        const { color, shape } = issuerStyle(iss)
        return (
          <span key={iss} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: fg[2] }}>
            <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><MarkerGlyph shape={shape} color={color} /></svg>
            {iss}
          </span>
        )
      })}
    </div>
  )
}

function MarkerGlyph({ shape, color }: { shape: MarkerShape; color: string }) {
  const p = { fill: color, stroke: BG, strokeWidth: 1 }
  switch (shape) {
    case 'square': return <rect x={-4} y={-4} width={8} height={8} {...p} />
    case 'diamond': return <path d="M0 -5 5 0 0 5 -5 0z" {...p} />
    case 'triangle': return <path d="M0 -5 5 4 -5 4z" {...p} />
    case 'wye': return <path d="M-1 -5h2v3.5l3-1.7 1 1.7-3 1.8 3 1.7-1 1.7-3-1.7V6h-2V2.5l-3 1.7-1-1.7 3-1.7-3-1.8 1-1.7 3 1.7z" {...p} />
    case 'star': return <path d="M0 -5.5 1.6 -1.7 5.5 -1.7 2.4 0.8 3.4 4.8 0 2.5 -3.4 4.8 -2.4 0.8 -5.5 -1.7 -1.6 -1.7z" {...p} />
    default: return <circle r={4.5} {...p} />
  }
}

interface BondPoint { tenor: number; bp: number; name: string; bond_id: string; issuer: string }

function CurveTooltip({ active, payload, rfr }: { active?: boolean; payload?: { payload: BondPoint | { tenor: number; bp: number } }[]; rfr: string }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const isBond = 'name' in p
  return (
    <div style={{ ...chart.tooltip.contentStyle, padding: '8px 10px' }}>
      <div style={{ color: fg[3], marginBottom: 4 }}>{isBond ? p.name : 'Fitted line'}</div>
      <div>{fmt(p.tenor, 1)}y · {rfr} {fmtBp(p.bp)} bp</div>
      {isBond && <div style={{ color: fg[4], marginTop: 4 }}>Click for the breakdown</div>}
    </div>
  )
}

function GlobalCurve({ data, onPick }: { data: Payload; onPick: (bondId: string) => void }) {
  const issuers = data.issuer_curves.map(c => c.issuer)
  const bondsBy = (iss: string): BondPoint[] => data.bonds
    .filter(b => b.issuer === iss)
    .map(b => ({ tenor: b.ttm, bp: b.target_spread_bp, name: b.name, bond_id: b.bond_id, issuer: b.issuer }))

  return (
    <div style={card}>
      <div style={sectionLabel}>Spread over {data.target_ccy} {data.target_rfr} by maturity · all issuers basis-swapped into {data.target_ccy}</div>
      <LegendRow issuers={issuers} />
      <div style={{ height: 440 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 56, bottom: 24, left: 4 }}>
            <CartesianGrid {...chart.grid} />
            <XAxis
              type="number" dataKey="tenor" scale="log" domain={[1.4, 34]} ticks={LOG_TICKS}
              allowDataOverflow {...chart.axis} tickFormatter={(t: number) => `${t}y`}
              label={{ value: 'Maturity (log scale)', position: 'insideBottom', offset: -14, fill: fg[4], fontSize: 10 }}
            />
            <YAxis
              type="number" dataKey="bp" {...chart.axis} width={48} tickFormatter={(v: number) => `${v}`}
              label={{ value: 'bp', angle: -90, position: 'insideLeft', fill: fg[4], fontSize: 10 }}
            />
            <ZAxis range={[90, 90]} />
            <ReferenceLine y={0} stroke={line2} />
            <Tooltip content={<CurveTooltip rfr={data.target_rfr} />} cursor={false} />
            {data.issuer_curves.map(c => {
              const { color } = issuerStyle(c.issuer)
              const last = c.points[c.points.length - 1]
              return (
                <Scatter
                  key={`${c.issuer}-line`}
                  data={c.points}
                  line={{ stroke: color, strokeWidth: 2 }}
                  lineType="joint"
                  isAnimationActive={false}
                  shape={(props: { cx?: number; cy?: number; payload?: { tenor: number } }) =>
                    props.payload?.tenor === last.tenor && props.cx != null && props.cy != null ? (
                      <text x={props.cx + 8} y={props.cy + 4} fill={fg[2]} fontSize={11}>{c.issuer}</text>
                    ) : <g />}
                />
              )
            })}
            {issuers.map(iss => {
              const { color, shape } = issuerStyle(iss)
              return (
                <Scatter
                  key={`${iss}-bonds`}
                  name={iss}
                  data={bondsBy(iss)}
                  fill={color}
                  shape={shape}
                  stroke={BG}
                  strokeWidth={2}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(p: { payload?: BondPoint }) => p.payload && onPick(p.payload.bond_id)}
                />
              )
            })}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div style={{ fontSize: 11, color: fg[4], marginTop: 6 }}>
        Points are bonds; lines are a quadratic fit in log-maturity per issuer. A bond above its issuer's line is cheap to it.
      </div>
    </div>
  )
}

function CurveTable({ data }: { data: Payload }) {
  const issuers = data.issuer_curves.map(c => c.issuer)
  const tenors = [...new Set(data.bonds.map(b => b.bond_id.split('-')[1]))]
  return (
    <div style={card}>
      <div style={sectionLabel}>Spread over {data.target_rfr} (bp) · benchmark bonds</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${line2}` }}>
            <th style={{ ...th, textAlign: 'left' }}>Issuer</th>
            {tenors.map(t => <th key={t} style={th}>{t}</th>)}
          </tr>
        </thead>
        <tbody>
          {issuers.map(iss => (
            <tr key={iss} style={{ borderBottom: `1px solid ${line}` }}>
              <td style={{ ...td, textAlign: 'left', fontFamily: undefined, color: fg[1] }}>{iss}</td>
              {tenors.map(t => {
                const b = data.bonds.find(x => x.bond_id === `${iss}-${t}`)
                return <td key={t} style={{ ...td, color: b ? bpColor(b.target_spread_bp) : fg[4] }}>{b ? fmtBp(b.target_spread_bp) : '–'}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Market inputs ────────────────────────────────────────────────────────────

function MarketInputs({ markets }: { markets: Payload['markets'] }) {
  const tenors = markets[0]?.par_curve.map(p => p.tenor) ?? []
  return (
    <div style={card}>
      <div style={sectionLabel}>Market inputs · OIS par rates (%) and CCBS vs SOFR (bp)</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${line2}` }}>
              <th style={{ ...th, textAlign: 'left' }}>Curve</th>
              {tenors.map(t => <th key={t} style={th}>{t}y</th>)}
            </tr>
          </thead>
          <tbody>
            {markets.map(m => (
              <tr key={`${m.ccy}-ois`} style={{ borderBottom: `1px solid ${line}` }}>
                <td style={{ ...td, textAlign: 'left', fontFamily: undefined, color: fg[1] }}>{m.ccy} {m.rfr} OIS</td>
                {m.par_curve.map(p => <td key={p.tenor} style={td}>{fmt(p.rate, 3)}</td>)}
              </tr>
            ))}
            {markets.filter(m => m.ccy !== 'USD').map(m => (
              <tr key={`${m.ccy}-ccbs`} style={{ borderBottom: `1px solid ${line}` }}>
                <td style={{ ...td, textAlign: 'left', fontFamily: undefined, color: fg[1] }}>{m.rfr} / SOFR CCBS</td>
                {m.ccbs.map(p => <td key={p.tenor} style={{ ...td, color: bpColor(p.bp) }}>{fmtBp(p.bp)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Fair-value inputs (CDS, basis, term rate, haircuts) ──────────────────────

type Funding = S['FundingInputs']

// Rates are sent as decimals; `pct` fields are edited in % and divided by 100.
const FUNDING_FIELDS = {
  cds_bp: { label: 'Sovereign CDS', unit: 'bp', step: 5, pct: false },
  g: { label: 'Cost of equity g', unit: '%', step: 0.5, pct: true },
  q: { label: 'Risk weight q', unit: '%', step: 5, pct: true },
  d: { label: 'Capital ratio d', unit: '%', step: 0.5, pct: true },
  d_new: { label: 'What-if capital ratio', unit: '%', step: 0.5, pct: true },
  repo: { label: 'Repo / RFR R', unit: '%', step: 0.05, pct: true },
  pd: { label: 'Default probability p', unit: '%', step: 0.05, pct: true },
  recovery: { label: 'Recovery c', unit: '%', step: 5, pct: true },
  b: { label: 'Return on capital b', unit: '%', step: 0.05, pct: true },
  market_term_rate: { label: 'Market term rate', unit: '%', step: 0.05, pct: true },
  excess_funding_bp: { label: 'Excess funding cost', unit: 'bp', step: 50, pct: false },
} as const
type FieldKey = keyof typeof FUNDING_FIELDS

const FUNDING_DEFAULTS: Record<FieldKey, number> = {
  cds_bp: 60, g: 0.10, q: 0.20, d: 0.08, d_new: 0.12, repo: 0.019, pd: 0.0025,
  recovery: 0.40, b: 0.019, market_term_rate: 0.0215, excess_funding_bp: 600,
}

function NumField({ k, value, onChange, hint }: { k: FieldKey; value: number; onChange: (k: FieldKey, v: number) => void; hint?: string }) {
  const f = FUNDING_FIELDS[k]
  const shown = f.pct ? +(value * 100).toFixed(4) : value
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '3px 0' }} title={hint}>
      <span style={{ fontSize: 12, color: fg[3] }}>{f.label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="number"
          aria-label={f.label}
          value={shown}
          step={f.step}
          onChange={e => {
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(k, f.pct ? v / 100 : v)
          }}
          style={{
            width: 74, background: 'rgba(200,220,240,0.04)', border: `1px solid ${line2}`, borderRadius: 4,
            color: fg[1], fontFamily: fontNum, fontSize: 12, padding: '3px 6px', textAlign: 'right',
          }}
        />
        <span style={{ fontSize: 11, color: fg[4], width: 18 }}>{f.unit}</span>
      </span>
    </label>
  )
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: fg[2], cursor: 'pointer' }} title={hint}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: accent }} />
      {label}
    </label>
  )
}

function CdsCard({ data, settlement, onSettlement, field }: {
  data: Funding['cds']; settlement: 'cash' | 'physical'; onSettlement: (s: 'cash' | 'physical') => void; field: React.ReactNode
}) {
  return (
    <Step n={1} title="CDS adjustment (Ch 13)" formula="adjusted CDS = CDS × factor">
      {field}
      <div role="radiogroup" aria-label="CDS settlement" style={{ display: 'flex', gap: 12, padding: '4px 0 6px' }}>
        {(['physical', 'cash'] as const).map(s => (
          <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: fg[2], cursor: 'pointer' }}>
            <input type="radio" name="settlement" checked={settlement === s} onChange={() => onSettlement(s)} style={{ accentColor: accent }} />
            {s === 'physical' ? 'Physical (FX + delivery option, 0.39)' : 'Cash (FX only, 0.45)'}
          </label>
        ))}
      </div>
      <Row label="Adjusted CDS fed into the ASW" value={`${fmt(data.adjusted_bp, 1)} bp`} strong />
      <div style={{ borderTop: `1px solid ${line}`, marginTop: 6, paddingTop: 6 }}>
        {data.scenarios.map(sc => (
          <Row key={sc.case} label={`${sc.case[0].toUpperCase()}${sc.case.slice(1)} case (${fmt(sc.factor * 100, 0)}%)`} value={`${fmt(sc.adjusted_bp, 1)} bp`} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: fg[4], marginTop: 6 }}>H&S: check every credit-linked trade under all three cases.</div>
    </Step>
  )
}

function BasisCard({ data, fields }: { data: Funding['secured_unsecured']; fields: React.ReactNode }) {
  return (
    <Step n={2} title="Secured–unsecured basis (Ch 11)" formula="basis ≈ g · q · d">
      {fields}
      <Row label="Secured–unsecured basis" value={`${fmt(data.basis_bp, 1)} bp`} strong />
      <Row label={`At capital ratio ${fmt(data.d_new * 100, 1)}%`} value={`${fmt(data.basis_new_bp, 1)} bp`} />
      <Row label="Change in basis" value={`${fmtBp(data.change_bp)} bp`} />
      <div style={{ fontSize: 11, color: fg[4], marginTop: 6 }}>
        The OIS-ASW subtracts g·q·d, so it moves by {fmtBp(-data.change_bp)} bp.
      </div>
    </Step>
  )
}

function TermRateCard({ data, fields }: { data: Funding['term_rate']; fields: React.ReactNode }) {
  const m = data.model
  return (
    <Step n={3} title="Repo–term-rate model (Ch 11)" formula="L = [R + p(1−c) + q·d·(g − b)] / (1 − p(1−c))">
      {fields}
      <Row label="Funding: R / (1 − p(1−c))" value={`${fmt(m.funding, 3)}%`} />
      <Row label="Credit: p(1−c) / (1 − p(1−c))" value={`${fmt(m.credit, 3)}%`} />
      <Row label="Capital: q·d·(g − b) / (1 − p(1−c))" value={`${fmt(m.capital, 3)}%`} />
      <Row label="Model term rate L" value={`${fmt(m.rate, 3)}% · ${fmtBp(m.spread_to_repo_bp)} bp over repo`} strong />
      <div style={{ borderTop: `1px solid ${line}`, marginTop: 6, paddingTop: 6 }}>
        <Row label="Market term rate" value={`${fmt(data.market_rate_pct, 3)}% · ${fmtBp(data.market_spread_to_repo_bp)} bp over repo`} />
        <Row
          label="Implied cost of equity g"
          value={data.implied_g_pct == null ? 'n/a (q·d = 0)' : `${fmt(data.implied_g_pct, 2)}%`}
          strong
          hint="The g that makes the model rate equal the market rate: a gauge of bank funding stress"
        />
      </div>
    </Step>
  )
}

/** Issuers whose haircut curves are identical share one line and one label. */
function groupCurves(curves: Funding['haircuts']['curves']) {
  const groups: { issuers: string[]; curve: Funding['haircuts']['curves'][number] }[] = []
  for (const c of curves) {
    const sig = c.points.map(p => p.drag_bp).join(',')
    const g = groups.find(x => x.curve.points.map(p => p.drag_bp).join(',') === sig)
    if (g) g.issuers.push(c.issuer)
    else groups.push({ issuers: [c.issuer], curve: c })
  }
  return groups
}

function HaircutChart({ data }: { data: Funding['haircuts'] }) {
  const groups = groupCurves(data.curves)
  return (
    <div style={{ height: 360 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart margin={{ top: 10, right: 110, bottom: 24, left: 4 }}>
          <CartesianGrid {...chart.grid} />
          <XAxis
            type="number" dataKey="tenor" domain={[0, 40]} ticks={[1, 3, 5, 7, 10, 15, 20, 30, 40]}
            {...chart.axis} tickFormatter={(t: number) => `${t}y`}
            label={{ value: 'Residual maturity', position: 'insideBottom', offset: -14, fill: fg[4], fontSize: 10 }}
          />
          <YAxis
            type="number" {...chart.axis} width={44}
            label={{ value: 'bp of yield', angle: -90, position: 'insideLeft', fill: fg[4], fontSize: 10 }}
          />
          <Tooltip
            {...chart.tooltip}
            labelFormatter={(t: number) => `${t}y`}
            formatter={(v: number, name: string) => [`${fmt(v, 1)} bp`, name]}
          />
          {groups.map(g => {
            const { color } = issuerStyle(g.issuers[0])
            const name = g.issuers.join(' · ')
            return (
              <Line
                key={name}
                name={name}
                data={g.curve.points}
                dataKey="drag_bp"
                type="stepAfter"
                stroke={color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                label={(p: { x?: number; y?: number; index?: number }) =>
                  p.index === g.curve.points.length - 1 && p.x != null && p.y != null
                    ? <text key={name} x={p.x + 8} y={p.y + 4} fill={fg[2]} fontSize={11}>{name}</text>
                    : <g key={`${name}-${p.index}`} />}
              />
            )
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function HaircutCard({ data, excessField, zero, onZero, downgrade, onDowngrade }: {
  data: Funding['haircuts']; excessField: React.ReactNode
  zero: boolean; onZero: (v: boolean) => void; downgrade: boolean; onDowngrade: (v: boolean) => void
}) {
  const btp = data.curves.find(c => c.issuer === 'BTP')
  return (
    <div style={card}>
      <div style={sectionLabel}>4 · Haircut cost by maturity (Ch 18) · yield drag ≈ haircut × excess funding cost</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 20, marginBottom: 8 }}>
        <div style={{ width: 260 }}>{excessField}</div>
        <Toggle label="Zero-coupon bonds" checked={zero} onChange={onZero} hint="Zero-coupon haircuts are higher at the long end" />
        <Toggle
          label="BTP downgraded to ECB credit quality step 3"
          checked={downgrade}
          onChange={onDowngrade}
          hint={btp?.rating_basis}
        />
      </div>
      <HaircutChart data={data} />
      <div style={{ fontSize: 11, color: fg[4], margin: '6px 0 12px' }}>
        ECB and BoE schedules are bucketed by residual maturity; the Fed's by duration (a 4% par bond's on this chart, each bond's own below).
        {btp && <> BTP: {btp.class_label} — {btp.rating_basis}.</>}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${line2}` }}>
            <th style={{ ...th, textAlign: 'left' }}>Benchmark bond</th>
            <th style={th}>TTM</th>
            <th style={th}>Duration</th>
            <th style={th}>Haircut %</th>
            <th style={th}>Drag bp</th>
          </tr>
        </thead>
        <tbody>
          {data.bonds.map(b => (
            <tr key={b.bond_id} style={{ borderBottom: `1px solid ${line}` }}>
              <td style={{ ...td, textAlign: 'left', fontFamily: undefined, color: fg[1] }}>{b.name}</td>
              <td style={td}>{fmt(b.ttm, 1)}</td>
              <td style={td}>{fmt(b.duration, 2)}</td>
              <td style={td}>{fmt(b.haircut_pct, 1)}</td>
              <td style={td}>{fmt(b.drag_bp, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 12, display: 'grid', gap: 3 }}>
        {data.sources.map(s => (
          <div key={s.schedule} style={{ fontSize: 11, color: fg[4] }}>
            <a href={s.url} target="_blank" rel="noreferrer" style={{ color: fg[3] }}>{s.name}</a> · {s.source} · as of {s.as_of}
          </div>
        ))}
      </div>
    </div>
  )
}

function FundingTab() {
  const [values, setValues] = useState<Record<FieldKey, number>>(FUNDING_DEFAULTS)
  const [settlement, setSettlement] = useState<'cash' | 'physical'>('physical')
  const [zero, setZero] = useState(false)
  const [downgrade, setDowngrade] = useState(false)
  const [data, setData] = useState<Funding | null>(null)
  const [error, setError] = useState<string | null>(null)

  const query = useMemo(() => {
    const p = new URLSearchParams({ settlement, zero: String(zero), btp_downgrade: String(downgrade) })
    for (const [k, v] of Object.entries(values)) p.set(k, String(v))
    return p.toString()
  }, [values, settlement, zero, downgrade])

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      authFetch(`/api/tools/swap-spreads/funding?${query}`)
        .then(async res => {
          if (!res.ok) throw new Error(res.status === 422 ? 'an input is out of range' : `HTTP ${res.status}`)
          const body: Funding = await res.json()
          if (!cancelled) { setData(body); setError(null) }
        })
        .catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query])

  const set = (k: FieldKey, v: number) => setValues(prev => ({ ...prev, [k]: v }))
  const field = (k: FieldKey, hint?: string) => <NumField k={k} value={values[k]} onChange={set} hint={hint} />

  if (!data) return <div style={{ ...card, color: error ? neg : fg[3], fontSize: 13 }}>{error ? `Failed to load: ${error}` : 'Loading…'}</div>
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {error && <div style={{ color: neg, fontSize: 12 }}>Not updated: {error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' }}>
        <CdsCard data={data.cds} settlement={settlement} onSettlement={setSettlement} field={field('cds_bp')} />
        <BasisCard data={data.secured_unsecured} fields={<>{field('g')}{field('q')}{field('d')}{field('d_new')}</>} />
        <TermRateCard
          data={data.term_rate}
          fields={<>
            {field('repo')}{field('pd', 'Probability the bank defaults over the year (e.g. from a bank CDS index)')}
            {field('recovery')}{field('b', 'Return earned on the capital itself; set to the secured rate by default')}
            {field('market_term_rate', 'e.g. Euribor 3M, to back out the implied cost of equity')}
            <div style={{ fontSize: 11, color: fg[4], padding: '2px 0 6px' }}>Uses g, q, d from the basis card.</div>
          </>}
        />
      </div>
      <HaircutCard
        data={data.haircuts}
        excessField={field('excess_funding_bp', 'Cost of funding the haircut portion above repo (H&S default 600bp)')}
        zero={zero} onZero={setZero} downgrade={downgrade} onDowngrade={setDowngrade}
      />
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SwapSpreads() {
  const [target, setTarget] = useState<Target>('USD')
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Breakdown | null>(null)
  const [tab, setTab] = useState<Tab>('calculator')

  useEffect(() => {
    let cancelled = false
    setError(null)
    authFetch(`/api/tools/swap-spreads?target=${target}`)
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body: Payload = await res.json()
        if (cancelled) return
        setData(body)
        setSelected(prev => prev ?? body.bonds[0]?.bond_id ?? null)
      })
      .catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true }
  }, [target])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    authFetch(`/api/tools/swap-spreads/bond?bond_id=${encodeURIComponent(selected)}&target=${target}`)
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body: Breakdown = await res.json()
        if (!cancelled) setDetail(body)
      })
      .catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true }
  }, [selected, target])

  return (
    <div style={{ background: BG, minHeight: '100vh' }}>
      <header style={{ ...headerBar, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 24px' }}>
        <PageTitle
          category="Funding"
          categoryId="funding"
          title="Swap Spreads & Basis"
          subtitle={<>Asset swaps, basis swaps and their funding inputs (Huggins & Schaller Ch 11–18){data ? ` · ${data.as_of}` : ''}</>}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {data && <SourceBadge source={data.data_source} />}
          {tab !== 'funding' && <TargetPicker value={target} onChange={setTarget} />}
        </div>
      </header>

      <main style={{ padding: '20px 24px' }}>
        {error && <div style={{ color: neg, fontSize: 13, marginBottom: 12 }}>Failed to load: {error}</div>}
        {!data && !error && <div style={{ color: fg[3], fontSize: 13 }}>Loading…</div>}
        {data && (
          <div style={{ display: 'grid', gap: 16 }}>
            <Tabs value={tab} onChange={setTab} />
            {tab === 'calculator' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
                <BondTable bonds={data.bonds} target={target} targetRfr={data.target_rfr} selected={selected} onSelect={setSelected} />
                {detail ? <BreakdownPanel data={detail} /> : <div style={{ ...card, color: fg[3], fontSize: 13 }}>Select a bond.</div>}
              </div>
            ) : tab === 'curve' ? (
              <>
                <GlobalCurve data={data} onPick={id => { setSelected(id); setTab('calculator') }} />
                <CurveTable data={data} />
              </>
            ) : (
              <FundingTab />
            )}
            {tab !== 'funding' && <MarketInputs markets={data.markets} />}
          </div>
        )}
      </main>
    </div>
  )
}
