import { useState, useEffect } from 'react'
import PageTitle, { headerBar } from '../components/PageTitle'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, ScatterChart,
  Scatter, ZAxis, ComposedChart, Area,
} from 'recharts'
import { authFetch } from '../api/client'

// ─── Types ────────────────────────────────────────────────────────────────────

interface OuParams {
  k: number
  mu: number
  sigma: number
  half_life_days: number
  stationary_std: number
  current: number
  current_zscore: number
}

interface StantonBucket {
  midpoint: number
  avg_change: number
  std_change: number
  n_obs: number
  sim_avg_change?: number
  sim_std_change?: number
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

interface SharpePoint {
  horizon_days: number
  annualised_sharpe: number
}

interface FptStats {
  histogram: Array<{ days: number; density: number }>
  hit_days_raw: number[]
  kde: Array<{ days: number; density: number }>
  total: number
  prob_5d: number
  prob_10d: number
  prob_20d: number
  prob_30d: number
  prob_50d: number
  mean_days: number | null
  median_days: number | null
  pct_hit: number
}

interface CoeffRow {
  symbol: string
  name: string
  value: number
}

interface DerivedRow {
  symbol: string
  name: string
  value: number | string
  note?: string
}

interface ModelInfo {
  model_type: string
  sde: string
  coefficients: CoeffRow[]
  derived: DerivedRow[]
  estimation_method: string
  estimation_detail: string
  constraint_note: string
}

interface DriftScatter {
  points: Array<{ dev: number; dx: number }>
  slope: number
  intercept: number
  r2: number
  theoretical_slope: number
}

interface AnalysisResult {
  expression: string
  terms: Array<{ weight: number; ticker: string }>
  simulation_mode: boolean
  fit_start: string
  fit_end: string
  series: { dates: string[]; values: number[] }
  drift_scatter: DriftScatter
  ou_params: OuParams
  model_type: string
  model_info: ModelInfo
  stanton: StantonBucket[]
  transition_densities: TransitionDensity[]
  sharpe_profile: SharpePoint[]
  fpt: { to_target: FptStats; to_stop?: FptStats }
  suggested_target: number
  suggested_stop: number
}

interface HistPoint {
  x: number
  hist: number
  narrow: number
  medium: number
  wide: number
}

interface HistData {
  horizon_days: number
  horizon_date: string
  x_now: number
  bw_scott: number
  data: HistPoint[]
  stats: { mean: number; std: number; p5: number; p25: number; p75: number; p95: number }
}

type ModelType = 'linear_ou' | 'polynomial' | 'inverse_polynomial'

const MODEL_OPTIONS: Array<{ id: ModelType; label: string }> = [
  { id: 'linear_ou',           label: 'Linear OU' },
  { id: 'polynomial',          label: 'Polynomial (3rd order)' },
  { id: 'inverse_polynomial',  label: 'Inverse Polynomial' },
]

// ─── Styling constants (match existing pages) ─────────────────────────────────

const BG = '#07090c'
const ACCENT = '#86c0de'
const ACCENT_DIM = 'rgba(134,192,222,0.14)'
const ACCENT_BORDER = 'rgba(134,192,222,0.42)'
const POS = '#58ad8e'
const NEG = '#d9705e'
const cardStyle: React.CSSProperties = {
  background: '#0b0f14',
  border: '1px solid rgba(150,178,205,0.09)',
  borderRadius: 6, padding: 20,
}
const sectionLabel: React.CSSProperties = {
  fontFamily: "'Geist Mono', ui-monospace, monospace",
  fontSize: 10.5, fontWeight: 500, textTransform: 'uppercase',
  letterSpacing: '0.14em', color: '#9aa5b1', marginBottom: 14,
}

// ─── Helper components ────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="hub-frame" style={{ ...cardStyle, padding: '14px 18px', minWidth: 130 }}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#9aa5b1', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: color ?? '#eef2f6', letterSpacing: '-0.02em' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: '#9aa5b1', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function TabButton({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '7px 18px',
        borderRadius: 6,
        border: active ? `1px solid ${ACCENT_BORDER}` : '1px solid transparent',
        background: active ? ACCENT_DIM : 'transparent',
        color: active ? ACCENT : '#9aa5b1',
        fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
      }}
    >
      {label}
    </button>
  )
}

const TICK_STYLE = { fill: '#9aa5b1', fontSize: 11 }
const GRID_STROKE = 'rgba(200,220,240,0.04)'

// ─── Hover-tooltip explanations ───────────────────────────────────────────────

const PARAM_TIPS: Record<string, string> = {
  mu:
    'Long-run mean μ is the equilibrium level the series is always being pulled toward. The drift term κ(μ − xₜ)dt is positive whenever the series is below μ and negative whenever it is above — so the process is perpetually nudged back. Think of μ as the model\'s estimate of "fair value": not where the series is today, but where gravity says it belongs over the long run.',

  k:
    'Speed of mean reversion κ (annualised) controls how aggressively the drift pulls toward μ. Each business day the deterministic component of the move is κ·(μ − xₜ)/252. A κ of 2.5 gives a half-life of about 70 business days; κ of 50 reverts in a few days. Because κ appears in the denominator of the stationary variance σ²/(2κ), faster reversion also keeps the series in a tighter range around μ.',

  sigma:
    'Instantaneous volatility σ is the diffusion coefficient — the amplitude of the random shock received per unit of time. Each business day the series is hit by a shock of size σ/√252. In practice σ dwarfs the drift on any single day, which is why mean reversion is a slow statistical force rather than something visible in day-to-day moves. σ is estimated jointly with κ and μ via MLE on the OU transition density.',

  half_life:
    'Half-life = ln(2)/κ × 252 is the expected number of business days for exactly half of today\'s deviation from μ to disappear under the deterministic drift alone. After one half-life the expected gap is 50% of now; after two half-lives 25%; after n half-lives 1/2ⁿ. Use it as your trade clock: it quantifies how patient you need to be when entering a mean-reversion position.',

  stat_std:
    'Stationary standard deviation σ∞ = σ/√(2κ) is the long-run spread of the process around μ — the standard deviation of the stationary distribution N(μ, σ²/(2κ)). It reflects the balance between noise (σ inflates it) and mean reversion (κ compresses it). Values beyond ±2σ∞ from μ are historically unusual (≈5% of observations) and represent the extremes where a mean-reversion trade is most attractive.',

  zscore:
    'Z-score = (xₜ − μ)/σ∞ expresses the current level in units of the stationary standard deviation. Under the stationary OU distribution z ~ N(0,1), so |z| > 2 places the series in the outer 5% of its historical range. The Sharpe profile tab shows that entry Sharpe is maximised at short horizons precisely when |z| is large — the further from μ you enter, the faster the initial convergence.',

  // Linear OU derived table
  derived_hl:
    'Half-life t½ = ln(2)/κ × 252 expressed in business days. This is the modal time horizon for a mean-reversion trade: you expect to capture roughly half the potential return within one half-life. Shorter half-lives demand more tactical management; longer half-lives require more carry/patience before reversion materialises.',

  derived_stat_std:
    'Stationary σ∞ = σ/√(2κ) is the theoretically predicted long-run standard deviation of the series around μ. Entry signals are most naturally sized in units of σ∞: a trade entered at z·σ∞ away from μ has an expected full-reversion P&L of z·σ∞ per unit notional. The stationary variance σ²/(2κ) also governs the width of the forward distribution fan chart.',

  derived_z:
    'Z-score z = (x − μ)/σ∞ is the canonical entry-signal metric from H&S Chapter 2. Under stationarity it is standard-normal, so it is directly interpretable as a percentile of the historical distribution: z = −1.96 means the series is cheaper than 97.5% of its history. The expected annualised Sharpe of a convergence trade scales with |z| at short horizons.',

  // Polynomial/inverse derived table
  derived_mu_star:
    'Estimated long-run mean μ* is the nearest real root of the nonlinear drift equation f(x) = 0 — the level at which the deterministic drift is zero and the process has no systematic tendency to move. It plays the same role as μ in the linear model but is found numerically from the polynomial coefficients rather than estimated directly.',

  derived_k_star:
    'Linearised reversion speed κ* = −f′(μ*) is the slope of the drift function evaluated at μ*, negated. It tells you how fast the process reverts to μ* for small deviations — the first-order approximation of the nonlinear dynamics. For large deviations from μ* the full nonlinear shape of f(x) matters, which is why the drift scatter and Stanton charts are important complements.',

  derived_hl_star:
    'Approximate half-life t½* = ln(2)/κ* × 252 is the linearised half-life near μ*. It is a good approximation when the current level is close to μ* but can understate or overstate reversion speed far from equilibrium where the drift function curves significantly.',

  derived_z_star:
    'Z-score z = (x − μ*) / (σ/√(2κ*)) uses the linearised stationary standard deviation as a normaliser. It gives a rough sense of how extreme the current deviation is relative to the typical range the series occupies near its equilibrium. For large |z| the nonlinear dynamics dominate, so treat this as an approximate signal rather than an exact probabilistic statement.',

  // Coefficients
  coeff_kappa:
    'κ (kappa) is the mean-reversion speed in the linear OU SDE dxₜ = κ(μ − xₜ)dt + σ dWₜ. It sets how quickly deviations from μ are corrected. Estimated via MLE on the exact OU transition density: the likelihood is the product of Gaussian conditional densities N(μ + (xₜ − μ)e^{−κΔt}, σ²(1−e^{−2κΔt})/(2κ)) across all consecutive pairs.',

  coeff_mu:
    'μ (mu) is the long-run mean in the linear OU SDE — the parameter that shifts the entire drift function. Together with κ and σ it fully characterises the OU dynamics. In the MLE, μ is the value that balances the drift residuals: the weighted average of the data points under the transition density.',

  coeff_sigma:
    'σ (sigma) is the instantaneous diffusion coefficient — the noise amplitude per unit of time. It appears in the conditional variance σ²(1−e^{−2κΔt})/(2κ) of each transition. MLE estimates σ by matching the spread of one-step innovations: a larger σ makes the transition density wider and more forgiving of large moves.',

  coeff_a:
    'Constant term a is the drift value at x = 0. In f(x) = a + bx + cx² + dx³ it sets the intercept of the nonlinear drift function. On its own it would push the series in a fixed direction regardless of level; the other terms bend and slope the drift to create mean reversion.',

  coeff_b:
    'Linear coefficient b is the slope of the drift at x = 0 and the dominant term near the long-run mean. A negative b creates mean-reversion (the series is pushed back when x is large positive and pushed up when x is small). It is analogous to −κ in the linear model: the linearised reversion speed κ* ≈ −(b + 2c·μ* + 3d·μ*²).',

  coeff_c:
    'Quadratic coefficient c introduces curvature into the drift function. A nonzero c creates asymmetric dynamics: the restoring force can be stronger on one side of the equilibrium than the other. Positive c steepens the drift for large positive x (faster reversion from above); negative c does the opposite.',

  coeff_d:
    'Cubic coefficient d is the highest-order term. For the model to remain mean-reverting for arbitrarily large deviations, d must be ≤ 0 — a positive d would make the drift point away from centre for large |x|, causing eventual explosion. The constraint indicator below the table flags whether this condition is satisfied in the current estimate.',

  coeff_a_inv:
    'Inverse coefficient a/x provides a reflecting barrier near x = 0: as x → 0⁺ the drift becomes large and positive (pushes x away from zero), preventing the series from crossing into negative territory. For this to work correctly a must be ≥ 0, which is flagged in the constraint note. The term is excluded for near-zero observations to avoid numerical singularities.',
}

// ─── Fixed hover tooltip ──────────────────────────────────────────────────────

interface TooltipState { text: string; x: number; y: number }

function SeriesTooltipOverlay({ tip }: { tip: TooltipState | null }) {
  if (!tip) return null
  // Keep the tooltip inside the viewport
  const left = Math.min(tip.x + 16, window.innerWidth - 420)
  const top  = tip.y + 20 + 280 > window.innerHeight ? tip.y - 280 : tip.y + 20
  return (
    <div style={{
      position: 'fixed', left, top,
      width: 400,
      background: '#0b0f14',
      border: '1px solid rgba(111,192,203,0.35)',
      borderRadius: 6,
      padding: '14px 16px',
      fontSize: 13, color: '#c3ccd6', lineHeight: 1.65,
      zIndex: 9999, pointerEvents: 'none',
      boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
    }}>
      {tip.text}
    </div>
  )
}

function fmt(v: number, decimals = 2): string {
  return v.toFixed(decimals)
}

// ─── Example expressions ──────────────────────────────────────────────────────

const EXAMPLES = [
  { label: '2s10s USD', expr: 'USGG10YR Index - USGG2YR Index' },
  { label: '2/5/10 fly EUR', expr: '2 * GDBR5 Index - GDBR2 Index - GDBR10 Index' },
  { label: '10Y Bund yield', expr: 'GDBR10 Index' },
  { label: 'EUR/USD', expr: 'EURUSD Curncy' },
  { label: '10Y BTP–Bund', expr: 'GBTPGR10 Index - GDBR10 Index' },
]

// ─── Tab components ───────────────────────────────────────────────────────────

