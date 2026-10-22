import { useCallback, useEffect, useRef, useState } from 'react'
import PageTitle, { headerBar } from '../../components/PageTitle'
import CountryFlag from '../../components/CountryFlag'
import { authFetch } from '../../api/client'
import { accent, fg, fontNum, line, line2, neg, warn } from '../../theme'
import { ContributionsChart, GdpImpliedChart, LoadingsChart, SvarChart, UnderlyingChart } from './labourCharts'
import { LABOUR_GROUP_COLOR, type Labour, type LabourJob, type LabourStatus } from './labourTypes'
import { QUANT_MACRO_CATEGORY } from './models'
import { BG, button, card, monthLabel, num, sectionLabel, signColor, signed, stampLabel, td, tdText, th } from './ui'

// UK Labour Market Nowcast: Bank of England staff's underlying employment growth measure,
// rebuilt. The backend (labour_nowcast.py) does all the modelling; this page renders it.

const TABS = [
  { id: 'underlying', label: 'Underlying employment' },
  { id: 'contributions', label: 'Contributions & news' },
  { id: 'prints', label: 'Next prints' },
  { id: 'boe', label: 'Bank of England' },
  { id: 'model', label: 'Indicators & model' },
] as const
type Tab = (typeof TABS)[number]['id']
const RANGES = [{ id: '2005-01', label: 'Since 2005' }, { id: '2015-01', label: 'Since 2015' }, { id: '2022-01', label: 'Since 2022' }]

const pp = (x: number | null | undefined, d = 2) => (x == null ? '—' : `${signed(x, d)}%`)

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

function Toggle({ value, options, onChange, label }: { value: string; options: { id: string; label: string }[]; onChange: (v: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', border: `1px solid ${line2}`, borderRadius: 6, overflow: 'hidden' }}>
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
const note: React.CSSProperties = { ...p, color: fg[3], fontSize: 11 }
const running = (j?: LabourJob) => j?.state === 'running'

function Controls({ status, onRefresh, onRefit }: { status: LabourStatus | null; onRefresh: () => void; onRefit: () => void }) {
  const busy = running(status?.jobs.update) || running(status?.jobs.refit)
  const job = running(status?.jobs.refit) ? status?.jobs.refit : status?.jobs.update
  const failed = status && Object.values(status.jobs).find(j => j.state === 'error')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: fg[3] }} aria-live="polite">
        {busy ? <>{running(status?.jobs.refit) ? 'Refitting' : 'Updating'}: {job?.step}</>
          : failed ? <span style={{ color: neg }}>Failed: {failed.error}</span>
          : <>Model fitted <span style={{ fontFamily: fontNum, color: fg[2] }}>{stampLabel(status?.model_fitted_at)}</span> · computed{' '}
            <span style={{ fontFamily: fontNum, color: fg[2] }}>{stampLabel(status?.computed_at)}</span></>}
      </span>
      <button type="button" onClick={onRefresh} disabled={busy || !status} title="Download the latest data and run it through the saved model"
        style={{ ...button, opacity: busy || !status ? 0.5 : 1 }}>Refresh</button>
      <button type="button" onClick={onRefit} disabled={busy || !status} title="Re-estimate the factor model and its scaling on today's data"
        style={{ ...button, opacity: busy || !status ? 0.5 : 1 }}>{running(status?.jobs.refit) ? 'Refitting…' : 'Refit'}</button>
    </div>
  )
}

// ─── Underlying employment ────────────────────────────────────────────────────

