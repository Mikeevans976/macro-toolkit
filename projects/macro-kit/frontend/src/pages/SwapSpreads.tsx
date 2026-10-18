import { useEffect, useMemo, useState } from 'react'
import PageTitle, { headerBar } from '../components/PageTitle'
import { authFetch } from '../api/client'
import type { components } from '../api/schema'
import { fg, fontNum, line, line2, accent, pos, neg, warn } from '../theme'

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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SwapSpreads() {
  const [target, setTarget] = useState<Target>('USD')
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Breakdown | null>(null)

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
          subtitle={<>Asset & basis-swap calculator (Huggins & Schaller Ch 16–17){data ? ` · ${data.as_of}` : ''}</>}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {data && <SourceBadge source={data.data_source} />}
          <TargetPicker value={target} onChange={setTarget} />
        </div>
      </header>

      <main style={{ padding: '20px 24px' }}>
        {error && <div style={{ color: neg, fontSize: 13, marginBottom: 12 }}>Failed to load: {error}</div>}
        {!data && !error && <div style={{ color: fg[3], fontSize: 13 }}>Loading…</div>}
        {data && (
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
              <BondTable bonds={data.bonds} target={target} targetRfr={data.target_rfr} selected={selected} onSelect={setSelected} />
              {detail ? <BreakdownPanel data={detail} /> : <div style={{ ...card, color: fg[3], fontSize: 13 }}>Select a bond.</div>}
            </div>
            <MarketInputs markets={data.markets} />
          </div>
        )}
      </main>
    </div>
  )
}
