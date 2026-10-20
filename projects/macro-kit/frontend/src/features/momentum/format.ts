import type { components } from '../../api/schema'

export type Monitor = components['schemas']['MomentumMonitor']
export type MonitorRow = components['schemas']['MomMonitorRow']
export type SectorFlows = components['schemas']['MomSectorFlows']
export type Series = components['schemas']['MomentumSeries']
export type Scenario = components['schemas']['MomScenario']

export const NUM = "'Geist Mono', ui-monospace, monospace"
export const BG = '#07090c'
export const ACCENT = '#8b8fd8'
export const GREEN = '#5fb592'
export const RED = '#d9705e'
export const AMBER = '#d6ad66'
export const MUTED = '#8995a2'
export const FG2 = '#c6ced8'
export const FG3 = '#9aa5b1'
export const FG4 = '#77828f'

export const cardStyle: React.CSSProperties = {
  background: 'rgba(200,220,240,0.03)',
  border: '1px solid rgba(200,220,240,0.07)',
  borderRadius: 6,
  padding: '16px 20px',
}

export const eyebrow: React.CSSProperties = {
  fontSize: 12, color: MUTED, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em',
}

export const SPEED_COLORS = ['#d6ad66', '#7cc3dc', '#b49fdb', '#dd9562']

const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '')

/** Last value in display units: price, yield in %, spread in bp. */
export function fmtLast(v: number | null | undefined, unit: string): string {
  if (v == null) return '—'
  if (unit === 'pct') return `${v.toFixed(3)}%`
  if (unit === 'bp') return `${v.toFixed(1)}`
  const a = Math.abs(v)
  return v.toFixed(a >= 1000 ? 1 : a >= 10 ? 2 : 4)
}

/** One-week change: % for prices, bp for yields and spreads. */
export function fmtChg(v: number | null | undefined, unit: string): string {
  if (v == null) return '—'
  if (unit === 'price') return `${sign(v)}${Math.abs(v).toFixed(2)}%`
  if (unit === 'level') return `${sign(v)}${Math.abs(v).toFixed(3)}`
  return `${sign(v)}${Math.abs(v).toFixed(1)}bp`
}

export function fmtSigned(v: number | null | undefined, dp = 0, suffix = ''): string {
  if (v == null) return '—'
  return `${sign(v)}${Math.abs(v).toFixed(dp)}${suffix}`
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null) return '—'
  const a = Math.abs(v)
  if (a >= 1e9) return `${sign(v)}$${(a / 1e9).toFixed(1)}bn`
  if (a >= 1e6) return `${sign(v)}$${(a / 1e6).toFixed(0)}m`
  if (a >= 1e3) return `${sign(v)}$${(a / 1e3).toFixed(0)}k`
  return `${sign(v)}$${a.toFixed(0)}`
}

export function fmtCount(v: number | null | undefined): string {
  if (v == null) return '—'
  const a = Math.abs(v)
  return `${sign(v)}${a >= 1e4 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0)}`
}

/** Fill for a value on a diverging scale, saturating at `cap`. */
export function divergingFill(v: number | null | undefined, cap: number): string {
  if (v == null) return 'transparent'
  const t = Math.min(1, Math.abs(v) / cap)
  const alpha = Math.round(16 + t * 150).toString(16).padStart(2, '0')
  return `${v >= 0 ? GREEN : RED}${alpha}`
}

export function regimeStyle(regime: string, direction: number): { color: string; text: string } {
  const arrow = direction > 0 ? '↑' : direction < 0 ? '↓' : ''
  const dirColor = direction > 0 ? GREEN : direction < 0 ? RED : FG3
  switch (regime) {
    case 'Strong momentum': return { color: dirColor, text: `Strong momentum ${arrow}` }
    case 'Momentum': return { color: direction > 0 ? '#9dd6bd' : '#ecaa9c', text: `Momentum ${arrow}` }
    case 'Fading': return { color: FG3, text: `Fading ${arrow}` }
    case 'Reversal': return { color: AMBER, text: `Reversal ${arrow}` }
    case 'Range': return { color: FG3, text: 'Range' }
    default: return { color: FG4, text: `Mixed ${arrow}`.trim() }
  }
}

export const REGIME_HELP: Record<string, string> = {
  'Strong momentum': 'All four speeds agree and the average signal is above 1.5σ.',
  'Momentum': 'Average signal above 0.75σ with at least three speeds agreeing.',
  'Fading': 'The slow trend is intact (|slow| ≥ 0.75σ) but the fast signal has gone flat.',
  'Reversal': 'The fast speed (≥ 1σ) points against the slow trend (≥ 0.75σ): a turn in progress.',
  'Range': 'No trend signal (|average| < 0.5σ) and a low 3-month efficiency ratio (< 0.2).',
  'Mixed': 'Speeds disagree without a clear turn.',
}
