import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from 'recharts'

// ─── Scenario config ──────────────────────────────────────────────────────────

const SCENARIOS = [
  { id: 'hard',    label: 'Hard Landing',   color: '#ef4444', area: 'rgba(239,68,68,0.10)'  },
  { id: 'soft',    label: 'Soft Landing',   color: '#22c55e', area: 'rgba(34,197,94,0.10)'  },
  { id: 'no',      label: 'No Landing',     color: '#3b82f6', area: 'rgba(59,130,246,0.10)' },
  { id: 'reaccel', label: 'Reacceleration', color: '#f59e0b', area: 'rgba(245,158,11,0.10)' },
] as const

// ─── Swaption structure dimensions ───────────────────────────────────────────

const CURRENCIES = ['USD', 'EUR', 'GBP'] as const
type Currency = typeof CURRENCIES[number]

// Expiry: when the option expires
const EXPIRIES = ['1m', '3m', '6m', '1y', '2y', '3y', '5y', '7y', '10y'] as const
type Expiry = typeof EXPIRIES[number]

// Tail: underlying swap tenor
const TAILS = ['1y', '2y', '5y', '10y', '15y', '20y', '30y'] as const
type Tail = typeof TAILS[number]

const EXPIRY_YEARS: Record<Expiry, number> = {
  '1m': 1 / 12, '3m': 0.25, '6m': 0.5,
  '1y': 1, '2y': 2, '3y': 3, '5y': 5, '7y': 7, '10y': 10,
}

// ─── Market parameter estimation ──────────────────────────────────────────────
//
// Rough mid-2025 calibration. User can override all values manually.

// Forward swap rate term-structure by (ccy, tail)
const FWD_RATE: Record<Currency, Record<Tail, number>> = {
  USD: { '1y': 4.65, '2y': 4.45, '5y': 4.35, '10y': 4.50, '15y': 4.60, '20y': 4.65, '30y': 4.70 },
  EUR: { '1y': 2.20, '2y': 2.25, '5y': 2.45, '10y': 2.60, '15y': 2.70, '20y': 2.75, '30y': 2.80 },
  GBP: { '1y': 3.90, '2y': 3.95, '5y': 4.05, '10y': 4.20, '15y': 4.30, '20y': 4.35, '30y': 4.40 },
}

// Annualised normal vol (%) by (ccy, tail).
// σ at expiry T = annualVol × √T
const ANNUAL_VOL: Record<Currency, Record<Tail, number>> = {
  USD: { '1y': 1.20, '2y': 1.00, '5y': 0.85, '10y': 0.75, '15y': 0.70, '20y': 0.67, '30y': 0.65 },
  EUR: { '1y': 0.85, '2y': 0.75, '5y': 0.65, '10y': 0.60, '15y': 0.57, '20y': 0.55, '30y': 0.52 },
  GBP: { '1y': 1.05, '2y': 0.90, '5y': 0.78, '10y': 0.70, '15y': 0.65, '20y': 0.62, '30y': 0.60 },
}

// Base skew by currency; grows (more negative) with √expiry
const BASE_SKEW: Record<Currency, number> = { USD: -0.45, EUR: -0.30, GBP: -0.40 }

function estimateParams(ccy: Currency, tail: Tail, expiry: Expiry) {
  const T = EXPIRY_YEARS[expiry]
  const forward = FWD_RATE[ccy][tail]
  const vol = Math.round(ANNUAL_VOL[ccy][tail] * Math.sqrt(T) * 100) / 100
  const skew = Math.round((BASE_SKEW[ccy] - 0.08 * Math.sqrt(T)) * 100) / 100
  return { forward, vol, skew }
}

// Breakpoints: approx –1.5σ / –0.25σ / +0.75σ from forward, rounded to 0.05%
function defaultBreaks(forward: number, vol: number): [number, number, number] {
  const r = (v: number) => Math.round(v / 0.05) * 0.05
  return [r(forward - 1.5 * vol), r(forward - 0.25 * vol), r(forward + 0.75 * vol)]
}

// ─── Math (Gram-Charlier expansion) ──────────────────────────────────────────
//
// PDF(x) = φ(z)/σ · [1 + (γ₁/6)·He₃(z)]     He₃(z) = z³ − 3z
// CDF(x) = Φ(z) − φ(z)·(γ₁/6)·He₂(z)         He₂(z) = z² − 1
//
// γ₁ < 0 → left-skew (receiver skew > payer skew, typical in rates options)

