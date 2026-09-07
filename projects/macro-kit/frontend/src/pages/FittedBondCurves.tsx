// Fitted Bond Curves — rich/cheap analysis via fitted discount curves.
// Implements Chapter 8 of Huggins & Schaller, "Fixed Income Relative Value
// Analysis" (2024): joint optimisation of a discount-function curve and
// external regression variables (size, age, deliverability), with residuals
// used as rich/cheap indicators and analysed with OU mean-reversion models.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CartesianGrid, Cell, ComposedChart, Line, LineChart,
  ReferenceDot, ReferenceLine, ResponsiveContainer, Scatter,
  Tooltip, XAxis, YAxis, Area,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface BondRow {
  bond_id: string
  name: string
  sector: string
  coupon: number
  maturity: string
  ttm: number
  age: number
  size_bn: number
  deliverable: string | null
  dirty_price: number
  clean_price: number
  fitted_price: number
  residual_eur: number
  residual_bp: number
  avg_resid_1m_bp: number
  avg_resid_3m_bp: number
  ytm: number
  fitted_ytm: number
  bpv: number
  ou_half_life: number
  ou_zscore: number
  sharpe_2w: number
}

interface Coefficient {
  variable: string
  label: string
  units: string
  estimate: number
  true_value: number
}

interface FitResult {
  as_of: string
  simulation_mode: boolean
  config: {
    functional_form: string
    exponent: number
    weighting: string
    n_exp_splines: number
    knots: number[] | null
    knots_source?: string
    custom_bonds?: string[] | null
  }
  fit_quality: {
    converged: boolean
    n_iter: number
    mean_abs_eur: number
    max_abs_eur: number
    mean_abs_bp: number
    max_abs_bp: number
    n_bonds: number
    smoothness: number
  }
  curve: { tau: number[]; zero_yield: number[]; discount_factor: number[] }
  coefficients: Coefficient[]
  bonds: BondRow[]
  benchmarks: Array<{
    tenor: number
    discount_factor: number
    annuity: number
    par_coupon: number
  }>
}

interface TransitionDensity {
  horizon_days: number
  horizon_label: string
  horizon_date?: string
  mean: number
  std: number
  p5: number
  p25: number
  p75: number
  p95: number
  prob_above_current: number
}

interface BondDetail {
  bond_id: string
  name: string
  residual_eur: number
  residual_bp: number
  history: { dates: string[]; values: number[] }
  ou_params: {
    k: number
    mu: number
    sigma: number
    half_life_days: number
    stationary_std: number
    current: number
    current_zscore: number
  }
  transition_densities: TransitionDensity[]
}

interface NewIssueResult {
  name: string
  maturity: string
  ttm: number
  coupon: number
  coupon_is_par: boolean
  par_coupon: number
  size_bn: number
  deliverable: string | null
  curve_pv: number
  effects: Array<{ label: string; eur: number; bp: number }>
  predicted_price: number
  predicted_ytm: number
  curve_ytm: number
  spread_to_curve_bp: number
  bpv: number
  neighbours: Array<{ name: string; ttm: number; ytm: number; residual_bp: number }>
}

type Tab = 'curve' | 'residuals' | 'coefficients' | 'richcheap' | 'detail' | 'newissue' | 'benchmarks'

// ─── Styling constants (match existing pages) ─────────────────────────────────

const BG = '#080d1a'
const ACCENT = '#A855F7'
const ACCENT_DIM = 'rgba(168,85,247,0.15)'
const ACCENT_BORDER = 'rgba(168,85,247,0.45)'
const POS = '#10B981'
const NEG = '#EF4444'
const AMBER = '#F59E0B'
const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12, padding: '18px 20px',
}
const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.08em', color: '#64748b', marginBottom: 12,
}
const TICK_STYLE = { fill: '#64748b', fontSize: 11 }
const GRID_STROKE = 'rgba(255,255,255,0.04)'

const SECTOR_COLORS: Record<string, string> = {
  BKO: '#38bdf8',
  OBL: '#10B981',
  DBR: '#A855F7',
}

function fmt(v: number | null | undefined, decimals = 2): string {
  if (v == null || Number.isNaN(v)) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// ─── Helper components ────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div style={{ ...cardStyle, padding: '14px 18px', flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#64748b' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6, color: color ?? '#f1f5f9', fontFamily: 'ui-monospace, monospace' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function TabButton({ label, active, onClick }: {
  label: string; active: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick} style={{
      padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
      cursor: 'pointer',
      background: active ? ACCENT_DIM : 'rgba(255,255,255,0.03)',
      border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.08)'}`,
      color: active ? ACCENT : '#94a3b8',
    }}>
      {label}
    </button>
  )
}

function ChartTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 8, padding: '8px 12px', fontSize: 12,
    }}>
      <div style={{ color: '#64748b', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any, i: number) => (
        p.value != null && (
          <div key={i} style={{ color: p.color ?? '#e2e8f0' }}>
            {p.name}: <b>{typeof p.value === 'number' ? fmt(p.value, 3) : p.value}</b>{unit ?? ''}
          </div>
        )
      ))}
    </div>
  )
}

// ─── Bond universe editor (Curve & Fit tab) ───────────────────────────────────

interface UniverseEditor {
  customMode: boolean
  setCustomMode: (v: boolean) => void
  tickerText: string
  setTickerText: (v: string) => void
  asOf: string
  setAsOf: (v: string) => void
  onApply: (useCustom: boolean) => void
  onAsOfChange: (date: string) => void
  loading: boolean
}

function UniverseEditorCard({ ed }: { ed: UniverseEditor }) {
  const nTickers = ed.tickerText.split('\n').map(t => t.trim()).filter(Boolean).length
  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>Bond universe</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <TabButton label="Default German universe" active={!ed.customMode}
          onClick={() => { if (ed.customMode) { ed.setCustomMode(false); ed.onApply(false) } }} />
        <TabButton label="Custom bond list (BBG tickers)" active={ed.customMode}
          onClick={() => ed.setCustomMode(true)} />
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.06em', color: '#64748b' }}>As-of date</span>
          <input type="date" value={ed.asOf}
            onChange={e => { ed.setAsOf(e.target.value); ed.onAsOfChange(e.target.value) }}
            style={{ background: '#0d1425', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: '6px 10px', color: '#e2e8f0', fontSize: 12.5,
              fontFamily: 'ui-monospace, monospace', colorScheme: 'dark' }} />
          {ed.asOf && (
            <button onClick={() => { ed.setAsOf(''); ed.onAsOfChange('') }}
              title="Reset to today"
              style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 13 }}>
              ↺ today
            </button>
          )}
        </span>
      </div>
      {ed.customMode && (
        <>
          <textarea
            value={ed.tickerText}
            onChange={e => ed.setTickerText(e.target.value)}
            placeholder={'One Bloomberg ticker per line, e.g.\nDBR 2.6 08/15/34 Govt\nOBL 2.4 04/12/28 Govt\nBKO 0 1/2 09/16/27 Govt'}
            rows={8}
            spellCheck={false}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              background: '#0d1425', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: '10px 12px', color: '#e2e8f0',
              fontSize: 12.5, fontFamily: 'ui-monospace, monospace', lineHeight: 1.7,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
            <button
              onClick={() => ed.onApply(true)}
              disabled={ed.loading || nTickers < 5}
              style={{
                padding: '8px 22px', borderRadius: 8,
                border: `1px solid ${ACCENT_BORDER}`, background: ACCENT_DIM,
                color: ACCENT, fontSize: 13, fontWeight: 600,
                cursor: ed.loading || nTickers < 5 ? 'not-allowed' : 'pointer',
                opacity: ed.loading || nTickers < 5 ? 0.5 : 1,
              }}>
              {ed.loading ? 'Fitting…' : 'Fit curve'}
            </button>
            <span style={{ fontSize: 11, color: nTickers < 5 ? AMBER : '#475569' }}>
              {nTickers} ticker{nTickers === 1 ? '' : 's'}{nTickers < 5 ? ' — at least 5 required' : ''}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#475569', marginTop: 8, lineHeight: 1.6 }}>
            Format: <span style={{ fontFamily: 'ui-monospace, monospace', color: '#64748b' }}>ISSUER COUPON MM/DD/YY [Govt]</span> — coupon
            and maturity are taken from the ticker; reference data (issue date, amount outstanding)
            is simulated deterministically per ticker until Bloomberg is connected. Spline knots
            adapt automatically to the maturity span and bond count.
          </div>
        </>
      )}
    </div>
  )
}

