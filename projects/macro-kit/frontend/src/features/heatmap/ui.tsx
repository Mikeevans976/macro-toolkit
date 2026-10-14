/** Building blocks shared by the regional heatmap sections. */
import type { CSSProperties, ReactNode } from 'react'
import { cardStyle } from './styles'

export const MONO = "'Geist Mono', ui-monospace, monospace"
export const C = {
  text: '#e4eaf1', body: '#c3ccd6', soft: '#c6ced8', muted: '#8995a2', faint: '#77828f',
  gold: '#d6ad66', green: '#6fc2a2', red: '#e2826f', blue: '#86c0de', violet: '#b49fdb',
  grid: 'rgba(200,220,240,0.05)', axis: 'rgba(200,220,240,0.08)', zero: 'rgba(200,220,240,0.12)',
  hair: 'rgba(200,220,240,0.04)', hair2: 'rgba(200,220,240,0.07)',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2024-03-28" → "Mar '24" (string maths, so no timezone shifts). */
export function monthLabel(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} '${iso.slice(2, 4)}`
}

/** First date of every `every`-th month in a daily ISO date list (axis ticks). */
export function monthTicks(dates: string[], every = 3): string[] {
  const out: string[] = []
  let last = ''
  let n = 0
  for (const d of dates) {
    const ym = d.slice(0, 7)
    if (ym !== last) {
      if (n % every === 0) out.push(d)
      last = ym
      n++
    }
  }
  return out
}

export const signed = (v: number, dp = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(dp)}`

export const axisTick = { fill: C.muted, fontSize: 9, fontFamily: MONO }
export const tooltipStyle: CSSProperties = {
  background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6,
  fontSize: 11, fontFamily: MONO, color: C.text,
}

/** Shared props for a date X axis over daily ISO dates. */
export function dateAxis(dates: string[], every = 3) {
  return {
    dataKey: 'date', ticks: monthTicks(dates, every), tickFormatter: monthLabel, tick: axisTick,
    tickLine: false, axisLine: { stroke: C.axis }, interval: 0 as const,
  }
}

export function Card({ title, subtitle, right, children, flush }: {
  title: ReactNode; subtitle?: ReactNode; right?: ReactNode; children: ReactNode; flush?: boolean
}) {
  return (
    <section style={flush ? { ...cardStyle, padding: 0, overflow: 'hidden' } : cardStyle}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
        ...(flush ? { padding: '16px 20px 12px', borderBottom: '1px solid rgba(200,220,240,0.06)' } : { marginBottom: 20 }),
      }}>
        <div>
          <h2 style={{ color: C.text, fontSize: 14, fontWeight: 500, letterSpacing: '-0.01em', margin: 0 }}>{title}</h2>
          {subtitle && <p style={{ color: C.muted, fontSize: 12, margin: '4px 0 0' }}>{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

export function Stat({ label, value, color = C.soft, big }: { label: string; value: ReactNode; color?: string; big?: boolean }) {
  return (
    <div style={{ background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6, padding: '6px 12px', textAlign: 'center' }}>
      <div style={{ color: C.muted, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
      <div style={{ color, fontSize: big ? 20 : 13, fontFamily: MONO, fontWeight: 600 }}>{value}</div>
    </div>
  )
}

export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p style={{ color: C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px', ...style }}>{children}</p>
}

export function Note({ children }: { children: ReactNode }) {
  return <p style={{ color: C.faint, fontSize: 9, margin: '8px 0 0', fontStyle: 'italic' }}>{children}</p>
}

export function LegendRow({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
      {items.map(it => (
        <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={it.dashed ? { width: 20, borderTop: `2px dashed ${it.color}` } : { width: 20, height: 2, borderRadius: 1, background: it.color }} />
          <span style={{ color: C.muted, fontSize: 10 }}>{it.label}</span>
        </div>
      ))}
    </div>
  )
}

export const th = (align: 'left' | 'right' = 'right'): CSSProperties => ({
  textAlign: align, color: C.muted, fontWeight: 600, fontSize: 10, padding: '4px 8px 6px',
  borderBottom: `1px solid ${C.hair2}`, whiteSpace: 'nowrap',
})
export const td = (align: 'left' | 'right' = 'right', extra: CSSProperties = {}): CSSProperties => ({
  textAlign: align, padding: '5px 8px', borderBottom: `1px solid ${C.hair}`,
  fontFamily: align === 'right' ? MONO : undefined, ...extra,
})

/** Rows of {date, ...series} for Recharts from parallel arrays. */
export function zipSeries(dates: string[], series: Record<string, (number | null)[]>): Record<string, string | number | null>[] {
  return dates.map((date, i) => {
    const row: Record<string, string | number | null> = { date }
    for (const [k, v] of Object.entries(series)) row[k] = v[i]
    return row
  })
}