function normCDF(z: number): number {
  const p = 0.3275911
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429]
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + p * x)
  const poly = ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x)))
}

function normPDF(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)
}

function gcCDF(x: number, mu: number, sigma: number, gamma1: number): number {
  if (sigma <= 0) return x < mu ? 0 : 1
  const z = (x - mu) / sigma
  return Math.max(0, Math.min(1, normCDF(z) - normPDF(z) * (gamma1 / 6) * (z * z - 1)))
}

function gcPDF(x: number, mu: number, sigma: number, gamma1: number): number {
  if (sigma <= 0) return 0
  const z = (x - mu) / sigma
  return Math.max(0, (normPDF(z) / sigma) * (1 + (gamma1 / 6) * (z * z * z - 3 * z)))
}

function computeProbs(
  forward: number, vol: number, skew: number,
  breaks: [number, number, number],
): [number, number, number, number] {
  const [b1, b2, b3] = breaks
  const c1 = gcCDF(b1, forward, vol, skew)
  const c2 = gcCDF(b2, forward, vol, skew)
  const c3 = gcCDF(b3, forward, vol, skew)
  return [Math.max(0, c1), Math.max(0, c2 - c1), Math.max(0, c3 - c2), Math.max(0, 1 - c3)]
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface HorizonState {
  expiry: Expiry
  forward: number
  vol: number
  skew: number
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const BG = '#080d1a'

const card: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: 18,
}

const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#64748b',
  marginBottom: 12,
}

const monoInput: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 6,
  color: '#f1f5f9',
  fontSize: 12,
  fontFamily: 'monospace',
  padding: '4px 8px',
  width: 80,
  outline: 'none',
  textAlign: 'right',
}

// ─── Pill button ──────────────────────────────────────────────────────────────