// ─── Curve & Fit tab ──────────────────────────────────────────────────────────

function CurveTab({ result, editor }: { result: FitResult; editor: UniverseEditor }) {
  const q = result.fit_quality

  // Merge fitted zero curve grid with bond YTM scatter points
  const curveData = result.curve.tau.map((t, i) => ({
    ttm: t, zero: result.curve.zero_yield[i], df: result.curve.discount_factor[i],
  }))
  const scatterBySector = useMemo(() => {
    const out: Record<string, Array<{ ttm: number; ytm: number; name: string }>> = {}
    for (const b of result.bonds) {
      (out[b.sector] = out[b.sector] ?? []).push({ ttm: b.ttm, ytm: b.ytm, name: b.name })
    }
    return out
  }, [result.bonds])

  // Knot markers: interpolate the fitted zero yield at each knot position
  const knotPoints = useMemo(() => {
    const knots = result.config.knots ?? []
    const { tau, zero_yield } = result.curve
    return knots
      .filter(k => k >= tau[0] && k <= tau[tau.length - 1])
      .map(k => {
        let i = tau.findIndex(t => t >= k)
        if (i <= 0) i = 1
        const w = (k - tau[i - 1]) / (tau[i] - tau[i - 1])
        return { knot: k, y: zero_yield[i - 1] + w * (zero_yield[i] - zero_yield[i - 1]) }
      })
  }, [result.config.knots, result.curve])

  return (
    <>
      <UniverseEditorCard ed={editor} />

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <StatCard label="Bonds fitted" value={String(q.n_bonds)} sub={`as of ${result.as_of}`} />
        <StatCard label="Mean |residual|" value={`${fmt(q.mean_abs_bp)} bp`} sub={`${fmt(q.mean_abs_eur * 100, 1)} cents — H&S example: 0.9 bp`} />
        <StatCard label="Max |residual|" value={`${fmt(q.max_abs_bp)} bp`} sub={`${fmt(q.max_abs_eur * 100, 1)} cents`} />
        <StatCard label="Smoothness ∫h″(τ)²dτ" value={q.smoothness >= 100 ? fmt(q.smoothness, 0) : q.smoothness >= 1 ? fmt(q.smoothness, 1) : fmt(q.smoothness, 3)}
          sub="%²/yr³ — lower = smoother (H&S p.174)" />
        <StatCard label="Optimiser" value={q.converged ? 'Converged' : 'Not converged'} sub={`${q.n_iter} iterations`} color={q.converged ? POS : NEG} />
      </div>

      <div style={cardStyle}>
        <div style={sectionLabel}>Bond yields vs fitted zero-coupon curve</div>
        <ResponsiveContainer width="100%" height={380}>
          <ComposedChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} />
            <XAxis dataKey="ttm" type="number" domain={[0, 34]} tick={TICK_STYLE}
              label={{ value: 'Years to maturity', position: 'insideBottom', offset: -5, fill: '#475569', fontSize: 11 }} />
            <YAxis dataKey="ytm" type="number" domain={['auto', 'auto']} tick={TICK_STYLE} tickFormatter={(v: number) => v.toFixed(2)}
              label={{ value: 'Yield (%)', angle: -90, position: 'insideLeft', fill: '#475569', fontSize: 11 }} />
            <Tooltip content={<ChartTooltip unit="%" />} />
            {/* Knot positions: faint vertical guides… */}
            {knotPoints.map(p => (
              <ReferenceLine key={`kl-${p.knot}`} x={p.knot}
                stroke="rgba(168,85,247,0.18)" strokeDasharray="3 4" />
            ))}
            <Line data={curveData} dataKey="zero" name="Fitted zero curve" type="monotone"
              stroke={AMBER} strokeWidth={2} dot={false} xAxisId={0} yAxisId={0}
              isAnimationActive={false} />
            {/* …and diamonds on the fitted curve where the spline pieces join */}
            {knotPoints.map(p => (
              <ReferenceDot key={`kd-${p.knot}`} x={p.knot} y={p.y} r={4}
                shape={props => {
                  const { cx, cy } = props as { cx: number; cy: number }
                  return (
                    <path d={`M ${cx} ${cy - 5} L ${cx + 4} ${cy} L ${cx} ${cy + 5} L ${cx - 4} ${cy} Z`}
                      fill={ACCENT} stroke="#0a0f1e" strokeWidth={1} />
                  )
                }} />
            ))}
            {Object.entries(scatterBySector).map(([sector, pts]) => (
              <Scatter key={sector} data={pts.map(p => ({ ttm: p.ttm, ytm: p.ytm, name: p.name }))}
                name={sector} fill={SECTOR_COLORS[sector] ?? '#94a3b8'} isAnimationActive={false} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 11, color: '#64748b', flexWrap: 'wrap' }}>
          <span><span style={{ color: AMBER }}>—</span> fitted zero-coupon curve h(τ)</span>
          {knotPoints.length > 0 && (
            <span><span style={{ color: ACCENT }}>◆</span> spline knots ({result.config.knots_source ?? 'auto'})</span>
          )}
          {Object.keys(scatterBySector).map(s => (
            <span key={s}><span style={{ color: SECTOR_COLORS[s] ?? '#94a3b8' }}>●</span> {s} (bond YTMs)</span>
          ))}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={sectionLabel}>Fitted discount function φ(τ) = e^(−h(τ)·τ)</div>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={curveData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} />
            <XAxis dataKey="ttm" type="number" domain={[0, 'auto']} tick={TICK_STYLE}
              label={{ value: 'Years to maturity', position: 'insideBottom', offset: -5, fill: '#475569', fontSize: 11 }} />
            <YAxis domain={[0, 1]} tick={TICK_STYLE} tickFormatter={(v: number) => v.toFixed(2)} />
            <Tooltip content={<ChartTooltip />} />
            <ReferenceLine y={1} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
            <Line dataKey="df" name="Discount factor" type="monotone"
              stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ fontSize: 11, color: '#475569', marginTop: 6, lineHeight: 1.6 }}>
          The price of a zero-coupon bond as a fraction of face value. By construction φ(0) = 1
          (criterion C2, no-arbitrage at the short end) and φ(τ) → 0 as τ → ∞ (criterion C1).
          Every bond&apos;s fitted price is its cash flows valued off this single function.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={sectionLabel}>Methodology — H&S Chapter 8</div>
        <div style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.75 }}>
          Bond prices are modelled as <span style={{ fontFamily: 'ui-monospace, monospace', color: '#e2e8f0' }}>
          P&#7522; = Σ C&#7522;&#8342;·φ(τ&#7522;&#8342;) + Σ γ&#8342;·X&#7522;&#8342; + ε&#7522;</span> —
          cash flows discounted with a fitted discount function φ(τ) = e^(−h(τ)·τ), plus a
          cross-sectional regression on external conditioning variables (issue size, age,
          futures deliverability scaled by BPV). Curve parameters and regression coefficients
          are fitted <i>in the same optimisation</i>, minimising Σ|ε|^p. The residuals ε are the
          rich/cheap indicators: <span style={{ color: NEG }}>positive = rich</span>,{' '}
          <span style={{ color: POS }}>negative = cheap</span>.
          {result.config.functional_form === 'cubic_spline'
            ? ` Curve form: natural cubic spline on ${result.config.knots?.length ?? 0} knots (${(result.config.knots ?? []).join(', ')}y).`
            : ` Curve form: ${result.config.n_exp_splines} exponential splines df(t) = Σ βⱼ·e^(−jtα).`}
          {` Error exponent p = ${result.config.exponent}`}
          {result.config.exponent === 1 ? ' (H&S recommendation to stop outliers dominating).' : ' (standard least squares).'}
        </div>
      </div>
    </>
  )
}

