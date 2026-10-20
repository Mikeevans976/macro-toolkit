import { useEffect, useMemo, useState } from 'react'
import PageTitle, { headerBar } from '../../components/PageTitle'
import CountryFlag from '../../components/CountryFlag'
import { authFetch } from '../../api/client'
import { accent, fg, fontNum, line, line2, neg, pos, warn } from '../../theme'
import { BacktestChart, EvolutionCharts, MonthlyPathChart, QuarterChart } from './charts'
import { QUANT_MACRO_CATEGORY, QUANT_MACRO_MODELS } from './models'
import type { Backtest, Indicator, Nowcast, QuarterRow } from './types'
import {
  BG, GROUP_COLOR, STATUS_LABEL, card, dayLabel, monthLabel, num, quarterLabel, sectionLabel, signColor,
  signed, td, tdText, th,
} from './ui'

// Quant Macro nowcast page. The backend (quant_macro.py / nowcast.py) does all the
// modelling; this page renders the payload.

const TABS = [
  { id: 'nowcast', label: 'Nowcast' },
  { id: 'news', label: 'News & catalysts' },
  { id: 'backtest', label: 'Track record' },
  { id: 'model', label: 'Model & data' },
] as const
type Tab = (typeof TABS)[number]['id']

function Tabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${line}` }}>
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

function SourceBadge({ source, missing }: { source: string; missing: number }) {
  const live = source === 'live'
  return (
    <span title={live ? undefined : `${missing} series unavailable from Bloomberg; showing the simulated panel`}
      style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '3px 8px', borderRadius: 4,
        color: live ? pos : warn, border: `1px solid ${live ? pos : warn}55`,
      }}>
      {live ? 'Live' : 'Simulated'}
    </span>
  )
}

function QuarterPicker({ quarters, value, onChange }: { quarters: QuarterRow[]; value: string; onChange: (q: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Quarter" style={{ display: 'flex', border: `1px solid ${line2}`, borderRadius: 6, overflow: 'hidden' }}>
      {quarters.map(q => (
        <button key={q.quarter} role="radio" aria-checked={q.quarter === value} onClick={() => onChange(q.quarter)}
          style={{
            background: q.quarter === value ? 'rgba(134,192,222,0.14)' : 'transparent', color: q.quarter === value ? accent : fg[3],
            border: 'none', padding: '5px 12px', fontSize: 12, fontFamily: fontNum, cursor: 'pointer',
          }}>
          {quarterLabel(q.quarter)}
        </button>
      ))}
    </div>
  )
}

// ─── Nowcast tab ──────────────────────────────────────────────────────────────

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: React.ReactNode; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: fg[4], textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontFamily: fontNum, fontSize: 15, color: color ?? fg[1], marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: fg[3], marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function QuarterCard({ q, cb, cbLabel }: { q: QuarterRow; cb?: { value: number; published: string }; cbLabel: string }) {
  return (
    <div style={{ ...card, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, color: fg[1], fontWeight: 500 }}>{quarterLabel(q.quarter)}</span>
        <span style={{ fontSize: 10, color: fg[3], textTransform: 'uppercase', letterSpacing: '0.06em' }}>{STATUS_LABEL[q.status]}</span>
      </div>
      <div>
        <div style={{ fontFamily: fontNum, fontSize: 30, color: fg[1], letterSpacing: '-0.02em' }}>
          {signed(q.nowcast)}<span style={{ fontSize: 14, color: fg[3] }}>% q/q</span>
        </div>
        <div style={{ fontSize: 11, color: fg[3], fontFamily: fontNum }}>68%: {num(q.lo68)} to {num(q.hi68)} · 90%: {num(q.lo90)} to {num(q.hi90)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        <Stat label={cbLabel} value={cb ? `${signed(cb.value, 1)}%` : '—'} sub={cb ? `since ${dayLabel(cb.published)}` : 'no estimate'} />
        <Stat label="PMI bridge" value={q.bridge != null ? `${signed(q.bridge)}%` : '—'} sub={q.bridge == null ? 'no surveys yet' : 'survey-only'} />
        <Stat label="Consensus" value={q.consensus != null ? `${signed(q.consensus, 1)}%` : '—'} sub={q.consensus == null ? 'live data only' : 'Bloomberg median'} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: fg[3] }}>
        <span>GDP months in: <span style={{ fontFamily: fontNum, color: fg[2] }}>{q.months_observed}/3</span></span>
        <span>First estimate <span style={{ fontFamily: fontNum, color: fg[2] }}>{dayLabel(q.release_date)}</span></span>
      </div>
    </div>
  )
}

function NextPrintCard({ data }: { data: Nowcast }) {
  const n = data.next_print
  return (
    <div style={{ ...card, display: 'grid', gap: 12, borderColor: 'rgba(134,192,222,0.28)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, color: fg[1], fontWeight: 500 }}>Next print</span>
        <span style={{ fontSize: 11, color: accent, fontFamily: fontNum }}>{dayLabel(n.release_date)}</span>
      </div>
      <div>
        <div style={{ fontSize: 11, color: fg[3] }}>{n.label}</div>
        <div style={{ fontFamily: fontNum, fontSize: 30, color: fg[1], letterSpacing: '-0.02em' }}>
          {signed(n.model)}<span style={{ fontSize: 14, color: fg[3] }}>% m/m</span>
        </div>
        <div style={{ fontSize: 11, color: fg[3], fontFamily: fontNum }}>68%: {num(n.lo68)} to {num(n.hi68)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <Stat label="Consensus m/m" value={n.consensus != null ? `${signed(n.consensus, 1)}%` : '—'}
          sub={n.consensus != null && n.model != null ? <>model − cons. <span style={{ color: signColor(n.model - n.consensus) }}>{signed(n.model - n.consensus)}</span></> : 'live data only'} />
        {n.quarter && (
          <Stat label={`${quarterLabel(n.quarter.quarter)} first estimate`} value={`${signed(n.quarter.model)}% q/q`}
            sub={n.quarter.consensus != null ? `consensus ${signed(n.quarter.consensus, 1)}%` : 'same day'} />
        )}
      </div>
    </div>
  )
}

function CentralBankPanel({ data }: { data: Nowcast }) {
  const cb = data.central_bank
  if (!cb) return null
  return (
    <div style={card}>
      <div style={sectionLabel}>Tracking the {cb.institution}</div>
      {cb.comparisons.map(c => (
        <p key={c.quarter} style={{ fontSize: 13, color: fg[2], margin: '0 0 10px', lineHeight: 1.55 }}>
          {cb.label} put {quarterLabel(c.quarter)} at <b style={{ color: fg[1], fontFamily: fontNum }}>{signed(c.cb_value, 1)}%</b> ({c.cb_source}, {dayLabel(c.cb_published)}).{' '}
          The model is at <b style={{ color: fg[1], fontFamily: fontNum }}>{signed(c.model_now)}%</b>
          {c.gap != null && <>, <span style={{ fontFamily: fontNum, color: signColor(c.gap, 0.05) }}>{signed(c.gap)}pp</span> {c.gap >= 0 ? 'above' : 'below'} the Bank</>}.
          {c.news_since != null && <> Data released since then moved the nowcast by <span style={{ fontFamily: fontNum, color: signColor(c.news_since) }}>{signed(c.news_since)}pp</span>, so the news points to {Math.abs(c.news_since) < 0.03 ? 'little change in' : c.news_since > 0 ? 'an upward revision to' : 'a downward revision to'} the staff estimate.</>}
        </p>
      ))}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Published</th>
            <th style={{ ...th, textAlign: 'left' }}>Source</th>
            <th style={th}>Quarter</th>
            <th style={th}>Estimate</th>
            <th style={th}>Outturn</th>
          </tr>
        </thead>
        <tbody>
          {[...cb.estimates].reverse().map(e => (
            <tr key={`${e.published}-${e.quarter}`} title={e.note ?? undefined}>
              <td style={{ ...td, textAlign: 'left' }}>{e.published}</td>
              <td style={tdText}>
                {e.url ? <a href={e.url} target="_blank" rel="noreferrer" style={{ color: fg[2] }}>{e.source}</a> : e.source}
                {e.note && <span style={{ color: fg[4] }}> *</span>}
              </td>
              <td style={td}>{quarterLabel(e.quarter)}</td>
              <td style={td}>{signed(e.value, 1)}</td>
              <td style={td}>{signed(e.actual)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: fg[4], marginTop: 8 }}>* implied rather than stated; hover for the wording. Estimates are entered by hand from the Bank's publications.</div>
    </div>
  )
}

function NowcastTab({ data }: { data: Nowcast }) {
  const open = data.quarters.filter(q => q.status !== 'released')
  const cbLatest = useMemo(() => {
    const out: Record<string, { value: number; published: string }> = {}
    for (const e of data.central_bank?.estimates ?? []) out[e.quarter] = { value: e.value, published: e.published }
    return out
  }, [data])
  const cbValues = Object.fromEntries(Object.entries(cbLatest).map(([k, v]) => [k, v.value]))
  const cbLabel = data.central_bank?.label ?? 'Central bank'
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(240px, 1fr))`, gap: 16 }}>
        <NextPrintCard data={data} />
        {open.map(q => <QuarterCard key={q.quarter} q={q} cb={cbLatest[q.quarter]} cbLabel={cbLabel} />)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 16 }}>
        <div style={card}>
          <div style={sectionLabel}>{data.target_label} growth, % q/q</div>
          <QuarterChart quarters={data.quarters} cb={cbValues} cbLabel={cbLabel} />
        </div>
        <div style={card}>
          <div style={sectionLabel}>Monthly {data.target_label}, % m/m: outturns and model path</div>
          <MonthlyPathChart path={data.monthly_path} unit="% m/m" />
        </div>
      </div>
      <CentralBankPanel data={data} />
    </div>
  )
}