function Pill({
  label, active, onClick, accentColor = '#ef4444',
}: {
  label: string; active: boolean; onClick: () => void; accentColor?: string
}) {
  return (
    <button onClick={onClick} style={{
      background: active ? `${accentColor}22` : 'rgba(255,255,255,0.04)',
      border: `1px solid ${active ? `${accentColor}66` : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 6,
      padding: '4px 11px',
      color: active ? accentColor : '#64748b',
      fontSize: 12,
      fontWeight: active ? 700 : 400,
      cursor: 'pointer',
      letterSpacing: active ? '-0.01em' : undefined,
      transition: 'all 0.12s',
    }}>
      {label}
    </button>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ParamRow({
  label, value, onChange, step = 0.05, min,
}: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ color: '#64748b', fontSize: 11, flex: 1 }}>{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v) }}
        style={monoInput}
      />
    </div>
  )
}

function BreakRow({
  dot1, dot2, label, value, onChange,
}: {
  dot1: string; dot2: string; label: string; value: number; onChange: (v: number) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot1, flexShrink: 0 }} />
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot2, flexShrink: 0 }} />
      <span style={{ color: '#64748b', fontSize: 10, flex: 1 }}>{label}</span>
      <input
        type="number"
        value={value}
        step={0.05}
        onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v) }}
        style={{ ...monoInput, width: 68 }}
      />
      <span style={{ color: '#475569', fontSize: 11 }}>%</span>
    </div>
  )
}

function ScenarioCard({
  scenario, p1, p2, h1Label, h2Label,
}: {
  scenario: typeof SCENARIOS[number]; p1: number; p2: number; h1Label: string; h2Label: string
}) {
  return (
    <div style={{
      background: scenario.area,
      border: `1px solid ${scenario.color}33`,
      borderRadius: 10,
      padding: '10px 12px',
    }}>
      <div style={{ color: scenario.color, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
        {scenario.label}
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div>
          <div style={{ color: '#475569', fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{h1Label}</div>
          <div style={{ color: scenario.color, fontSize: 20, fontWeight: 800, fontFamily: 'monospace', lineHeight: 1 }}>
            {(p1 * 100).toFixed(1)}%
          </div>
        </div>
        <div>
          <div style={{ color: '#475569', fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{h2Label}</div>
          <div style={{ color: '#94a3b8', fontSize: 20, fontWeight: 800, fontFamily: 'monospace', lineHeight: 1 }}>
            {(p2 * 100).toFixed(1)}%
          </div>
        </div>
      </div>
    </div>
  )
}

function CDFTooltip({ active, payload, label }: {
  active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: number
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'rgba(8,13,26,0.95)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#64748b', marginBottom: 4 }}>{typeof label === 'number' ? `${label.toFixed(3)}%` : label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ display: 'flex', gap: 12, justifyContent: 'space-between' }}>
          <span style={{ color: p.color }}>{p.name}</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#f1f5f9' }}>{p.value.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  )
}

function PDFTooltip({ active, payload, label }: {
  active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: number
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'rgba(8,13,26,0.95)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#64748b', marginBottom: 4 }}>{typeof label === 'number' ? `${label.toFixed(3)}%` : label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ display: 'flex', gap: 12, justifyContent: 'space-between' }}>
          <span style={{ color: p.color }}>{p.name}</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#f1f5f9' }}>{p.value.toFixed(4)}</span>
        </div>
      ))}
    </div>
  )
}

function LegendLine({ color, label, dashed }: { color: string; label: string; dashed: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <svg width="22" height="4">
        <line x1="0" y1="2" x2="22" y2="2" stroke={color} strokeWidth="2.5" strokeDasharray={dashed ? '6 3' : undefined} />
      </svg>
      <span style={{ color: '#94a3b8', fontSize: 10 }}>{label}</span>
    </div>
  )
}

// ─── Horizon panel ─────────────────────────────────────────────────────────────

function HorizonPanel({
  title, lineColor, dashed,
  ccy, tail, state, onChange, onReset,
}: {
  title: string; lineColor: string; dashed: boolean
  ccy: Currency; tail: Tail
  state: HorizonState
  onChange: (patch: Partial<HorizonState>) => void
  onReset: () => void
}) {
  return (
    <div style={card}>
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="18" height="4">
            <line x1="0" y1="2" x2="18" y2="2" stroke={lineColor} strokeWidth="2.5" strokeDasharray={dashed ? '5 3' : undefined} />
          </svg>
          <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600 }}>{title}</span>
        </div>
        <button onClick={onReset} style={{
          background: 'none', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 5, padding: '2px 8px',
          color: '#475569', fontSize: 10, cursor: 'pointer',
        }}>reset</button>
      </div>

      {/* Expiry pills */}
      <div style={{ ...sectionLabel, marginBottom: 6 }}>Expiry</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
        {EXPIRIES.map(e => (
          <Pill
            key={e} label={e} active={state.expiry === e}
            accentColor={lineColor}
            onClick={() => {
              const p = estimateParams(ccy, tail, e)
              onChange({ expiry: e, ...p })
            }}
          />
        ))}
      </div>

      {/* Editable params */}
      <div style={{ ...sectionLabel, marginBottom: 8 }}>Parameters</div>
      <ParamRow label="Forward (%)" value={state.forward} step={0.05}
        onChange={v => onChange({ forward: v })} />
      <ParamRow label="Vol (%)" value={state.vol} step={0.05} min={0.01}
        onChange={v => onChange({ vol: v })} />
      <ParamRow label="Skew (γ₁)" value={state.skew} step={0.1}
        onChange={v => onChange({ skew: v })} />
      <div style={{ marginTop: 4, fontSize: 10, color: '#334155' }}>
        γ₁ &lt; 0 → fat lower tail (receiver skew)
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const DEFAULT_CCY: Currency = 'USD'
const DEFAULT_TAIL: Tail = '10y'
const DEFAULT_H1_EXPIRY: Expiry = '6m'
const DEFAULT_H2_EXPIRY: Expiry = '1y'

function makeHorizon(ccy: Currency, tail: Tail, expiry: Expiry): HorizonState {
  return { expiry, ...estimateParams(ccy, tail, expiry) }
}

export default function OptionDerivedCDF() {
  const navigate = useNavigate()

  const [ccy, setCcy]   = useState<Currency>(DEFAULT_CCY)
  const [tail, setTail] = useState<Tail>(DEFAULT_TAIL)

  const [h1, setH1] = useState<HorizonState>(() => makeHorizon(DEFAULT_CCY, DEFAULT_TAIL, DEFAULT_H1_EXPIRY))
  const [h2, setH2] = useState<HorizonState>(() => makeHorizon(DEFAULT_CCY, DEFAULT_TAIL, DEFAULT_H2_EXPIRY))

  const initBreaks = () => {
    const p = estimateParams(DEFAULT_CCY, DEFAULT_TAIL, DEFAULT_H1_EXPIRY)
    return defaultBreaks(p.forward, p.vol)
  }
  const [breaks, setBreaks] = useState<[number, number, number]>(initBreaks)

  // When currency changes: reset both horizons, keep expiries
  const handleCcy = (c: Currency) => {
    setCcy(c)
    const p1 = estimateParams(c, tail, h1.expiry)
    const p2 = estimateParams(c, tail, h2.expiry)
    setH1({ ...h1, ...p1 })
    setH2({ ...h2, ...p2 })
    setBreaks(defaultBreaks(p1.forward, p1.vol))
  }

  // When tail changes: reset both horizons, keep expiries
  const handleTail = (t: Tail) => {
    setTail(t)
    const p1 = estimateParams(ccy, t, h1.expiry)
    const p2 = estimateParams(ccy, t, h2.expiry)
    setH1({ ...h1, ...p1 })
    setH2({ ...h2, ...p2 })
    setBreaks(defaultBreaks(p1.forward, p1.vol))
  }

  const setBreak = (idx: 0 | 1 | 2, val: number) => {
    const next: [number, number, number] = [...breaks] as [number, number, number]
    next[idx] = val
    setBreaks(next)
  }

  const h1Label = `${h1.expiry} expiry`
  const h2Label = `${h2.expiry} expiry`
  const instrument = `${ccy} ${h1.expiry}${tail} / ${h2.expiry}${tail}`

  // ── Chart domain ──────────────────────────────────────────────────────────
  const { chartLo, chartHi, xTicks } = useMemo(() => {
    const mu = (h1.forward + h2.forward) / 2
    const sigma = Math.max(h1.vol, h2.vol)
    const lo = Math.max(mu - 4 * sigma, 0.01)
    const hi = mu + 4 * sigma
    const step = (hi - lo) / 8
    const ticks = Array.from({ length: 9 }, (_, i) => Math.round((lo + i * step) * 100) / 100)
    return { chartLo: lo, chartHi: hi, xTicks: ticks }
  }, [h1.forward, h1.vol, h2.forward, h2.vol])

  // ── Chart data ────────────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    const N = 300
    return Array.from({ length: N }, (_, i) => {
      const rate = chartLo + (i / (N - 1)) * (chartHi - chartLo)
      return {
        rate,
        cdf1: gcCDF(rate, h1.forward, h1.vol, h1.skew) * 100,
        cdf2: gcCDF(rate, h2.forward, h2.vol, h2.skew) * 100,
        pdf1: gcPDF(rate, h1.forward, h1.vol, h1.skew),
        pdf2: gcPDF(rate, h2.forward, h2.vol, h2.skew),
      }
    })
  }, [chartLo, chartHi, h1, h2])

  // ── Probabilities ─────────────────────────────────────────────────────────
  const probs1 = useMemo(() => computeProbs(h1.forward, h1.vol, h1.skew, breaks), [h1, breaks])
  const probs2 = useMemo(() => computeProbs(h2.forward, h2.vol, h2.skew, breaks), [h2, breaks])

  const rangeLabel = (i: number) => {
    const lo = i === 0 ? null : breaks[i - 1]
    const hi = i === 3 ? null : breaks[i]
    if (lo == null) return `< ${hi!.toFixed(2)}%`
    if (hi == null) return `> ${lo.toFixed(2)}%`
    return `${lo.toFixed(2)}% – ${hi.toFixed(2)}%`
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: BG, minHeight: '100vh' }}>

      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at 50% -10%, rgba(239,68,68,0.05) 0%, transparent 55%)',
      }} />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50,
        padding: '12px 24px',
        background: 'rgba(8,13,26,0.90)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        backdropFilter: 'blur(12px)',
      }}>
        {/* Row 1: back + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
          <button onClick={() => navigate('/')} style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 8, padding: '6px 14px',
            color: '#94a3b8', fontSize: 13, cursor: 'pointer',
          }}>← Back</button>
          <div>
            <div style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>
              Option-Implied Macro Scenario Probabilities
            </div>
            <div style={{ color: '#475569', fontSize: 11, marginTop: 1 }}>
              Option-implied scenario probabilities · Gram-Charlier expansion
            </div>
          </div>
        </div>

        {/* Row 2: structure selectors */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>

          {/* Currency */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#475569', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>
              Underlying
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              {CURRENCIES.map(c => (
                <Pill key={c} label={c} active={ccy === c} onClick={() => handleCcy(c)} />
              ))}
            </div>
          </div>

          <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)' }} />

          {/* Tail */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#475569', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>
              Tail
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              {TAILS.map(t => (
                <Pill key={t} label={t} active={tail === t} onClick={() => handleTail(t)} />
              ))}
            </div>
          </div>

          {/* Active instrument badge */}
          <div style={{ marginLeft: 'auto' }}>
            <div style={{
              background: 'rgba(239,68,68,0.10)',
              border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: 8, padding: '4px 14px',
              color: '#fca5a5', fontSize: 12, fontWeight: 600, fontFamily: 'monospace',
            }}>
              {instrument}
            </div>
          </div>
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <main style={{ display: 'grid', gridTemplateColumns: '290px 1fr', gap: 16, padding: '20px 24px', alignItems: 'start' }}>

        {/* Left sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Horizon 1 */}
          <HorizonPanel
            title="Horizon 1"
            lineColor="#60a5fa"
            dashed={false}
            ccy={ccy} tail={tail}
            state={h1}
            onChange={patch => setH1(prev => ({ ...prev, ...patch }))}
            onReset={() => {
              const p = estimateParams(ccy, tail, h1.expiry)
              setH1(prev => ({ ...prev, ...p }))
            }}
          />

          {/* Horizon 2 */}
          <HorizonPanel
            title="Horizon 2"
            lineColor="#94a3b8"
            dashed
            ccy={ccy} tail={tail}
            state={h2}
            onChange={patch => setH2(prev => ({ ...prev, ...patch }))}
            onReset={() => {
              const p = estimateParams(ccy, tail, h2.expiry)
              setH2(prev => ({ ...prev, ...p }))
            }}
          />

          {/* Scenario breakpoints */}
          <div style={card}>
            <div style={sectionLabel}>Scenario Breakpoints</div>
            <BreakRow dot1={SCENARIOS[0].color} dot2={SCENARIOS[1].color}
              label="Hard / Soft" value={breaks[0]} onChange={v => setBreak(0, v)} />
            <BreakRow dot1={SCENARIOS[1].color} dot2={SCENARIOS[2].color}
              label="Soft / No Landing" value={breaks[1]} onChange={v => setBreak(1, v)} />
            <BreakRow dot1={SCENARIOS[2].color} dot2={SCENARIOS[3].color}
              label="No Landing / Reaccel" value={breaks[2]} onChange={v => setBreak(2, v)} />

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10, marginTop: 2, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {SCENARIOS.map((s, i) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                  <span style={{ color: '#94a3b8', fontSize: 10, flex: 1 }}>{s.label}</span>
                  <span style={{ color: '#475569', fontSize: 10, fontFamily: 'monospace' }}>{rangeLabel(i)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Probability cards */}
          <div style={card}>
            <div style={sectionLabel}>Scenario Probabilities</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {SCENARIOS.map((s, i) => (
                <ScenarioCard key={s.id} scenario={s}
                  p1={probs1[i]} p2={probs2[i]}
                  h1Label={h1Label} h2Label={h2Label} />
              ))}
            </div>
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#334155' }}>
              <span>Sum</span>
              <span style={{ fontFamily: 'monospace' }}>
                {h1Label}: {(probs1.reduce((a, b) => a + b, 0) * 100).toFixed(1)}%
                &nbsp;&nbsp;
                {h2Label}: {(probs2.reduce((a, b) => a + b, 0) * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        </div>

        {/* Right: charts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* CDF */}
          <div style={card}>
            <div style={sectionLabel}>Option-Implied CDF — {ccy} {tail} rate · {instrument}</div>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData} margin={{ top: 8, right: 20, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <ReferenceArea x1={chartLo}    x2={breaks[0]} fill={SCENARIOS[0].area} stroke="none" ifOverflow="hidden" />
                <ReferenceArea x1={breaks[0]}  x2={breaks[1]} fill={SCENARIOS[1].area} stroke="none" ifOverflow="hidden" />
                <ReferenceArea x1={breaks[1]}  x2={breaks[2]} fill={SCENARIOS[2].area} stroke="none" ifOverflow="hidden" />
                <ReferenceArea x1={breaks[2]}  x2={chartHi}   fill={SCENARIOS[3].area} stroke="none" ifOverflow="hidden" />
                {breaks.map((b, i) => (
                  <ReferenceLine key={i} x={b} stroke={SCENARIOS[i].color}
                    strokeDasharray="4 3" strokeOpacity={0.55} strokeWidth={1} />
                ))}
                <XAxis dataKey="rate" type="number" domain={[chartLo, chartHi]} ticks={xTicks}
                  tickFormatter={v => `${(v as number).toFixed(2)}%`}
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} tickLine={false} />
                <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`}
                  tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                <Tooltip content={<CDFTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.08)' }} />
                <Line dataKey="cdf1" name={h1Label} stroke="#60a5fa" strokeWidth={2.5} dot={false} activeDot={{ r: 4, fill: '#60a5fa' }} />
                <Line dataKey="cdf2" name={h2Label} stroke="#94a3b8" strokeWidth={2} strokeDasharray="7 3" dot={false} activeDot={{ r: 4, fill: '#94a3b8' }} />
              </LineChart>
            </ResponsiveContainer>

            <div style={{ display: 'flex', gap: 20, marginTop: 10, justifyContent: 'center', alignItems: 'center' }}>
              <LegendLine color="#60a5fa" label={h1Label} dashed={false} />
              <LegendLine color="#94a3b8" label={h2Label} dashed />
              <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)' }} />
              {SCENARIOS.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: s.area, border: `1px solid ${s.color}55` }} />
                  <span style={{ color: '#475569', fontSize: 10 }}>{s.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* PDF */}
          <div style={card}>
            <div style={sectionLabel}>Option-Implied Probability Density</div>
            <ResponsiveContainer width="100%" height={190}>
              <LineChart data={chartData} margin={{ top: 8, right: 20, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <ReferenceArea x1={chartLo}   x2={breaks[0]} fill={SCENARIOS[0].area} stroke="none" ifOverflow="hidden" />
                <ReferenceArea x1={breaks[0]} x2={breaks[1]} fill={SCENARIOS[1].area} stroke="none" ifOverflow="hidden" />
                <ReferenceArea x1={breaks[1]} x2={breaks[2]} fill={SCENARIOS[2].area} stroke="none" ifOverflow="hidden" />
                <ReferenceArea x1={breaks[2]} x2={chartHi}   fill={SCENARIOS[3].area} stroke="none" ifOverflow="hidden" />
                {breaks.map((b, i) => (
                  <ReferenceLine key={i} x={b} stroke={SCENARIOS[i].color}
                    strokeDasharray="4 3" strokeOpacity={0.55} strokeWidth={1} />
                ))}
                <XAxis dataKey="rate" type="number" domain={[chartLo, chartHi]} ticks={xTicks}
                  tickFormatter={v => `${(v as number).toFixed(2)}%`}
                  tick={{ fill: '#475569', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} tickLine={false} />
                <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false}
                  tickFormatter={v => (v as number).toFixed(2)} width={40} />
                <Tooltip content={<PDFTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.08)' }} />
                <Line dataKey="pdf1" name={h1Label} stroke="#60a5fa" strokeWidth={2} dot={false} activeDot={{ r: 3, fill: '#60a5fa' }} />
                <Line dataKey="pdf2" name={h2Label} stroke="#94a3b8" strokeWidth={2} strokeDasharray="7 3" dot={false} activeDot={{ r: 3, fill: '#94a3b8' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Summary table */}
          <div style={card}>
            <div style={sectionLabel}>Scenario Summary</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  {['Scenario', 'Range', h1Label, h2Label].map((h, i) => (
                    <th key={h} style={{
                      padding: '4px 10px',
                      color: i >= 2 ? (i === 2 ? '#60a5fa' : '#94a3b8') : '#475569',
                      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                      textAlign: i === 0 ? 'left' : i === 1 ? 'center' : 'right',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SCENARIOS.map((s, i) => (
                  <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '7px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                        <span style={{ color: '#e2e8f0' }}>{s.label}</span>
                      </div>
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'center', fontFamily: 'monospace', color: '#64748b', fontSize: 11 }}>
                      {rangeLabel(i)}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: s.color, fontSize: 13 }}>
                      {(probs1[i] * 100).toFixed(1)}%
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#94a3b8', fontSize: 13 }}>
                      {(probs2[i] * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <td colSpan={2} style={{ padding: '6px 10px', color: '#334155', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#60a5fa' }}>
                    {(probs1.reduce((a, b) => a + b, 0) * 100).toFixed(1)}%
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#94a3b8' }}>
                    {(probs2.reduce((a, b) => a + b, 0) * 100).toFixed(1)}%
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

        </div>
      </main>
    </div>
  )
}
