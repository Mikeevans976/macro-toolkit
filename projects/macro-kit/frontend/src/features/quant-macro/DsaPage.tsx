import { useCallback, useEffect, useRef, useState } from 'react'
import PageTitle, { headerBar } from '../../components/PageTitle'
import CountryFlag from '../../components/CountryFlag'
import { authFetch } from '../../api/client'
import { accent, fg, fontNum, line, line2, neg, pos, warn } from '../../theme'
import {
  AttributionBars, CurveChart, DebtPathChart, DynamicsChart, GrossFinancingChart, HeadroomHistoryChart, InterestChart,
  InterestCompositionChart, MaturityChart, RminusGChart, ScenarioChart, SpreadChart, TrackerChart, YieldsChart,
} from './dsaCharts'
import type { Dsa, DsaRule, DsaStatus, DsaUpload } from './dsaTypes'
import { QUANT_MACRO_CATEGORY } from './models'
import { BG, button, card, dayLabel, lastOf, monthLabel, num, sectionLabel, signColor, signed, stampLabel, td, tdText, th } from './ui'

// UK debt sustainability monitor. The backend (debt_sustainability.py) does all the
// modelling; this page renders the payload.

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'rules', label: 'Fiscal rules' },
  { id: 'dynamics', label: 'Debt dynamics' },
  { id: 'interest', label: 'Debt interest' },
  { id: 'financing', label: 'Financing' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'tracker', label: 'Monthly borrowing' },
  { id: 'market', label: 'Market pricing' },
  { id: 'method', label: 'Method & data' },
] as const
type Tab = (typeof TABS)[number]['id']
type Measure = 'psnd_pct' | 'psnfl_pct'
const MEASURE_LABEL: Record<Measure, string> = { psnd_pct: 'Net debt ex Bank of England', psnfl_pct: 'Net financial liabilities (PSNFL)' }

const bn = (x: number | null | undefined, d = 1) =>
  x == null ? '—' : `${x < 0 && Number(Math.abs(x).toFixed(d)) !== 0 ? '−' : ''}£${Math.abs(x).toFixed(d)}bn`
const pct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${num(x, d)}%`)
const prob = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(100 * x)}%`)
const probColor = (x: number | null | undefined) => (x == null ? fg[2] : x >= 0.66 ? pos : x >= 0.4 ? warn : neg)

function Tabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${line}`, flexWrap: 'wrap' }}>
      {TABS.map(t => (
        <button key={t.id} role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 12px', fontSize: 12,
            color: t.id === value ? fg[1] : fg[3], borderBottom: `2px solid ${t.id === value ? accent : 'transparent'}`, marginBottom: -1,
          }}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

function Toggle<T extends string>({ value, options, onChange, label }: {
  value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', border: `1px solid ${line2}`, borderRadius: 6, overflow: 'hidden', flexWrap: 'wrap' }}>
      {options.map(o => (
        <button key={o.id} role="radio" aria-checked={o.id === value} onClick={() => onChange(o.id)}
          style={{
            background: o.id === value ? 'rgba(134,192,222,0.14)' : 'transparent', color: o.id === value ? accent : fg[3],
            border: 'none', padding: '5px 10px', fontSize: 12, cursor: 'pointer',
          }}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: React.ReactNode; color?: string }) {
  return (
    <div style={{ ...card, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: fg[4], textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontFamily: fontNum, fontSize: 20, color: color ?? fg[1], marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: fg[3], marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

const grid = (min: number): React.CSSProperties => ({ display: 'grid', gap: 12, gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` })
const p: React.CSSProperties = { fontSize: 12, color: fg[2], lineHeight: 1.6, margin: 0 }

// ─── Header controls ──────────────────────────────────────────────────────────