// ─── Residuals tab ────────────────────────────────────────────────────────────

function ResidualsTab({ result }: { result: FitResult }) {
  const [unit, setUnit] = useState<'bp' | 'eur'>('bp')
  const data = result.bonds.map(b => ({
    ttm: b.ttm,
    value: unit === 'bp' ? b.residual_bp : b.residual_eur,
    name: b.name,
    deliverable: b.deliverable,
  }))
  const maxAbs = Math.max(...data.map(d => Math.abs(d.value))) * 1.15

  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        <TabButton label="Basis points (Fig. 8.3)" active={unit === 'bp'} onClick={() => setUnit('bp')} />
        <TabButton label="EUR (Fig. 8.2)" active={unit === 'eur'} onClick={() => setUnit('eur')} />
      </div>

      <div style={cardStyle}>
        <div style={sectionLabel}>Regression residuals by maturity — positive = rich</div>
        <ResponsiveContainer width="100%" height={400}>
          <ComposedChart data={data} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} />
            <XAxis dataKey="ttm" type="number" domain={[0, 34]} tick={TICK_STYLE}
              label={{ value: 'Years to maturity', position: 'insideBottom', offset: -5, fill: '#475569', fontSize: 11 }} />
            <YAxis type="number" domain={[-maxAbs, maxAbs]} tick={TICK_STYLE} tickFormatter={(v: number) => v.toFixed(unit === 'bp' ? 1 : 2)}
              label={{ value: unit === 'bp' ? 'Residual (bp)' : 'Residual (EUR)', angle: -90, position: 'insideLeft', fill: '#475569', fontSize: 11 }} />
            <Tooltip content={<ChartTooltip unit={unit === 'bp' ? ' bp' : ' EUR'} />} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
            <Scatter dataKey="value" name="Residual" isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.deliverable ? AMBER : (d.value > 0 ? NEG : POS)} />
              ))}
            </Scatter>
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 11, color: '#64748b' }}>
          <span><span style={{ color: NEG }}>●</span> rich</span>
          <span><span style={{ color: POS }}>●</span> cheap</span>
          <span><span style={{ color: AMBER }}>●</span> futures-deliverable issue</span>
        </div>
      </div>
    </>
  )
}

// ─── Coefficients tab ─────────────────────────────────────────────────────────

function CoefficientsTab({ result }: { result: FitResult }) {
  const thStyle: React.CSSProperties = {
    textAlign: 'left', padding: '8px 12px', fontSize: 10, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  }
  const tdStyle: React.CSSProperties = {
    padding: '9px 12px', fontSize: 13, color: '#e2e8f0',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    fontFamily: 'ui-monospace, monospace',
  }
  return (
    <>
      <div style={cardStyle}>
        <div style={sectionLabel}>External regression coefficients (Table 8.2 equivalent)</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Independent variable</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Estimate</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>True (generator)</th>
              <th style={thStyle}>Units</th>
            </tr>
          </thead>
          <tbody>
            {result.coefficients.map(c => {
              const err = Math.abs(c.estimate - c.true_value)
              const scale = Math.max(Math.abs(c.true_value), 1e-9)
              const good = err / scale < 0.5
              return (
                <tr key={c.variable}>
                  <td style={{ ...tdStyle, fontFamily: 'inherit' }}>{c.label}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: good ? POS : AMBER }}>{fmt(c.estimate, 4)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: '#64748b' }}>{fmt(c.true_value, 4)}</td>
                  <td style={{ ...tdStyle, color: '#64748b', fontFamily: 'inherit' }}>{c.units}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={cardStyle}>
        <div style={sectionLabel}>Interpretation</div>
        <div style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.8 }}>
          <b style={{ color: '#e2e8f0' }}>Amount outstanding</b> — a positive coefficient means larger
          issues trade expensive: the benchmark effect. H&S estimated EUR 0.025 per EUR 1bn on
          7 Dec 2012 Bund data.<br />
          <b style={{ color: '#e2e8f0' }}>Issue age</b> — a negative coefficient means bonds cheapen as
          they age (off-the-run effect); H&S: −2.7 cents/year.<br />
          <b style={{ color: '#e2e8f0' }}>Deliverability</b> — the variable is the bond&apos;s BPV when it
          is deliverable into the futures contract (zero otherwise), so the coefficient reads directly
          as the number of basis points of richness for deliverable issues; H&S found 2–4 bp.<br />
          <span style={{ color: '#64748b' }}>
            Since this page runs on synthetic data with known pricing effects, the &quot;True&quot; column
            validates the optimiser: estimates should be near truth when identification is good.
            The tiny Schatz basket (2 issues, small BPVs) is genuinely hard to identify — especially
            with p = 1 — which mirrors H&S&apos;s remark that the Schatz premium is the least precisely
            estimated.
          </span>
        </div>
      </div>
    </>
  )
}

// ─── Rich / Cheap tab ─────────────────────────────────────────────────────────

type SortKey = 'ttm' | 'residual_bp' | 'residual_eur' | 'avg_resid_1m_bp' | 'avg_resid_3m_bp' | 'ou_zscore' | 'ou_half_life' | 'sharpe_2w'