function SeriesTab({
  result, modelType, onModelChange,
}: {
  result: AnalysisResult
  modelType: ModelType
  onModelChange: (m: ModelType) => void
}) {
  const { series, ou_params: ou, model_info: mi } = result
  const [tip, setTip] = useState<TooltipState | null>(null)

  function onTip(key: string) {
    return {
      onMouseEnter: (e: React.MouseEvent) => setTip({ text: PARAM_TIPS[key] ?? '', x: e.clientX, y: e.clientY }),
      onMouseMove:  (e: React.MouseEvent) => setTip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null),
      onMouseLeave: () => setTip(null),
    }
  }

  // Map coefficient symbol to its tooltip key
  function coeffTipKey(symbol: string, mode: string): string {
    if (symbol === 'σ') return 'coeff_sigma'
    if (symbol === 'κ') return 'coeff_kappa'
    if (symbol === 'μ') return 'coeff_mu'
    if (symbol === 'a') return mode === 'inverse_polynomial' ? 'coeff_a_inv' : 'coeff_a'
    if (symbol === 'b') return 'coeff_b'
    if (symbol === 'c') return 'coeff_c'
    if (symbol === 'd') return 'coeff_d'
    return ''
  }

  function derivedTipKey(symbol: string, isLinear: boolean): string {
    if (symbol === 't½')  return 'derived_hl'
    if (symbol === 'σ∞')  return 'derived_stat_std'
    if (symbol === 'z' && isLinear) return 'derived_z'
    if (symbol === 'μ*')  return 'derived_mu_star'
    if (symbol === 'κ*')  return 'derived_k_star'
    if (symbol === 't½*') return 'derived_hl_star'
    if (symbol === 'z')   return 'derived_z_star'
    return ''
  }
  const chartData = series.dates.map((d, i) => ({ date: d, value: series.values[i] }))
  const zColor = ou.current_zscore > 2 ? NEG : ou.current_zscore < -2 ? POS : '#eef2f6'

  // Thin the date axis to avoid overcrowding
  const tickStep = Math.max(1, Math.floor(chartData.length / 8))
  const ticks = chartData.filter((_, i) => i % tickStep === 0).map(d => d.date)

  // Constraint check for the banner
  const constraintOk = mi?.constraint_note ? !mi.constraint_note.includes('⚠') : true

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Model selector */}
      <div className="hub-frame" style={{ ...cardStyle, padding: '14px 18px' }}>
        <div style={{ ...sectionLabel, marginBottom: 10 }}>Drift model</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {MODEL_OPTIONS.map(opt => (
            <button
              key={opt.id}
              onClick={() => onModelChange(opt.id)}
              style={{
                padding: '7px 18px', borderRadius: 6,
                border: modelType === opt.id ? `1px solid ${ACCENT_BORDER}` : '1px solid rgba(200,220,240,0.1)',
                background: modelType === opt.id ? ACCENT_DIM : 'rgba(200,220,240,0.03)',
                color: modelType === opt.id ? ACCENT : '#c6ced8',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* SDE + coefficients panel (hidden for linear OU where it would be redundant with stat cards) */}
      {mi && (
        <div className="hub-frame" style={cardStyle}>
          {/* SDE equation */}
          <div style={{ ...sectionLabel, marginBottom: 8 }}>Stochastic differential equation</div>
          <div style={{
            fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 15, fontWeight: 600,
            color: '#e4eaf1', background: 'rgba(200,220,240,0.04)',
            borderRadius: 6, padding: '10px 16px', marginBottom: 16, letterSpacing: '0.02em',
          }}>
            {mi.sde}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Coefficients table */}
            <div>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>Estimated coefficients</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(200,220,240,0.07)' }}>
                    {['Symbol', 'Description', 'Value'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#9aa5b1', fontWeight: 600, fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mi.coefficients.map(row => (
                    <tr key={row.symbol}
                      style={{ borderBottom: '1px solid rgba(200,220,240,0.04)', cursor: 'help' }}
                      {...onTip(coeffTipKey(row.symbol, mi.model_type))}
                    >
                      <td style={{ padding: '6px 10px', fontFamily: "'Geist Mono', ui-monospace, monospace", color: ACCENT, fontWeight: 600, fontSize: 14 }}>{row.symbol}</td>
                      <td style={{ padding: '6px 10px', color: '#c6ced8' }}>{row.name}</td>
                      <td style={{ padding: '6px 10px', color: '#eef2f6', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                        {typeof row.value === 'number' ? row.value.toFixed(6) : row.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Derived quantities table */}
            <div>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>Derived quantities</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(200,220,240,0.07)' }}>
                    {['Symbol', 'Quantity', 'Value'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#9aa5b1', fontWeight: 600, fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mi.derived.map(row => (
                    <tr key={row.symbol}
                      style={{ borderBottom: '1px solid rgba(200,220,240,0.04)', cursor: 'help' }}
                      {...onTip(derivedTipKey(row.symbol, mi.model_type === 'linear_ou'))}
                    >
                      <td style={{ padding: '6px 10px', fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#b49fdb', fontWeight: 600, fontSize: 14 }}>{row.symbol}</td>
                      <td style={{ padding: '6px 10px', color: '#c6ced8' }}>
                        {row.name}
                        {row.note && <div style={{ fontSize: 10, color: '#8995a2', marginTop: 1 }}>{row.note}</div>}
                      </td>
                      <td style={{ padding: '6px 10px', color: '#eef2f6', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                        {typeof row.value === 'number' ? row.value.toFixed(4) : row.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Estimation method */}
          <div style={{ marginTop: 16, padding: '12px 14px', background: 'rgba(200,220,240,0.03)', borderRadius: 6 }}>
            <div style={{ ...sectionLabel, marginBottom: 4 }}>Estimation method</div>
            <div style={{ fontSize: 13, color: '#e4eaf1', fontWeight: 600, marginBottom: 4 }}>{mi.estimation_method}</div>
            <div style={{ fontSize: 12, color: '#9aa5b1', lineHeight: 1.5 }}>{mi.estimation_detail}</div>
          </div>

          {/* Constraint note */}
          {mi.constraint_note && (
            <div style={{
              marginTop: 12, padding: '10px 14px', borderRadius: 6,
              borderLeft: `3px solid ${constraintOk ? POS : '#d6ad66'}`,
              background: constraintOk ? 'rgba(88,173,142,0.05)' : 'rgba(214,173,102,0.05)',
            }}>
              <div style={{ fontSize: 12, color: constraintOk ? POS : '#d6ad66', lineHeight: 1.5 }}>
                {mi.constraint_note}
              </div>
            </div>
          )}
        </div>
      )}

      {/* OU parameter cards */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[
          { key: 'mu',       node: <StatCard label="Long-run mean (μ)" value={fmt(ou.mu)} /> },
          { key: 'k',        node: <StatCard label="Speed of rev. (κ)" value={fmt(ou.k, 3)} sub="annualised" /> },
          { key: 'sigma',    node: <StatCard label="Volatility (σ)" value={fmt(ou.sigma, 3)} sub="annualised" /> },
          { key: 'half_life',node: <StatCard label="Half-life" value={`${Math.round(ou.half_life_days)}d`} sub="business days" /> },
          { key: 'stat_std', node: <StatCard label="Stat. std (σ∞)" value={fmt(ou.stationary_std)} /> },
          { key: 'zscore',   node: <StatCard label="Z-score" value={fmt(ou.current_zscore)} sub={`current ${fmt(ou.current)}`} color={zColor} /> },
        ].map(({ key, node }) => (
          <div key={key} style={{ cursor: 'help' }} {...onTip(key)}>{node}</div>
        ))}
      </div>

      {/* ── Drift scatter (Figure 8 equivalent) ── */}
      {(() => {
        const ds = result.drift_scatter
        const pts = ds.points
        const devVals = pts.map(p => p.dev)
        const xMin = Math.min(...devVals)
        const xMax = Math.max(...devVals)
        const regLine = [
          { dev: xMin, dx: ds.intercept + ds.slope * xMin },
          { dev: xMax, dx: ds.intercept + ds.slope * xMax },
        ]
        const theoLine = [
          { dev: xMin, dx: ds.theoretical_slope * xMin },
          { dev: xMax, dx: ds.theoretical_slope * xMax },
        ]
        const slopeRatio = ds.slope / ds.theoretical_slope

        return (
          <div className="hub-frame" style={cardStyle}>
            <div style={sectionLabel}>Daily change vs deviation from mean — cf. H&S Figure 8</div>
            <div style={{ fontSize: 12, color: '#c6ced8', marginBottom: 14, lineHeight: 1.6 }}>
              Each dot is one day: x-axis = x<sub>t</sub> − μ, y-axis = Δx<sub>t</sub> = x<sub>t+1</sub> − x<sub>t</sub>.
              A negative slope confirms mean reversion. Under OU the slope equals −κ·Δt.
            </div>

            {/* Summary stats */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              <StatCard
                label="OLS slope"
                value={ds.slope.toFixed(5)}
                sub="Δx regressed on (x − μ)"
                color={ds.slope < 0 ? POS : NEG}
              />
              <StatCard
                label="Theoretical slope"
                value={ds.theoretical_slope.toFixed(5)}
                sub="−κ · Δt = −κ/252"
              />
              <StatCard
                label="Ratio actual / theory"
                value={isFinite(slopeRatio) ? slopeRatio.toFixed(2) : '—'}
                sub="1.0 = perfect OU"
                color={Math.abs(slopeRatio - 1) < 0.3 ? POS : '#d6ad66'}
              />
              <StatCard
                label="R²"
                value={(ds.r2 * 100).toFixed(2) + '%'}
                sub="variance explained by drift"
              />
            </div>

            <ResponsiveContainer width="100%" height={360}>
              <ScatterChart margin={{ top: 8, right: 24, bottom: 48, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.08)" />
                <XAxis
                  type="number" dataKey="dev"
                  tick={{ fill: '#c6ced8', fontSize: 12 }} axisLine={false} tickLine={false}
                  tickFormatter={v => fmt(v, 4)} domain={['auto', 'auto']}
                  label={{ value: 'xₜ − μ  (deviation from long-run mean)', position: 'insideBottom', offset: -30, fill: '#c6ced8', fontSize: 12 }}
                />
                <YAxis
                  type="number" dataKey="dx"
                  tick={{ fill: '#c6ced8', fontSize: 12 }} axisLine={false} tickLine={false}
                  tickFormatter={v => fmt(v, 4)} width={76}
                  label={{ value: 'Δxₜ  (next-day change)', angle: -90, position: 'insideLeft', offset: 14, fill: '#c6ced8', fontSize: 12 }}
                />
                <ZAxis range={[12, 12]} />
                <Tooltip
                  contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
                  itemStyle={{ color: '#e4eaf1' }}
                  formatter={(v: number, name: string) => [fmt(v, 5), name === 'dev' ? 'xₜ − μ' : 'Δxₜ']}
                />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.3)" strokeWidth={1} />
                <ReferenceLine x={0} stroke="rgba(200,220,240,0.3)" strokeWidth={1} />
                {/* Raw observations */}
                <Scatter data={pts} fill={ACCENT} opacity={0.55} />
                {/* OLS regression line */}
                <Scatter
                  data={regLine}
                  line={{ stroke: NEG, strokeWidth: 2.5 }}
                  shape={(props: { cx?: number; cy?: number }) => <circle cx={props.cx} cy={props.cy} r={0} fill="none" />}
                  legendType="none"
                />
                {/* Theoretical OU line (−κ·Δt slope, through origin) */}
                <Scatter
                  data={theoLine}
                  line={{ stroke: ACCENT, strokeWidth: 2, strokeDasharray: '6 3' }}
                  shape={(props: { cx?: number; cy?: number }) => <circle cx={props.cx} cy={props.cy} r={0} fill="none" />}
                  legendType="none"
                />
              </ScatterChart>
            </ResponsiveContainer>

            <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 12, color: '#c6ced8', flexWrap: 'wrap' }}>
              <span><span style={{ color: NEG, fontWeight: 600 }}>——</span>&nbsp; OLS regression line</span>
              <span><span style={{ color: ACCENT, fontWeight: 600 }}>- - -</span>&nbsp; Theoretical OU slope (−κ·Δt)</span>
              <span>OLS intercept: <span style={{ color: '#e4eaf1' }}>{ds.intercept.toFixed(5)}</span></span>
            </div>
          </div>
        )
      })()}

      {/* Time series chart */}
      <div className="hub-frame" style={cardStyle}>
        <div style={sectionLabel}>Series — {result.expression}</div>
        <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 10 }}>
          Shaded region = estimation window used for SDE fit.
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="date" ticks={ticks} tick={TICK_STYLE} axisLine={false} tickLine={false} />
            <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={55}
              tickFormatter={v => fmt(v)} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: '#c6ced8' }}
              itemStyle={{ color: ACCENT }}
              formatter={(v: number) => [fmt(v, 4), 'Value']}
            />
            {/* Fit window shading */}
            <ReferenceArea
              x1={result.fit_start} x2={result.fit_end}
              fill={ACCENT_DIM} fillOpacity={1}
              stroke={ACCENT_BORDER} strokeWidth={1}
            />
            <ReferenceLine y={ou.mu} stroke={ACCENT} strokeDasharray="6 3" strokeWidth={1.5}
              label={{ value: `μ = ${fmt(ou.mu)}`, position: 'right', fill: ACCENT, fontSize: 11 }} />
            <Line type="monotone" dataKey="value" dot={false} stroke="#b49fdb" strokeWidth={1.5} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <SeriesTooltipOverlay tip={tip} />
    </div>
  )
}

function DiagnosticsTab({ result, token, expression, startDate, fitStart, fitEnd }: {
  result: AnalysisResult
  token: string | null
  expression: string
  startDate: string
  fitStart: string
  fitEnd: string
}) {
  const [nBuckets, setNBuckets] = useState(20)
  const [stanton, setStanton] = useState<StantonBucket[]>(result.stanton)
  const [bucketLoading, setBucketLoading] = useState(false)
  const [simSde, setSimSde] = useState<string | null>(null)      // which SDE is selected
  const [simLoading, setSimLoading] = useState(false)

  const SDE_OPTIONS = [
    { key: 'linear_ou',          label: 'Linear OU',          sde: 'dx = κ(μ−x) dt + σ dW' },
    { key: 'polynomial',         label: 'Polynomial',         sde: 'dx = (a+bx+cx²+dx³) dt + σ dW' },
    { key: 'inverse_polynomial', label: 'Inverse Polynomial', sde: 'dx = (a/x+bx+cx²+dx³) dt + σ dW' },
  ]

  async function fetchStanton(n: number, withSim: string | null = null) {
    if (!token) return
    const isSim = !!withSim
    if (isSim) setSimLoading(true); else setBucketLoading(true)
    try {
      const res = await authFetch('/api/tools/mean-reversion/stanton', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          expression,
          start_date: startDate,
          fit_start: fitStart || undefined,
          fit_end: fitEnd || undefined,
          n_buckets: n,
          sim_sde: withSim ?? undefined,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setStanton(data)
      }
    } finally {
      if (isSim) setSimLoading(false); else setBucketLoading(false)
    }
  }

  if (!stanton.length) {
    return <div style={{ color: '#9aa5b1', padding: 24 }}>Insufficient data for diagnostic.</div>
  }

  const driftData = stanton.map(b => ({ x: b.midpoint, y: b.avg_change, n: b.n_obs }))
  const diffData  = stanton.map(b => ({ x: b.midpoint, y: b.std_change, n: b.n_obs }))

  const simDriftData = stanton
    .filter(b => b.sim_avg_change !== undefined)
    .map(b => ({ x: b.midpoint, y: b.sim_avg_change as number }))
  const simDiffData = stanton
    .filter(b => b.sim_std_change !== undefined)
    .map(b => ({ x: b.midpoint, y: b.sim_std_change as number }))

  function tightDomain(vals: number[], padFrac = 0.03): [number, number] {
    const mn = Math.min(...vals), mx = Math.max(...vals)
    const pad = (mx - mn) * padFrac || Math.abs(mn) * padFrac || 0.001
    return [mn - pad, mx + pad]
  }

  const xVals = driftData.map(d => d.x)
  const xDomain = tightDomain(xVals)

  const allDriftY = [...driftData.map(d => d.y), ...simDriftData.map(d => d.y)]
  const allDiffY  = [...diffData.map(d => d.y),  ...simDiffData.map(d => d.y)]
  const yDriftDom = tightDomain(allDriftY)
  const yDiffDom  = tightDomain(allDiffY)

  // Simple linearity check: is drift monotonically approximately decreasing?
  const avgChanges = stanton.map(b => b.avg_change)
  const firstHalf = avgChanges.slice(0, Math.floor(avgChanges.length / 2))
  const secondHalf = avgChanges.slice(Math.floor(avgChanges.length / 2))
  const firstMean = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
  const secondMean = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
  const linearOuAppropriate = firstMean > secondMean

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Controls row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        {/* Bucket selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#c6ced8' }}>Level buckets:</span>
          {[10, 15, 20, 30, 50].map(n => (
            <button key={n}
              onClick={() => { setNBuckets(n); fetchStanton(n, simSde) }}
              disabled={bucketLoading || simLoading}
              style={{
                padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${nBuckets === n ? ACCENT : 'rgba(200,220,240,0.1)'}`,
                background: nBuckets === n ? 'rgba(134,192,222,0.15)' : 'transparent',
                color: nBuckets === n ? ACCENT : '#c6ced8',
                opacity: (bucketLoading || simLoading) ? 0.5 : 1,
              }}>
              {n}
            </button>
          ))}
          {bucketLoading && <span style={{ fontSize: 11, color: '#9aa5b1' }}>updating…</span>}
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: 'rgba(200,220,240,0.1)' }} />

        {/* SDE selector + Run button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#c6ced8' }}>Simulate:</span>
          {SDE_OPTIONS.map(opt => (
            <button key={opt.key}
              onClick={() => setSimSde(simSde === opt.key ? null : opt.key)}
              disabled={simLoading}
              title={opt.sde}
              style={{
                padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${simSde === opt.key ? '#d6ad66' : 'rgba(200,220,240,0.1)'}`,
                background: simSde === opt.key ? 'rgba(214,173,102,0.15)' : 'transparent',
                color: simSde === opt.key ? '#d6ad66' : '#c6ced8',
                opacity: simLoading ? 0.5 : 1,
              }}>
              {opt.label}
            </button>
          ))}
          <button
            onClick={() => { if (simSde) fetchStanton(nBuckets, simSde) }}
            disabled={!simSde || simLoading}
            style={{
              padding: '3px 14px', borderRadius: 6, fontSize: 12, cursor: simSde ? 'pointer' : 'not-allowed',
              border: '1px solid rgba(214,173,102,0.5)',
              background: 'rgba(214,173,102,0.12)',
              color: simSde ? '#d6ad66' : '#9aa5b1',
              opacity: (!simSde || simLoading) ? 0.5 : 1,
              fontWeight: 500,
            }}>
            {simLoading ? 'Simulating…' : 'Run simulation'}
          </button>
          {simSde && !simLoading && stanton.some(b => b.sim_avg_change !== undefined) && (
            <button onClick={() => {
              setSimSde(null)
              fetchStanton(nBuckets, null)
            }}
              style={{
                padding: '3px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                border: '1px solid rgba(200,220,240,0.1)', background: 'transparent', color: '#9aa5b1',
              }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Interpretation banner */}
      <div style={{
        ...cardStyle,
        padding: '12px 18px',
        borderColor: linearOuAppropriate ? 'rgba(88,173,142,0.3)' : 'rgba(214,173,102,0.3)',
        background: linearOuAppropriate ? 'rgba(88,173,142,0.05)' : 'rgba(214,173,102,0.05)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 16 }}>{linearOuAppropriate ? '✓' : '⚠'}</span>
        <span style={{ fontSize: 13, color: linearOuAppropriate ? POS : '#d6ad66' }}>
          {linearOuAppropriate
            ? 'Drift diagnostic is downward-sloping — linear OU (constant-κ) appears appropriate.'
            : 'Drift diagnostic is not clearly downward-sloping — consider nonlinear drift or verify mean reversion.'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Drift coefficient */}
        <div className="hub-frame" style={cardStyle}>
          <div style={sectionLabel}>Drift diagnostic — f(x)</div>
          <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 8 }}>
            Average subsequent 1-day change by level bucket. Should slope downward for mean reversion.
          </div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 11 }}>
            <span><span style={{ color: ACCENT }}>●</span> Observed data</span>
            <span><span style={{ color: '#d6ad66' }}>●</span> Simulated SDE</span>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 36, left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" dataKey="x" name="Level" tick={TICK_STYLE}
                axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} domain={xDomain}
                label={{ value: 'Series level  x', position: 'insideBottom', offset: -20, fill: '#9aa5b1', fontSize: 11 }} />
              <YAxis type="number" dataKey="y" name="Avg Δ" tick={TICK_STYLE}
                axisLine={false} tickLine={false} tickFormatter={v => fmt(v, 4)} width={70} domain={yDriftDom}
                label={{ value: 'E[Δx | x]  (avg 1-day change)', angle: -90, position: 'insideLeft', offset: 10, fill: '#9aa5b1', fontSize: 11 }} />
              <ZAxis type="number" dataKey="n" range={[30, 120]} zAxisId="obs" />
              <ZAxis zAxisId="sim" range={[30, 30]} />
              <Tooltip
                contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
                formatter={(v: number, name: string) => [fmt(v, 5), name === 'x' ? 'Level' : name === 'y' ? 'Avg Δx' : 'Obs']}
              />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" strokeDasharray="4 2" />
              <Scatter data={driftData} fill={ACCENT} opacity={0.8} zAxisId="obs" name="Observed" />
              {simDriftData.length > 0 && (
                <Scatter data={simDriftData} fill="#d6ad66" opacity={0.9} zAxisId="sim" name="Simulated SDE"
                  line={{ stroke: '#d6ad66', strokeWidth: 2 }}
                  shape={(props: { cx?: number; cy?: number }) => <circle cx={props.cx} cy={props.cy} r={3} fill="#d6ad66" opacity={0.8} />}
                />
              )}
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        {/* Diffusion coefficient */}
        <div className="hub-frame" style={cardStyle}>
          <div style={sectionLabel}>Diffusion diagnostic — g(x)</div>
          <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 8 }}>
            Std of subsequent 1-day changes by level bucket. Flat = constant-σ OU appropriate.
          </div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 11 }}>
            <span><span style={{ color: '#b49fdb' }}>●</span> Observed data</span>
            <span><span style={{ color: '#d6ad66' }}>●</span> Simulated SDE</span>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 8, right: 16, bottom: 36, left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" dataKey="x" name="Level" tick={TICK_STYLE}
                axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} domain={xDomain}
                label={{ value: 'Series level  x', position: 'insideBottom', offset: -20, fill: '#9aa5b1', fontSize: 11 }} />
              <YAxis type="number" dataKey="y" name="Std Δ" tick={TICK_STYLE}
                axisLine={false} tickLine={false} tickFormatter={v => fmt(v, 4)} width={70} domain={yDiffDom}
                label={{ value: 'Std[Δx | x]  (1-day vol by level)', angle: -90, position: 'insideLeft', offset: 10, fill: '#9aa5b1', fontSize: 11 }} />
              <ZAxis type="number" dataKey="n" range={[30, 120]} zAxisId="obs" />
              <ZAxis zAxisId="sim" range={[30, 30]} />
              <Tooltip
                contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
                formatter={(v: number, name: string) => [fmt(v, 5), name === 'x' ? 'Level' : name === 'y' ? 'Std Δx' : 'Obs']}
              />
              <Scatter data={diffData} fill="#b49fdb" opacity={0.8} zAxisId="obs" name="Observed" />
              {simDiffData.length > 0 && (
                <Scatter data={simDiffData} fill="#d6ad66" opacity={0.9} zAxisId="sim" name="Simulated SDE"
                  line={{ stroke: '#d6ad66', strokeWidth: 2 }}
                  shape={(props: { cx?: number; cy?: number }) => <circle cx={props.cx} cy={props.cy} r={3} fill="#d6ad66" opacity={0.8} />}
                />
              )}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