function Controls({ status, onRefresh, onUpload, uploadMsg }: {
  status: DsaStatus | null; onRefresh: () => void; onUpload: (f: File) => void; uploadMsg: string | null
}) {
  const input = useRef<HTMLInputElement>(null)
  const busy = status?.job.state === 'running'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: fg[3] }} aria-live="polite">
        {busy ? <>Updating: {status?.job.step}</>
          : status?.job.state === 'error' ? <span style={{ color: neg }}>Update failed: {status.job.error}</span>
          : uploadMsg ? uploadMsg
          : <>Computed <span style={{ fontFamily: fontNum, color: fg[2] }}>{stampLabel(status?.computed_at)}</span></>}
      </span>
      <button type="button" onClick={onRefresh} disabled={busy || !status} title="Download the latest data and recompute (about 30 seconds)"
        style={{ ...button, opacity: busy || !status ? 0.5 : 1 }}>
        {busy ? 'Updating…' : 'Refresh'}
      </button>
      <button type="button" onClick={() => input.current?.click()} disabled={busy}
        title="Upload an OBR Economic and fiscal outlook (PDF) or the DMO gilts-in-issue report (D1A: CSV, XLSX or XML)"
        style={{ ...button, opacity: busy ? 0.5 : 1 }}>
        Upload OBR / DMO file
      </button>
      <input ref={input} type="file" accept=".pdf,.csv,.xlsx,.xls,.xml" aria-label="Upload file" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = '' }} />
    </div>
  )
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function Overview({ data, measure, setMeasure }: { data: Dsa; measure: Measure; setMeasure: (m: Measure) => void }) {
  const [stab, inv] = data.rules
  const target = data.projection.find(r => r.year === data.target_year)
  const last = lastOf(data.projection)
  const worst = [...data.scenarios].sort((a, b) => (a.stability_bn ?? 0) - (b.stability_bn ?? 0)).slice(0, 3)
  const mkt = data.dynamics.market.filter(r => r.year >= data.tracker.year)
  const rg = mkt.length ? mkt.reduce((s, r) => s + (r.r_minus_g ?? 0), 0) / mkt.length : null
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={grid(190)}>
        <Stat label={`Stability rule headroom, ${data.target_year}`} value={bn(stab.market_bn)} color={signColor(stab.market_bn)}
          sub={<>OBR {bn(stab.obr_bn)} · <span style={{ color: signColor(stab.change_bn) }}>{signed(stab.change_bn, 1)}</span> at today's prices</>} />
        <Stat label={`Investment rule headroom, ${data.target_year}`} value={bn(inv.market_bn)} color={signColor(inv.market_bn)}
          sub={<>OBR {bn(inv.obr_bn)} · PSNFL falls {num(inv.market_pp, 2)}pp of GDP</>} />
        <Stat label="Chance both rules are met" value={prob(data.probabilities.both)} color={probColor(data.probabilities.both)}
          sub={<>Stability {prob(data.probabilities.stability)} · investment {prob(data.probabilities.investment)}</>} />
        <Stat label={`Net debt ex BoE, ${data.target_year}`} value={pct(target?.psnd_pct)}
          sub={<>OBR {pct(target?.obr_psnd_pct)} · {pct(last?.psnd_pct)} by {last?.year}</>} />
        <Stat label={`Debt interest, ${data.target_year}`} value={bn(target?.interest_bn, 0)}
          sub={<>{pct(target?.interest_receipts)} of receipts · OBR {bn(target?.obr_interest_bn, 0)}</>} />
        <Stat label="Interest rate minus growth" value={rg == null ? '—' : `${signed(rg, 2)}pp`} color={rg != null && rg > 0 ? warn : fg[1]}
          sub={<>Average {data.tracker.year} to {last?.year}, market baseline</>} />
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={sectionLabel}>{MEASURE_LABEL[measure]}, % of GDP</div>
          <Toggle label="Debt measure" value={measure} onChange={setMeasure}
            options={[{ id: 'psnd_pct', label: 'Net debt ex BoE' }, { id: 'psnfl_pct', label: 'PSNFL' }]} />
        </div>
        <DebtPathChart rows={data.projection} fan={data.fan[measure]} measure={measure} />
        <p style={{ ...p, color: fg[3], fontSize: 11 }}>
          The fan shows {data.model.paths.toLocaleString()} simulated paths around the market baseline (shocks to growth,
          inflation, Bank Rate, gilt yields and the primary balance). OBR forecast to {lastOf(data.projection.filter(r => r.kind === 'forecast'))?.year};
          later years extend it. {data.model.extension_note}
        </p>
      </div>

      <div style={grid(360)}>
        <div style={card}>
          <div style={sectionLabel}>What moved the stability-rule headroom since the OBR</div>
          <AttributionBars rule={stab} />
          <p style={{ ...p, marginTop: 10, color: fg[3], fontSize: 11 }}>
            The OBR priced debt interest on curves averaged over the 10 working days to {dayLabel(data.sources.obr_cutoff)} {data.sources.obr_cutoff.slice(0, 4)};
            today's figure re-prices it on the Bank of England curves of {dayLabel(data.sources.curves_latest)}. Everything else is the OBR's forecast.
          </p>
        </div>
        <div style={card}>
          <div style={sectionLabel}>Biggest risks to the stability rule</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={{ ...th, textAlign: 'left' }}>Scenario</th><th style={th}>Headroom</th><th style={th}>Debt {last?.year}</th></tr></thead>
            <tbody>
              {worst.map(s => (
                <tr key={s.id}>
                  <td style={{ ...tdText, whiteSpace: 'normal' }}>{s.name}<div style={{ fontSize: 11, color: fg[3] }}>{s.description}</div></td>
                  <td style={{ ...td, color: signColor(s.stability_bn) }}>{bn(s.stability_bn)}</td>
                  <td style={td}>{pct(s.psnd_end)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Fiscal rules ─────────────────────────────────────────────────────────────

function RuleCard({ rule, target }: { rule: DsaRule; target: string }) {
  return (
    <div style={{ ...card, display: 'grid', gap: 14 }}>
      <div>
        <div style={{ fontSize: 14, color: fg[1], fontWeight: 500 }}>{rule.name}</div>
        <p style={{ ...p, color: fg[3], marginTop: 4 }}>{rule.description}</p>
      </div>
      <div style={grid(130)}>
        <div><div style={sectionLabel}>OBR</div><div style={{ fontFamily: fontNum, fontSize: 18, color: fg[2] }}>{bn(rule.obr_bn)}</div></div>
        <div><div style={sectionLabel}>Today's prices</div><div style={{ fontFamily: fontNum, fontSize: 18, color: signColor(rule.market_bn) }}>{bn(rule.market_bn)}</div></div>
        <div><div style={sectionLabel}>Chance it is met</div><div style={{ fontFamily: fontNum, fontSize: 18, color: probColor(rule.probability) }}>{prob(rule.probability)}</div></div>
      </div>
      {rule.obr_pp != null && (
        <p style={{ ...p, color: fg[3], fontSize: 11 }}>PSNFL falls by {num(rule.obr_pp, 2)}pp of GDP in {target} in the OBR forecast, {num(rule.market_pp, 2)}pp at today's prices.</p>
      )}
      <div><div style={sectionLabel}>From the OBR's headroom to today's</div><AttributionBars rule={rule} /></div>
      <div><div style={sectionLabel}>Headroom at each day's prices since the OBR's window (£bn)</div>
        <HeadroomHistoryChart history={rule.history} obr={rule.obr_bn} /></div>
    </div>
  )
}

function Rules({ data }: { data: Dsa }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={grid(420)}>{data.rules.map(r => <RuleCard key={r.id} rule={r} target={data.target_year} />)}</div>
      <div style={card}>
        <div style={sectionLabel}>The rules</div>
        <p style={p}>{data.model.rules_note}</p>
        <p style={{ ...p, marginTop: 8, color: fg[3] }}>
          Probabilities come from the stochastic projection: the share of {data.model.paths.toLocaleString()} paths in which the current budget is in
          surplus, or PSNFL falls as a share of GDP, in {data.target_year}. Headroom is in £bn of the target year.
        </p>
      </div>
    </div>
  )
}

// ─── Debt dynamics ────────────────────────────────────────────────────────────

function Dynamics({ data }: { data: Dsa }) {
  const rows = [...data.dynamics.history.filter(r => r.year >= '2010' && !data.dynamics.market.some(m => m.year === r.year)), ...data.dynamics.market]
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card}>
        <div style={sectionLabel}>Change in net debt ex BoE (pp of GDP) and what drove it</div>
        <DynamicsChart rows={rows} />
        <p style={{ ...p, color: fg[3], fontSize: 11 }}>
          Change = interest + primary deficit + growth effect (debt diluted by nominal GDP growth) + other (financial transactions such as
          student loans and APF losses, and valuation). Outturns from the ONS to {lastOf(data.dynamics.history)?.year}; then the market baseline.
        </p>
      </div>
      <div style={grid(420)}>
        <div style={card}>
          <div style={sectionLabel}>Effective interest rate and nominal growth</div>
          <RminusGChart rows={rows} />
        </div>
        <div style={{ ...card, overflowX: 'auto' }}>
          <div style={sectionLabel}>Market baseline</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Year', 'Debt', 'Change', 'Interest', 'Primary', 'Growth', 'Other', 'r − g', 'Stabilising PB'].map((h, i) =>
              <th key={h} style={{ ...th, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
            <tbody>
              {data.dynamics.market.map(r => (
                <tr key={r.year}>
                  <td style={tdText}>{r.year}</td><td style={td}>{num(r.debt, 1)}</td>
                  <td style={{ ...td, color: signColor(r.change != null ? -r.change : null) }}>{signed(r.change, 2)}</td>
                  <td style={td}>{signed(r.interest, 2)}</td><td style={td}>{signed(r.primary, 2)}</td><td style={td}>{signed(r.growth, 2)}</td>
                  <td style={td}>{signed(r.other, 2)}</td><td style={td}>{signed(r.r_minus_g, 2)}</td><td style={td}>{signed(r.stabilising_primary, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ ...p, color: fg[3], fontSize: 11, marginTop: 8 }}>
            Stabilising PB: the primary surplus (% of GDP) that would hold the debt ratio flat given that year's interest rate and growth.
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Debt interest ────────────────────────────────────────────────────────────

function Interest({ data }: { data: Dsa }) {
  const it = data.interest
  const rk = it.obr_reckoner
  const ry = it.rows.find(r => r.year === rk.year)
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={grid(420)}>
        <div style={card}>
          <div style={sectionLabel}>Central government debt interest, net of the APF (£bn)</div>
          <InterestChart interest={it} />
        </div>
        <div style={card}>
          <div style={sectionLabel}>Composition at today's prices (£bn, interest model)</div>
          <InterestCompositionChart interest={it} />
        </div>
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={sectionLabel}>Interest by year and its sensitivity (£bn)</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Year', 'OBR', 'Today', 'Change', 'Effective rate', '+1pp all rates', '+1pp Bank Rate', '+1pp gilts', '+1pp RPI'].map((h, i) =>
            <th key={h} style={{ ...th, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {it.rows.map(r => (
              <tr key={r.year} style={{ color: r.kind === 'extension' ? fg[3] : undefined }}>
                <td style={tdText}>{r.year}{r.kind === 'extension' ? ' *' : ''}</td><td style={td}>{num(r.obr, 1)}</td><td style={td}>{num(r.market, 1)}</td>
                <td style={{ ...td, color: signColor(r.change != null ? -r.change : null) }}>{signed(r.change, 1)}</td>
                <td style={td}>{pct(r.effective_rate, 2)}</td><td style={td}>{signed(r.sens_rates_100, 1)}</td>
                <td style={td}>{signed(r.sens_bank_rate_100, 1)}</td><td style={td}>{signed(r.sens_gilts_100, 1)}</td><td style={td}>{signed(r.sens_rpi_100, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ ...p, color: fg[3], fontSize: 11, marginTop: 8 }}>
          * Beyond the OBR horizon. Check against the OBR's ready reckoners for {rk.year}: +1pp on gilt yields and Bank Rate adds £{num(rk.rates_1pp_bn, 0)}bn
          to borrowing (this model: {bn(ry?.sens_rates_100)}); +1pp RPI adds £{num(rk.rpi_1pp_bn, 0)}bn to borrowing, of which this model's debt-interest
          part is {bn(ry?.sens_rpi_100)} (the OBR figure also includes RPI-linked receipts and spending).
        </p>
      </div>
    </div>
  )
}

// ─── Financing ────────────────────────────────────────────────────────────────

function Financing({ data }: { data: Dsa }) {
  const f = data.financing
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={grid(170)}>
        <Stat label="Gilts in issue" value={bn(f.gilts_bn, 0)} sub={<>{prob(f.linker_share)} index-linked</>} />
        <Stat label="Average maturity" value={`${num(f.avg_maturity_conventional, 1)}y`} sub={<>Index-linked {num(f.avg_maturity_linkers, 1)}y</>} />
        <Stat label="Held by the Bank (APF)" value={bn(f.apf_bn, 0)} sub={<>{prob(f.apf_share)} of gilts, financed with reserves</>} />
        <Stat label="Reprices within a year" value={bn(f.repricing_1y_bn, 0)}
          sub={<>{prob(f.floating_share)} of net debt: reserves {bn(f.reserves_bn, 0)}, bills {bn(f.bills_bn, 0)}, NS&I {bn(f.nsandi_bn, 0)}, plus RPI-linked gilts</>} />
      </div>
      <div style={grid(420)}>
        <div style={card}>
          <div style={sectionLabel}>Gilt redemptions by financial year (£bn)</div>
          <MaturityChart financing={f} />
        </div>
        <div style={card}>
          <div style={sectionLabel}>Gross financing requirement (£bn)</div>
          <GrossFinancingChart financing={f} />
        </div>
      </div>
      <div style={card}>
        <div style={sectionLabel}>Gilt portfolio</div>
        <p style={p}>{data.sources.register_note}</p>
        <p style={{ ...p, color: fg[3], marginTop: 6 }}>Debt stocks as of {f.as_of} (ONS public sector finances).</p>
      </div>
    </div>
  )
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

function Scenarios({ data, measure, setMeasure }: { data: Dsa; measure: Measure; setMeasure: (m: Measure) => void }) {
  const [sel, setSel] = useState(data.scenarios[0]?.id)
  const s = data.scenarios.find(x => x.id === sel) ?? data.scenarios[0]
  const base = data.rules[0]
  const last = lastOf(data.projection)
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <div style={sectionLabel}>{MEASURE_LABEL[measure]}, % of GDP: {s?.name}</div>
          <Toggle label="Debt measure" value={measure} onChange={setMeasure}
            options={[{ id: 'psnd_pct', label: 'Net debt ex BoE' }, { id: 'psnfl_pct', label: 'PSNFL' }]} />
        </div>
        <Toggle label="Scenario" value={sel ?? ''} onChange={setSel} options={data.scenarios.map(x => ({ id: x.id, label: x.name }))} />
        {s && <ScenarioChart base={data.projection} scenario={s} measure={measure} />}
        {s && <p style={{ ...p, color: fg[3] }}>{s.description}</p>}
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Scenario', `Stability headroom ${data.target_year}`, 'PSNFL change (pp)', `Net debt ${last?.year}`, `Interest ${last?.year}`].map((h, i) =>
            <th key={h} style={{ ...th, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            <tr>
              <td style={tdText}>Market baseline</td><td style={{ ...td, color: signColor(base.market_bn) }}>{bn(base.market_bn)}</td>
              <td style={td}>{signed(data.rules[1].market_pp != null ? -data.rules[1].market_pp : null, 2)}</td>
              <td style={td}>{pct(last?.psnd_pct)}</td><td style={td}>{bn(last?.interest_bn, 0)}</td>
            </tr>
            {data.scenarios.map(x => (
              <tr key={x.id} onClick={() => setSel(x.id)} style={{ cursor: 'pointer', background: x.id === sel ? 'rgba(134,192,222,0.06)' : undefined }}>
                <td style={tdText}>{x.name}</td><td style={{ ...td, color: signColor(x.stability_bn) }}>{bn(x.stability_bn)}</td>
                <td style={td}>{signed(x.investment_pp != null ? -x.investment_pp : null, 2)}</td>
                <td style={td}>{pct(x.psnd_end)}</td><td style={td}>{bn(x.interest_end, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ ...p, color: fg[3], fontSize: 11, marginTop: 8 }}>
          Shocks are applied to the market baseline from next year through the same model as the fan chart (interest repricing, cyclical
          primary balance with semi-elasticity {data.model.cyclical.pb_semi_elasticity as number}, nominal GDP). PSNFL change: a negative number means
          PSNFL falls in {data.target_year}, as the investment rule requires.
        </p>
      </div>
    </div>
  )
}

// ─── Monthly borrowing ────────────────────────────────────────────────────────

function Tracker({ data }: { data: Dsa }) {
  const t = data.tracker
  const gap = t.ytd_bn != null && t.ytd_obr_profile_bn != null ? t.ytd_bn - t.ytd_obr_profile_bn : null
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={grid(190)}>
        <Stat label={`Borrowing ${t.year}, ${t.months_observed} months`} value={bn(t.ytd_bn)}
          sub={<>Last year to {monthLabel(t.latest_month).slice(0, 3)}: {bn(t.ytd_previous_bn)}</>} />
        <Stat label="Against the OBR's year" value={gap == null ? '—' : `${signed(gap, 1)}bn`} color={signColor(gap != null ? -gap : null)}
          sub={<>OBR {bn(t.obr_full_year_bn)} for the year, {bn(t.ytd_obr_profile_bn)} by now on last year's pattern</>} />
        <Stat label="Full year at this pace" value={bn(t.implied_full_year_bn)}
          sub={<>Typically {prob(t.typical_share)} of the year is borrowed by {monthLabel(t.latest_month).slice(0, 3)}</>} />
        <Stat label="Next release" value={t.next_release ?? '—'}
          sub={<>{monthLabel(t.next_month)}: about {bn(t.next_month_forecast_bn)} if the OBR's year is met</>} />
      </div>
      <div style={card}>
        <div style={sectionLabel}>Public sector net borrowing by month (£bn)</div>
        <TrackerChart tracker={t} />
        <p style={{ ...p, color: fg[3], fontSize: 11 }}>
          ONS public sector finances, released {data.sources.pusf_release}; latest month {monthLabel(t.latest_month)}. The OBR line spreads the OBR's
          full-year forecast over the months in last year's proportions.
        </p>
      </div>
    </div>
  )
}

// ─── Market pricing ───────────────────────────────────────────────────────────

function Market({ data }: { data: Dsa }) {
  const m = data.market
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={sectionLabel}>Gilt market: today, the OBR's window and a year ago</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['', 'Latest', 'OBR window', 'Change', 'Year ago'].map((h, i) => <th key={h || 'x'} style={{ ...th, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {m.gauges.map(g => {
              const ch = g.latest != null && g.obr_window != null ? g.latest - g.obr_window : null
              const d = g.unit === 'bp' ? 0 : 2
              const u = g.unit === 'bp' ? 'bp' : '%'
              return (
                <tr key={g.id}>
                  <td style={tdText}>{g.label}</td><td style={td}>{num(g.latest, d)}{u}</td><td style={td}>{num(g.obr_window, d)}{u}</td>
                  <td style={{ ...td, color: fg[2] }}>{g.unit === 'bp' ? signed(ch, 0) : signed(ch != null ? ch * 100 : null, 0)}bp</td>
                  <td style={td}>{g.year_ago == null ? '—' : `${num(g.year_ago, d)}${u}`}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={grid(420)}>
        <div style={card}><div style={sectionLabel}>Gilt yields (spot)</div><YieldsChart market={m} /></div>
        <div style={card}><div style={sectionLabel}>Nominal gilt and OIS curves</div><CurveChart market={m} /></div>
      </div>
      <div style={card}>
        <div style={sectionLabel}>10y gilt yield minus 10y OIS (bp): a gauge of the premium for holding gilts</div>
        <SpreadChart market={m} />
      </div>
    </div>
  )
}

// ─── Method & data ────────────────────────────────────────────────────────────

function Method({ data }: { data: Dsa }) {
  const s = data.sources
  const v = data.model.var as { sample: string; observations: number; max_eigenvalue: number; shock_sd: Record<string, number> }
  const b = data.model.bohn as { rho: number | null; se: number | null; r2: number | null; n: number; used: number; resid_sd: number; sample?: string }
  const rows: [string, React.ReactNode][] = [
    ['OBR forecast', <>Economic and fiscal outlook, {s.obr_edition} (<a href={s.obr_source ?? '#'} style={{ color: accent }} target="_blank" rel="noreferrer">source</a>); market window to {s.obr_cutoff}</>],
    ['ONS public sector finances', <>Release {s.pusf_release}, latest month {s.pusf_latest_month}; next release {s.pusf_next_release}. Every release is kept ({s.pusf_editions.length} so far).</>],
    ['Bank of England curves', <>Nominal, real, implied RPI and OIS spot curves; OBR window averaged to {s.curves_cutoff}, latest {s.curves_latest}</>],
    ['Gilt portfolio', s.register_source === 'dmo' ? <>DMO gilts in issue (uploaded {s.register_upload?.uploaded as string})</> : <>Reconstruction from ONS totals: upload the DMO D1A report for gilt-by-gilt cash flows</>],
  ]
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card}>
        <div style={sectionLabel}>Data</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>{rows.map(([k, val]) => (
            <tr key={k}><td style={{ ...tdText, color: fg[3], width: 200, verticalAlign: 'top' }}>{k}</td><td style={{ ...tdText, whiteSpace: 'normal', color: fg[2] }}>{val}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div style={card}>
        <div style={sectionLabel}>How it works</div>
        <div style={{ display: 'grid', gap: 10 }}>
          <p style={p}><b style={{ color: fg[1] }}>Baselines.</b> The OBR baseline is the OBR's forecast as published. The market baseline keeps everything the OBR
            forecast except debt interest, which is re-priced: an interest model is run twice, on the Bank of England curves averaged over the OBR's
            market window and on the latest curves, and only the difference is added to the OBR's figures (with the extra borrowing it causes).</p>
          <p style={p}><b style={{ color: fg[1] }}>Interest model.</b> Coupons on every gilt to maturity; new issuance (split as in the DMO remit) at forward
            yields from the curve; index-linked gilts uplifted by RPI (OBR forecast plus the change in market-implied RPI); bills, NS&I and the
            reserves created by QE at the Bank Rate path implied by OIS; the APF run down by £{data.model.apf.reduction_per_year_bn as number}bn a year.</p>
          <p style={p}><b style={{ color: fg[1] }}>Stochastic projection.</b> A VAR(2) on quarterly real growth, GDP-deflator inflation, Bank Rate and the 10y
            gilt yield ({v.sample}, {v.observations} quarters, pandemic excluded; largest root {num(v.max_eigenvalue, 3)}) draws {data.model.paths.toLocaleString()} paths
            of shocks. Each feeds nominal GDP, interest (floating debt at once, new issuance until it matures, linkers through RPI) and the primary
            balance (cyclical response, persistence {data.model.cyclical.gap_persistence as number}, plus an independent shock of {num(b.resid_sd, 2)}% of GDP a year).</p>
          <p style={p}><b style={{ color: fg[1] }}>Fiscal reaction.</b> The response of the primary surplus to last year's debt ratio, estimated on {b.sample ?? 'UK data'}:
            {' '}{num(b.rho, 3)} (s.e. {num(b.se, 3)}, R² {num(b.r2, 2)}). {b.used > 0 ? `The projection uses ${num(b.used, 3)}.` : 'Not significantly positive, so the projection assumes no systematic consolidation as debt rises.'}</p>
          <p style={p}><b style={{ color: fg[1] }}>Limits.</b> Market re-pricing covers debt interest only: growth, receipts and spending stay at the OBR's
            forecast until the next one. Implied RPI below 2½ years uses the curve's shortest point. Years after the OBR horizon are an extension, not a forecast.</p>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

async function getJson<T>(url: string, ok: (body: unknown) => boolean, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init)
  const body = await res.json().catch(() => undefined)
  if (!res.ok) throw new Error((body as { detail?: string } | undefined)?.detail ?? `HTTP ${res.status}`)
  // An old server answers unknown /api routes with the SPA's index.html
  if (!ok(body)) throw new Error('unexpected response (restart the backend?)')
  return body as T
}

const isStatus = (b: unknown) => typeof b === 'object' && b !== null && 'job' in b

export default function DsaPage({ country = 'uk' }: { country?: string }) {
  const base = `/api/tools/quant-macro/dsa/${country}`
  const [data, setData] = useState<Dsa | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<DsaStatus | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [measure, setMeasure] = useState<Measure>('psnd_pct')
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const prevState = useRef<string | null>(null)

  const load = useCallback(() => getJson<Dsa>(base, b => Array.isArray((b as Dsa | undefined)?.rules)).then(setData), [base])
  const loadStatus = useCallback(() => getJson<DsaStatus>(`${base}/status`, isStatus).then(setStatus).catch(() => {}), [base])

  useEffect(() => {
    let cancelled = false
    setError(null)
    load().then(() => { if (!cancelled) loadStatus() }).catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true }
  }, [load, loadStatus])

  const running = status?.job.state === 'running'
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(loadStatus, 2000)
    return () => window.clearInterval(id)
  }, [running, loadStatus])
  useEffect(() => {
    const prev = prevState.current
    prevState.current = status?.job.state ?? null
    if (prev === 'running' && status?.job.state === 'done') load().catch(() => {})
  }, [status, load])

  const refresh = () => getJson<DsaStatus>(`${base}/refresh`, isStatus, { method: 'POST' }).then(setStatus).catch(e => setError(String(e.message ?? e)))
  const upload = (f: File) => {
    const form = new FormData()
    form.append('file', f)
    setUploadMsg(`Uploading ${f.name}…`)
    getJson<DsaUpload>(`${base}/upload`, b => typeof b === 'object' && b !== null && 'kind' in b, { method: 'POST', body: form })
      .then(r => { setUploadMsg(`Loaded: ${r.detail}`); setStatus(r.status) })
      .catch(e => setUploadMsg(`Upload failed: ${String(e.message ?? e)}`))
  }

  return (
    <div style={{ background: BG, minHeight: '100vh' }}>
      <header style={{ ...headerBar, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 24px', flexWrap: 'wrap' }}>
        <PageTitle category={QUANT_MACRO_CATEGORY.name} categoryId={QUANT_MACRO_CATEGORY.id}
          flag={<CountryFlag country="GB" height={14} />}
          title="UK Debt Sustainability"
          subtitle={data ? <>OBR {data.sources.obr_edition} forecast at market prices of {dayLabel(data.as_of)} {data.as_of.slice(0, 4)}</> : 'Fiscal rules, debt dynamics and risks'} />
        {data && <Controls status={status} onRefresh={refresh} onUpload={upload} uploadMsg={uploadMsg} />}
      </header>
      <main style={{ padding: '20px 24px' }}>
        {error && <div style={{ color: neg, fontSize: 13, marginBottom: 12 }}>Failed to load: {error}</div>}
        {!data && !error && <div style={{ color: fg[3], fontSize: 13 }}>Loading (the first run downloads the data and takes about a minute)…</div>}
        {data && (
          <div style={{ display: 'grid', gap: 16 }}>
            <Tabs value={tab} onChange={setTab} />
            {tab === 'overview' && <Overview data={data} measure={measure} setMeasure={setMeasure} />}
            {tab === 'rules' && <Rules data={data} />}
            {tab === 'dynamics' && <Dynamics data={data} />}
            {tab === 'interest' && <Interest data={data} />}
            {tab === 'financing' && <Financing data={data} />}
            {tab === 'scenarios' && <Scenarios data={data} measure={measure} setMeasure={setMeasure} />}
            {tab === 'tracker' && <Tracker data={data} />}
            {tab === 'market' && <Market data={data} />}
            {tab === 'method' && <Method data={data} />}
          </div>
        )}
      </main>
    </div>
  )
}