// ─── News & catalysts tab ─────────────────────────────────────────────────────

function NewsTab({ data, quarter, names }: { data: Nowcast; quarter: string; names: Record<string, Indicator> }) {
  const steps = data.evolution
  const first = steps[0]?.nowcasts[quarter]
  const last = steps[steps.length - 1]?.nowcasts[quarter]
  const releases = steps.slice(1).flatMap(s => s.releases.map(r => ({ ...r, date: s.date }))).reverse()
  const catalysts = [...data.indicators].filter(i => i.next_release).sort((a, b) =>
    (a.next_release ?? '').localeCompare(b.next_release ?? '') || a.name.localeCompare(b.name))
  const maxImpact = Math.max(1e-6, ...catalysts.map(c => Math.abs(c.typical_impacts[quarter] ?? 0)))
  const dp = (i?: Indicator) => (i && Math.abs(i.next_expected ?? i.last_value ?? 0) >= 10 ? 1 : 2)

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <div style={sectionLabel}>{quarterLabel(quarter)} nowcast through the data flow, and the news behind each move (pp)</div>
          <div style={{ fontSize: 12, color: fg[3], fontFamily: fontNum }}>
            {dayLabel(steps[0]?.date)} {signed(first)}% → {dayLabel(steps[steps.length - 1]?.date)} {signed(last)}%
            {first != null && last != null && <span style={{ color: signColor(last - first) }}> ({signed(last - first)}pp)</span>}
          </div>
        </div>
        <EvolutionCharts steps={steps} quarter={quarter} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={card}>
          <div style={sectionLabel}>Upcoming releases: model expectation and what a surprise would do</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Date</th>
                <th style={{ ...th, textAlign: 'left' }}>Indicator</th>
                <th style={th}>Period</th>
                <th style={th}>Model</th>
                <th style={th}>Cons.</th>
                <th style={th} title={`Change in the ${quarterLabel(quarter)} nowcast per unit of surprise`}>pp / unit</th>
                <th style={{ ...th, textAlign: 'left' }} title="Impact of a one-standard-deviation surprise (typical one-step forecast error)">Typical move</th>
              </tr>
            </thead>
            <tbody>
              {catalysts.map(c => {
                const imp = c.typical_impacts[quarter] ?? 0
                return (
                  <tr key={c.id}>
                    <td style={{ ...td, textAlign: 'left', color: fg[3] }}>{dayLabel(c.next_release)}</td>
                    <td style={tdText}>
                      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 1, background: GROUP_COLOR[c.group], marginRight: 7 }} />
                      {c.name}
                    </td>
                    <td style={td}>{c.next_period ? monthLabel(c.next_period) : '—'}</td>
                    <td style={td} title={`±${num(c.next_sd)} (1 sd), ${c.units}`}>{num(c.next_expected, dp(c))}</td>
                    <td style={td}>{num(c.consensus, dp(c))}</td>
                    <td style={td}>{signed(c.weights[quarter], 3)}</td>
                    <td style={{ ...td, textAlign: 'left', width: 120 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ display: 'inline-block', height: 6, borderRadius: 2, background: accent, opacity: 0.7, width: Math.max(2, 60 * Math.abs(imp) / maxImpact) }} />
                        ±{num(imp, 3)}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div style={card}>
          <div style={sectionLabel}>Releases since {dayLabel(steps[0]?.date)}: surprise vs model and impact on {quarterLabel(quarter)}</div>
          <div style={{ maxHeight: 560, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: BG }}>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Date</th>
                  <th style={{ ...th, textAlign: 'left' }}>Indicator</th>
                  <th style={th}>Period</th>
                  <th style={th}>Actual</th>
                  <th style={th}>Model</th>
                  <th style={th}>Surprise</th>
                  <th style={th}>Impact pp</th>
                </tr>
              </thead>
              <tbody>
                {releases.map(r => {
                  const ind = names[r.series_id]
                  const imp = r.impacts[quarter]
                  return (
                    <tr key={`${r.date}-${r.series_id}-${r.period}`}>
                      <td style={{ ...td, textAlign: 'left', color: fg[3] }}>{dayLabel(r.date)}</td>
                      <td style={tdText}>
                        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 1, background: GROUP_COLOR[ind?.group ?? ''], marginRight: 7 }} />
                        {ind?.name ?? r.series_id}
                      </td>
                      <td style={td}>{monthLabel(r.period)}</td>
                      <td style={td}>{num(r.observed, dp(ind))}</td>
                      <td style={td}>{num(r.expected, dp(ind))}</td>
                      <td style={{ ...td, color: signColor(r.news) }}>{signed(r.news, dp(ind))}</td>
                      <td style={{ ...td, color: signColor(imp, 0.0005) }}>{signed(imp, 3)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Track record tab ─────────────────────────────────────────────────────────

function BacktestTab({ slug }: { slug: string }) {
  const [bt, setBt] = useState<Backtest | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    authFetch(`/api/tools/quant-macro/${slug}/backtest`)
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        if (!Array.isArray(body?.summary)) throw new Error('unexpected response (restart the backend?)')
        if (!cancelled) setBt(body as Backtest)
      })
      .catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true }
  }, [slug])

  if (error) return <div style={{ color: neg, fontSize: 13 }}>Failed to load the backtest: {error}</div>
  if (!bt) return <div style={{ color: fg[3], fontSize: 13 }}>Running the pseudo-real-time backtest (a minute on first use)…</div>
  const last = bt.horizons.length - 1
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={card}>
          <div style={sectionLabel}>Root-mean-square error of the q/q nowcast, pp, by days before the first estimate</div>
          <BacktestChart bt={bt} />
          <div style={{ fontSize: 11, color: fg[4], marginTop: 6 }}>{bt.note}</div>
        </div>
        <div style={card}>
          <div style={sectionLabel}>Error statistics</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Days before</th>
                <th style={th}>DFM RMSE</th>
                <th style={th}>DFM bias</th>
                <th style={th}>Bridge RMSE</th>
                <th style={th}>Last outturn RMSE</th>
                <th style={th}>Quarters</th>
              </tr>
            </thead>
            <tbody>
              {bt.summary.map(s => (
                <tr key={s.horizon}>
                  <td style={{ ...td, textAlign: 'left' }}>{Math.abs(s.horizon)}</td>
                  <td style={{ ...td, color: fg[1] }}>{num(s.dfm.rmse)}</td>
                  <td style={td}>{signed(s.dfm.bias)}</td>
                  <td style={td}>{num(s.bridge.rmse)}</td>
                  <td style={td}>{num(s.naive.rmse)}</td>
                  <td style={td}>{s.dfm.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div style={card}>
        <div style={sectionLabel}>Each quarter: nowcast the day before the first estimate vs outturn</div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: BG }}>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Quarter</th>
                <th style={th}>Released</th>
                <th style={th}>Outturn</th>
                {bt.horizons.map(h => <th key={h} style={th}>DFM {Math.abs(h)}d</th>)}
                <th style={th}>Bridge</th>
                <th style={th}>Error</th>
              </tr>
            </thead>
            <tbody>
              {[...bt.rows].reverse().map(r => {
                const err = r.dfm[last] != null && r.actual != null ? r.dfm[last]! - r.actual : null
                return (
                  <tr key={r.quarter}>
                    <td style={{ ...td, textAlign: 'left' }}>{quarterLabel(r.quarter)}</td>
                    <td style={{ ...td, color: fg[3] }}>{r.release_date}</td>
                    <td style={{ ...td, color: fg[1] }}>{signed(r.actual)}</td>
                    {r.dfm.map((v, k) => <td key={k} style={td}>{signed(v)}</td>)}
                    <td style={td}>{signed(r.bridge[last])}</td>
                    <td style={td}>{signed(err)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Model & data tab ─────────────────────────────────────────────────────────

function ModelTab({ data }: { data: Nowcast }) {
  const m = data.model
  const p: React.CSSProperties = { fontSize: 13, color: fg[2], lineHeight: 1.6, margin: '0 0 10px' }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.9fr) minmax(0, 1.1fr)', gap: 16, alignItems: 'start' }}>
      <div style={card}>
        <div style={sectionLabel}>How the nowcast is built</div>
        <p style={p}>
          A mixed-frequency dynamic factor model in the Bańbura–Modugno class: {m.n_series} monthly indicators load on a common
          <b style={{ color: fg[1] }}> Global</b> factor (VAR({m.factor_orders.Global ?? 1})) and one block factor each
          ({m.blocks.filter(b => b !== 'Global').join(', ')}). Every series keeps an AR(1) idiosyncratic component.
          Parameters are estimated by EM on {m.sample_start} to {monthLabel(m.last_data)} ({m.em_iterations} iterations),
          with {m.excluded.join(', ')} treated as missing (COVID).
        </p>
        <p style={p}>
          The target is monthly {data.target_label} (% m/m). Quarterly growth of the three-month average follows exactly from the
          monthly path, (g<sub>t</sub> + 2g<sub>t−1</sub> + 3g<sub>t−2</sub> + 2g<sub>t−3</sub> + g<sub>t−4</sub>) / 3, so the same model
          forecasts the next monthly print and the quarterly first estimate. Months already published enter as data; bands
          come from the smoothed state covariance, including the covariance across months.
        </p>
        <p style={p}>
          News: with parameters fixed, each release moves the nowcast by its weight × (actual − model expectation).
          The weights in the catalysts table say how much a surprise in each upcoming release would move the nowcast,
          assuming everything released before it comes in line.
        </p>
        <p style={p}>
          Like the BoE staff's own suite, the toolkit pairs the DFM with a survey bridge equation
          {data.bridge && <> (q/q on the quarterly average of the composite PMI: β = {num(data.bridge.beta, 3)}, R² = {num(data.bridge.r2)}, n = {data.bridge.n})</>},
          and the panel includes the Bank's Agents' scores and Decision Maker Panel. The Bank's published staff estimates sit
          alongside, so the gap between the model and the Bank, and the news since the Bank last spoke, are visible.
        </p>
        <p style={{ ...p, color: fg[3], fontSize: 12 }}>
          Caveats: vintages are pseudo-real-time (today's data masked by release date, so no revisions), and parameters use
          the full sample. Release dates come from Bloomberg when available, otherwise from typical publication lags.
        </p>
        {data.missing_series.length > 0 && (
          <p style={{ ...p, color: warn, fontSize: 12 }}>
            Bloomberg did not return {data.missing_series.length} series, so the page shows the simulated panel: {data.missing_series.join(', ')}.
          </p>
        )}
      </div>
      <div style={card}>
        <div style={sectionLabel}>Indicator panel</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Indicator</th>
              <th style={{ ...th, textAlign: 'left' }}>Ticker</th>
              <th style={{ ...th, textAlign: 'left' }}>Units</th>
              <th style={th}>Latest</th>
              <th style={th}>Period</th>
              <th style={th} title="Loading on the Global factor (standardised)">Global λ</th>
            </tr>
          </thead>
          <tbody>
            {data.indicators.map(i => (
              <tr key={i.id}>
                <td style={tdText}>
                  <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 1, background: GROUP_COLOR[i.group], marginRight: 7 }} />
                  {i.name}
                </td>
                <td style={{ ...tdText, fontFamily: fontNum, color: fg[3], fontSize: 11 }}>{i.ticker}</td>
                <td style={{ ...tdText, color: fg[3], fontSize: 11 }}>{i.units}</td>
                <td style={td}>{num(i.last_value, Math.abs(i.last_value ?? 0) >= 10 ? 1 : 2)}</td>
                <td style={{ ...td, color: fg[3] }}>{i.last_period ? monthLabel(i.last_period) : '—'}</td>
                <td style={td}>{num(i.global_loading, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NowcastPage({ slug }: { slug: string }) {
  const meta = QUANT_MACRO_MODELS.find(m => m.slug === slug) ?? QUANT_MACRO_MODELS[0]
  const [data, setData] = useState<Nowcast | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('nowcast')
  const [quarter, setQuarter] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    authFetch(`/api/tools/quant-macro/${meta.slug}`)
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        // An old server answers unknown /api routes with the SPA's index.html
        if (!Array.isArray(body?.quarters)) throw new Error('unexpected response (restart the backend?)')
        if (cancelled) return
        const payload = body as Nowcast
        setData(payload)
        setQuarter(payload.next_print.quarter?.quarter
          ?? payload.quarters.find(q => q.status === 'nowcast')?.quarter ?? null)
      })
      .catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true }
  }, [meta.slug])

  const names = useMemo(() => Object.fromEntries((data?.indicators ?? []).map(i => [i.id, i])), [data])
  const open = data?.quarters.filter(q => q.status !== 'released') ?? []

  return (
    <div style={{ background: BG, minHeight: '100vh' }}>
      <header style={{ ...headerBar, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 24px' }}>
        <PageTitle category={QUANT_MACRO_CATEGORY.name} categoryId={QUANT_MACRO_CATEGORY.id}
          flag={<CountryFlag country={meta.country} height={14} />}
          title={meta.title}
          subtitle={<>Mixed-frequency dynamic factor model{data ? ` · ${data.model.n_series} indicators · as of ${data.as_of}` : ''}</>} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {data && tab === 'news' && quarter && <QuarterPicker quarters={open} value={quarter} onChange={setQuarter} />}
          {data && <SourceBadge source={data.data_source} missing={data.missing_series.length} />}
        </div>
      </header>

      <main style={{ padding: '20px 24px' }}>
        {error && <div style={{ color: neg, fontSize: 13, marginBottom: 12 }}>Failed to load: {error}</div>}
        {!data && !error && <div style={{ color: fg[3], fontSize: 13 }}>Estimating the model (up to a minute after a restart)…</div>}
        {data && (
          <div style={{ display: 'grid', gap: 16 }}>
            <Tabs value={tab} onChange={setTab} />
            {tab === 'nowcast' && <NowcastTab data={data} />}
            {tab === 'news' && quarter && <NewsTab data={data} quarter={quarter} names={names} />}
            {tab === 'backtest' && <BacktestTab slug={meta.slug} />}
            {tab === 'model' && <ModelTab data={data} />}
          </div>
        )}
      </main>
    </div>
  )
}
