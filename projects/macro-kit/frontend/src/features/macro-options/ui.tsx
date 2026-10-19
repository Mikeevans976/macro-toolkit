// Shared UI of the Macro Options Monitor: colours, chips, stats, axes, snapshot controls.

import { fmtSnap, londonNow, toDateInput } from './model/calendar'
import type { Market } from './model/types'

export const BG     = '#07090c'
export const CARD   = 'rgba(200,220,240,0.04)'
export const BORDER = 'rgba(200,220,240,0.08)'
export const MONO   = "'Geist Mono', ui-monospace, monospace"
export const FG1 = '#e4eaf1', FG2 = '#c6ced8', FG3 = '#9aa5b1', FG4 = '#77828f'

// Strike grid spacing (price units). 0.0625 is the listed ICE Euribor strike interval.
export const WIDTHS: { h: number; label: string }[] = [
  { h: 0.0125, label: '1.25 bp' },
  { h: 0.025,  label: '2.5 bp' },
  { h: 0.0625, label: '6.25 bp' },
  { h: 0.125,  label: '12.5 bp' },
  { h: 0.25,   label: '25 bp' },
]

export const card: React.CSSProperties = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 6 }

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: FG3, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', minWidth: 86 }}>
      {children}
    </span>
  )
}

export function Chip({ active, onClick, children, color, title }: {
  active: boolean; onClick: () => void; children: React.ReactNode; color?: string; title?: string
}) {
  const c = color ?? '#86c0de'
  return (
    <button onClick={onClick} title={title} style={{
      background: active ? `${c}1f` : 'rgba(200,220,240,0.03)',
      border: `1px solid ${active ? c : BORDER}`,
      color: active ? (color ? c : '#a9d2e8') : FG2,
      borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: active ? 600 : 400, cursor: 'pointer',
    }}>{children}</button>
  )
}

export const inputStyle: React.CSSProperties = {
  background: 'rgba(106,169,204,0.08)', border: '1px solid rgba(106,169,204,0.2)', borderRadius: 6,
  padding: '4px 10px', color: '#a9d2e8', fontSize: 12, fontFamily: MONO, outline: 'none', colorScheme: 'dark',
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: '10px 14px', minWidth: 0 }}>
      <div style={{ color: FG4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ color: FG1, fontSize: 15, fontFamily: MONO, whiteSpace: 'nowrap' }}>{value}</div>
      {sub && <div style={{ color: FG4, fontSize: 10, fontFamily: MONO, marginTop: 2, whiteSpace: 'nowrap' }}>{sub}</div>}
    </div>
  )
}

// Round-number ticks spanning [lo, hi]
export function niceTicks(lo: number, hi: number, target = 6): number[] {
  if (!(hi > lo)) return [lo]
  const raw  = (hi - lo) / target
  const mag  = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6))
  return out
}

// Density axis: round ticks from 0 with the top tick at or above the peak
export function pdfAxis(peak: number): { domain: [number, number]; ticks: number[] } {
  const target = (peak > 0 ? peak : 1) * 1.04
  const t = niceTicks(0, target, 4)
  const step = t.length > 1 ? t[1] - t[0] : target
  const top = +(Math.ceil(target / step) * step).toFixed(6)
  return { domain: [0, top], ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(6)) }
}

export const peakOf = (rows: Record<string, number>[], suffix: string) =>
  rows.reduce((m, r) => Math.max(m, ...Object.entries(r).filter(([k]) => k.endsWith(suffix)).map(([, v]) => v)), 0)

export const axisProps = {
  stroke: 'rgba(150,178,205,0.14)',
  tick: { fill: FG3, fontSize: 10, fontFamily: MONO },
  tickLine: false,
}

// ─── Snapshot / width controls (shared by the tabs) ───────────────────────────

const SOURCE_TEXT: Record<Market['source'], string> = {
  live: 'Live Bloomberg: mids where two-sided, else the last settlement re-struck at the live futures price',
  settlement: "That day's ICE settlement prices (Bloomberg)",
  simulation: 'Simulated option chain',
}

export function SnapshotControls({ snapDate, snapTime, onDate, onTime, onNow, h, onWidth, market, requested, showWidth = true }: {
  showWidth?: boolean
  snapDate: string; snapTime: string
  onDate: (v: string) => void; onTime: (v: string) => void; onNow: () => void
  h: number; onWidth: (h: number) => void
  market: Market; requested: Date
}) {
  const sim = market.source === 'simulation'
  const effective = market.snap
  // Bloomberg history here is daily: only the simulation honours a time of day
  const snapped = sim ? effective.getTime() !== requested.getTime() : toDateInput(effective) !== snapDate && market.source === 'settlement'
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Label>Snapshot</Label>
        <input type="date" value={snapDate} max={toDateInput(londonNow())} onChange={e => e.target.value && onDate(e.target.value)} style={inputStyle} />
        {sim && <input type="time" value={snapTime} step={300} onChange={e => e.target.value && onTime(e.target.value)} style={inputStyle} />}
        <span style={{ color: FG4, fontSize: 11 }}>{sim ? 'London' : market.source === 'live' ? `live · ${fmtSnap(effective)}` : 'settlement'}</span>
        <button onClick={onNow} style={{ ...inputStyle, background: 'rgba(200,220,240,0.05)', border: `1px solid ${BORDER}`, color: FG2, cursor: 'pointer', fontFamily: 'inherit' }}>
          Now
        </button>
        {snapped && (
          <span style={{ color: '#dfbb78', fontSize: 11 }}>
            {sim ? `Market closed — using last trade time ${fmtSnap(effective)}` : `No settlement that day — using ${toDateInput(effective)}`}
          </span>
        )}
      </div>
      {showWidth && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Label>Strike width</Label>
        {WIDTHS.map(w => (
          <Chip key={w.h} active={h === w.h} onClick={() => onWidth(w.h)}
            title={`Strike grid spacing ${w.h.toFixed(4)}${w.h === 0.0625 ? ' — listed ICE strike interval' : ''}`}>
            {w.label}
          </Chip>
        ))}
        <span style={{ color: FG4, fontSize: 11 }}>
          spacing h between strikes in the butterfly / call-spread estimators{sim ? '' : '; live prices come from a smile fitted to the listed strikes'}
        </span>
      </div>}
    </>
  )
}

/** Where the numbers come from, for footnotes */
export const sourceNote = (m: Market) => SOURCE_TEXT[m.source]

export function SourceBadge({ market }: { market: Market }) {
  const s = market.source
  const [label, c] = s === 'live' ? ['LIVE', '#6fc2a2'] : s === 'settlement' ? ['SETTLEMENT', '#86c0de'] : ['SIMULATED DATA', '#dd9562']
  return (
    <span title={market.note ?? SOURCE_TEXT[s]} style={{
      background: `${c}1f`, border: `1px solid ${c}4d`, borderRadius: 6, padding: '3px 10px', fontSize: 11, color: c,
    }}>
      {label}
    </span>
  )
}