function Underlying({ data }: { data: Labour }) {
  const [from, setFrom] = useState('2015-01')
  const [payrolls, setPayrolls] = useState(true)
  const l = data.latest
  const lfs = data.next_prints.lfs_employment
  const pay = data.next_prints.payrolls
  const change = l.underlying != null && l.three_months_ago != null ? l.underlying - l.three_months_ago : null
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={grid(190)}>
        <Stat label={`Underlying employment growth, ${monthLabel(l.month)}`} value={pp(l.underlying)} color={signColor(l.underlying, 0.02)}
          sub={<>3m on 3m · 95% band {num(l.lo, 2)} to {num(l.hi, 2)}</>} />
        <Stat label="Change over three months" value={change == null ? '—' : `${signed(change, 2)}pp`} sub={<>From {pp(l.three_months_ago)}</>} />
        <Stat label={`LFS employment, 3 months to ${monthLabel(lfs.latest_period)}`} value={pp(lfs.latest)}
          sub={<>Official; the Bank puts less weight on it while LFS samples are small</>} />
        <Stat label={`HMRC payrolls, ${monthLabel(pay?.latest_period ?? l.month)}`} value={pp(pay?.latest_growth3)}
          sub={<>3m on 3m · latest month {pay?.latest_change_k == null ? '—' : `${signed(pay.latest_change_k, 1)}k`} (flash)</>} />
        <Stat label={`Bank staff, ${l.boe_report ?? '—'} MPR`} value={l.boe_value == null ? '—' : pp(l.boe_value, 1)}
          sub={<>"{l.boe_text}"</>} />
      </div>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={sectionLabel}>Employment growth, % three months on three months</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Toggle label="Payrolls" value={payrolls ? 'on' : 'off'} onChange={v => setPayrolls(v === 'on')}
              options={[{ id: 'on', label: 'With payrolls' }, { id: 'off', label: 'Without' }]} />
            <Toggle label="Range" value={from} onChange={setFrom} options={RANGES} />
          </div>
        </div>
        <UnderlyingChart series={data.series} staff={data.staff} from={from} showPayrolls={payrolls} />
        <p style={note}>
          Underlying growth is the common component of {data.model.n_indicators} monthly indicators (dynamic factor model, Doz, Giannone and Reichlin 2011),
          scaled to LFS employment growth over {data.model.scale_window.join(' to ')}, as Bank staff do. Diamonds: Bank staff's judgement in each
          Monetary Policy Report, read from its text (the Bank publishes the measure as a chart only). Dashed: the factor's projection to the next prints.
          {data.model.missing > 0 && <> {data.model.missing} of the Bank's survey series are Bloomberg-only and not in this estimate (Indicators & model tab).</>}
        </p>
      </div>
    </div>
  )
}

// ─── Contributions & news ─────────────────────────────────────────────────────

