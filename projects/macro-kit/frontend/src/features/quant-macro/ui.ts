import type React from 'react'
import { fg, fontNum, line, neg, pos } from '../../theme'

export const BG = '#07090c'

// News groups: the house hues stepped to pass the categorical checks on the dark
// surface (lightness band, chroma floor, CVD ΔE ≥ 8 between stack neighbours).
export const GROUP_ORDER = ['Activity', 'Surveys', 'Labour', 'Housing & credit'] as const
export const GROUP_COLOR: Record<string, string> = {
  Activity: '#3b8fd0',
  Surveys: '#c27f20',
  Labour: '#a07ae0',
  'Housing & credit': '#2fa37a',
}
// Backtest models reuse the first three slots in the same fixed order.
export const MODEL_COLOR = { dfm: '#3b8fd0', bridge: '#c27f20', naive: '#a07ae0' } as const

export const card: React.CSSProperties = {
  background: 'rgba(200,220,240,0.03)',
  border: `1px solid ${line}`,
  borderRadius: 6,
  padding: 16,
  minWidth: 0,
}

export const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: fg[3], marginBottom: 10,
}

export const th: React.CSSProperties = {
  color: fg[4], fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
  padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap', borderBottom: `1px solid ${line}`,
}

export const td: React.CSSProperties = {
  padding: '5px 8px', textAlign: 'right', fontFamily: fontNum, fontSize: 12, color: fg[2], whiteSpace: 'nowrap',
}

export const tdText: React.CSSProperties = { ...td, textAlign: 'left', fontFamily: 'inherit' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026Q3' → 'Q3 2026' */
export const quarterLabel = (q: string) => `${q.slice(4)} ${q.slice(0, 4)}`
/** '2026-09' → 'Sep 26' */
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`
/** '2026-11-12' → '12 Nov' (calendar dates are parsed as text, never through Date) */
export const dayLabel = (d: string | null | undefined) =>
  d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : '—'

export const num = (x: number | null | undefined, d = 2) => (x == null ? '—' : x.toFixed(d))
export const signed = (x: number | null | undefined, d = 2) =>
  x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`
export const signColor = (x: number | null | undefined, eps = 0.005) =>
  x == null || Math.abs(x) < eps ? fg[2] : x > 0 ? pos : neg

export const STATUS_LABEL: Record<string, string> = {
  released: 'Released', backcast: 'Backcast', nowcast: 'Nowcast', forecast: 'Forecast',
}