function RichCheapTab({ result, onSelectBond }: {
  result: FitResult
  onSelectBond: (id: string) => void
}) {
  const [sortKey, setSortKey] = useState<SortKey>('residual_bp')
  const [sortAsc, setSortAsc] = useState(false)

  const rows = useMemo(() => {
    const r = [...result.bonds]
    r.sort((a, b) => (sortAsc ? 1 : -1) * ((a[sortKey] as number) - (b[sortKey] as number)))
    return r
  }, [result.bonds, sortKey, sortAsc])

  function clickSort(k: SortKey) {
    if (k === sortKey) setSortAsc(!sortAsc)
    else { setSortKey(k); setSortAsc(false) }
  }

  const thStyle: React.CSSProperties = {
    textAlign: 'right', padding: '8px 10px', fontSize: 10, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748b',
    borderBottom: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer',
    whiteSpace: 'nowrap', userSelect: 'none',
  }
  const tdStyle: React.CSSProperties = {
    padding: '7px 10px', fontSize: 12.5, color: '#e2e8f0', textAlign: 'right',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap',
  }
  const arrow = (k: SortKey) => sortKey === k ? (sortAsc ? ' ↑' : ' ↓') : ''

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>
        Rich / cheap ranking — residuals with OU mean-reversion statistics (click a row for detail)
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left', cursor: 'default' }}>Bond</th>
              <th style={{ ...thStyle, cursor: 'default' }}>Deliv.</th>
              <th style={thStyle} onClick={() => clickSort('ttm')}>TTM{arrow('ttm')}</th>
              <th style={{ ...thStyle, cursor: 'default' }}>YTM %</th>
              <th style={{ ...thStyle, cursor: 'default' }}>Fitted %</th>
              <th style={thStyle} onClick={() => clickSort('residual_bp')}>Resid bp{arrow('residual_bp')}</th>
              <th style={thStyle} onClick={() => clickSort('avg_resid_1m_bp')}>Avg 1m{arrow('avg_resid_1m_bp')}</th>
              <th style={thStyle} onClick={() => clickSort('avg_resid_3m_bp')}>Avg 3m{arrow('avg_resid_3m_bp')}</th>
              <th style={thStyle} onClick={() => clickSort('residual_eur')}>Resid €{arrow('residual_eur')}</th>
              <th style={thStyle} onClick={() => clickSort('ou_zscore')}>z{arrow('ou_zscore')}</th>
              <th style={thStyle} onClick={() => clickSort('ou_half_life')}>t½ (bd){arrow('ou_half_life')}</th>
              <th style={thStyle} onClick={() => clickSort('sharpe_2w')}>SR 2w{arrow('sharpe_2w')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(b => {
              const rc = b.residual_bp
              const rcColor = rc > 1 ? NEG : rc < -1 ? POS : '#e2e8f0'
              const avgColor = (v: number) => v > 1 ? NEG : v < -1 ? POS : '#94a3b8'
              return (
                <tr key={b.bond_id} onClick={() => onSelectBond(b.bond_id)}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ ...tdStyle, textAlign: 'left', fontFamily: 'inherit' }}>
                    <span style={{ color: SECTOR_COLORS[b.sector], marginRight: 6 }}>●</span>{b.name}
                  </td>
                  <td style={{ ...tdStyle, color: AMBER }}>{b.deliverable ?? ''}</td>
                  <td style={tdStyle}>{fmt(b.ttm, 1)}</td>
                  <td style={tdStyle}>{fmt(b.ytm, 3)}</td>
                  <td style={{ ...tdStyle, color: '#64748b' }}>{fmt(b.fitted_ytm, 3)}</td>
                  <td style={{ ...tdStyle, color: rcColor, fontWeight: 700 }}>{fmt(rc, 1)}</td>
                  <td style={{ ...tdStyle, color: avgColor(b.avg_resid_1m_bp) }}>{fmt(b.avg_resid_1m_bp, 1)}</td>
                  <td style={{ ...tdStyle, color: avgColor(b.avg_resid_3m_bp) }}>{fmt(b.avg_resid_3m_bp, 1)}</td>
                  <td style={{ ...tdStyle, color: rcColor }}>{fmt(b.residual_eur, 3)}</td>
                  <td style={{ ...tdStyle, color: Math.abs(b.ou_zscore) > 2 ? AMBER : '#e2e8f0' }}>{fmt(b.ou_zscore, 1)}</td>
                  <td style={tdStyle}>{fmt(b.ou_half_life, 0)}</td>
                  <td style={{ ...tdStyle, color: b.sharpe_2w > 1 ? POS : '#e2e8f0' }}>{fmt(b.sharpe_2w, 2)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: '#475569', marginTop: 10, lineHeight: 1.7 }}>
        Residual: <span style={{ color: NEG }}>positive = rich</span> (short candidate),{' '}
        <span style={{ color: POS }}>negative = cheap</span> (long candidate). Per H&S p.178, naked
        z-scores ignore reversion speed — so t½ (OU half-life) and the ex-ante 2-week Sharpe ratio of
        the convergence trade are shown alongside. High |z| with a short half-life and high Sharpe is
        the attractive combination.
      </div>
    </div>
  )
}

// ─── New Issue tab ────────────────────────────────────────────────────────────

