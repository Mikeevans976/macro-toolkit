import type React from 'react'
import { fg, fontNum, line, neg, pos } from '../../theme'

export const BG = '#07090c'

// News groups: the house hues stepped to pass the categorical checks on the dark
// surface (lightness band, chroma floor, CVD ΔE ≥ 8 between stack neighbours).
// Revisions to periods before the tracked window are one neutral "other" item.
export const GROUP_ORDER = ['Activity', 'Surveys', 'Labour', 'Housing & credit', 'Older revisions'] as const
export const GROUP_COLOR: Record<string, string> = {
  Activity: '#3b8fd0',
  Surveys: '#c27f20',
  Labour: '#a07ae0',
  'Housing & credit': '#2fa37a',
  'Older revisions': '#7d8792',
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

/** '2026-10-20T11:13:45' → '20 Oct 11:13' */
export const stampLabel = (t: string | null | undefined) => (t ? `${dayLabel(t.slice(0, 10))} ${t.slice(11, 16)}` : '—')

export const button: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${line}`, borderRadius: 5, color: fg[1], fontSize: 12,
  padding: '5px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
}

export const lastOf = <T,>(a: readonly T[]): T | undefined => a[a.length - 1]

export const num = (x: number | null | undefined, d = 2) => (x == null ? '—' : x.toFixed(d))
export const signed = (x: number | null | undefined, d = 2) => {
  if (x == null) return '—'
  const mag = Math.abs(x).toFixed(d)
  return `${Number(mag) === 0 ? '' : x > 0 ? '+' : '−'}${mag}`
}
export const signColor = (x: number | null | undefined, eps = 0.005) =>
  x == null || Math.abs(x) < eps ? fg[2] : x > 0 ? pos : neg

export const STATUS_LABEL: Record<string, string> = {
  released: 'Released', backcast: 'Backcast', nowcast: 'Nowcast', forecast: 'Forecast',
}