function ForwardDistTab({ result, token, expression, startDate, fitStart, fitEnd }: {
  result: AnalysisResult
  token: string | null
  expression: string
  startDate: string
  fitStart: string
  fitEnd: string
}) {
  const { ou_params: ou } = result
  const [td, setTd] = useState(result.transition_densities)
  const [simSde, setSimSde] = useState<string | null>(null)
  const [simLoading, setSimLoading] = useState(false)
  const [simError, setSimError] = useState<string | null>(null)
  const [activeSpec, setActiveSpec] = useState<string>('linear_ou (analytical)')
  const [histDays, setHistDays] = useState(252)      // trading days of history to show
  const [fwdDays,  setFwdDays]  = useState(252)      // trading days of fan to show

  // Terminal distribution (Figs 2.13 / 2.14)
  const defaultTarget = (() => {
    const base = result.series.dates[result.series.dates.length - 1]
    const d = new Date(base + 'T12:00:00'); d.setDate(d.getDate() + 90)
    return d.toISOString().split('T')[0]
  })()
  const [histTarget,  setHistTarget]  = useState(defaultTarget)
  const [histData,    setHistData]    = useState<HistData | null>(null)
  const [histLoading, setHistLoading] = useState(false)
  const [histError,   setHistError]   = useState<string | null>(null)

  const SDE_OPTIONS = [
    { key: 'linear_ou',          label: 'Linear OU',          sde: 'dx = κ(μ−x) dt + σ dW' },
    { key: 'polynomial',         label: 'Polynomial',         sde: 'dx = (a+bx+cx²+dx³) dt + σ dW' },
    { key: 'inverse_polynomial', label: 'Inverse Polynomial', sde: 'dx = (a/x+bx+cx²+dx³) dt + σ dW' },
  ]

  async function runMC(sde: string) {
    if (!token) return
    setSimLoading(true)
    setSimError(null)
    try {
      const res = await authFetch('/api/tools/mean-reversion/forward-dist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          expression,
          start_date: startDate,
          fit_start: fitStart || undefined,
          fit_end: fitEnd || undefined,
          sim_sde: sde,
          n_sims: 10000,
        }),
      })
      if (res.ok) {
        setTd(await res.json())
        setActiveSpec(`${SDE_OPTIONS.find(o => o.key === sde)?.label} (MC, n=10 000)`)
      } else {
        const body = await res.json().catch(() => ({}))
        setSimError(`Simulation failed (${res.status}): ${body?.detail ?? 'unknown error'}`)
      }
    } catch (e) {
      setSimError(`Network error: ${String(e)}`)
    } finally {
      setSimLoading(false)
    }
  }

  function clearMC() {
    setTd(result.transition_densities)
    setSimSde(null)
    setSimError(null)
    setActiveSpec('linear_ou (analytical)')
  }

  async function runHist() {
    if (!token) return
    setHistLoading(true)
    setHistError(null)
    const sde = simSde ?? 'linear_ou'
    try {
      const res = await authFetch('/api/tools/mean-reversion/forward-hist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          expression,
          start_date: startDate,
          fit_start: fitStart || undefined,
          fit_end: fitEnd || undefined,
          sim_sde: sde,
          n_sims: 10000,
          target_date: histTarget,
        }),
      })
      if (res.ok) {
        setHistData(await res.json())
      } else {
        const body = await res.json().catch(() => ({}))
        setHistError(`Failed (${res.status}): ${body?.detail ?? 'unknown error'}`)
      }
    } catch (e) {
      setHistError(`Network error: ${String(e)}`)
    } finally {
      setHistLoading(false)
    }
  }

  // Format a date string for the x-axis: "9 Sep '26"
  function fmtDate(iso: string): string {
    const d = new Date(iso + 'T12:00:00')
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
  }

  const nowDate = result.series.dates[result.series.dates.length - 1]
  const lastValue = result.series.values[result.series.values.length - 1]

  // History slice (user-controlled window)
  const histDates  = result.series.dates.slice(-histDays)
  const histValues = result.series.values.slice(-histDays)
  const histPoints = histDates.map((d, i) => ({ label: fmtDate(d), historical: histValues[i] }))

  // Junction point — always anchored to last observed value, not ou.current
  // (ou.current may lag if the fit window ends before today)
  const junctionPoint = {
    label: fmtDate(nowDate),
    historical: lastValue,
    p5: lastValue, p25: lastValue, mean: lastValue, p75: lastValue, p95: lastValue,
  }

  // Forward fan (user-controlled horizon, daily points)
  const fanSlice = td.slice(0, fwdDays)
  const fanPoints = fanSlice.map(d => ({
    label: d.horizon_date ? fmtDate(d.horizon_date) : d.horizon_label,
    p5: d.p5, p25: d.p25, mean: d.mean, p75: d.p75, p95: d.p95,
  }))

  const chartData = [...histPoints, junctionPoint, ...fanPoints]

  // Probability table — only the 7 standard horizons
  const TABLE_HORIZONS = new Set([7, 14, 30, 60, 90, 180, 252])
  const probData = td.filter(d => TABLE_HORIZONS.has(d.horizon_days)).map(d => ({
    label: d.horizon_date ? fmtDate(d.horizon_date) : d.horizon_label,
    probAbove: (d.prob_above_current * 100).toFixed(1),
    probBelow: ((1 - d.prob_above_current) * 100).toFixed(1),
    mean: fmt(d.mean),
    std: fmt(d.std),
  }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* SDE selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#c6ced8' }}>Simulate:</span>
        {SDE_OPTIONS.map(opt => (
          <button key={opt.key}
            onClick={() => setSimSde(simSde === opt.key ? null : opt.key)}
            disabled={simLoading}
            title={opt.sde}
            style={{
              padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
              border: `1px solid ${simSde === opt.key ? '#d6ad66' : 'rgba(200,220,240,0.1)'}`,
              background: simSde === opt.key ? 'rgba(214,173,102,0.15)' : 'transparent',
              color: simSde === opt.key ? '#d6ad66' : '#c6ced8',
              opacity: simLoading ? 0.5 : 1,
            }}>
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => { if (simSde) runMC(simSde) }}
          disabled={!simSde || simLoading}
          style={{
            padding: '3px 14px', borderRadius: 6, fontSize: 12,
            cursor: simSde ? 'pointer' : 'not-allowed',
            border: '1px solid rgba(214,173,102,0.5)',
            background: 'rgba(214,173,102,0.12)',
            color: simSde ? '#d6ad66' : '#9aa5b1',
            opacity: (!simSde || simLoading) ? 0.5 : 1,
            fontWeight: 500,
          }}>
          {simLoading ? 'Simulating…' : 'Run simulation'}
        </button>
        {activeSpec !== 'linear_ou (analytical)' && !simLoading && (
          <button onClick={clearMC} style={{
            padding: '3px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
            border: '1px solid rgba(200,220,240,0.1)', background: 'transparent', color: '#9aa5b1',
          }}>Clear</button>
        )}
        <span style={{ fontSize: 11, color: '#8995a2', marginLeft: 4 }}>
          Active: <span style={{ color: '#c6ced8' }}>{activeSpec}</span>
        </span>
      </div>

      {simError && (
        <div style={{
          padding: '10px 16px', borderRadius: 6, fontSize: 12,
          background: 'rgba(217,112,94,0.08)', border: '1px solid rgba(217,112,94,0.3)',
          color: '#ecaa9c',
        }}>
          {simError}
        </div>
      )}

      {/* Chart window controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#9aa5b1', whiteSpace: 'nowrap' }}>History:</span>
          {([
            { label: '1M', days: 21 },
            { label: '3M', days: 63 },
            { label: '6M', days: 126 },
            { label: '1Y', days: 252 },
            { label: '2Y', days: 504 },
            { label: 'All', days: result.series.dates.length },
          ] as const).map(opt => (
            <button key={opt.label}
              onClick={() => setHistDays(opt.days)}
              style={{
                padding: '2px 9px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                border: `1px solid ${histDays === opt.days ? ACCENT_BORDER : 'rgba(200,220,240,0.08)'}`,
                background: histDays === opt.days ? ACCENT_DIM : 'transparent',
                color: histDays === opt.days ? ACCENT : '#9aa5b1',
              }}>
              {opt.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#9aa5b1', whiteSpace: 'nowrap' }}>Forward:</span>
          {([
            { label: '1M', days: 21 },
            { label: '3M', days: 63 },
            { label: '6M', days: 126 },
            { label: '1Y', days: 252 },
          ] as const).map(opt => (
            <button key={opt.label}
              onClick={() => setFwdDays(opt.days)}
              style={{
                padding: '2px 9px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                border: `1px solid ${fwdDays === opt.days ? '#f59e0b66' : 'rgba(200,220,240,0.08)'}`,
                background: fwdDays === opt.days ? 'rgba(214,173,102,0.1)' : 'transparent',
                color: fwdDays === opt.days ? '#d6ad66' : '#9aa5b1',
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="hub-frame" style={cardStyle}>
        <div style={sectionLabel}>Forward distribution fan chart</div>
        <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 12 }}>
          Lines show p5 / p25 / mean / p75 / p95.
          μ = {fmt(ou.mu)} shown as dashed reference.
        </div>
        <ResponsiveContainer width="100%" height={380}>
          <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 24, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={{ ...TICK_STYLE, fontSize: 10 }} axisLine={false} tickLine={false}
              interval={Math.max(0, Math.floor(chartData.length / 8) - 1)} angle={-30} textAnchor="end" />
            <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={55}
              tickFormatter={v => fmt(v)} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
              itemStyle={{ fontSize: 12 }}
              formatter={(v: number, name: string) => [fmt(v, 4), name]}
            />
            <ReferenceLine y={ou.mu} stroke={ACCENT} strokeDasharray="6 3" strokeWidth={1.5} label={{ value: 'μ', fill: ACCENT, fontSize: 11, position: 'right' }} />
            {/* Historical series */}
            <Line type="monotone" dataKey="historical" stroke="#b49fdb" dot={false} strokeWidth={1.5} connectNulls={false} name="historical" />
            {/* Forward fan */}
            <Line type="monotone" dataKey="p5"   stroke="rgba(106,118,132,0.45)" dot={false} strokeWidth={1} strokeDasharray="4 2" name="p5"  connectNulls={false} />
            <Line type="monotone" dataKey="p25"  stroke="rgba(134,192,222,0.5)"   dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="p25" connectNulls={false} />
            <Line type="monotone" dataKey="mean" stroke={ACCENT} dot={false} strokeWidth={2} name="mean" connectNulls={false} />
            <Line type="monotone" dataKey="p75"  stroke="rgba(134,192,222,0.5)"   dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="p75" connectNulls={false} />
            <Line type="monotone" dataKey="p95"  stroke="rgba(106,118,132,0.45)" dot={false} strokeWidth={1} strokeDasharray="4 2" name="p95"  connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Probability table */}
      <div className="hub-frame" style={cardStyle}>
        <div style={sectionLabel}>Conditional probabilities by horizon</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(200,220,240,0.07)' }}>
              {['Horizon', 'Mean', 'Std', 'P(above current)', 'P(below current)'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#9aa5b1', fontWeight: 600, fontSize: 11 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {probData.map(row => (
              <tr key={row.label} style={{ borderBottom: '1px solid rgba(200,220,240,0.04)' }}>
                <td style={{ padding: '8px 12px', color: ACCENT, fontWeight: 600 }}>{row.label}</td>
                <td style={{ padding: '8px 12px', color: '#eef2f6' }}>{row.mean}</td>
                <td style={{ padding: '8px 12px', color: '#c6ced8' }}>{row.std}</td>
                <td style={{ padding: '8px 12px', color: '#d6ad66' }}>{row.probAbove}%</td>
                <td style={{ padding: '8px 12px', color: '#9ea2e2' }}>{row.probBelow}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Terminal distribution (Figs 2.13 / 2.14) ── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={sectionLabel}>Terminal distribution at horizon</div>
        <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 14 }}>
          Histogram of simulated terminal values + non-parametric kernel densities at
          three bandwidths (0.5× / 1× / 2× Scott's rule) — cf. H&S Figures 2.13–2.14.
          Uses the currently active SDE spec.
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: '#c6ced8' }}>Target date:</span>
          <input
            type="date"
            value={histTarget}
            min={nowDate}
            onChange={e => setHistTarget(e.target.value)}
            style={{
              background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.12)',
              borderRadius: 6, color: '#eef2f6', fontSize: 12, padding: '4px 8px', cursor: 'pointer',
            }}
          />
          <span style={{ fontSize: 11, color: '#8995a2' }}>
            SDE: <span style={{ color: '#c6ced8' }}>{simSde ? SDE_OPTIONS.find(o => o.key === simSde)?.label : 'Linear OU'}</span>
          </span>
          <button
            onClick={runHist}
            disabled={histLoading}
            style={{
              padding: '4px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500,
              cursor: histLoading ? 'not-allowed' : 'pointer',
              border: '1px solid rgba(111,192,203,0.4)',
              background: 'rgba(111,192,203,0.1)', color: histLoading ? '#9aa5b1' : ACCENT,
              opacity: histLoading ? 0.6 : 1,
            }}>
            {histLoading ? 'Computing…' : 'Compute'}
          </button>
        </div>

        {histError && (
          <div style={{
            padding: '8px 14px', borderRadius: 6, fontSize: 12, marginBottom: 12,
            background: 'rgba(217,112,94,0.08)', border: '1px solid rgba(217,112,94,0.3)', color: '#ecaa9c',
          }}>
            {histError}
          </div>
        )}

        {histData && (
          <>
            {/* Stat strip */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              {[
                { label: 'Mean',  val: fmt(histData.stats.mean)  },
                { label: 'Std',   val: fmt(histData.stats.std)   },
                { label: 'p5',    val: fmt(histData.stats.p5)    },
                { label: 'p25',   val: fmt(histData.stats.p25)   },
                { label: 'p75',   val: fmt(histData.stats.p75)   },
                { label: 'p95',   val: fmt(histData.stats.p95)   },
                { label: 'Scott h', val: fmt(histData.bw_scott, 4) },
              ].map(s => (
                <div key={s.label} style={{ ...cardStyle, padding: '8px 14px', minWidth: 80 }}>
                  <div style={{ fontSize: 10, color: '#9aa5b1', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{s.label}</div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#eef2f6' }}>{s.val}</div>
                </div>
              ))}
            </div>

            {/* Chart */}
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={histData.data} margin={{ top: 8, right: 24, bottom: 28, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                <XAxis
                  dataKey="x" type="number" scale="linear"
                  domain={[histData.data[0].x, histData.data[histData.data.length - 1].x]}
                  tickFormatter={v => fmt(v)} tick={{ ...TICK_STYLE, fontSize: 10 }}
                  tickCount={8} axisLine={false} tickLine={false}
                  label={{ value: 'Level', position: 'insideBottomRight', offset: -8, fill: '#9aa5b1', fontSize: 11 }}
                />
                <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={52}
                  tickFormatter={v => v.toFixed(2)} />
                <Tooltip
                  contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 11 }}
                  formatter={(v: number, name: string) => [v.toFixed(4), name]}
                  labelFormatter={v => `x = ${fmt(Number(v), 4)}`}
                />
                {/* Histogram (step-function area) */}
                <Area type="linear" dataKey="hist"
                  fill="rgba(106,118,132,0.2)" stroke="rgba(106,118,132,0.45)" strokeWidth={0.5}
                  name="Histogram" dot={false} isAnimationActive={false} />
                {/* KDE curves */}
                <Line type="monotone" dataKey="narrow" stroke="#6aa9cc" dot={false} strokeWidth={1.5}
                  name="KDE (0.5× Scott)" isAnimationActive={false} />
                <Line type="monotone" dataKey="medium" stroke={ACCENT} dot={false} strokeWidth={2}
                  name="KDE (Scott's rule)" isAnimationActive={false} />
                <Line type="monotone" dataKey="wide" stroke="#b49fdb" dot={false} strokeWidth={1.5}
                  name="KDE (2× Scott)" isAnimationActive={false} />
                {/* Current level */}
                <ReferenceLine x={histData.x_now} stroke={POS} strokeDasharray="5 3" strokeWidth={1.5}
                  label={{ value: 'now', fill: POS, fontSize: 10, position: 'top' }} />
                {/* Mean of terminal distribution */}
                <ReferenceLine x={histData.stats.mean} stroke={ACCENT} strokeDasharray="5 3" strokeWidth={1.5}
                  label={{ value: 'E[X]', fill: ACCENT, fontSize: 10, position: 'top' }} />
              </ComposedChart>
            </ResponsiveContainer>

            {/* Bandwidth legend */}
            <div style={{ display: 'flex', gap: 20, marginTop: 10, flexWrap: 'wrap' }}>
              {[
                { color: 'rgba(106,118,132,0.6)', label: 'Histogram' },
                { color: '#6aa9cc',  label: 'KDE — narrow  (h = 0.5×Scott)' },
                { color: ACCENT,     label: "KDE — medium  (h = Scott's rule)" },
                { color: '#b49fdb',  label: 'KDE — wide    (h = 2×Scott)' },
              ].map(e => (
                <div key={e.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#c6ced8' }}>
                  <div style={{ width: 20, height: 2, background: e.color, borderRadius: 1 }} />
                  {e.label}
                </div>
              ))}
            </div>
          </>
        )}

        {!histData && !histLoading && (
          <div style={{ fontSize: 12, color: '#8995a2', textAlign: 'center', padding: '24px 0' }}>
            Select a target date and click <span style={{ color: ACCENT }}>Compute</span> to generate the terminal distribution.
          </div>
        )}
      </div>
    </div>
  )
}

function SharpeTab({ result, token, expression, startDate, fitStart, fitEnd }: {
  result: AnalysisResult
  token: string | null
  expression: string
  startDate: string
  fitStart: string
  fitEnd: string
}) {
  const { sharpe_profile, ou_params: ou } = result

  const [mcSde,     setMcSde]     = useState<string | null>(null)
  const [mcData,    setMcData]    = useState<SharpePoint[] | null>(null)
  const [mcLoading, setMcLoading] = useState(false)
  const [mcError,   setMcError]   = useState<string | null>(null)

  const SDE_OPTIONS = [
    { key: 'linear_ou',          label: 'Linear OU'          },
    { key: 'polynomial',         label: 'Polynomial'         },
    { key: 'inverse_polynomial', label: 'Inv. Polynomial'    },
  ]

  async function runMcSharpe(sde: string) {
    if (!token) return
    setMcLoading(true); setMcError(null)
    try {
      const res = await authFetch('/api/tools/mean-reversion/sharpe-mc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          expression, start_date: startDate,
          fit_start: fitStart || undefined, fit_end: fitEnd || undefined,
          sim_sde: sde, n_sims: 10000,
        }),
      })
      if (res.ok) { setMcData(await res.json()) }
      else {
        const b = await res.json().catch(() => ({}))
        setMcError(`Failed (${res.status}): ${b?.detail ?? 'unknown error'}`)
      }
    } catch (e) { setMcError(`Network error: ${String(e)}`) }
    finally { setMcLoading(false) }
  }

  // Find peak SR (analytical)
  const peak = sharpe_profile.reduce((a, b) => b.annualised_sharpe > a.annualised_sharpe ? b : a, sharpe_profile[0])

  // 90% convergence time: ln(10)/κ × 252
  const conv90d = Math.round(Math.log(10) / ou.k * 252)

  // Merge analytical + MC onto same x-grid keyed by horizon_days
  const mcByDay = new Map((mcData ?? []).map(p => [p.horizon_days, p.annualised_sharpe]))
  const displayData = sharpe_profile.map(p => ({
    days: p.horizon_days,
    sr:   parseFloat(p.annualised_sharpe.toFixed(3)),
    srMc: mcByDay.has(p.horizon_days) ? parseFloat((mcByDay.get(p.horizon_days)!).toFixed(3)) : undefined,
  }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Stat cards ── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatCard label="Peak SR (analytical)" value={fmt(peak.annualised_sharpe)} sub={`at ${peak.horizon_days}d horizon`} color={POS} />
        <StatCard label="Current z-score" value={fmt(ou.current_zscore)} sub="entry signal" color={Math.abs(ou.current_zscore) > 2 ? POS : '#c6ced8'} />
        <StatCard label="Half-life" value={`${Math.round(ou.half_life_days)}d`} sub="50% of gap closed" />
        <StatCard label="90% conv. time" value={`${conv90d}d`} sub="90% of gap closed" />
      </div>

      {/* ── Interpretation ── */}
      <div className="hub-frame" style={{ ...cardStyle, fontSize: 12, color: '#c6ced8', lineHeight: 1.65 }}>
        <div style={sectionLabel}>How to read this chart</div>
        <p style={{ margin: '0 0 8px' }}>
          <strong style={{ color: '#eef2f6' }}>What SR(τ) measures.</strong>{' '}
          For a convergence trade entered today at z-score {fmt(ou.current_zscore, 2)},
          SR(τ) is the <em>annualised</em> Sharpe ratio if you hold for exactly τ business days
          and exit — regardless of whether the series has reached μ. It is computed as
          |E[x<sub>τ</sub>−x<sub>0</sub>]| / Std[x<sub>τ</sub>−x<sub>0</sub>] × √(252/τ),
          always measured in the direction of expected reversion so SR ≥ 0.
        </p>
        <p style={{ margin: '0 0 8px' }}>
          <strong style={{ color: '#eef2f6' }}>Why SR peaks at the shortest horizon.</strong>{' '}
          At very short horizons the numerator (expected return) grows like κτ while the denominator
          (conditional std) grows like σ√τ. Since σ√τ grows faster, the raw ratio |E|/Std ~ √τ and
          annualising by √(252/τ) reverses this, producing a near-flat plateau of duration
          ≈ 252/κ ≈ {Math.round(252/ou.k)}d. After that, the expected return saturates while
          risk keeps growing, so SR declines as ~1/√τ.
        </p>
        <p style={{ margin: '0 0 8px' }}>
          <strong style={{ color: '#eef2f6' }}>Practical implication (H&S Chapter 2).</strong>{' '}
          The optimal holding horizon in pure Sharpe terms is the shortest available. With a
          half-life of {Math.round(ou.half_life_days)}d you should capture most of the
          expected return within 1–2 half-lives. Holding longer adds noise faster than it adds
          expected return. The <em>90% convergence time</em> ({conv90d}d) marks when 90% of
          the current gap is expected to close under the deterministic drift.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: '#eef2f6' }}>Analytical vs MC.</strong>{' '}
          The cyan line uses the closed-form OU Gaussian transition density — exact for the
          linear model. For polynomial / inverse-polynomial SDEs, use the MC button below
          to simulate 10,000 paths and compute the empirical SR at each horizon (shown as the
          dashed amber line). Differences between the two reveal how much nonlinearity
          changes the risk–return profile.
        </p>
      </div>

      {/* ── MC controls ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#c6ced8' }}>MC Sharpe:</span>
        {SDE_OPTIONS.map(opt => (
          <button key={opt.key}
            onClick={() => setMcSde(mcSde === opt.key ? null : opt.key)}
            disabled={mcLoading}
            style={{
              padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
              border: `1px solid ${mcSde === opt.key ? '#d6ad66' : 'rgba(200,220,240,0.1)'}`,
              background: mcSde === opt.key ? 'rgba(214,173,102,0.15)' : 'transparent',
              color: mcSde === opt.key ? '#d6ad66' : '#c6ced8',
              opacity: mcLoading ? 0.5 : 1,
            }}>
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => { if (mcSde) runMcSharpe(mcSde) }}
          disabled={!mcSde || mcLoading}
          style={{
            padding: '3px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500,
            cursor: mcSde ? 'pointer' : 'not-allowed',
            border: '1px solid rgba(214,173,102,0.5)',
            background: 'rgba(214,173,102,0.12)',
            color: mcSde ? '#d6ad66' : '#9aa5b1',
            opacity: (!mcSde || mcLoading) ? 0.5 : 1,
          }}>
          {mcLoading ? 'Simulating…' : 'Run MC'}
        </button>
        {mcData && !mcLoading && (
          <button onClick={() => { setMcData(null); setMcSde(null) }} style={{
            padding: '3px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
            border: '1px solid rgba(200,220,240,0.1)', background: 'transparent', color: '#9aa5b1',
          }}>Clear</button>
        )}
      </div>

      {mcError && (
        <div style={{
          padding: '8px 14px', borderRadius: 6, fontSize: 12,
          background: 'rgba(217,112,94,0.08)', border: '1px solid rgba(217,112,94,0.3)', color: '#ecaa9c',
        }}>{mcError}</div>
      )}

      {/* ── Chart ── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={sectionLabel}>Annualised Sharpe ratio vs holding horizon</div>
        <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 12 }}>
          Cyan — analytical OU (closed-form).{mcData ? '  Amber dashed — MC simulation.' : ''}
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={displayData} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="days" tick={TICK_STYLE} axisLine={false} tickLine={false}
              label={{ value: 'Holding horizon (business days)', position: 'insideBottomRight', offset: -8, fill: '#9aa5b1', fontSize: 11 }} />
            <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={50}
              tickFormatter={v => fmt(v)} domain={[0, 'auto']} />
            <Tooltip
              contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
              formatter={(v: number, name: string) => [fmt(v, 3), name]}
              labelFormatter={v => `${v} business days`}
            />
            <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" />
            <ReferenceLine x={peak.horizon_days} stroke={POS} strokeDasharray="4 2"
              label={{ value: `Peak ${fmt(peak.annualised_sharpe)}`, position: 'top', fill: POS, fontSize: 11 }} />
            <Line type="monotone" dataKey="sr" stroke={ACCENT} dot={false} strokeWidth={2.5} name="Analytical OU" />
            {mcData && (
              <Line type="monotone" dataKey="srMc" stroke="#d6ad66" dot={false} strokeWidth={2}
                strokeDasharray="6 3" name="MC Sharpe" connectNulls />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function FPTTab({
  result,
  modelType,
  onModelChange,
  targetInput,
  stopInput,
  onTargetChange,
  onStopChange,
  onRerun,
  rerunLoading,
}: {
  result: AnalysisResult
  modelType: ModelType
  onModelChange: (m: ModelType) => void
  targetInput: string
  stopInput: string
  onTargetChange: (v: string) => void
  onStopChange: (v: string) => void
  onRerun: () => void
  rerunLoading: boolean
}) {
  const { fpt, suggested_target, suggested_stop, ou_params: ou } = result
  const toTarget = fpt.to_target
  const toStop   = fpt.to_stop

  const [binWidth, setBinWidth] = useState(5)

  const targetVal = parseFloat(targetInput) || suggested_target
  const stopVal   = parseFloat(stopInput)   || suggested_stop
  const goingDown = targetVal < ou.current

  // Rebin raw hitting times with the chosen bin width; returns step-function
  // histogram merged with the backend KDE onto a common integer-day grid.
  function buildChartData(stats: FptStats) {
    if (!stats.hit_days_raw?.length || !stats.kde?.length) return []

    // Density map: day → histogram density for its bin
    const densityByDay = new Map<number, number>()
    const maxDay = stats.kde[stats.kde.length - 1].days
    for (let lo = 0; lo < maxDay; lo += binWidth) {
      const hi = lo + binWidth
      const count = stats.hit_days_raw.filter(d => d >= lo && d < hi).length
      const density = count / (stats.total * binWidth)
      for (let d = lo; d < hi; d++) {
        densityByDay.set(d + 1, density)
      }
    }

    return stats.kde.map(k => ({
      days:    k.days,
      hist:    densityByDay.get(k.days) ?? 0,
      kde:     k.density,
    }))
  }

  function ProbTable({ stats, label, color }: { stats: FptStats; label: string; color: string }) {
    const rows = [
      { window: '5 days',  prob: stats.prob_5d },
      { window: '10 days', prob: stats.prob_10d },
      { window: '20 days', prob: stats.prob_20d },
      { window: '30 days', prob: stats.prob_30d },
      { window: '50 days', prob: stats.prob_50d },
    ]
    const chartData = buildChartData(stats)

    return (
      <div className="hub-frame" style={cardStyle}>
        <div style={{ ...sectionLabel, color }}>{label}</div>
        <div style={{ display: 'flex', gap: 20, marginBottom: 16, flexWrap: 'wrap' }}>
          <StatCard label="% ever hit" value={`${stats.pct_hit.toFixed(1)}%`} color={color} />
          {stats.mean_days != null && <StatCard label="Mean hitting time" value={`${Math.round(stats.mean_days)}d`} />}
          {stats.median_days != null && <StatCard label="Median hitting time" value={`${Math.round(stats.median_days)}d`} />}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(200,220,240,0.07)' }}>
              <th style={{ padding: '6px 12px', textAlign: 'left', color: '#9aa5b1', fontWeight: 600, fontSize: 11 }}>Window</th>
              <th style={{ padding: '6px 12px', textAlign: 'left', color: '#9aa5b1', fontWeight: 600, fontSize: 11 }}>Probability</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.window} style={{ borderBottom: '1px solid rgba(200,220,240,0.04)' }}>
                <td style={{ padding: '6px 12px', color: '#c6ced8' }}>{r.window}</td>
                <td style={{ padding: '6px 12px', color: r.prob > 50 ? POS : '#eef2f6', fontWeight: 600 }}>
                  {r.prob.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {chartData.length > 0 && (
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="days" tick={TICK_STYLE} axisLine={false} tickLine={false}
                tickFormatter={v => `${Math.round(v)}d`} tickCount={8} />
              <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={50}
                tickFormatter={v => v.toFixed(3)} />
              <Tooltip
                contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
                formatter={(v: number, name: string) => [v.toFixed(4), name]}
                labelFormatter={v => `${Math.round(Number(v))} business days`}
              />
              <Area type="stepAfter" dataKey="hist"
                fill={`${color}33`} stroke={`${color}88`} strokeWidth={0.5}
                name="Histogram" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="kde"
                stroke={color} strokeWidth={2} dot={false}
                name="KDE (Scott's rule)" isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Drift model selector */}
      <div className="hub-frame" style={{ ...cardStyle, padding: '14px 18px' }}>
        <div style={{ ...sectionLabel, marginBottom: 10 }}>Drift model</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {MODEL_OPTIONS.map(opt => (
            <button key={opt.id} onClick={() => onModelChange(opt.id)} style={{
              padding: '7px 18px', borderRadius: 6,
              border: modelType === opt.id ? `1px solid ${ACCENT_BORDER}` : '1px solid rgba(200,220,240,0.1)',
              background: modelType === opt.id ? ACCENT_DIM : 'rgba(200,220,240,0.03)',
              color: modelType === opt.id ? ACCENT : '#c6ced8',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
            }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {/* Controls */}
      <div className="hub-frame" style={{ ...cardStyle, display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {/* Current level box */}
        <div>
          <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 6 }}>CURRENT LEVEL</div>
          <div style={{
            background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.12)',
            borderRadius: 6, padding: '8px 12px', fontSize: 14, fontWeight: 600,
            color: '#eef2f6', fontFamily: "'Geist Mono', ui-monospace, monospace", width: 160, boxSizing: 'border-box',
          }}>
            {fmt(ou.current, 4)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 6 }}>
            TARGET LEVEL <span style={{ color: '#8995a2' }}>(default: ½ way to μ)</span>
          </div>
          <input
            type="number" value={targetInput}
            onChange={e => onTargetChange(e.target.value)}
            placeholder={fmt(suggested_target, 4)}
            style={{
              background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.12)',
              borderRadius: 6, padding: '8px 12px', color: '#eef2f6', fontSize: 14, width: 160,
            }}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 6 }}>
            STOP LEVEL <span style={{ color: '#8995a2' }}>(default: 2σ away)</span>
          </div>
          <input
            type="number" value={stopInput}
            onChange={e => onStopChange(e.target.value)}
            placeholder={fmt(suggested_stop, 4)}
            style={{
              background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.12)',
              borderRadius: 6, padding: '8px 12px', color: '#eef2f6', fontSize: 14, width: 160,
            }}
          />
        </div>
        <button
          onClick={onRerun} disabled={rerunLoading}
          style={{
            padding: '9px 20px', borderRadius: 6, border: `1px solid ${ACCENT_BORDER}`,
            background: ACCENT_DIM, color: ACCENT, fontSize: 13, fontWeight: 600,
            cursor: rerunLoading ? 'not-allowed' : 'pointer', opacity: rerunLoading ? 0.5 : 1,
          }}
        >
          {rerunLoading ? 'Running…' : 'Re-run FPT'}
        </button>
        <div style={{ fontSize: 12, color: '#9aa5b1' }}>
          Current: <b style={{ color: '#eef2f6' }}>{fmt(ou.current, 4)}</b>
          &nbsp;·&nbsp; μ: <b style={{ color: ACCENT }}>{fmt(ou.mu, 4)}</b>
          &nbsp;·&nbsp; Direction: <b style={{ color: goingDown ? NEG : POS }}>{goingDown ? '↓ sell' : '↑ buy'}</b>
        </div>
      </div>

      {/* Bin width selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: '#9aa5b1' }}>Histogram bin width:</span>
        {[1, 2, 5, 10, 20].map(w => (
          <button key={w}
            onClick={() => setBinWidth(w)}
            style={{
              padding: '2px 10px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
              border: `1px solid ${binWidth === w ? ACCENT_BORDER : 'rgba(200,220,240,0.08)'}`,
              background: binWidth === w ? ACCENT_DIM : 'transparent',
              color: binWidth === w ? ACCENT : '#9aa5b1',
            }}>
            {w}d
          </button>
        ))}
        <input
          type="number" min={1} max={30} value={binWidth}
          onChange={e => { const v = parseInt(e.target.value); if (v >= 1 && v <= 30) setBinWidth(v) }}
          style={{
            width: 52, background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.1)',
            borderRadius: 5, color: '#eef2f6', fontSize: 11, padding: '2px 6px', textAlign: 'center',
          }}
        />
        <span style={{ fontSize: 11, color: '#8995a2' }}>days &nbsp;·&nbsp; KDE: Scott's rule</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <ProbTable stats={toTarget} label={`To target (${fmt(targetVal, 4)})`} color={POS} />
        {toStop && <ProbTable stats={toStop} label={`To stop (${fmt(stopVal, 4)})`} color={NEG} />}
      </div>
    </div>
  )
}

// ─── Saved series ─────────────────────────────────────────────────────────────

interface SavedSeries {
  id: string
  name: string
  expression: string
  startDate: string
}

interface SavedTrade {
  id: string
  label: string
  expression: string
  modelType: string
  entryDate: string   // ISO date string (today)
  entryLevel: number
  target: number
  stopLoss: number
  direction: string   // 'LONG' | 'SHORT'
  mu: number
  halfLife: number
  rr: number
}

const LS_KEY       = 'mr_saved_series'
const LS_TRADES    = 'mr_saved_trades'

function loadSaved(): SavedSeries[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') } catch { return [] }
}
function persistSaved(list: SavedSeries[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list))
}
function loadTrades(): SavedTrade[] {
  try { return JSON.parse(localStorage.getItem(LS_TRADES) ?? '[]') } catch { return [] }
}
function persistTrades(list: SavedTrade[]) {
  localStorage.setItem(LS_TRADES, JSON.stringify(list))
}

// ─── Trade Builder tab ────────────────────────────────────────────────────────

function TradeBuilderTab({
  result,
  modelType,
  onModelChange,
  targetInput,
  stopInput,
  onTargetChange,
  onStopChange,
  onSaveTrade,
}: {
  result: AnalysisResult
  modelType: ModelType
  onModelChange: (m: ModelType) => void
  targetInput: string
  stopInput: string
  onTargetChange: (v: string) => void
  onStopChange: (v: string) => void
  onSaveTrade: (t: SavedTrade) => void
}) {
  // All hooks unconditionally before any return
  const [entryInput, setEntryInput] = useState(() => fmt(result.ou_params?.current ?? 0, 4))
  const [clickedPoint, setClickedPoint] = useState<{
    label: string; mean: number; p5: number; p25: number; p75: number; p95: number
  } | null>(null)
  const [histDays, setHistDays] = useState(252)
  const [fwdDays,  setFwdDays]  = useState(252)
  const [tradeLabelStr, setTradeLabelStr] = useState('')
  // Q&A section inputs
  const [q1Days,    setQ1Days]    = useState(10)
  const [q1StopStr, setQ1StopStr] = useState('')
  const [q2Days,    setQ2Days]    = useState(21)
  const [q2ProbStr, setQ2ProbStr] = useState('20')
  const [q3Days,    setQ3Days]    = useState(42)
  const [q3TgtStr,  setQ3TgtStr]  = useState('')

  // Reset entry when result changes (new model type run)
  useEffect(() => {
    if (result.ou_params?.current != null) setEntryInput(fmt(result.ou_params.current, 4))
    setClickedPoint(null)
  }, [result.expression, result.model_type])

  const { ou_params: ou, fpt, suggested_target, suggested_stop,
          sharpe_profile, transition_densities, model_info } = result

  const modelSelector = (
    <div className="hub-frame" style={{ ...cardStyle, padding: '14px 18px' }}>
      <div style={{ ...sectionLabel, marginBottom: 10 }}>Drift model</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {MODEL_OPTIONS.map(opt => (
          <button key={opt.id} onClick={() => onModelChange(opt.id)} style={{
            padding: '7px 18px', borderRadius: 6,
            border: modelType === opt.id ? `1px solid ${ACCENT_BORDER}` : '1px solid rgba(200,220,240,0.1)',
            background: modelType === opt.id ? ACCENT_DIM : 'rgba(200,220,240,0.03)',
            color: modelType === opt.id ? ACCENT : '#c6ced8',
            fontSize: 13, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
          }}>
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )

  if (!ou || !fpt?.to_target) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {modelSelector}
        <div style={{ padding: 40, color: '#8995a2', textAlign: 'center', fontSize: 13 }}>
          Run the analysis first — FPT data not yet available.
        </div>
      </div>
    )
  }

  const entryVal  = !isNaN(parseFloat(entryInput)) ? parseFloat(entryInput) : ou.current
  const targetVal = (targetInput && !isNaN(parseFloat(targetInput)))
    ? parseFloat(targetInput) : (suggested_target ?? ou.mu)
  const stopVal = (stopInput && !isNaN(parseFloat(stopInput)))
    ? parseFloat(stopInput) : (suggested_stop ?? ou.current - 2 * ou.stationary_std)

  const current   = ou.current
  const goingDown = targetVal < entryVal
  const dirLabel  = goingDown ? 'SELL / SHORT' : 'BUY / LONG'
  const dirColor  = goingDown ? NEG : POS

  const targetDist = Math.abs(targetVal - entryVal)
  const stopDist   = Math.abs(stopVal   - entryVal)
  const rr         = stopDist > 1e-8 ? targetDist / stopDist : 0

  const toTarget = fpt.to_target
  const toStop   = fpt.to_stop

  const peakSR = (sharpe_profile ?? []).length > 0
    ? (sharpe_profile ?? []).reduce((a, b) => a.annualised_sharpe > b.annualised_sharpe ? a : b)
    : null

  const probRows = [
    { window: '5d',  pt: toTarget.prob_5d,  ps: toStop?.prob_5d  ?? null },
    { window: '10d', pt: toTarget.prob_10d, ps: toStop?.prob_10d ?? null },
    { window: '20d', pt: toTarget.prob_20d, ps: toStop?.prob_20d ?? null },
    { window: '30d', pt: toTarget.prob_30d, ps: toStop?.prob_30d ?? null },
    { window: '50d', pt: toTarget.prob_50d, ps: toStop?.prob_50d ?? null },
  ]

  function fmtDate(iso: string): string {
    const d = new Date(iso + 'T12:00:00')
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
  }

  const td = transition_densities ?? []
  const seriesDates  = result.series?.dates  ?? []
  const seriesValues = result.series?.values ?? []
  const nowDate      = seriesDates[seriesDates.length - 1]
  const lastValue    = seriesValues[seriesValues.length - 1] ?? ou.current

  const histSlice  = seriesDates.slice(-histDays)
  const histPoints = histSlice.map((d, i) => ({
    label: fmtDate(d),
    historical: seriesValues[seriesValues.length - histDays + i],
  }))
  const junctionPoint = {
    label: nowDate ? fmtDate(nowDate) : '',
    historical: lastValue,
    p5: lastValue, p25: lastValue, mean: lastValue, p75: lastValue, p95: lastValue,
  }
  const fanPoints = td.slice(0, fwdDays).map(d => ({
    label: d.horizon_date ? fmtDate(d.horizon_date) : d.horizon_label,
    p5: d.p5, p25: d.p25, mean: d.mean, p75: d.p75, p95: d.p95,
  }))
  const chartData = [...histPoints, junctionPoint, ...fanPoints]

  const hasWarning = model_info?.constraint_note?.includes('⚠') ?? false

  const thStyle: React.CSSProperties = {
    padding: '6px 10px', fontSize: 11, fontWeight: 600, color: '#9aa5b1',
    borderBottom: '1px solid rgba(200,220,240,0.07)',
  }
  const tdStyle: React.CSSProperties = {
    padding: '6px 10px', fontSize: 12, borderBottom: '1px solid rgba(200,220,240,0.04)',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Model selector */}
      {modelSelector}

      {/* Controls */}
      <div className="hub-frame" style={{ ...cardStyle, display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {([
          { label: 'Entry level',  value: entryInput,  onChange: setEntryInput,
            hint: `current: ${fmt(ou.current, 4)}`, hintColor: '#c6ced8' },
          { label: 'Take profit',  value: targetInput, onChange: onTargetChange,
            hint: `default: ${fmt(suggested_target ?? ou.mu, 4)}`, hintColor: POS,
            placeholder: fmt(suggested_target ?? ou.mu, 4) },
          { label: 'Stop loss',    value: stopInput,   onChange: onStopChange,
            hint: `default: ${fmt(suggested_stop ?? ou.current - 2 * ou.stationary_std, 4)}`,
            hintColor: NEG,
            placeholder: fmt(suggested_stop ?? ou.current - 2 * ou.stationary_std, 4) },
        ] as { label: string; value: string; onChange: (v: string) => void;
                hint: string; hintColor: string; placeholder?: string }[])
          .map(({ label, value, onChange, hint, hintColor, placeholder }) => (
            <div key={label}>
              <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 6 }}>
                {label.toUpperCase()}
                <span style={{ marginLeft: 8, color: hintColor, fontSize: 10 }}>{hint}</span>
              </div>
              <input
                type="number" value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                style={{
                  background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.12)',
                  borderRadius: 6, padding: '8px 12px', color: '#eef2f6', fontSize: 14,
                  width: 160, fontFamily: "'Geist Mono', ui-monospace, monospace",
                }}
              />
            </div>
          ))}
        <div style={{ fontSize: 12, color: '#9aa5b1', alignSelf: 'center' }}>
          Direction: <b style={{ color: dirColor }}>{dirLabel}</b>
          &nbsp;·&nbsp; R:R: <b style={{ color: rr >= 1 ? POS : NEG }}>{fmt(rr, 2)} : 1</b>
        </div>
        {/* Save trade */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 6 }}>TRADE LABEL</div>
            <input
              type="text" value={tradeLabelStr} placeholder={result.expression}
              onChange={e => setTradeLabelStr(e.target.value)}
              style={{
                background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.12)',
                borderRadius: 6, padding: '8px 12px', color: '#eef2f6', fontSize: 13,
                width: 180,
              }}
            />
          </div>
          <button
            onClick={() => {
              const trade: SavedTrade = {
                id: Date.now().toString(),
                label: tradeLabelStr.trim() || result.expression,
                expression: result.expression,
                modelType,
                entryDate: new Date().toISOString().slice(0, 10),
                entryLevel: entryVal,
                target: targetVal,
                stopLoss: stopVal,
                direction: goingDown ? 'SHORT' : 'LONG',
                mu: ou.mu,
                halfLife: ou.half_life_days,
                rr,
              }
              onSaveTrade(trade)
              setTradeLabelStr('')
            }}
            style={{
              padding: '8px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600,
              cursor: 'pointer', border: `1px solid ${ACCENT_BORDER}`,
              background: ACCENT_DIM, color: ACCENT,
            }}
          >
            Save Trade
          </button>
        </div>
      </div>

      {hasWarning && (
        <div style={{ padding: '10px 16px', background: 'rgba(214,173,102,0.08)',
          border: '1px solid rgba(214,173,102,0.25)', borderRadius: 6, fontSize: 12, color: '#dfbb78' }}>
          ⚠ {model_info.constraint_note}
        </div>
      )}

      {/* Signal strip */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatCard label="Current" value={fmt(current, 4)}
          sub={`z = ${ou.current_zscore >= 0 ? '+' : ''}${fmt(ou.current_zscore, 2)}σ`}
          color={Math.abs(ou.current_zscore) >= 2 ? dirColor : '#eef2f6'} />
        <StatCard label="Direction" value={dirLabel} color={dirColor} />
        <StatCard label="Take Profit" value={fmt(targetVal, 4)}
          sub={`${fmt(targetDist, 4)} pts away`} color={POS} />
        <StatCard label="Stop Loss" value={fmt(stopVal, 4)}
          sub={`${fmt(stopDist, 4)} pts away`} color={NEG} />
        <StatCard label="R : R" value={`${fmt(rr, 2)} : 1`}
          color={rr >= 1.5 ? POS : rr >= 1 ? '#dfbb78' : NEG} />
        <StatCard label="Half-life" value={`${Math.round(ou.half_life_days)}d`} />
        {peakSR && (
          <StatCard label="Peak Sharpe" value={fmt(peakSR.annualised_sharpe, 2)}
            sub={`at ${peakSR.horizon_days}d`}
            color={peakSR.annualised_sharpe >= 1 ? POS : '#dfbb78'} />
        )}
        <StatCard label="% Hit Target" value={`${fmt(toTarget.pct_hit, 1)}%`}
          color={toTarget.pct_hit >= 70 ? POS : toTarget.pct_hit >= 50 ? '#dfbb78' : NEG} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Levels */}
        <div className="hub-frame" style={cardStyle}>
          <div style={sectionLabel}>Levels</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              { label: 'μ (long-run mean)', val: ou.mu,     color: ACCENT },
              { label: 'Take profit (TP)',  val: targetVal, color: POS },
              { label: 'Entry',             val: entryVal,  color: '#eef2f6', highlight: true },
              { label: 'Stop loss (SL)',     val: stopVal,   color: NEG },
            ] as { label: string; val: number; color: string; highlight?: boolean }[])
              .sort((a, b) => b.val - a.val)
              .map(({ label, val, color, highlight }) => (
                <div key={label} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', borderRadius: 6,
                  background: highlight ? 'rgba(200,220,240,0.06)' : 'rgba(200,220,240,0.02)',
                  border: `1px solid ${highlight ? 'rgba(200,220,240,0.14)' : 'rgba(200,220,240,0.05)'}`,
                }}>
                  <span style={{ fontSize: 12, color: '#c6ced8' }}>{label}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                    {fmt(val, 4)}
                  </span>
                </div>
              ))}
            <div style={{ marginTop: 4, fontSize: 11, color: '#8995a2', padding: '0 4px' }}>
              TP distance: <b style={{ color: POS }}>{fmt(targetDist, 4)}</b>
              &nbsp;·&nbsp; SL distance: <b style={{ color: NEG }}>{fmt(stopDist, 4)}</b>
              &nbsp;·&nbsp; R:R: <b style={{ color: rr >= 1 ? POS : NEG }}>{fmt(rr, 2)}</b>
              &nbsp;·&nbsp; μ gap from entry: <b style={{ color: ACCENT }}>{fmt(Math.abs(ou.mu - entryVal), 4)}</b>
            </div>
          </div>
        </div>

        {/* Hitting probabilities */}
        <div className="hub-frame" style={cardStyle}>
          <div style={sectionLabel}>Hitting Probabilities</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, textAlign: 'left' }}>Window</th>
                <th style={{ ...thStyle, textAlign: 'right', color: POS }}>P(TP)</th>
                {toStop && <th style={{ ...thStyle, textAlign: 'right', color: NEG }}>P(SL)</th>}
                {toStop && <th style={{ ...thStyle, textAlign: 'right' }}>E[P&L]</th>}
                {toTarget.mean_days != null &&
                  <th style={{ ...thStyle, textAlign: 'right' }}>Median hit</th>}
              </tr>
            </thead>
            <tbody>
              {probRows.map(r => {
                const ev = toStop && r.ps !== null
                  ? (r.pt / 100) * targetDist - (r.ps / 100) * stopDist
                  : null
                return (
                  <tr key={r.window}>
                    <td style={{ ...tdStyle, color: '#c6ced8' }}>{r.window}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: "'Geist Mono', ui-monospace, monospace",
                      color: r.pt > 50 ? POS : '#eef2f6', fontWeight: 600 }}>
                      {fmt(r.pt, 1)}%
                    </td>
                    {toStop && (
                      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: "'Geist Mono', ui-monospace, monospace",
                        color: r.ps !== null && r.ps > 20 ? NEG : '#c6ced8', fontWeight: 600 }}>
                        {r.ps !== null ? `${fmt(r.ps, 1)}%` : '—'}
                      </td>
                    )}
                    {toStop && (
                      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: "'Geist Mono', ui-monospace, monospace",
                        color: ev !== null ? (ev > 0 ? POS : NEG) : '#9aa5b1', fontWeight: 600 }}>
                        {ev !== null ? `${ev > 0 ? '+' : ''}${fmt(ev, 3)}` : '—'}
                      </td>
                    )}
                    {toTarget.mean_days != null && (
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#9aa5b1' }}>
                        {r.window === '50d' ? `${Math.round(toTarget.median_days ?? 0)}d` : ''}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 11, color: '#8995a2' }}>
            E[P&L] = P(TP) × TP dist − P(SL) × SL dist · Median hit: <b style={{ color: '#c6ced8' }}>
              {toTarget.median_days != null ? `${Math.round(toTarget.median_days)}d` : '—'}
            </b>
          </div>
        </div>
      </div>

      {/* Forward distribution */}
      <div className="hub-frame" style={cardStyle}>
        <div style={sectionLabel}>Forward Path — OU Transition Density</div>
        <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 10 }}>
          Lines show p5 / p25 / mean / p75 / p95. μ = {fmt(ou.mu)} shown as dashed reference.
        </div>
        {/* Window controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#9aa5b1', whiteSpace: 'nowrap' }}>History:</span>
            {([
              { label: '1M', days: 21 },
              { label: '3M', days: 63 },
              { label: '6M', days: 126 },
              { label: '1Y', days: 252 },
              { label: '2Y', days: 504 },
              { label: 'All', days: seriesDates.length },
            ] as const).map(opt => (
              <button key={opt.label} onClick={() => setHistDays(opt.days)} style={{
                padding: '2px 9px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                border: `1px solid ${histDays === opt.days ? ACCENT_BORDER : 'rgba(200,220,240,0.08)'}`,
                background: histDays === opt.days ? ACCENT_DIM : 'transparent',
                color: histDays === opt.days ? ACCENT : '#9aa5b1',
              }}>{opt.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#9aa5b1', whiteSpace: 'nowrap' }}>Forward:</span>
            {([
              { label: '1M', days: 21 },
              { label: '3M', days: 63 },
              { label: '6M', days: 126 },
              { label: '1Y', days: 252 },
            ] as const).map(opt => (
              <button key={opt.label} onClick={() => setFwdDays(opt.days)} style={{
                padding: '2px 9px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                border: `1px solid ${fwdDays === opt.days ? '#f59e0b66' : 'rgba(200,220,240,0.08)'}`,
                background: fwdDays === opt.days ? 'rgba(214,173,102,0.1)' : 'transparent',
                color: fwdDays === opt.days ? '#d6ad66' : '#9aa5b1',
              }}>{opt.label}</button>
            ))}
          </div>
        </div>
        <div style={{ cursor: 'crosshair' }}>
        <ResponsiveContainer width="100%" height={380}>
          <LineChart data={chartData} margin={{ top: 8, right: 24, bottom: 24, left: 8 }}
            onClick={(ev) => {
              const pt = ev?.activePayload?.[0]?.payload
              if (pt?.mean != null && pt?.p5 != null) setClickedPoint(pt)
            }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={{ ...TICK_STYLE, fontSize: 10 }} axisLine={false} tickLine={false}
              interval={Math.max(0, Math.floor(chartData.length / 8) - 1)} angle={-30} textAnchor="end" />
            <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={55}
              tickFormatter={v => fmt(v)} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
              itemStyle={{ fontSize: 12 }}
              formatter={(v: number, name: string) => [fmt(v, 4), name]}
            />
            <ReferenceLine y={ou.mu} stroke={ACCENT} strokeDasharray="6 3" strokeWidth={1.5}
              label={{ value: 'μ', fill: ACCENT, fontSize: 11, position: 'right' }} />
            <ReferenceLine y={targetVal} stroke={POS} strokeDasharray="5 3" strokeWidth={1.5}
              label={{ value: `TP  ${fmt(targetVal, 4)}`, position: 'right', fill: POS, fontSize: 10 }} />
            <ReferenceLine y={stopVal} stroke={NEG} strokeDasharray="5 3" strokeWidth={1.5}
              label={{ value: `SL  ${fmt(stopVal, 4)}`, position: 'right', fill: NEG, fontSize: 10 }} />
            <ReferenceLine y={entryVal} stroke="rgba(200,220,240,0.25)" strokeDasharray="3 3"
              label={{ value: 'entry', position: 'right', fill: '#9aa5b1', fontSize: 10 }} />
            <Line type="monotone" dataKey="historical" stroke="#b49fdb" dot={false} strokeWidth={1.5} connectNulls={false} name="historical" />
            <Line type="monotone" dataKey="p5"   stroke="rgba(106,118,132,0.45)" dot={false} strokeWidth={1}   strokeDasharray="4 2" name="p5"   connectNulls={false} />
            <Line type="monotone" dataKey="p25"  stroke="rgba(134,192,222,0.5)"   dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="p25"  connectNulls={false} />
            <Line type="monotone" dataKey="mean" stroke={ACCENT} dot={false} strokeWidth={2} name="mean" connectNulls={false} />
            <Line type="monotone" dataKey="p75"  stroke="rgba(134,192,222,0.5)"   dot={false} strokeWidth={1.5} strokeDasharray="4 2" name="p75"  connectNulls={false} />
            <Line type="monotone" dataKey="p95"  stroke="rgba(106,118,132,0.45)" dot={false} strokeWidth={1}   strokeDasharray="4 2" name="p95"  connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
        </div>
        <div style={{ fontSize: 11, color: '#8995a2', marginTop: 6 }}>
          Click any point in the forward fan to view the conditional probability distribution at that horizon.
        </div>
      </div>

      {/* Conditional PDF on click */}
      {clickedPoint && (() => {
        const cp = clickedPoint
        const sigmaT = Math.max((cp.p95 - cp.p5) / (2 * 1.6449), 1e-8)
        const xMin = Math.min(cp.mean - 3.8 * sigmaT, stopVal - 0.5 * sigmaT, targetVal - 0.5 * sigmaT, entryVal - 0.5 * sigmaT)
        const xMax = Math.max(cp.mean + 3.8 * sigmaT, stopVal + 0.5 * sigmaT, targetVal + 0.5 * sigmaT, entryVal + 0.5 * sigmaT)
        const nPts = 240
        const pdfData = Array.from({ length: nPts }, (_, i) => {
          const x = xMin + (xMax - xMin) * i / (nPts - 1)
          const density = Math.exp(-0.5 * ((x - cp.mean) / sigmaT) ** 2) / (sigmaT * Math.sqrt(2 * Math.PI))
          return { x, density }
        })
        // erf approximation for probabilities
        function erfc(z: number): number {
          const t = 1 / (1 + 0.3275911 * Math.abs(z))
          const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
          const val = poly * Math.exp(-z * z)
          return z >= 0 ? val : 2 - val
        }
        function normCDF(x: number) { return 1 - 0.5 * erfc((x - cp.mean) / (sigmaT * Math.SQRT2)) }
        const pTP = goingDown ? normCDF(targetVal) : 1 - normCDF(targetVal)
        const pSL = goingDown ? 1 - normCDF(stopVal)  : normCDF(stopVal)
        const pxTickCount = 6
        const pxTicks = Array.from({ length: pxTickCount }, (_, i) => xMin + (xMax - xMin) * i / (pxTickCount - 1))
        return (
          <div className="hub-frame" style={{ ...cardStyle, borderColor: 'rgba(139,143,216,0.35)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={sectionLabel}>Conditional Distribution — {cp.label}</div>
                <div style={{ fontSize: 11, color: '#9aa5b1' }}>
                  OU transition density at this horizon · μ<sub>t</sub> = {fmt(cp.mean, 4)} · σ<sub>t</sub> = {fmt(sigmaT, 4)}
                </div>
              </div>
              <button onClick={() => setClickedPoint(null)} style={{
                background: 'transparent', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 5,
                color: '#9aa5b1', cursor: 'pointer', fontSize: 11, padding: '2px 8px',
              }}>✕ close</button>
            </div>
            {/* Key probs */}
            <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
              {[
                { label: goingDown ? 'P(X ≤ TP)' : 'P(X ≥ TP)', val: `${(pTP * 100).toFixed(1)}%`, color: POS },
                { label: goingDown ? 'P(X ≥ SL)' : 'P(X ≤ SL)', val: `${(pSL * 100).toFixed(1)}%`, color: NEG },
                { label: 'E[P&L]', val: fmt(pTP * Math.abs(targetVal - entryVal) - pSL * Math.abs(stopVal - entryVal), 4),
                  color: (pTP * Math.abs(targetVal - entryVal) - pSL * Math.abs(stopVal - entryVal)) >= 0 ? POS : NEG },
              ].map(s => (
                <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#8995a2' }}>{s.label}</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: s.color, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{s.val}</span>
                </div>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={pdfData} margin={{ top: 8, right: 24, bottom: 16, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                <XAxis dataKey="x" type="number" domain={[xMin, xMax]} tick={{ ...TICK_STYLE, fontSize: 10 }}
                  axisLine={false} tickLine={false} tickFormatter={v => fmt(v, 3)} ticks={pxTicks} />
                <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={45}
                  tickFormatter={v => v.toFixed(0)} domain={[0, 'auto']} />
                <Tooltip
                  contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
                  formatter={(v: number) => [v.toExponential(3), 'density']}
                  labelFormatter={v => `x = ${fmt(Number(v), 4)}`}
                />
                {/* Shaded TP tail */}
                {goingDown
                  ? <ReferenceArea x1={xMin} x2={targetVal} fill={POS} fillOpacity={0.08} />
                  : <ReferenceArea x1={targetVal} x2={xMax} fill={POS} fillOpacity={0.08} />}
                {/* Shaded SL tail */}
                {goingDown
                  ? <ReferenceArea x1={stopVal} x2={xMax} fill={NEG} fillOpacity={0.08} />
                  : <ReferenceArea x1={xMin} x2={stopVal} fill={NEG} fillOpacity={0.08} />}
                <ReferenceLine x={cp.mean}   stroke={ACCENT} strokeDasharray="6 3" strokeWidth={1.5} label={{ value: 'μₜ', fill: ACCENT, fontSize: 10, position: 'top' }} />
                <ReferenceLine x={ou.mu}     stroke={ACCENT} strokeDasharray="2 4" strokeWidth={1}   label={{ value: 'μ∞', fill: ACCENT, fontSize: 10, position: 'insideTopRight' }} />
                <ReferenceLine x={entryVal}  stroke="rgba(200,220,240,0.3)" strokeDasharray="3 3"    label={{ value: 'entry', fill: '#9aa5b1', fontSize: 10, position: 'top' }} />
                <ReferenceLine x={targetVal} stroke={POS} strokeDasharray="5 3" strokeWidth={1.5}   label={{ value: 'TP', fill: POS, fontSize: 10, position: 'top' }} />
                <ReferenceLine x={stopVal}   stroke={NEG} strokeDasharray="5 3" strokeWidth={1.5}   label={{ value: 'SL', fill: NEG, fontSize: 10, position: 'top' }} />
                <Line type="monotone" dataKey="density" stroke={ACCENT} dot={false} strokeWidth={2} name="density" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )
      })()}

      {/* Expected Sharpe at each horizon */}
      {(() => {
        const { k, mu, sigma } = ou
        if (!k || k <= 0) return null
        const horizons = [
          ...Array.from({ length: 10 }, (_, i) => i + 1),
          ...Array.from({ length: 7  }, (_, i) => 12 + i * 3),
          ...Array.from({ length: 12 }, (_, i) => 35 + i * 5),
          100, 120, 150, 180, 210, 252,
        ]
        function srAt(x0: number, tau_d: number): number | null {
          const tau = tau_d / 252
          const exp_ret = Math.abs(mu - x0) * (1 - Math.exp(-k * tau))
          const cv = sigma * sigma * (1 - Math.exp(-2 * k * tau)) / (2 * k)
          const cs = Math.sqrt(Math.max(cv, 1e-14))
          if (cs < 1e-14) return null
          return (exp_ret / cs) * Math.sqrt(252 / tau_d)
        }
        const srData = horizons.map(tau_d => ({
          days: tau_d,
          srEntry:   parseFloat((srAt(entryVal,  tau_d) ?? 0).toFixed(3)),
          srCurrent: parseFloat((srAt(ou.current, tau_d) ?? 0).toFixed(3)),
        }))
        const peakEntry   = srData.reduce((a, b) => b.srEntry   > a.srEntry   ? b : a, srData[0])
        const entryDiffersFromCurrent = Math.abs(entryVal - ou.current) > 1e-6
        return (
          <div className="hub-frame" style={cardStyle}>
            <div style={sectionLabel}>Expected Sharpe ratio by holding horizon</div>
            <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 12 }}>
              Analytical OU (exit at horizon, no early stop). Entry SR in{' '}
              <span style={{ color: '#d6ad66' }}>amber</span>
              {entryDiffersFromCurrent && <>, current-level SR in <span style={{ color: ACCENT }}>cyan</span> for reference</>}.
              SR(τ) = |μ−entry| · (1−e<sup>−κτ</sup>) / σ<sub>τ</sub> × √(252/τ).
            </div>
            {/* Peak stats */}
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
              {[
                { label: 'Peak SR (entry)', val: fmt(peakEntry.srEntry, 2), sub: `at ${peakEntry.days}d`, color: '#d6ad66' },
                { label: 'Half-life', val: `${Math.round(ou.half_life_days)}d`, sub: '50% gap closed', color: undefined },
                { label: 'Dist to TP', val: fmt(Math.abs(targetVal - entryVal), 4), sub: '', color: POS },
                { label: 'Dist to SL', val: fmt(Math.abs(stopVal   - entryVal), 4), sub: '', color: NEG },
              ].map(s => (
                <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#8995a2' }}>{s.label}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: s.color ?? '#eef2f6', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{s.val}</span>
                  {s.sub && <span style={{ fontSize: 10, color: '#8995a2' }}>{s.sub}</span>}
                </div>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={srData} margin={{ top: 8, right: 24, bottom: 16, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                <XAxis dataKey="days" tick={TICK_STYLE} axisLine={false} tickLine={false}
                  label={{ value: 'Holding horizon (business days)', position: 'insideBottomRight', offset: -8, fill: '#9aa5b1', fontSize: 11 }} />
                <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} width={50}
                  tickFormatter={v => fmt(v)} domain={[0, 'auto']} />
                <Tooltip
                  contentStyle={{ background: '#0b0f14', border: `1px solid ${ACCENT_BORDER}`, borderRadius: 6, fontSize: 12 }}
                  formatter={(v: number, name: string) => [fmt(v, 3), name]}
                  labelFormatter={v => `${v} business days`}
                />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" />
                <ReferenceLine x={peakEntry.days} stroke="#d6ad66" strokeDasharray="4 2"
                  label={{ value: `Peak ${fmt(peakEntry.srEntry, 2)}`, position: 'top', fill: '#d6ad66', fontSize: 10 }} />
                {entryDiffersFromCurrent && (
                  <Line type="monotone" dataKey="srCurrent" stroke={ACCENT} dot={false} strokeWidth={1.5}
                    strokeDasharray="5 3" name="SR from current" />
                )}
                <Line type="monotone" dataKey="srEntry" stroke="#d6ad66" dot={false} strokeWidth={2.5} name="SR from entry" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )
      })()}

      {/* Q&A section */}
      {(() => {
        // OU helpers
        function ouMean(x0: number, tau_d: number) {
          return ou.mu + (x0 - ou.mu) * Math.exp(-ou.k * tau_d / 252)
        }
        function ouSig(tau_d: number) {
          return Math.sqrt(Math.max(ou.sigma ** 2 * (1 - Math.exp(-2 * ou.k * tau_d / 252)) / (2 * ou.k), 1e-14))
        }
        function erfc2(z: number) {
          const t = 1 / (1 + 0.3275911 * Math.abs(z))
          const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
          const v = p * Math.exp(-z * z)
          return z >= 0 ? v : 2 - v
        }
        function normCDF2(x: number, mu: number, sig: number) {
          return 1 - 0.5 * erfc2((x - mu) / (sig * Math.SQRT2))
        }
        // Rational approx for inverse normal (Acklam)
        function normInv(p: number): number {
          const a = [-3.969683028665376e1,2.209460984245205e2,-2.759285104469687e2,1.383577518672690e2,-3.066479806614716e1,2.506628277459239]
          const b = [-5.447609879822406e1,1.615858368580409e2,-1.556989798598866e2,6.680131188771972e1,-1.328068155288572e1]
          const c = [-7.784894002430293e-3,-3.223964580411365e-1,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783]
          const d = [7.784695709041462e-3,3.224671290700398e-1,2.445134137142996,3.754408661907416]
          const plo = 0.02425, phi2 = 1 - plo
          if (p <= 0) return -Infinity; if (p >= 1) return Infinity
          if (p < plo) {
            const q = Math.sqrt(-2*Math.log(p))
            return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
          } else if (p <= phi2) {
            const q = p-0.5, r = q*q
            return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
          } else {
            const q = Math.sqrt(-2*Math.log(1-p))
            return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
          }
        }

        // Q1
        const q1StopVal  = parseFloat(q1StopStr) || stopVal
        const q1Mean     = ouMean(entryVal, q1Days)
        const q1Sig      = ouSig(q1Days)
        const q1Prob     = goingDown
          ? (1 - normCDF2(q1StopVal, q1Mean, q1Sig))   // short: stop above
          : normCDF2(q1StopVal, q1Mean, q1Sig)           // long:  stop below
        // Q2
        const q2ProbVal  = Math.min(0.999, Math.max(0.001, (parseFloat(q2ProbStr) || 20) / 100))
        const q2Mean     = ouMean(entryVal, q2Days)
        const q2Sig      = ouSig(q2Days)
        const q2Level    = goingDown
          ? q2Mean + q2Sig * normInv(1 - q2ProbVal)   // short: stop above
          : q2Mean + q2Sig * normInv(q2ProbVal)         // long:  stop below
        // Q3
        const q3TgtVal   = parseFloat(q3TgtStr) || targetVal
        const q3Mean     = ouMean(entryVal, q3Days)
        const q3Sig      = ouSig(q3Days)
        const q3Prob     = goingDown
          ? normCDF2(q3TgtVal, q3Mean, q3Sig)           // short: target below
          : (1 - normCDF2(q3TgtVal, q3Mean, q3Sig))     // long:  target above
        // Q4 / Q5 from FPT data
        const rawHits    = toTarget.hit_days_raw ?? []
        const sorted     = [...rawHits].sort((a, b) => a - b)
        const p15        = sorted.length ? sorted[Math.floor(0.15 * sorted.length)] : null
        const p85        = sorted.length ? sorted[Math.floor(0.85 * sorted.length)] : null

        const inStyle: React.CSSProperties = {
          background: 'transparent',
          border: 'none', borderBottom: '1px solid rgba(200,220,240,0.25)',
          color: '#eef2f6', fontSize: 13, textAlign: 'center',
          padding: '1px 4px', outline: 'none', width: 70,
        }
        const ansStyle = (ok: boolean): React.CSSProperties => ({
          fontSize: 15, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace",
          color: ok ? ACCENT : '#eef2f6',
        })
        const rowStyle: React.CSSProperties = {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 0', borderBottom: '1px solid rgba(200,220,240,0.05)',
          gap: 16, flexWrap: 'wrap',
        }
        const qStyle: React.CSSProperties = { fontSize: 13, color: '#c3ccd6', lineHeight: 1.6, flex: 1, minWidth: 260 }

        return (
          <div className="hub-frame" style={cardStyle}>
            <div style={{ ...sectionLabel, marginBottom: 4 }}>Trade Questions</div>
            <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 16 }}>
              Analytical OU terminal distribution — probabilities are at the stated horizon, not first-passage.
            </div>

            {/* Q1 */}
            <div style={rowStyle}>
              <div style={qStyle}>
                What is the likelihood of <span style={{ color: NEG }}>stopping out</span> within the next{' '}
                <input type="number" value={q1Days} min={1} max={504}
                  onChange={e => setQ1Days(Math.max(1, parseInt(e.target.value) || 10))}
                  style={{ ...inStyle, width: 45 }} />
                {' '}days if I set my stop at{' '}
                <input type="text" value={q1StopStr}
                  placeholder={fmt(stopVal, 4)}
                  onChange={e => setQ1StopStr(e.target.value)}
                  style={inStyle} />
                ?
              </div>
              <div style={ansStyle(q1Prob > 0)}>{(q1Prob * 100).toFixed(1)}%</div>
            </div>

            {/* Q2 */}
            <div style={rowStyle}>
              <div style={qStyle}>
                At what level should I set my <span style={{ color: NEG }}>stop</span> if I want the probability
                of being stopped out within the next{' '}
                <input type="number" value={q2Days} min={1} max={504}
                  onChange={e => setQ2Days(Math.max(1, parseInt(e.target.value) || 21))}
                  style={{ ...inStyle, width: 45 }} />
                {' '}days to be{' '}
                <input type="number" value={q2ProbStr} min={1} max={99}
                  onChange={e => setQ2ProbStr(e.target.value)}
                  style={{ ...inStyle, width: 40 }} />
                %?
              </div>
              <div style={ansStyle(true)}>{fmt(q2Level, 4)}</div>
            </div>

            {/* Q3 */}
            <div style={rowStyle}>
              <div style={qStyle}>
                What is the likelihood of hitting my <span style={{ color: POS }}>profit target</span> within
                the next{' '}
                <input type="number" value={q3Days} min={1} max={504}
                  onChange={e => setQ3Days(Math.max(1, parseInt(e.target.value) || 42))}
                  style={{ ...inStyle, width: 45 }} />
                {' '}days if I set it at{' '}
                <input type="text" value={q3TgtStr}
                  placeholder={fmt(targetVal, 4)}
                  onChange={e => setQ3TgtStr(e.target.value)}
                  style={inStyle} />
                ?
              </div>
              <div style={ansStyle(q3Prob > 0)}>{(q3Prob * 100).toFixed(1)}%</div>
            </div>

            {/* Q4 */}
            <div style={rowStyle}>
              <div style={qStyle}>
                How much time should I expect to pass before this spread next reaches its{' '}
                <span style={{ color: ACCENT }}>configured target</span>{' '}
                ({fmt(targetVal, 4)})?
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                <div style={ansStyle(true)}>
                  {toTarget.mean_days != null ? `${Math.round(toTarget.mean_days)}d` : '—'}
                </div>
                <div style={{ fontSize: 11, color: '#8995a2' }}>
                  mean · median {toTarget.median_days != null ? `${Math.round(toTarget.median_days)}d` : '—'}
                </div>
              </div>
            </div>

            {/* Q5 */}
            <div style={{ ...rowStyle, borderBottom: 'none' }}>
              <div style={qStyle}>
                What is a <span style={{ color: ACCENT }}>70% symmetric confidence interval</span> for the time
                before this spread next reaches its configured target ({fmt(targetVal, 4)})?
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                <div style={ansStyle(p15 != null)}>
                  {p15 != null && p85 != null ? `${Math.round(p15)}d – ${Math.round(p85)}d` : '—'}
                </div>
                <div style={{ fontSize: 11, color: '#8995a2' }}>P15 – P85</div>
              </div>
            </div>

          </div>
        )
      })()}

      {/* OU params footer */}
      <div className="hub-frame" style={cardStyle}>
        <div style={sectionLabel}>OU Model Reference</div>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          {([
            { label: 'μ',         val: fmt(ou.mu, 4),             color: ACCENT },
            { label: 'κ',         val: fmt(ou.k, 4)                             },
            { label: 'σ',         val: fmt(ou.sigma, 4)                         },
            { label: 'σ∞',        val: fmt(ou.stationary_std, 4)                },
            { label: 't½',        val: `${Math.round(ou.half_life_days)}d`      },
            { label: 'z-score',   val: `${ou.current_zscore >= 0 ? '+' : ''}${fmt(ou.current_zscore, 2)}σ`,
              color: Math.abs(ou.current_zscore) >= 2 ? dirColor : '#eef2f6'    },
          ] as { label: string; val: string; color?: string }[]).map(({ label, val, color }) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.06em', color: '#8995a2' }}>{label}</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: color ?? '#eef2f6',
                fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{val}</span>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}

// ─── Main page component ──────────────────────────────────────────────────────

type Tab = 'series' | 'diagnostics' | 'forward' | 'sharpe' | 'fpt' | 'trade'

export default function MeanReversion() {
  const token     = localStorage.getItem('access_token')

  const [expression,   setExpression]  = useState('')
  const [startDate,    setStartDate]   = useState('2015-01-01')
  const [modelType,    setModelType]   = useState<ModelType>('linear_ou')
  const [fitStart,     setFitStart]    = useState('')
  const [fitEnd,       setFitEnd]      = useState('')
  const [localFitStart,setLocalFitStart] = useState('')
  const [localFitEnd,  setLocalFitEnd]   = useState('')
  const [result,       setResult]      = useState<AnalysisResult | null>(null)
  const [loading,      setLoading]     = useState(false)
  const [error,        setError]       = useState<string | null>(null)
  const [activeTab,    setActiveTab]   = useState<Tab>('series')
  const [savedSeries,  setSavedSeries] = useState<SavedSeries[]>(loadSaved)
  const [savedTrades,  setSavedTrades] = useState<SavedTrade[]>(loadTrades)
  const [saveLabel,    setSaveLabel]   = useState('')

  // FPT override state
  const [targetInput,   setTargetInput]   = useState('')
  const [stopInput,     setStopInput]     = useState('')
  const [rerunLoading,  setRerunLoading]  = useState(false)
  const [refitLoading,  setRefitLoading]  = useState(false)

  function handleSave() {
    if (!expression.trim()) return
    const label = saveLabel.trim() || expression.trim()
    const entry: SavedSeries = {
      id: Date.now().toString(),
      name: label,
      expression: expression.trim(),
      startDate,
    }
    const updated = [entry, ...savedSeries]
    setSavedSeries(updated)
    persistSaved(updated)
    setSaveLabel('')
  }

  function handleDeleteSaved(id: string) {
    const updated = savedSeries.filter(s => s.id !== id)
    setSavedSeries(updated)
    persistSaved(updated)
  }

  function handleSaveTrade(t: SavedTrade) {
    const updated = [t, ...savedTrades]
    setSavedTrades(updated)
    persistTrades(updated)
  }

  function handleDeleteTrade(id: string) {
    const updated = savedTrades.filter(t => t.id !== id)
    setSavedTrades(updated)
    persistTrades(updated)
  }

  function handleLoadSaved(s: SavedSeries) {
    setExpression(s.expression)
    setStartDate(s.startDate)
    setFitStart(''); setFitEnd('')
    setLocalFitStart(''); setLocalFitEnd('')
    runAnalysis({ expr: s.expression, start: s.startDate, model: modelType })
    setActiveTab('series')
  }

  async function runAnalysis(opts: {
    expr: string
    start: string
    model?: ModelType
    fitStart?: string
    fitEnd?: string
    customTarget?: number
    customStop?: number
    loadingSetter?: (v: boolean) => void
  }) {
    const {
      expr, start,
      model = modelType,
      fitStart: fs, fitEnd: fe,
      customTarget, customStop,
      loadingSetter = setLoading,
    } = opts
    if (!expr.trim()) return
    loadingSetter(true)
    setError(null)
    try {
      const res = await authFetch('/api/tools/mean-reversion/analyse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          expression: expr,
          start_date: start,
          model_type: model,
          ...(fs ? { fit_start: fs } : {}),
          ...(fe ? { fit_end:   fe } : {}),
          ...(customTarget != null ? { target: customTarget } : {}),
          ...(customStop   != null ? { stop:   customStop   } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      const data: AnalysisResult = await res.json()
      setResult(data)
      setTargetInput('')
      setStopInput('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      loadingSetter(false)
    }
  }

  function handleAnalyse() {
    setFitStart(''); setFitEnd('')
    setLocalFitStart(''); setLocalFitEnd('')
    runAnalysis({ expr: expression, start: startDate, model: modelType })
    setActiveTab('series')
  }

  function handleModelChange(m: ModelType) {
    setModelType(m)
    if (result) {
      runAnalysis({ expr: result.expression, start: startDate, model: m, fitStart, fitEnd })
    }
  }

  function handleFitChange() {
    const fs = localFitStart
    const fe = localFitEnd
    setFitStart(fs); setFitEnd(fe)
    if (result) {
      runAnalysis({
        expr: result.expression, start: startDate, model: modelType,
        fitStart: fs, fitEnd: fe,
        loadingSetter: setRefitLoading,
      })
    }
  }

  function handleRerunFPT() {
    if (!result) return
    const t = targetInput ? parseFloat(targetInput) : undefined
    const s = stopInput   ? parseFloat(stopInput)   : undefined
    runAnalysis({
      expr: result.expression, start: startDate, model: modelType,
      fitStart, fitEnd,
      customTarget: t, customStop: s,
      loadingSetter: setRerunLoading,
    })
  }

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'series',      label: 'Time Series'        },
    { id: 'diagnostics', label: 'Diagnostics'        },
    { id: 'forward',     label: 'Forward Dist.'      },
    { id: 'sharpe',      label: 'Sharpe Profile'     },
    { id: 'fpt',         label: 'First Passage Times'},
    { id: 'trade',       label: 'Trade Builder'     },
  ]

  const sideInputStyle: React.CSSProperties = {
    width: '100%', background: 'rgba(200,220,240,0.05)',
    border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6,
    padding: '8px 12px', color: '#eef2f6', fontSize: 13, boxSizing: 'border-box',
  }
  const sideLabelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.07em', color: '#9aa5b1', marginBottom: 5,
  }
  const sideCardStyle: React.CSSProperties = {
    background: 'rgba(200,220,240,0.03)',
    border: '1px solid rgba(200,220,240,0.07)',
    borderRadius: 6, padding: '16px 16px',
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: BG, color: '#eef2f6', fontFamily: "'Geist', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{
        ...headerBar, position: 'relative',
        padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0,
      }}>
        <PageTitle
          category="Market Structure & Analysis"
          categoryId="market-structure"
          title="Mean Reversion"
          subtitle="OU estimation · Stanton diagnostic · Sharpe profile · First passage times"
        />
      </div>

      {/* Body — sidebar + main */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Left sidebar ── */}
        <div style={{
          width: 284, flexShrink: 0,
          borderRight: '1px solid rgba(200,220,240,0.07)',
          overflowY: 'auto', padding: '20px 16px',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>

          {/* Expression panel */}
          <div style={sideCardStyle}>
            <div style={{ ...sideCardStyle, padding: 0, background: 'none', border: 'none' }}>
              <div style={sideLabelStyle}>Bloomberg Expression</div>
              <textarea
                value={expression}
                onChange={e => setExpression(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleAnalyse())}
                placeholder="ticker or weighted combination…"
                rows={3}
                style={{ ...sideInputStyle, resize: 'vertical', lineHeight: 1.5, marginBottom: 10 }}
              />
              <div style={{ ...sideLabelStyle, marginTop: 2 }}>History start</div>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                style={{ ...sideInputStyle, marginBottom: 12 }} />
              <button
                onClick={handleAnalyse}
                disabled={loading || !expression.trim()}
                style={{
                  width: '100%', padding: '9px 0', borderRadius: 6,
                  background: loading || !expression.trim() ? 'rgba(111,192,203,0.2)' : ACCENT,
                  border: 'none', color: '#0b0f14', fontSize: 13, fontWeight: 600,
                  cursor: loading || !expression.trim() ? 'not-allowed' : 'pointer',
                  opacity: loading || !expression.trim() ? 0.5 : 1, marginBottom: 12,
                }}
              >
                {loading ? 'Analysing…' : 'Analyse'}
              </button>

              {/* Save row */}
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={saveLabel}
                  onChange={e => setSaveLabel(e.target.value)}
                  placeholder="Label (optional)"
                  style={{ ...sideInputStyle, flex: 1, fontSize: 12 }}
                />
                <button
                  onClick={handleSave}
                  disabled={!expression.trim()}
                  style={{
                    padding: '8px 12px', borderRadius: 6,
                    border: `1px solid ${ACCENT_BORDER}`, background: ACCENT_DIM,
                    color: ACCENT, fontSize: 12, fontWeight: 600,
                    cursor: expression.trim() ? 'pointer' : 'not-allowed',
                    opacity: expression.trim() ? 1 : 0.4, whiteSpace: 'nowrap',
                  }}
                >
                  Save
                </button>
              </div>
            </div>

            {/* Example shortcuts */}
            <div style={{ marginTop: 12 }}>
              <div style={sideLabelStyle}>Quick examples</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {EXAMPLES.map(ex => (
                  <button
                    key={ex.label}
                    onClick={() => { setExpression(ex.expr); setResult(null) }}
                    style={{
                      textAlign: 'left', padding: '5px 10px', borderRadius: 6,
                      background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)',
                      color: '#c6ced8', fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    <span style={{ color: ACCENT, fontWeight: 600 }}>{ex.label}</span>
                    <span style={{ color: '#8995a2', fontSize: 11, display: 'block', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {ex.expr}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Saved series panel */}
          <div style={sideCardStyle}>
            <div style={sideLabelStyle}>Saved Series ({savedSeries.length})</div>
            {savedSeries.length === 0 ? (
              <div style={{ fontSize: 12, color: '#8995a2', fontStyle: 'italic' }}>No saved series yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {savedSeries.map(s => (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '7px 10px', borderRadius: 7,
                    background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)',
                  }}>
                    <button
                      onClick={() => handleLoadSaved(s)}
                      style={{
                        flex: 1, textAlign: 'left', background: 'none', border: 'none',
                        cursor: 'pointer', padding: 0, minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#e4eaf1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.name}
                      </div>
                      <div style={{ fontSize: 10, color: '#8995a2', marginTop: 2 }}>from {s.startDate}</div>
                    </button>
                    <button
                      onClick={() => handleDeleteSaved(s.id)}
                      style={{ background: 'none', border: 'none', color: '#8995a2', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Saved trades panel */}
          <div style={sideCardStyle}>
            <div style={sideLabelStyle}>Saved Trades ({savedTrades.length})</div>
            {savedTrades.length === 0 ? (
              <div style={{ fontSize: 12, color: '#8995a2', fontStyle: 'italic' }}>No saved trades yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {savedTrades.map(t => (
                  <div key={t.id} style={{
                    padding: '8px 10px', borderRadius: 7,
                    background: 'rgba(200,220,240,0.03)',
                    border: `1px solid ${t.direction === 'LONG' ? 'rgba(88,173,142,0.2)' : 'rgba(217,112,94,0.2)'}`,
                    position: 'relative',
                  }}>
                    <button
                      onClick={() => handleDeleteTrade(t.id)}
                      style={{ position: 'absolute', top: 6, right: 6, background: 'none', border: 'none', color: '#8995a2', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
                      title="Remove"
                    >×</button>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e4eaf1', paddingRight: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.label}
                    </div>
                    <div style={{ fontSize: 10, color: t.direction === 'LONG' ? POS : NEG, marginTop: 2, fontWeight: 600 }}>
                      {t.direction} · {t.entryDate}
                    </div>
                    <div style={{ fontSize: 10, color: '#9aa5b1', marginTop: 4, fontFamily: "'Geist Mono', ui-monospace, monospace", lineHeight: 1.7 }}>
                      <span>Entry <b style={{ color: '#c6ced8' }}>{fmt(t.entryLevel, 4)}</b></span><br/>
                      <span>TP <b style={{ color: POS }}>{fmt(t.target, 4)}</b>
                        &nbsp;·&nbsp; SL <b style={{ color: NEG }}>{fmt(t.stopLoss, 4)}</b></span><br/>
                      <span>μ <b style={{ color: ACCENT }}>{fmt(t.mu, 4)}</b>
                        &nbsp;·&nbsp; t½ <b style={{ color: '#c6ced8' }}>{Math.round(t.halfLife)}d</b>
                        &nbsp;·&nbsp; R:R <b style={{ color: t.rr >= 1 ? POS : NEG }}>{fmt(t.rr, 2)}</b></span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Estimation window panel — only when a result is loaded */}
          {result && (
            <div style={sideCardStyle}>
              <div style={sideLabelStyle}>Estimation window</div>
              <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 10 }}>
                Active: <span style={{ color: '#c6ced8' }}>{result.fit_start}</span> → <span style={{ color: '#c6ced8' }}>{result.fit_end}</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <div style={sideLabelStyle}>Fit start</div>
                <input type="date" value={localFitStart} onChange={e => setLocalFitStart(e.target.value)}
                  style={sideInputStyle} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={sideLabelStyle}>Fit end</div>
                <input type="date" value={localFitEnd} onChange={e => setLocalFitEnd(e.target.value)}
                  style={sideInputStyle} />
              </div>
              <button
                onClick={handleFitChange}
                disabled={refitLoading}
                style={{
                  width: '100%', padding: '8px 0', borderRadius: 6,
                  border: `1px solid ${ACCENT_BORDER}`, background: ACCENT_DIM,
                  color: ACCENT, fontSize: 13, fontWeight: 600,
                  cursor: refitLoading ? 'not-allowed' : 'pointer',
                  opacity: refitLoading ? 0.5 : 1,
                }}
              >
                {refitLoading ? 'Fitting…' : 'Re-fit'}
              </button>
            </div>
          )}

        </div>{/* end sidebar */}

        {/* ── Main content ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Error */}
          {error && (
            <div className="hub-frame" style={{ ...cardStyle, borderColor: 'rgba(217,112,94,0.4)', background: 'rgba(217,112,94,0.05)', color: NEG, fontSize: 13, padding: '12px 18px' }}>
              {error}
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div style={{ textAlign: 'center', color: '#9aa5b1', padding: 80, fontSize: 14 }}>
              Running OU estimation and Monte Carlo simulation…
            </div>
          )}

          {/* Results */}
          {result && !loading && (
            <>
              {/* Simulation badge */}
              {result.simulation_mode && (
                <div className="hub-frame" style={{ ...cardStyle, padding: '10px 16px', borderColor: 'rgba(214,173,102,0.3)', background: 'rgba(214,173,102,0.05)', fontSize: 12, color: '#d6ad66' }}>
                  Simulation mode — Bloomberg not available. Synthetic data used for all tickers.
                </div>
              )}

              {/* Parsed terms */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: '#8995a2' }}>Parsed:</span>
                {result.terms.map((t, i) => (
                  <span key={i} style={{
                    padding: '3px 12px', borderRadius: 6,
                    background: t.weight > 0 ? 'rgba(88,173,142,0.1)' : 'rgba(217,112,94,0.1)',
                    border: `1px solid ${t.weight > 0 ? 'rgba(88,173,142,0.3)' : 'rgba(217,112,94,0.3)'}`,
                    color: t.weight > 0 ? POS : NEG, fontSize: 12,
                  }}>
                    {t.weight > 0 && i > 0 ? '+' : ''}{t.weight !== 1 && t.weight !== -1 ? `${t.weight} × ` : t.weight === -1 ? '−' : ''}{t.ticker}
                  </span>
                ))}
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {TABS.map(tab => (
                  <TabButton key={tab.id} label={tab.label} active={activeTab === tab.id} onClick={() => setActiveTab(tab.id)} />
                ))}
              </div>

              {/* Tab content */}
              {activeTab === 'series'      && <SeriesTab result={result} modelType={modelType} onModelChange={handleModelChange} />}
              {activeTab === 'diagnostics' && <DiagnosticsTab result={result} token={token} expression={result.expression} startDate={startDate} fitStart={fitStart} fitEnd={fitEnd} />}
              {activeTab === 'forward'     && <ForwardDistTab result={result} token={token} expression={result.expression} startDate={startDate} fitStart={fitStart} fitEnd={fitEnd} />}
              {activeTab === 'sharpe'      && <SharpeTab result={result} token={token} expression={result.expression} startDate={startDate} fitStart={fitStart} fitEnd={fitEnd} />}
              {activeTab === 'fpt'         && (
                <FPTTab
                  result={result}
                  modelType={modelType}
                  onModelChange={handleModelChange}
                  targetInput={targetInput}
                  stopInput={stopInput}
                  onTargetChange={setTargetInput}
                  onStopChange={setStopInput}
                  onRerun={handleRerunFPT}
                  rerunLoading={rerunLoading}
                />
              )}
              {activeTab === 'trade' && (
                <TradeBuilderTab
                  result={result}
                  modelType={modelType}
                  onModelChange={handleModelChange}
                  targetInput={targetInput}
                  stopInput={stopInput}
                  onTargetChange={setTargetInput}
                  onStopChange={setStopInput}
                  onSaveTrade={handleSaveTrade}
                />
              )}
            </>
          )}

          {/* Empty state */}
          {!result && !loading && !error && (
            <div style={{ textAlign: 'center', padding: 80, color: '#8995a2' }}>
              <div style={{ fontSize: 40, marginBottom: 16 }}>〜</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Enter an expression in the left panel to begin</div>
              <div style={{ fontSize: 13, color: '#77828f' }}>
                Single ticker, spread, butterfly, or any linear combination.
              </div>
            </div>
          )}

        </div>{/* end main */}
      </div>{/* end body */}
    </div>
  )
}
