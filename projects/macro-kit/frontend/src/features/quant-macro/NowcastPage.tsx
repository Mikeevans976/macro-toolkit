import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageTitle, { headerBar } from '../../components/PageTitle'
import CountryFlag from '../../components/CountryFlag'
import { authFetch } from '../../api/client'
import { accent, fg, fontNum, line, line2, neg, pos, warn } from '../../theme'
import { BacktestChart, EvolutionCharts, MonthlyPathChart, QuarterChart } from './charts'
import { QUANT_MACRO_CATEGORY, QUANT_MACRO_MODELS } from './models'
import type { Backtest, Indicator, Job, Nowcast, QuarterRow, Status } from './types'
import {
  BG, GROUP_COLOR, STATUS_LABEL, button, card, dayLabel, monthLabel, num, quarterLabel, sectionLabel, signColor,
  signed, stampLabel, td, tdText, th,
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

const running = (j?: Job) => j?.state === 'running'

function JobProgress({ job }: { job: Job }) {
  const pct = job.total > 0 ? Math.round((100 * job.progress) / job.total) : null
  return (
    <div style={{ display: 'grid', gap: 4, minWidth: 220 }}>
      <div style={{ fontSize: 11, color: fg[3] }}>
        {job.step}{job.total > 0 && <span style={{ fontFamily: fontNum }}> · {job.progress}/{job.total}</span>}
      </div>
      {pct != null && (
        <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
          style={{ height: 4, borderRadius: 2, background: line, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: accent }} />
        </div>
      )}
    </div>
  )
}

function RefitControl({ status, onRefit }: { status: Status | null; onRefit: () => void }) {
  const refit = status?.jobs.refit
  const update = status?.jobs.update
  const busy = running(refit)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {busy && refit ? <JobProgress job={refit} />
        : running(update) && update ? <span style={{ fontSize: 11, color: fg[3] }}>Updating with new data: {update.step}</span>
        : (
          <span style={{ fontSize: 11, color: fg[3] }}
            title={status?.model_data_as_of ? `Parameters estimated on data as of ${status.model_data_as_of}` : undefined}>
            {refit?.state === 'error' ? <span style={{ color: neg }}>Refit failed: {refit.error}</span>
              : <>Model fitted <span style={{ fontFamily: fontNum, color: fg[2] }}>{stampLabel(status?.model_fitted_at)}</span></>}
          </span>
        )}
      <button type="button" onClick={onRefit} disabled={busy || !status}
        title="Re-estimate the parameters on today's data (about a minute)"
        style={{ ...button, opacity: busy || !status ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}>
        {busy ? 'Refitting…' : 'Refit'}
      </button>
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

function QuarterCard({ q, cb, cbLabel, units, quarterly }: {
  q: QuarterRow; cb?: { value: number; published: string }; cbLabel: string; units: string; quarterly: boolean
}) {
  return (
    <div style={{ ...card, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, color: fg[1], fontWeight: 500 }}>{quarterLabel(q.quarter)}</span>
        <span style={{ fontSize: 10, color: fg[3], textTransform: 'uppercase', letterSpacing: '0.06em' }}>{STATUS_LABEL[q.status]}</span>
      </div>
      <div>
        <div style={{ fontFamily: fontNum, fontSize: 30, color: fg[1], letterSpacing: '-0.02em' }}>
          {signed(q.nowcast)}<span style={{ fontSize: 14, color: fg[3] }}>{units}</span>
        </div>
        <div style={{ fontSize: 11, color: fg[3], fontFamily: fontNum }}>68%: {num(q.lo68)} to {num(q.hi68)} · 90%: {num(q.lo90)} to {num(q.hi90)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        <Stat label={cbLabel} value={cb ? `${signed(cb.value, 1)}%` : '—'} sub={cb ? `since ${dayLabel(cb.published)}` : 'no estimate'} />
        <Stat label="Survey bridge" value={q.bridge != null ? `${signed(q.bridge)}%` : '—'} sub={q.bridge == null ? 'no surveys yet' : 'survey-only'} />
        <Stat label="Consensus" value={q.consensus != null ? `${signed(q.consensus, 1)}%` : '—'} sub={q.consensus == null ? 'live data only' : 'Bloomberg median'} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: fg[3] }}>
        <span>{quarterly ? 'Months of data in' : 'GDP months in'}: <span style={{ fontFamily: fontNum, color: fg[2] }}>{q.months_observed}/3</span></span>
        <span>First estimate <span style={{ fontFamily: fontNum, color: fg[2] }}>{dayLabel(q.release_date)}</span></span>
      </div>
    </div>
  )
}

function NextPrintCard({ data }: { data: Nowcast }) {
  const n = data.next_print
  const quarterly = data.target_freq === 'Q'
  return (
    <div style={{ ...card, display: 'grid', gap: 12, borderColor: 'rgba(134,192,222,0.28)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, color: fg[1], fontWeight: 500 }}>Next print</span>
        <span style={{ fontSize: 11, color: accent, fontFamily: fontNum }}>{dayLabel(n.release_date)}</span>
      </div>
      <div>
        <div style={{ fontSize: 11, color: fg[3] }}>{n.label}</div>
        <div style={{ fontFamily: fontNum, fontSize: 30, color: fg[1], letterSpacing: '-0.02em' }}>
          {signed(n.model)}<span style={{ fontSize: 14, color: fg[3] }}>{quarterly ? data.target_units.replace('q/q ', '') : '% m/m'}</span>
        </div>
        <div style={{ fontSize: 11, color: fg[3], fontFamily: fontNum }}>68%: {num(n.lo68)} to {num(n.hi68)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <Stat label={quarterly ? 'Consensus' : 'Consensus m/m'} value={n.consensus != null ? `${signed(n.consensus, 1)}%` : '—'}
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
  const downloaded = cb.label === 'GDPNow'
  return (
    <div style={card}>
      <div style={sectionLabel}>Tracking the {cb.institution}</div>
      {cb.comparisons.map(c => (
        <p key={c.quarter} style={{ fontSize: 13, color: fg[2], margin: '0 0 10px', lineHeight: 1.55 }}>
          {cb.label} put {quarterLabel(c.quarter)} at <b style={{ color: fg[1], fontFamily: fontNum }}>{signed(c.cb_value, 1)}%</b> ({c.cb_source}, {dayLabel(c.cb_published)}).{' '}
          The model is at <b style={{ color: fg[1], fontFamily: fontNum }}>{signed(c.model_now)}%</b>
          {c.gap != null && <>, <span style={{ fontFamily: fontNum, color: signColor(c.gap, 0.05) }}>{signed(c.gap)}pp</span> {c.gap >= 0 ? 'above' : 'below'} {downloaded ? cb.label : 'the Bank'}</>}.
          {c.news_since != null && <> Data released since then moved the nowcast by <span style={{ fontFamily: fontNum, color: signColor(c.news_since) }}>{signed(c.news_since)}pp</span>, so the news points to {Math.abs(c.news_since) < 0.03 ? 'little change in' : c.news_since > 0 ? 'an upward revision to' : 'a downward revision to'} {downloaded ? `the next ${cb.label} reading` : 'the staff estimate'}.</>}
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
          {[...cb.estimates].reverse().slice(0, downloaded ? 30 : undefined).map(e => (
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
      <div style={{ fontSize: 11, color: fg[4], marginTop: 8 }}>
        {downloaded
          ? <>Every GDPNow update, read from the Atlanta Fed's own workbook each day (latest 30 shown).</>
          : <>* implied rather than stated; hover for the wording. Estimates are entered by hand from the Bank's publications.</>}
      </div>
    </div>
  )
}

function PolicyPanel({ data }: { data: Nowcast }) {
  const pol = data.policy
  if (!pol) return null
  const prev = pol.previous
  return (
    <div style={card}>
      <div style={sectionLabel}>{data.target_label} growth against the {pol.label}, % Q4/Q4</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Year</th>
            <th style={th}>This model</th>
            <th style={th}>{pol.release}</th>
            {prev && <th style={th}>{prev.release}</th>}
            <th style={th}>Unemployment ({pol.release})</th>
          </tr>
        </thead>
        <tbody>
          {pol.model_years.map(y => (
            <tr key={y.year}>
              <td style={tdText}>{y.year}{y.quarters_published > 0 && <span style={{ color: fg[4] }}> · {y.quarters_published}/4 published</span>}</td>
              <td style={{ ...td, color: fg[1] }}>{y.model == null ? '—' : num(y.model, 1)}</td>
              <td style={td}>{num(pol.gdp[String(y.year)], 1)}</td>
              {prev && <td style={{ ...td, color: fg[3] }}>{num(prev.gdp[String(y.year)], 1)}</td>}
              <td style={td}>{num(pol.unemployment[String(y.year)], 1)}</td>
            </tr>
          ))}
          <tr>
            <td style={tdText}>Longer run</td><td style={td}>—</td><td style={td}>{num(pol.gdp.longer_run, 1)}</td>
            {prev && <td style={{ ...td, color: fg[3] }}>{num(prev.gdp.longer_run, 1)}</td>}
            <td style={td}>{num(pol.unemployment.longer_run, 1)}</td>
          </tr>
        </tbody>
      </table>
      <p style={{ fontSize: 11, color: fg[3], margin: '8px 0 0', lineHeight: 1.5 }}>
        The model's year compounds its four quarters (outturns where published, nowcasts and forecasts otherwise); it reaches as far as
        the model forecasts. <a href={pol.url} target="_blank" rel="noreferrer" style={{ color: accent }}>{pol.institution}, {pol.release}</a>.
      </p>
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
  const quarterly = data.target_freq === 'Q'
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(240px, 1fr))`, gap: 16 }}>
        <NextPrintCard data={data} />
        {open.map(q => <QuarterCard key={q.quarter} q={q} cb={cbLatest[q.quarter]} cbLabel={cbLabel}
          units={quarterly ? data.target_units.replace('q/q ', '') : '% q/q'} quarterly={quarterly} />)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 16 }}>
        <div style={card}>
          <div style={sectionLabel}>{data.target_label} growth, {data.target_units}</div>
          <QuarterChart quarters={data.quarters} cb={cbValues} cbLabel={cbLabel} />
        </div>
        {data.monthly_path.length > 0 ? (
          <div style={card}>
            <div style={sectionLabel}>Monthly {data.target_label}, % m/m: outturns and model path</div>
            <MonthlyPathChart path={data.monthly_path} unit="% m/m" />
          </div>
        ) : <PolicyPanel data={data} />}
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
          <div style={sectionLabel}>Releases and revisions since {dayLabel(steps[0]?.date)}: surprise vs model and impact on {quarterLabel(quarter)}</div>
          <div style={{ maxHeight: 560, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: BG }}>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Date</th>
                  <th style={{ ...th, textAlign: 'left' }}>Indicator</th>
                  <th style={th}>Period</th>
                  <th style={th} title="Released value; for a revision, the revised value">Actual</th>
                  <th style={th} title="Model expectation; for a revision, the previously published value">Model / prev.</th>
                  <th style={th} title="Actual − model; for a revision, the size of the revision">Surprise</th>
                  <th style={th}>Impact pp</th>
                </tr>
              </thead>
              <tbody>
                {releases.map(r => {
                  const ind = names[r.series_id]
                  const imp = r.impacts[quarter]
                  const older = r.series_id === 'older_revisions'
                  return (
                    <tr key={`${r.date}-${r.series_id}-${r.period}-${r.kind}`}>
                      <td style={{ ...td, textAlign: 'left', color: fg[3] }}>{dayLabel(r.date)}</td>
                      <td style={tdText}>
                        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 1, background: GROUP_COLOR[older ? 'Older revisions' : ind?.group ?? ''], marginRight: 7 }} />
                        {older ? `Revisions before ${monthLabel(r.period)}` : ind?.name ?? r.series_id}
                        {r.kind === 'revision' && !older && <span style={{ color: fg[4], fontSize: 11 }}> (revised)</span>}
                      </td>
                      <td style={td}>{older ? '' : monthLabel(r.period)}</td>
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

function BacktestTab({ bt, error, job, onRun }: {
  bt: Backtest | null | undefined; error: string | null; job?: Job; onRun: () => void
}) {
  const busy = running(job)
  const header = (
    <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ fontSize: 12, color: fg[3], lineHeight: 1.6, maxWidth: 760 }}>
        {bt ? (
          <>Last run <span style={{ fontFamily: fontNum, color: fg[2] }}>{stampLabel(bt.run_at)}</span> on data as of {bt.as_of}
            {' '}· {bt.n_fits} quarterly re-estimations · took {Math.round(bt.duration_s / 60)} min.{' '}</>
        ) : bt === null ? <>No backtest has been run yet. </> : null}
        Each nowcast uses only the data public on that day (first prints and revisions as published), with
        parameters re-estimated at the start of each quarter. Takes about 5–10 minutes; the page stays usable.
        {job?.state === 'error' && <div style={{ color: neg }}>Last run failed: {job.error}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {busy && job && <JobProgress job={job} />}
        <button type="button" onClick={onRun} disabled={busy}
          style={{ ...button, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}>
          {busy ? 'Running…' : 'Run full backtest'}
        </button>
      </div>
    </div>
  )

  if (error) return <div style={{ display: 'grid', gap: 16 }}>{header}<div style={{ color: neg, fontSize: 13 }}>Failed to load the backtest: {error}</div></div>
  if (bt === undefined) return <div style={{ display: 'grid', gap: 16 }}>{header}<div style={{ color: fg[3], fontSize: 13 }}>Loading…</div></div>
  if (bt === null) return header
  const last = bt.horizons.length - 1
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {header}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={card}>
          <div style={sectionLabel}>Root-mean-square error of the q/q nowcast vs the first estimate, pp, by days before it</div>
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
                <th style={th} title="DFM error against today's (revised) value instead of the first estimate">DFM vs latest</th>
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
                  <td style={td}>{num(s.dfm.rmse_latest)}</td>
                  <td style={td}>{num(s.bridge.rmse)}</td>
                  <td style={td}>{num(s.naive.rmse)}</td>
                  <td style={td}>{s.dfm.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {bt.first_estimate_revision_rmse != null && (
            <div style={{ fontSize: 11, color: fg[4], marginTop: 10 }}>
              For scale: the first estimate itself has since been revised by {num(bt.first_estimate_revision_rmse)}pp (RMS) over these quarters.
            </div>
          )}
        </div>
      </div>
      <div style={card}>
        <div style={sectionLabel}>Each quarter: real-time nowcasts vs the first estimate</div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: BG }}>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Quarter</th>
                <th style={th}>Released</th>
                <th style={th}>First est.</th>
                <th style={th}>Latest</th>
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
                    <td style={td}>{signed(r.actual_latest)}</td>
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
        {data.target_freq === 'Q' ? (
          <p style={p}>
            The target is quarterly {data.target_label} ({data.target_units}), observed in the last month of each quarter. It loads on the
            same factors through their monthly path, aggregated as (g<sub>t</sub> + 2g<sub>t−1</sub> + 3g<sub>t−2</sub> + 2g<sub>t−3</sub> +
            g<sub>t−4</sub>) / 3 (Mariano and Murasawa), the approach of the New York Fed Staff Nowcast. Bands come from the smoothed
            state covariance; the model runs four quarters past the current one for the comparison with the FOMC's projections.
          </p>
        ) : (
          <p style={p}>
            The target is monthly {data.target_label} (% m/m). Quarterly growth of the three-month average follows exactly from the
            monthly path, (g<sub>t</sub> + 2g<sub>t−1</sub> + 3g<sub>t−2</sub> + 2g<sub>t−3</sub> + g<sub>t−4</sub>) / 3, so the same model
            forecasts the next monthly print and the quarterly first estimate. Months already published enter as data; bands
            come from the smoothed state covariance, including the covariance across months.
          </p>
        )}
        <p style={p}>
          News: with parameters fixed, each release moves the nowcast by its weight × (actual − model expectation).
          The weights in the catalysts table say how much a surprise in each upcoming release would move the nowcast,
          assuming everything released before it comes in line.
        </p>
        {data.country === 'US' ? (
          <p style={p}>
            The panel follows the New York Fed Staff Nowcast and the Atlanta Fed's GDPNow (surveys, labour, activity, housing), with a
            survey bridge equation alongside
            {data.bridge && <> (GDP on the quarterly average of the ISM manufacturing index: β = {num(data.bridge.beta, 3)}, R² = {num(data.bridge.r2)}, n = {data.bridge.n})</>}.
            GDPNow's every update sits next to the model, and the FOMC's projections next to its calendar-year forecasts.
          </p>
        ) : (
          <p style={p}>
            Like the BoE staff's own suite, the toolkit pairs the DFM with a survey bridge equation
            {data.bridge && <> (q/q on the quarterly average of the composite PMI: β = {num(data.bridge.beta, 3)}, R² = {num(data.bridge.r2)}, n = {data.bridge.n})</>},
            and the panel includes the Bank's Agents' scores and Decision Maker Panel. The Bank's published staff estimates sit
            alongside, so the gap between the model and the Bank, and the news since the Bank last spoke, are visible.
          </p>
        )}
        <p style={p}>
          Data are real-time: every value is stored with the day it became public, first prints and revisions alike, so the
          news history and the backtest see each day's data exactly as published (sources per indicator below).
          Parameters were last estimated on data as of {m.fit_data_as_of ?? '—'} ({stampLabel(m.fitted_at)}); new data
          are run through those parameters until the next Refit.
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

function VintagesCard({ data }: { data: Nowcast }) {
  return (
    <div style={card}>
      <div style={sectionLabel}>Real-time data: where each indicator's first prints and revisions come from</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {data.indicators.map(i => (
            <tr key={i.id}>
              <td style={{ ...tdText, width: 220 }}>
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 1, background: GROUP_COLOR[i.group], marginRight: 7 }} />
                {i.name}
              </td>
              <td style={{ ...tdText, color: fg[3], whiteSpace: 'normal' }}>{i.vintages}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

async function getJson<T>(url: string, ok: (body: unknown) => boolean, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json().catch(() => undefined)
  // An old server answers unknown /api routes with the SPA's index.html
  if (!ok(body)) throw new Error('unexpected response (restart the backend?)')
  return body as T
}

const isStatus = (b: unknown) => typeof b === 'object' && b !== null && 'jobs' in b

export default function NowcastPage({ slug }: { slug: string }) {
  const meta = QUANT_MACRO_MODELS.find(m => m.slug === slug) ?? QUANT_MACRO_MODELS[0]
  const base = `/api/tools/quant-macro/${meta.slug}`
  const [data, setData] = useState<Nowcast | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('nowcast')
  const [quarter, setQuarter] = useState<string | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [bt, setBt] = useState<Backtest | null | undefined>(undefined)
  const [btError, setBtError] = useState<string | null>(null)
  const prevJobs = useRef<Status['jobs'] | null>(null)

  const loadNowcast = useCallback(() => getJson<Nowcast>(base, b => Array.isArray((b as Nowcast | undefined)?.quarters))
    .then(payload => {
      setData(payload)
      setQuarter(q => (q && payload.quarters.some(r => r.quarter === q && r.status !== 'released') ? q
        : payload.next_print.quarter?.quarter ?? payload.quarters.find(r => r.status === 'nowcast')?.quarter ?? null))
    }), [base])
  const loadStatus = useCallback(() => getJson<Status>(`${base}/status`, isStatus).then(setStatus).catch(() => {}), [base])
  const loadBacktest = useCallback(() => getJson<Backtest | null>(`${base}/backtest`,
    b => b === null || Array.isArray((b as Backtest | undefined)?.summary))
    .then(b => { setBt(b); setBtError(null) })
    .catch(e => setBtError(String(e.message ?? e))), [base])

  useEffect(() => {
    let cancelled = false
    setError(null)
    loadNowcast().then(() => { if (!cancelled) loadStatus() })
      .catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true }
  }, [loadNowcast, loadStatus])

  useEffect(() => { if (tab === 'backtest' && bt === undefined) loadBacktest() }, [tab, bt, loadBacktest])

  // Poll while a job runs; reload what it produced when it finishes.
  const anyRunning = !!status && Object.values(status.jobs).some(j => j.state === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const id = window.setInterval(loadStatus, 2000)
    return () => window.clearInterval(id)
  }, [anyRunning, loadStatus])
  useEffect(() => {
    const prev = prevJobs.current
    prevJobs.current = status?.jobs ?? null
    if (!prev || !status) return
    const finished = (k: keyof Status['jobs']) => prev[k].state === 'running' && status.jobs[k].state !== 'running'
    if (finished('update') || finished('refit')) loadNowcast().catch(() => {})
    if (finished('backtest')) loadBacktest()
  }, [status, loadNowcast, loadBacktest])

  const post = (path: string) => getJson<Status>(`${base}${path}`, isStatus, { method: 'POST' })
    .then(setStatus).catch(e => setError(String(e.message ?? e)))

  const names = useMemo(() => Object.fromEntries((data?.indicators ?? []).map(i => [i.id, i])), [data])
  const open = data?.quarters.filter(q => q.status !== 'released') ?? []

  return (
    <div style={{ background: BG, minHeight: '100vh' }}>
      <header style={{ ...headerBar, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 24px', flexWrap: 'wrap' }}>
        <PageTitle category={QUANT_MACRO_CATEGORY.name} categoryId={QUANT_MACRO_CATEGORY.id}
          flag={<CountryFlag country={meta.country} height={14} />}
          title={meta.title}
          subtitle={<>Mixed-frequency dynamic factor model{data ? ` · ${data.model.n_series} indicators · as of ${data.as_of}` : ''}</>} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {data && tab === 'news' && quarter && <QuarterPicker quarters={open} value={quarter} onChange={setQuarter} />}
          {data && <RefitControl status={status} onRefit={() => post('/refit')} />}
          {data && <SourceBadge source={data.data_source} missing={data.missing_series.length} />}
        </div>
      </header>

      <main style={{ padding: '20px 24px' }}>
        {error && <div style={{ color: neg, fontSize: 13, marginBottom: 12 }}>Failed to load: {error}</div>}
        {!data && !error && <div style={{ color: fg[3], fontSize: 13 }}>Loading the nowcast (the first run estimates the model, about a minute)…</div>}
        {data && (
          <div style={{ display: 'grid', gap: 16 }}>
            <Tabs value={tab} onChange={setTab} />
            {tab === 'nowcast' && <NowcastTab data={data} />}
            {tab === 'news' && quarter && <NewsTab data={data} quarter={quarter} names={names} />}
            {tab === 'backtest' && <BacktestTab bt={bt} error={btError} job={status?.jobs.backtest} onRun={() => post('/backtest')} />}
            {tab === 'model' && <div style={{ display: 'grid', gap: 16 }}><ModelTab data={data} /><VintagesCard data={data} /></div>}
          </div>
        )}
      </main>
    </div>
  )
}