function Contributions({ data }: { data: Labour }) {
  const ind = Object.fromEntries(data.indicators.map(i => [i.id, i]))
  const last = data.contributions[data.contributions.length - 1]
  const n = data.news
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card}>
        <div style={sectionLabel}>What drives underlying growth: contributions relative to average growth ({pp(data.model.a)}), pp</div>
        <ContributionsChart rows={data.contributions} indicators={data.indicators} />
        <p style={note}>The smoother is linear in the data, so each indicator's contribution is exact and they add up to the estimate.</p>
      </div>
      <div style={grid(420)}>
        <div style={{ ...card, overflowX: 'auto' }}>
          <div style={sectionLabel}>{monthLabel(last.month)} by indicator</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={{ ...th, textAlign: 'left' }}>Indicator</th><th style={th}>Latest</th><th style={th}>Contribution</th></tr></thead>
            <tbody>
              <tr><td style={tdText}>Average growth (constant)</td><td style={td} /><td style={td}>{signed(last.constant, 3)}</td></tr>
              {Object.entries(last.contributions).map(([id, v]) => (
                <tr key={id}>
                  <td style={tdText}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: LABOUR_GROUP_COLOR[ind[id]?.group] ?? fg[4], marginRight: 8 }} />{ind[id]?.name ?? id}</td>
                  <td style={{ ...td, color: fg[3] }}>{ind[id]?.latest_month ? monthLabel(ind[id].latest_month as string) : '—'}</td>
                  <td style={{ ...td, color: signColor(v, 0.0005) }}>{signed(v, 3)}</td>
                </tr>
              ))}
              <tr><td style={{ ...tdText, color: fg[1] }}>Underlying growth</td><td style={td} /><td style={{ ...td, color: fg[1] }}>{pp(last.total, 3)}</td></tr>
            </tbody>
          </table>
        </div>
        <div style={card}>
          <div style={sectionLabel}>News since the previous update</div>
          {!n ? <p style={note}>No earlier update to compare with yet.</p> : (
            <div style={{ display: 'grid', gap: 10 }}>
              <p style={p}>
                The estimate for {monthLabel(n.month)} moved from {pp(n.previous, 3)} to {pp(n.current, 3)}{' '}
                (<span style={{ color: signColor(n.change, 0.0005) }}>{signed(n.change, 3)}pp</span>) since {stampLabel(n.previous_computed_at)}.
                {n.new_month && <> New data now reach {monthLabel(n.new_month)}.</>}
                {!n.same_model && <> The model was re-estimated in between, so part of the change is the new parameters.</>}
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {Object.entries(n.by_indicator).filter(([, v]) => Math.abs(v ?? 0) >= 0.0005).map(([id, v]) => (
                    <tr key={id}><td style={tdText}>{ind[id]?.name ?? id}</td><td style={{ ...td, color: signColor(v, 0.0005) }}>{signed(v, 3)}pp</td></tr>
                  ))}
                </tbody>
              </table>
              {Object.values(n.by_indicator).every(v => Math.abs(v ?? 0) < 0.0005) && <p style={note}>No indicator moved the estimate.</p>}
            </div>
          )}
          {data.runs.length > 1 && (
            <p style={{ ...note, marginTop: 10 }}>
              Recent runs: {data.runs.slice(-6).map(r => `${stampLabel(r.computed_at)} ${pp(r.underlying, 3)}`).join(' · ')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Next prints ──────────────────────────────────────────────────────────────

function Prints({ data }: { data: Labour }) {
  const np = data.next_prints
  const lfs = np.lfs_employment
  const pay = np.payrolls
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={grid(260)}>
        <div style={card}>
          <div style={sectionLabel}>LFS employment, 3 months to {monthLabel(lfs.period)}</div>
          <div style={{ fontFamily: fontNum, fontSize: 24, color: fg[1] }}>{pp(lfs.forecast)}</div>
          <p style={note}>95% range {num(lfs.lo, 2)} to {num(lfs.hi, 2)} · release {lfs.release ?? '—'}</p>
          <p style={{ ...note, marginTop: 6 }}>
            Previous print {pp(lfs.latest)} (3 months to {monthLabel(lfs.latest_period)}). The range adds LFS sampling noise: residual s.d.{' '}
            {num(lfs.noise_sd, 2)}pp ({num(lfs.noise_sd_2000_19, 2)}pp over 2000–19).
          </p>
        </div>
        <div style={card}>
          <div style={sectionLabel}>HMRC payrolls flash, {pay ? monthLabel(pay.period) : '—'}</div>
          <div style={{ fontFamily: fontNum, fontSize: 24, color: fg[1] }}>{pay?.change_k == null ? '—' : `${signed(pay.change_k, 1)}k`}</div>
          <p style={note}>95% range {pay ? `${signed(pay.lo_k, 0)}k to ${signed(pay.hi_k, 0)}k` : '—'} · 3m/3m {pp(pay?.growth3)}</p>
          <p style={{ ...note, marginTop: 6 }}>Latest {pay?.latest_change_k == null ? '—' : `${signed(pay.latest_change_k, 1)}k`} ({pay ? monthLabel(pay.latest_period) : '—'}, flash). Released with the LFS.</p>
        </div>
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={sectionLabel}>LFS unemployment rate: projections against the Bank's</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Quarter', 'This model', '95% range', 'Underlying employment growth', 'Bank staff', 'MPR'].map((h, i) =>
            <th key={h} style={{ ...th, textAlign: i ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            <tr>
              <td style={tdText}>3 months to {monthLabel(np.unemployment_latest.period)} (latest)</td>
              <td style={td}>{num(np.unemployment_latest.value, 1)}%</td><td style={td} /><td style={td} /><td style={td} /><td style={td} />
            </tr>
            {np.unemployment.map(u => (
              <tr key={u.period}>
                <td style={tdText}>{u.period.slice(4)} {u.period.slice(0, 4)}</td>
                <td style={{ ...td, color: fg[1] }}>{num(u.projection, 2)}%</td>
                <td style={td}>{num(u.lo, 2)} to {num(u.hi, 2)}</td>
                <td style={td}>{pp(u.employment_growth)}</td>
                <td style={td}>{u.boe ? `${num(u.boe.value, 1)}%` : '—'}</td>
                <td style={{ ...td, color: fg[3] }}>{u.boe?.report ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ ...note, marginTop: 8 }}>
          From the latest LFS levels, employment grows at the underlying rate and the labour force at its trend over the past year
          ({pp(np.labour_force_growth)} 3m/3m). The range reflects uncertainty in underlying employment only. The Bank's projections were made with
          earlier data.
        </p>
      </div>
    </div>
  )
}

// ─── Bank of England ──────────────────────────────────────────────────────────

function Boe({ data }: { data: Labour }) {
  const at = Object.fromEntries(data.series.map(s => [s.month, s.underlying]))
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={sectionLabel}>Bank staff's judgement in each Monetary Policy Report</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Report', 'Staff judgement on underlying employment', 'Read as', 'This model', 'Unemployment projections'].map((h, i) =>
            <th key={h} style={{ ...th, textAlign: i === 0 || i === 1 || i === 4 ? 'left' : 'right' }}>{h}</th>)}</tr></thead>
          <tbody>
            {[...data.staff].reverse().map(r => (
              <tr key={r.report}>
                <td style={tdText}><a href={r.url} target="_blank" rel="noreferrer" style={{ color: accent }}>{r.report}</a></td>
                <td style={{ ...tdText, whiteSpace: 'normal', color: fg[2], maxWidth: 520 }}>"{r.underlying_text}"</td>
                <td style={td}>{r.underlying_value == null ? '—' : pp(r.underlying_value, 1)}</td>
                <td style={td}>{r.data_through ? <>{pp(at[r.data_through])} <span style={{ color: fg[4] }}>{monthLabel(r.data_through)}</span></> : '—'}</td>
                <td style={{ ...tdText, color: fg[2] }}>{r.unemployment.map(u => `${u.period.slice(4)} ${u.period.slice(0, 4)}: ${num(u.value, 1)}%`).join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ ...note, marginTop: 8 }}>
          "This model" is today's estimate for the month the Bank's chart ended, with data published since. The Bank's method: {data.staff_method}
        </p>
      </div>
      <div style={grid(420)}>
        {data.gdp_implied && (
          <div style={card}>
            <div style={sectionLabel}>Employment growth implied by GDP momentum (% q/q)</div>
            <GdpImpliedChart g={data.gdp_implied} />
            <p style={note}>
              As in the Bank's chart: underlying employment growth regressed on {data.gdp_implied.lags} lags of quarterly GDP growth
              ({data.gdp_implied.sample}, R² {num(data.gdp_implied.r2, 2)}). GDP data to {data.gdp_implied.latest_gdp_quarter}. When employment runs below
              the GDP-implied path, the Bank has read it as cost pressures (NICs, NLW) weighing on hiring.
            </p>
          </div>
        )}
        {data.svar && (
          <div style={card}>
            <div style={sectionLabel}>Labour demand and supply behind employment growth (pp)</div>
            <SvarChart svar={data.svar} />
            <p style={note}>
              As in the April 2026 MPR: a bivariate structural VAR in underlying employment and real AWE growth ({data.svar.sample}, {data.svar.lags} lags),
              identified by sign restrictions. Demand moves employment and real wages the same way, supply in opposite directions
              ({data.svar.accepted} admissible rotations; the one closest to their median is used).
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Indicators & model ───────────────────────────────────────────────────────

function Model({ data }: { data: Labour }) {
  const m = data.model
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={sectionLabel}>Indicators</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Indicator', 'Source', 'Latest', 'Value', 'Units', 'z-score', 'Loading', 'From'].map((h, i) =>
            <th key={h} style={{ ...th, textAlign: i < 2 ? 'left' : 'right' }}>{h}</th>)}</tr></thead>
          <tbody>
            {data.indicators.map(i => (
              <tr key={i.id} style={{ opacity: i.in_model ? 1 : 0.6 }}>
                <td style={tdText} title={i.notes}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: LABOUR_GROUP_COLOR[i.group], marginRight: 8 }} />{i.name}
                </td>
                <td style={{ ...tdText, color: fg[3] }}>{i.in_model ? i.group : <span style={{ color: warn }}>{i.missing}</span>}</td>
                <td style={{ ...td, color: fg[3] }}>{i.latest_month ? monthLabel(i.latest_month) : '—'}</td>
                <td style={td}>{num(i.latest_transformed ?? i.latest, 2)}</td>
                <td style={{ ...td, color: fg[3] }}>{i.units}</td>
                <td style={{ ...td, color: signColor(i.z, 0.05) }}>{signed(i.z, 2)}</td>
                <td style={td}>{num(i.loading, 2)}</td>
                <td style={{ ...td, color: fg[3] }}>{i.first_month ? i.first_month.slice(0, 4) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {m.missing > 0 && (
          <p style={{ ...note, marginTop: 8 }}>
            Greyed rows are in the Bank's model but only on Bloomberg (S&P Global PMI, KPMG/REC, Lloyds). Set their tickers in
            backend/data/series_catalogue_labour_uk.json, check them on the Terminal, and Refit with Bloomberg as the data source to add them.
          </p>
        )}
      </div>
      <div style={grid(380)}>
        <div style={card}>
          <div style={sectionLabel}>Loadings on the common factor</div>
          <LoadingsChart indicators={data.indicators} />
        </div>
        <div style={card}>
          <div style={sectionLabel}>Model</div>
          <div style={{ display: 'grid', gap: 8 }}>
            <p style={p}><b style={{ color: fg[1] }}>Factor.</b> Indicators standardised; first principal component by EM (the panel is ragged:
              DMP from 2017, payrolls from 2014); AR(2) factor ({num(m.phi[0], 2)}, {num(m.phi[1], 2)}); then the Kalman filter and smoother once
              on all the data. Months {m.exclude.map(w => w.join(' to ')).join(', ')} are left out of estimation and carry no information.</p>
            <p style={p}><b style={{ color: fg[1] }}>Scaling.</b> LFS employment growth (3m/3m) = {num(m.a, 3)} + {num(m.b, 3)} × three-month average
              of the factor over {m.scale_window.join(' to ')} (R² {num(m.r2, 2)}, residual s.d. {num(m.resid_sd, 2)}pp; the LFS is noisy month to
              month, and the factor is meant to look through that noise).</p>
            <p style={p}><b style={{ color: fg[1] }}>Updating.</b> New data run through the saved parameters (fitted {stampLabel(m.fitted_at)} on data to{' '}
              {monthLabel(m.data_through)}), so news between runs is attributable. Refit re-estimates them.</p>
          </div>
        </div>
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={sectionLabel}>Data</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>{Object.entries(data.sources).map(([k, s]) => (
            <tr key={k}>
              <td style={{ ...tdText, color: fg[3] }}>{s.name}</td>
              <td style={tdText}>{s.file ?? '—'}</td>
              <td style={td}>latest {s.latest ? monthLabel(s.latest) : '—'}</td>
              <td style={td}>{s.release ? `released ${s.release}` : ''}{s.next_release ? ` · next ${s.next_release}` : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

async function getJson<T>(url: string, ok: (body: unknown) => boolean, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init)
  const body = await res.json().catch(() => undefined)
  if (!res.ok) throw new Error((body as { detail?: string } | undefined)?.detail ?? `HTTP ${res.status}`)
  if (!ok(body)) throw new Error('unexpected response (restart the backend?)')
  return body as T
}

const isStatus = (b: unknown) => typeof b === 'object' && b !== null && 'jobs' in b

export default function LabourPage({ country = 'uk' }: { country?: string }) {
  const base = `/api/tools/quant-macro/labour/${country}`
  const [data, setData] = useState<Labour | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<LabourStatus | null>(null)
  const [tab, setTab] = useState<Tab>('underlying')
  const prev = useRef<string | null>(null)

  const load = useCallback(() => getJson<Labour>(base, b => Array.isArray((b as Labour | undefined)?.series)).then(setData), [base])
  const loadStatus = useCallback(() => getJson<LabourStatus>(`${base}/status`, isStatus).then(setStatus).catch(() => {}), [base])

  useEffect(() => {
    let cancelled = false
    setError(null)
    load().then(() => { if (!cancelled) loadStatus() }).catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true }
  }, [load, loadStatus])

  const busy = !!status && Object.values(status.jobs).some(j => j.state === 'running')
  useEffect(() => {
    if (!busy) return
    const id = window.setInterval(loadStatus, 2000)
    return () => window.clearInterval(id)
  }, [busy, loadStatus])
  useEffect(() => {
    const key = status ? `${status.jobs.update.state}/${status.jobs.refit.state}` : null
    const was = prev.current
    prev.current = key
    if (was && was.includes('running') && key && !key.includes('running')) load().catch(() => {})
  }, [status, load])

  const post = (path: string) => getJson<LabourStatus>(`${base}${path}`, isStatus, { method: 'POST' })
    .then(setStatus).catch(e => setError(String(e.message ?? e)))

  return (
    <div style={{ background: BG, minHeight: '100vh' }}>
      <header style={{ ...headerBar, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 24px', flexWrap: 'wrap' }}>
        <PageTitle category={QUANT_MACRO_CATEGORY.name} categoryId={QUANT_MACRO_CATEGORY.id}
          flag={<CountryFlag country="GB" height={14} />}
          title="UK Labour Market Nowcast"
          subtitle={data ? <>Bank of England staff method · {data.model.n_indicators} indicators · data to {monthLabel(data.latest.month)}</> : 'Underlying employment growth'} />
        {data && <Controls status={status} onRefresh={() => post('/refresh')} onRefit={() => post('/refit')} />}
      </header>
      <main style={{ padding: '20px 24px' }}>
        {error && <div style={{ color: neg, fontSize: 13, marginBottom: 12 }}>Failed to load: {error}</div>}
        {!data && !error && <div style={{ color: fg[3], fontSize: 13 }}>Loading (the first run downloads the data and fits the model, about a minute)…</div>}
        {data && (
          <div style={{ display: 'grid', gap: 16 }}>
            <Tabs value={tab} onChange={setTab} />
            {tab === 'underlying' && <Underlying data={data} />}
            {tab === 'contributions' && <Contributions data={data} />}
            {tab === 'prints' && <Prints data={data} />}
            {tab === 'boe' && <Boe data={data} />}
            {tab === 'model' && <Model data={data} />}
          </div>
        )}
      </main>
    </div>
  )
}