function NewIssueTab({ token, config }: {
  token: string
  config: { functional_form: string; exponent: number; weighting: string; custom_bonds: string; knots: string; external_vars: string; as_of: string }
}) {
  const [maturity, setMaturity] = useState('10')
  const [coupon, setCoupon] = useState('')          // empty → fitted par coupon
  const [sizeBn, setSizeBn] = useState('20')
  const [extraBp, setExtraBp] = useState('0')
  const [out, setOut] = useState<NewIssueResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function price() {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({
        maturity: maturity.trim(),
        size_bn: sizeBn || '20',
        extra_bp: extraBp || '0',
        functional_form: config.functional_form,
        exponent: String(config.exponent),
        weighting: config.weighting,
        ...(coupon.trim() ? { coupon: coupon.trim() } : {}),
        ...(config.custom_bonds ? { custom_bonds: config.custom_bonds } : {}),
        ...(config.knots ? { knots: config.knots } : {}),
        ...(config.external_vars ? { external_vars: config.external_vars } : {}),
        ...(config.as_of ? { as_of: config.as_of } : {}),
      })
      const res = await fetch(`/api/tools/fitted-bond-curves/new-issue?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      setOut(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '8px 10px',
    borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)',
    background: '#0d1425', color: '#e2e8f0', fontFamily: 'ui-monospace, monospace',
  }
  const lblStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: '#64748b', marginBottom: 5,
  }
  const tdStyle: React.CSSProperties = {
    padding: '8px 12px', fontSize: 13, color: '#e2e8f0',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    fontFamily: 'ui-monospace, monospace',
  }

  return (
    <>
      <div style={cardStyle}>
        <div style={sectionLabel}>Hypothetical new issue — priced off the fitted curve + estimated effects</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 150 }}>
            <div style={lblStyle}>Maturity (years or date)</div>
            <input value={maturity} onChange={e => setMaturity(e.target.value)}
              placeholder="10 or 2036-08-15" style={inputStyle} />
          </div>
          <div style={{ minWidth: 130 }}>
            <div style={lblStyle}>Coupon % (blank = par)</div>
            <input value={coupon} onChange={e => setCoupon(e.target.value)}
              placeholder="fitted par" style={inputStyle} />
          </div>
          <div style={{ minWidth: 110 }}>
            <div style={lblStyle}>Size (EUR bn)</div>
            <input value={sizeBn} onChange={e => setSizeBn(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ minWidth: 130 }}>
            <div style={lblStyle}>Extra rich/cheap (bp)</div>
            <input value={extraBp} onChange={e => setExtraBp(e.target.value)}
              placeholder="+ = rich" style={inputStyle} />
          </div>
          <button onClick={price} disabled={loading || !maturity.trim()}
            style={{
              padding: '9px 26px', borderRadius: 8,
              border: `1px solid ${ACCENT_BORDER}`, background: ACCENT_DIM,
              color: ACCENT, fontSize: 13, fontWeight: 700,
              cursor: loading || !maturity.trim() ? 'not-allowed' : 'pointer',
              opacity: loading || !maturity.trim() ? 0.5 : 1,
            }}>
            {loading ? 'Pricing…' : 'Price issue'}
          </button>
        </div>
        {error && <div style={{ color: NEG, fontSize: 12.5, marginTop: 10 }}>{error}</div>}
      </div>

      {out && (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <StatCard label="Issue" value={out.name}
              sub={`${out.ttm}y · ${out.size_bn}bn${out.deliverable ? ` · ${out.deliverable} deliverable` : ''}${out.coupon_is_par ? ' · coupon = fitted par' : ''}`} />
            <StatCard label="Predicted price" value={fmt(out.predicted_price, 3)}
              sub={`pure curve PV: ${fmt(out.curve_pv, 3)}`} color={ACCENT} />
            <StatCard label="Predicted YTM" value={`${fmt(out.predicted_ytm, 3)}%`}
              sub={`curve yield: ${fmt(out.curve_ytm, 3)}%`} />
            <StatCard label="Richness to curve" value={`${fmt(out.spread_to_curve_bp, 1)} bp`}
              sub={`BPV ${fmt(out.bpv, 4)} EUR/bp`}
              color={out.spread_to_curve_bp > 0 ? NEG : POS} />
          </div>

          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ ...cardStyle, flex: 1, minWidth: 360 }}>
              <div style={sectionLabel}>Pricing build-up</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  <tr>
                    <td style={tdStyle}>Cash flows off fitted curve Σ C·φ(τ)</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(out.curve_pv, 4)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#64748b' }}>—</td>
                  </tr>
                  {out.effects.map((e, i) => (
                    <tr key={i}>
                      <td style={{ ...tdStyle, color: '#94a3b8' }}>{e.label}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: e.eur > 0 ? NEG : e.eur < 0 ? POS : '#64748b' }}>
                        {e.eur >= 0 ? '+' : ''}{fmt(e.eur, 4)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#64748b' }}>{fmt(e.bp, 1)} bp</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ ...tdStyle, fontWeight: 700, borderTop: '1px solid rgba(255,255,255,0.12)' }}>Predicted dirty price</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: ACCENT, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
                      {fmt(out.predicted_price, 4)}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#64748b', borderTop: '1px solid rgba(255,255,255,0.12)' }}>
                      {fmt(out.spread_to_curve_bp, 1)} bp
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={{ ...cardStyle, flex: 1, minWidth: 320 }}>
              <div style={sectionLabel}>Nearest existing issues</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <td style={{ ...tdStyle, color: '#64748b', fontSize: 10, textTransform: 'uppercase', fontFamily: 'inherit' }}>Bond</td>
                    <td style={{ ...tdStyle, color: '#64748b', fontSize: 10, textTransform: 'uppercase', textAlign: 'right', fontFamily: 'inherit' }}>TTM</td>
                    <td style={{ ...tdStyle, color: '#64748b', fontSize: 10, textTransform: 'uppercase', textAlign: 'right', fontFamily: 'inherit' }}>YTM</td>
                    <td style={{ ...tdStyle, color: '#64748b', fontSize: 10, textTransform: 'uppercase', textAlign: 'right', fontFamily: 'inherit' }}>Resid bp</td>
                  </tr>
                </thead>
                <tbody>
                  {out.neighbours.map(n => (
                    <tr key={n.name}>
                      <td style={tdStyle}>{n.name}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(n.ttm, 1)}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(n.ytm, 3)}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: n.residual_bp > 1 ? NEG : n.residual_bp < -1 ? POS : '#e2e8f0' }}>
                        {fmt(n.residual_bp, 1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: '#475569', marginTop: 10, lineHeight: 1.6 }}>
                Sanity check: neighbouring bonds&apos; current residuals suggest how much local
                richness/cheapness to anticipate via the &quot;extra bp&quot; input.
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>Use case (H&S p.180)</div>
            <div style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.75 }}>
              New issues follow a regular schedule, so a yet-to-be-announced bond can affect futures
              pricing before it exists — e.g. a new Schatz that will become CTD. Forecast its coupon
              (the fitted par coupon is the natural default) and maturity, add the systematic effects
              from the regression and your anticipatory view, and you get a spot price. From there a
              conversion factor, BPV, and an assumed repo rate give the converted forward price and
              the futures fair value along Chapter 7 lines.
            </div>
          </div>
        </>
      )}
    </>
  )
}

// ─── Benchmarks tab ───────────────────────────────────────────────────────────

function BenchmarksTab({ result }: { result: FitResult }) {
  const thStyle: React.CSSProperties = {
    textAlign: 'right', padding: '8px 12px', fontSize: 10, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  }
  const tdStyle: React.CSSProperties = {
    padding: '9px 12px', fontSize: 13, color: '#e2e8f0', textAlign: 'right',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    fontFamily: 'ui-monospace, monospace',
  }
  const chartData = result.benchmarks.map(b => ({ tenor: b.tenor, par: b.par_coupon }))
  return (
    <>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ ...cardStyle, flex: 1, minWidth: 380 }}>
          <div style={sectionLabel}>Notional par benchmarks — C = 100·(1 − Z_T) / A_T</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, textAlign: 'left' }}>Tenor</th>
                <th style={thStyle}>Discount factor Z</th>
                <th style={thStyle}>Annuity A</th>
                <th style={thStyle}>Par coupon %</th>
              </tr>
            </thead>
            <tbody>
              {result.benchmarks.map(b => (
                <tr key={b.tenor}>
                  <td style={{ ...tdStyle, textAlign: 'left' }}>{b.tenor}y</td>
                  <td style={tdStyle}>{fmt(b.discount_factor, 4)}</td>
                  <td style={tdStyle}>{fmt(b.annuity, 4)}</td>
                  <td style={{ ...tdStyle, color: ACCENT, fontWeight: 700 }}>{fmt(b.par_coupon, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ ...cardStyle, flex: 1, minWidth: 380 }}>
          <div style={sectionLabel}>Constant-maturity par yield curve</div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
              <CartesianGrid stroke={GRID_STROKE} />
              <XAxis dataKey="tenor" type="number" domain={[0, 31]} tick={TICK_STYLE}
                label={{ value: 'Tenor (years)', position: 'insideBottom', offset: -5, fill: '#475569', fontSize: 11 }} />
              <YAxis domain={['auto', 'auto']} tick={TICK_STYLE} tickFormatter={(v: number) => v.toFixed(2)} />
              <Tooltip content={<ChartTooltip unit="%" />} />
              <Line dataKey="par" name="Par coupon" type="monotone" stroke={ACCENT} strokeWidth={2}
                dot={{ r: 4, fill: ACCENT }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div style={cardStyle}>
        <div style={sectionLabel}>Why this matters (H&S p.180–181)</div>
        <div style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.75 }}>
          The fitted discount function lets us price a <i>notional</i> bond that doesn&apos;t exist —
          e.g. a true constant-maturity 10y trading at par — via C = 100·(1 − Z₁₀)/A₁₀. These
          synthetic benchmarks produce structural-break-free time series (unlike swap-based series
          post-LIBOR), are the recommended input for PCA curve analysis, and can be used to predict
          the pricing of new issues before they are announced (e.g. future CTDs into Schatz contracts).
        </div>
      </div>
    </>
  )
}

// ─── Bond detail tab ──────────────────────────────────────────────────────────

function BondDetailTab({ result, bondId, token, config, onSelectBond }: {
  result: FitResult
  bondId: string | null
  token: string
  config: { functional_form: string; exponent: number; weighting: string; custom_bonds: string; knots: string; external_vars: string; as_of: string }
  onSelectBond: (id: string) => void
}) {
  const [detail, setDetail] = useState<BondDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bondId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({
      functional_form: config.functional_form,
      exponent: String(config.exponent),
      weighting: config.weighting,
      ...(config.custom_bonds ? { custom_bonds: config.custom_bonds } : {}),
      ...(config.knots ? { knots: config.knots } : {}),
      ...(config.external_vars ? { external_vars: config.external_vars } : {}),
        ...(config.as_of ? { as_of: config.as_of } : {}),
    })
    fetch(`/api/tools/fitted-bond-curves/bond/${bondId}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async res => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({ detail: res.statusText }))
          throw new Error(err.detail ?? `HTTP ${res.status}`)
        }
        return res.json()
      })
      .then(d => { if (!cancelled) setDetail(d) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bondId, token, config.functional_form, config.exponent, config.weighting, config.custom_bonds, config.knots, config.external_vars, config.as_of])

  if (!bondId) {
    return (
      <div style={{ ...cardStyle, textAlign: 'center', padding: 60, color: '#475569' }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No bond selected</div>
        <div style={{ fontSize: 12 }}>Pick a bond from the Rich / Cheap table, or choose below.</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', marginTop: 18 }}>
          {result.bonds.slice(0, 12).map(b => (
            <button key={b.bond_id} onClick={() => onSelectBond(b.bond_id)} style={{
              padding: '5px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8',
            }}>{b.name}</button>
          ))}
        </div>
      </div>
    )
  }
  if (loading) return <div style={{ textAlign: 'center', color: '#64748b', padding: 60 }}>Loading bond history…</div>
  if (error) return <div style={{ ...cardStyle, color: NEG, fontSize: 13 }}>{error}</div>
  if (!detail) return null

  const ou = detail.ou_params
  const histData = detail.history.dates.map((d, i) => ({ date: d, value: detail.history.values[i] }))
  const tickStep = Math.max(1, Math.floor(histData.length / 8))
  const ticks = histData.filter((_, i) => i % tickStep === 0).map(d => d.date)

  // Fan chart: history tail + forward percentile bands
  const fanData = detail.transition_densities.map(td => ({
    date: td.horizon_date ?? String(td.horizon_days),
    mean: td.mean, band90: [td.p5, td.p95], band50: [td.p25, td.p75],
  }))

  const bondRow = result.bonds.find(b => b.bond_id === detail.bond_id)

  return (
    <>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <StatCard label="Bond" value={detail.name}
          sub={bondRow ? `${bondRow.size_bn}bn · age ${fmt(bondRow.age, 1)}y${bondRow.deliverable ? ` · ${bondRow.deliverable} deliverable` : ''}` : undefined} />
        <StatCard label="Residual" value={`${fmt(detail.residual_bp, 1)} bp`}
          sub={`${fmt(detail.residual_eur * 100, 1)} cents`}
          color={detail.residual_bp > 1 ? NEG : detail.residual_bp < -1 ? POS : '#f1f5f9'} />
        <StatCard label="OU half-life" value={`${fmt(ou.half_life_days, 0)} bd`} sub={`κ = ${fmt(ou.k, 2)} (ann.)`} />
        <StatCard label="Z-score" value={fmt(ou.current_zscore, 2)} sub={`σ∞ = ${fmt(ou.stationary_std, 2)} bp`}
          color={Math.abs(ou.current_zscore) > 2 ? AMBER : '#f1f5f9'} />
      </div>

      <div style={cardStyle}>
        <div style={sectionLabel}>Rich/cheap indicator history — residual vs fitted curve, bp (ε / BPV)</div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={histData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} />
            <XAxis dataKey="date" ticks={ticks} tick={TICK_STYLE} />
            <YAxis domain={['auto', 'auto']} tick={TICK_STYLE} tickFormatter={(v: number) => v.toFixed(2)} />
            <Tooltip content={<ChartTooltip unit=" bp" />} />
            <ReferenceLine y={ou.mu} stroke={ACCENT} strokeDasharray="4 4"
              label={{ value: 'μ', fill: ACCENT, fontSize: 11, position: 'right' }} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
            <Line dataKey="value" name="Residual" stroke="#38bdf8" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={cardStyle}>
        <div style={sectionLabel}>Forward distribution — OU transition density fan, bp (6 months)</div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={fanData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} />
            <XAxis dataKey="date" tick={TICK_STYLE}
              ticks={fanData.filter((_, i) => i % 21 === 0).map(d => d.date)} />
            <YAxis domain={['auto', 'auto']} tick={TICK_STYLE} tickFormatter={(v: number) => v.toFixed(2)} />
            <Tooltip content={<ChartTooltip unit=" bp" />} />
            <Area dataKey="band90" name="5–95%" stroke="none" fill={ACCENT} fillOpacity={0.12} isAnimationActive={false} />
            <Area dataKey="band50" name="25–75%" stroke="none" fill={ACCENT} fillOpacity={0.22} isAnimationActive={false} />
            <Line dataKey="mean" name="E[ε]" stroke={ACCENT} strokeWidth={2} dot={false} isAnimationActive={false} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ fontSize: 11, color: '#475569', marginTop: 8, lineHeight: 1.7 }}>
          Expected convergence path of the residual under the estimated OU process, with 50% and 90%
          bands. H&S p.178: the speed of reversion — not the naked z-score — determines what to
          expect tomorrow; a z of 2.0 with a 200-day half-life tells you almost nothing.
        </div>
      </div>
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function FittedBondCurves() {
  const navigate = useNavigate()
  const token = localStorage.getItem('access_token') ?? ''

  const [functionalForm, setFunctionalForm] = useState('cubic_spline')
  const [exponent, setExponent] = useState(2)
  const [weighting, setWeighting] = useState('none')
  const [result, setResult] = useState<FitResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('curve')
  const [selectedBond, setSelectedBond] = useState<string | null>(null)

  // Custom bond universe (BBG tickers, one per line)
  const [customMode, setCustomMode] = useState(false)
  const [tickerText, setTickerText] = useState('')
  // custom_bonds string actually used by the last fit (drives detail requests too)
  const [activeCustom, setActiveCustom] = useState('')

  // Curve assumptions (right pane)
  const [nExp, setNExp] = useState(7)                                  // exponential splines
  const [knotsMode, setKnotsMode] = useState<'auto' | 'manual'>('auto')
  const [manualKnots, setManualKnots] = useState<number[]>([])
  const [knotDraft, setKnotDraft] = useState('')
  const [activeKnots, setActiveKnots] = useState('')                   // knots used by last fit

  // As-of date ('' = today)
  const [asOf, setAsOf] = useState('')
  const [activeAsOf, setActiveAsOf] = useState('')

  // External regression variables
  const ALL_EXT_VARS = ['size', 'age', 'Schatz', 'Bobl', 'Bund', 'Buxl']
  const [extVars, setExtVars] = useState<Set<string>>(new Set(ALL_EXT_VARS))
  const [activeExtVars, setActiveExtVars] = useState('')               // used by last fit
  const extVarsParam = (s: Set<string>) =>
    s.size === ALL_EXT_VARS.length ? '' : (s.size === 0 ? 'none' : ALL_EXT_VARS.filter(v => s.has(v)).join(','))
  const toggleExtVar = (v: string) => {
    const next = new Set(extVars)
    if (next.has(v)) next.delete(v); else next.add(v)
    setExtVars(next)
  }

  // Saved curves (left pane, PCA Analysis pattern)
  const [savedCurves, setSavedCurves] = useState<{ name: string; tickers: string[] }[]>(() => {
    try { return JSON.parse(localStorage.getItem('fbc_saved_curves') ?? '[]') } catch { return [] }
  })
  const [showSaveInput, setShowSaveInput] = useState(false)
  const [saveNameDraft, setSaveNameDraft] = useState('')

  const persistCurves = (curves: typeof savedCurves) => {
    setSavedCurves(curves)
    localStorage.setItem('fbc_saved_curves', JSON.stringify(curves))
  }
  const currentTickers = () => tickerText.split('\n').map(t => t.trim()).filter(Boolean)
  const saveCurve = () => {
    const name = saveNameDraft.trim()
    if (!name || currentTickers().length < 5) return
    persistCurves([...savedCurves, { name, tickers: currentTickers() }])
    setSaveNameDraft('')
    setShowSaveInput(false)
  }
  const loadCurve = (idx: number) => {
    const c = savedCurves[idx]
    if (!c) return
    setCustomMode(true)
    setTickerText(c.tickers.join('\n'))
    setActiveTab('curve')
    setSelectedBond(null)
    setKnotsMode('auto')   // manual knots may not suit the new maturity span
    runFit({ custom: c.tickers.join(','), knots: '' })
  }
  const deleteCurve = (idx: number) => persistCurves(savedCurves.filter((_, i) => i !== idx))

  interface FitOverrides {
    form?: string; exp?: number; w?: string
    custom?: string; knots?: string; nSplines?: number; ext?: string; date?: string
  }

  async function runFit(overrides: FitOverrides = {}) {
    const form = overrides.form ?? functionalForm
    const exp = overrides.exp ?? exponent
    const w = overrides.w ?? weighting
    const custom = overrides.custom ?? activeCustom
    const knots = form === 'cubic_spline' ? (overrides.knots ?? activeKnots) : ''
    const nSplines = overrides.nSplines ?? nExp
    const ext = overrides.ext ?? activeExtVars
    const date = overrides.date ?? activeAsOf
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({
        functional_form: form, exponent: String(exp), weighting: w,
        n_exp_splines: String(nSplines),
        ...(custom ? { custom_bonds: custom } : {}),
        ...(knots ? { knots } : {}),
        ...(ext ? { external_vars: ext } : {}),
        ...(date ? { as_of: date } : {}),
      })
      const res = await fetch(`/api/tools/fitted-bond-curves?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      setResult(await res.json())
      setActiveCustom(custom)
      setActiveKnots(knots)
      setActiveExtVars(ext)
      setActiveAsOf(date)
      setSelectedBond(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { runFit() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  function applyUniverse(useCustom: boolean) {
    // Called from the Curve & Fit editor: fit with the chosen bond set.
    // Reset knots to automatic — a new universe has a new maturity span.
    setKnotsMode('auto')
    runFit({ custom: useCustom ? currentTickers().join(',') : '', knots: '' })
  }

  function refitWithAssumptions() {
    const knots = knotsMode === 'manual' && functionalForm === 'cubic_spline'
      ? manualKnots.join(',') : ''
    runFit({ form: functionalForm, exp: exponent, w: weighting, knots,
             nSplines: nExp, ext: extVarsParam(extVars) })
  }

  function enterManualKnots() {
    setManualKnots(result?.config.knots ?? [0, 0.5, 1, 2, 5, 10, 20, 30])
    setKnotsMode('manual')
  }

  function addKnot() {
    const v = parseFloat(knotDraft)
    if (!Number.isFinite(v) || v < 0) return
    const r = Math.round(v * 100) / 100
    if (!manualKnots.includes(r)) setManualKnots([...manualKnots, r].sort((a, b) => a - b))
    setKnotDraft('')
  }

  function selectBond(id: string) {
    setSelectedBond(id)
    setActiveTab('detail')
  }

  const editor: UniverseEditor = {
    customMode, setCustomMode, tickerText, setTickerText,
    asOf, setAsOf,
    onApply: applyUniverse,
    onAsOfChange: (date: string) => runFit({ date }),
    loading,
  }

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'curve',        label: 'Curve & Fit' },
    { id: 'residuals',    label: 'Residuals' },
    { id: 'coefficients', label: 'Coefficients' },
    { id: 'richcheap',    label: 'Rich / Cheap' },
    { id: 'detail',       label: 'Bond Detail' },
    { id: 'newissue',     label: 'New Issue' },
    { id: 'benchmarks',   label: 'Par Benchmarks' },
  ]

  const selStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8, padding: '7px 10px', color: '#f1f5f9', fontSize: 12.5,
  }
  const ctlLabel: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: '#64748b', marginBottom: 5,
  }

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#f1f5f9', fontFamily: 'system-ui, sans-serif' }}>

      {/* Header */}
      <div style={{
        background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)',
        padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 16,
        position: 'sticky', top: 0, zIndex: 10, backdropFilter: 'blur(8px)',
      }}>
        <button onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>
          ←
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em' }}>Fitted Bond Curves</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            Rich/cheap via fitted discount curves — Huggins & Schaller Ch. 8
          </div>
        </div>

      </div>

      {/* Body: sidebar + main content */}
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>

        {/* ── Saved Curves sidebar (PCA Analysis pattern) ── */}
        <div style={{
          width: 210, flexShrink: 0, position: 'sticky', top: 57,
          height: 'calc(100vh - 57px)', overflowY: 'auto',
          borderRight: '1px solid rgba(255,255,255,0.1)',
          background: '#0a0f1e', padding: '16px 12px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: '0.1em',
            textTransform: 'uppercase', marginBottom: 8 }}>
            Saved Curves
          </div>

          {savedCurves.length === 0 && (
            <div style={{ fontSize: 11, color: '#475569', fontStyle: 'italic', lineHeight: 1.5 }}>
              No curves saved yet.
            </div>
          )}

          {savedCurves.map((c, idx) => (
            <div key={idx} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              borderRadius: 6, padding: '5px 8px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
              cursor: 'pointer',
            }}
              onClick={() => loadCurve(idx)}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#cbd5e1' }}>
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                <span style={{ fontSize: 10, color: '#475569' }}>{c.tickers.length} bonds</span>
              </span>
              <button
                onClick={e => { e.stopPropagation(); deleteCurve(idx) }}
                style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer',
                  fontSize: 13, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                title="Delete"
              >×</button>
            </div>
          ))}

          {/* Save current */}
          <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            {customMode && currentTickers().length >= 5 ? (
              showSaveInput ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    value={saveNameDraft}
                    onChange={e => setSaveNameDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveCurve(); if (e.key === 'Escape') setShowSaveInput(false) }}
                    placeholder="Curve name…"
                    autoFocus
                    style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: `1px solid ${ACCENT_BORDER}`,
                      background: '#0d1425', color: '#e2e8f0', width: '100%', boxSizing: 'border-box' }}
                  />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={saveCurve}
                      style={{ flex: 1, fontSize: 11, fontWeight: 600, color: '#fff', background: 'rgba(168,85,247,0.7)',
                        border: 'none', borderRadius: 6, padding: '4px 0', cursor: 'pointer' }}>
                      Save
                    </button>
                    <button onClick={() => setShowSaveInput(false)}
                      style={{ fontSize: 11, color: '#475569', background: 'none',
                        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowSaveInput(true)}
                  style={{ width: '100%', fontSize: 11, color: ACCENT, background: 'none',
                    border: `1px dashed ${ACCENT_BORDER}`, borderRadius: 6, padding: '5px 0', cursor: 'pointer' }}>
                  + Save current
                </button>
              )
            ) : (
              <div style={{ fontSize: 10, color: '#334155', textAlign: 'center', lineHeight: 1.4 }}>
                Enter a custom bond list (≥ 5 tickers) in Curve &amp; Fit to save it
              </div>
            )}
          </div>
        </div>

        {/* ── Main content ── */}
        <div style={{ flex: 1, minWidth: 0, maxWidth: 1280, margin: '0 auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {error && (
          <div style={{ ...cardStyle, borderColor: 'rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.05)', color: NEG, fontSize: 13, padding: '12px 18px' }}>
            {error}
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', color: '#64748b', padding: 80, fontSize: 14 }}>
            Running joint curve + regression optimisation…
          </div>
        )}

        {result && !loading && (
          <>
            {result.simulation_mode && (
              <div style={{ ...cardStyle, padding: '10px 16px', borderColor: 'rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.05)', fontSize: 12, color: '#f59e0b' }}>
                Simulation mode — synthetic German bond universe with known pricing effects
                (Bloomberg replacement pending). The Coefficients tab shows true vs estimated values.
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TABS.map(tab => (
                <TabButton key={tab.id} label={tab.label} active={activeTab === tab.id} onClick={() => setActiveTab(tab.id)} />
              ))}
            </div>

            {activeTab === 'curve'        && <CurveTab result={result} editor={editor} />}
            {activeTab === 'residuals'    && <ResidualsTab result={result} />}
            {activeTab === 'coefficients' && <CoefficientsTab result={result} />}
            {activeTab === 'richcheap'    && <RichCheapTab result={result} onSelectBond={selectBond} />}
            {activeTab === 'detail'       && (
              <BondDetailTab result={result} bondId={selectedBond} token={token}
                config={{ functional_form: functionalForm, exponent, weighting, custom_bonds: activeCustom, knots: activeKnots, external_vars: activeExtVars, as_of: activeAsOf }}
                onSelectBond={selectBond} />
            )}
            {activeTab === 'newissue'     && (
              <NewIssueTab token={token}
                config={{ functional_form: functionalForm, exponent, weighting, custom_bonds: activeCustom, knots: activeKnots, external_vars: activeExtVars, as_of: activeAsOf }} />
            )}
            {activeTab === 'benchmarks'   && <BenchmarksTab result={result} />}
          </>
        )}
        </div>{/* end main content */}

        {/* ── Curve Assumptions right pane ── */}
        <div style={{
          width: 240, flexShrink: 0, position: 'sticky', top: 57,
          height: 'calc(100vh - 57px)', overflowY: 'auto',
          borderLeft: '1px solid rgba(255,255,255,0.1)',
          background: '#0a0f1e', padding: '16px 14px',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: '0.1em',
            textTransform: 'uppercase' }}>
            Curve Assumptions
          </div>

          {/* Functional form */}
          <div>
            <div style={ctlLabel}>Discount function</div>
            <select value={functionalForm} style={{ ...selStyle, width: '100%', boxSizing: 'border-box' }}
              onChange={e => setFunctionalForm(e.target.value)}>
              <option value="cubic_spline">Cubic spline on h(τ)</option>
              <option value="exponential_splines">Exponential splines</option>
            </select>
          </div>

          {/* Knot editor (cubic) or spline count (exponential) */}
          {functionalForm === 'cubic_spline' ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ ...ctlLabel, marginBottom: 0 }}>Knot points (years)</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['auto', 'manual'] as const).map(m => (
                    <button key={m}
                      onClick={() => { if (m === 'manual') enterManualKnots(); else setKnotsMode('auto') }}
                      style={{
                        padding: '2px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: 'pointer',
                        textTransform: 'capitalize',
                        background: knotsMode === m ? ACCENT_DIM : 'transparent',
                        border: `1px solid ${knotsMode === m ? ACCENT_BORDER : 'rgba(255,255,255,0.1)'}`,
                        color: knotsMode === m ? ACCENT : '#64748b',
                      }}>{m}</button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {(knotsMode === 'manual' ? manualKnots : (result?.config.knots ?? [])).map(k => (
                  <span key={k} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '2px 7px', borderRadius: 5, fontSize: 11,
                    fontFamily: 'ui-monospace, monospace',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: knotsMode === 'manual' ? '#e2e8f0' : '#64748b',
                  }}>
                    {k}
                    {knotsMode === 'manual' && (
                      <button onClick={() => setManualKnots(manualKnots.filter(x => x !== k))}
                        style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer',
                          fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
                    )}
                  </span>
                ))}
              </div>

              {knotsMode === 'manual' ? (
                <>
                  <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                    <input
                      value={knotDraft}
                      onChange={e => setKnotDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') addKnot() }}
                      placeholder="Add knot, e.g. 12.5"
                      style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '5px 8px', borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.12)', background: '#0d1425',
                        color: '#e2e8f0', fontFamily: 'ui-monospace, monospace' }}
                    />
                    <button onClick={addKnot} disabled={!knotDraft.trim()}
                      style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                        border: `1px solid ${ACCENT_BORDER}`, background: ACCENT_DIM, color: ACCENT,
                        cursor: knotDraft.trim() ? 'pointer' : 'not-allowed',
                        opacity: knotDraft.trim() ? 1 : 0.4 }}>
                      +
                    </button>
                  </div>
                  {manualKnots.length < 4 && (
                    <div style={{ fontSize: 10, color: AMBER, marginTop: 5 }}>
                      At least 4 knots required for a cubic spline.
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 10, color: '#475569', marginTop: 6, lineHeight: 1.5 }}>
                  Automatic placement — H&S p.174 grid, trimmed to the maturity span and thinned
                  for small universes. Switch to Manual to edit.
                </div>
              )}

              <div style={{ fontSize: 10, color: '#334155', marginTop: 8, lineHeight: 1.5 }}>
                H&S p.174: changes in the curve&apos;s first derivative concentrate at the front end
                (monetary policy), so it&apos;s typically advisable to widen knot spacing with maturity.
              </div>
            </div>
          ) : (
            <div>
              <div style={ctlLabel}>Number of splines</div>
              <input type="number" min={3} max={12} value={nExp}
                onChange={e => setNExp(Math.max(3, Math.min(12, Number(e.target.value) || 7)))}
                style={{ ...selStyle, width: '100%', boxSizing: 'border-box' }} />
              <div style={{ fontSize: 10, color: '#475569', marginTop: 6, lineHeight: 1.5 }}>
                df(t) = Σ βⱼ·e^(−jtα). H&S p.174: seven is a good starting point — too few makes
                the curve sticky, too many follows each outlier too closely.
              </div>
            </div>
          )}

          {/* Error exponent */}
          <div>
            <div style={ctlLabel}>Error exponent |ε|^p</div>
            <select value={exponent} style={{ ...selStyle, width: '100%', boxSizing: 'border-box' }}
              onChange={e => setExponent(Number(e.target.value))}>
              <option value={2}>p = 2 (least squares)</option>
              <option value={1}>p = 1 (robust to outliers)</option>
            </select>
          </div>

          {/* Weighting */}
          <div>
            <div style={ctlLabel}>Observation weights</div>
            <select value={weighting} style={{ ...selStyle, width: '100%', boxSizing: 'border-box' }}
              onChange={e => setWeighting(e.target.value)}>
              <option value="none">Equal (OLS)</option>
              <option value="bpv">1 / BPV (WLS)</option>
            </select>
          </div>

          {/* External regression variables */}
          <div>
            <div style={ctlLabel}>External variables</div>
            {([['size', 'Issue size'], ['age', 'Issue age']] as const).map(([v, label]) => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12,
                color: extVars.has(v) ? '#e2e8f0' : '#64748b', cursor: 'pointer', padding: '3px 0' }}>
                <input type="checkbox" checked={extVars.has(v)} onChange={() => toggleExtVar(v)}
                  style={{ accentColor: ACCENT }} />
                {label}
              </label>
            ))}
            <div style={{ fontSize: 10, color: '#475569', margin: '6px 0 2px' }}>Deliverability (× BPV):</div>
            {(['Schatz', 'Bobl', 'Bund', 'Buxl'] as const).map(v => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12,
                color: extVars.has(v) ? '#e2e8f0' : '#64748b', cursor: 'pointer', padding: '3px 0' }}>
                <input type="checkbox" checked={extVars.has(v)} onChange={() => toggleExtVar(v)}
                  style={{ accentColor: ACCENT }} />
                {v} deliverable
              </label>
            ))}
            <div style={{ fontSize: 10, color: '#334155', marginTop: 6, lineHeight: 1.5 }}>
              Effects you exclude are no longer &quot;explained away&quot; and show up in the
              residuals instead — e.g. untick a contract to see its deliverables screen as rich.
            </div>
          </div>

          <button
            onClick={refitWithAssumptions}
            disabled={loading || (functionalForm === 'cubic_spline' && knotsMode === 'manual' && manualKnots.length < 4)}
            style={{
              width: '100%', padding: '9px 0', borderRadius: 8,
              border: `1px solid ${ACCENT_BORDER}`, background: ACCENT_DIM,
              color: ACCENT, fontSize: 13, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1,
            }}>
            {loading ? 'Fitting…' : 'Refit curve'}
          </button>

          {result && (
            <div style={{ fontSize: 10, color: '#475569', lineHeight: 1.6, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
              Last fit: {result.config.functional_form === 'cubic_spline'
                ? `cubic spline, ${result.config.knots?.length ?? 0} knots (${result.config.knots_source ?? 'auto'})`
                : `${result.config.n_exp_splines} exponential splines`}
              {` · p = ${result.config.exponent} · ${result.config.weighting === 'bpv' ? 'WLS' : 'OLS'}`}
              {` · ${result.fit_quality.n_bonds} bonds · ${fmt(result.fit_quality.mean_abs_bp)} bp mean |ε|`}
              {` · smoothness ${result.fit_quality.smoothness >= 1 ? fmt(result.fit_quality.smoothness, 1) : fmt(result.fit_quality.smoothness, 3)}`}
            </div>
          )}
        </div>{/* end right pane */}
      </div>{/* end body */}
    </div>
  )
}
