import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  ScatterChart,
  Scatter,
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface CurvePoint {
  start: number
  label: string
  rate: number
}

interface CurveGroup {
  color: string
  points: CurvePoint[]
}

interface RVRow {
  label: string
  group: string        // "curve" | "fly"
  value_bps: number
  d1d_bps: number | null
  d1w_bps: number | null
  d1m_bps: number | null
  zscore_1y: number
  pctile_1y: number
  vol3m_bps: number
  carry1y_bps: number
  carry_vol_ratio: number | null
}

interface BetaRow {
  label: string
  group: string
  beta_1y10y_fwd: number
  beta_2y1y_fwd: number
  beta_1m10y_vol: number
  beta_1y10y_vol: number
  r2: number
  residual_zscore: number
}

interface SeriesPoint {
  date: string
  value: number
}

interface SwapsRVData {
  as_of: string
  min_date: string
  max_date: string
  curve_snapshot: Record<string, CurveGroup>
  rv_monitor: RVRow[]
  beta_monitor: BetaRow[]
  series: Record<string, SeriesPoint[]>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zscoreStyle(z: number): { background: string; color: string; fontWeight?: string } {
  if (z > 1.5)  return { background: 'rgba(239,68,68,0.12)',  color: '#f87171' }
  if (z > 0.75) return { background: 'rgba(245,158,11,0.12)', color: '#fbbf24' }
  if (z < -1.5) return { background: 'rgba(16,185,129,0.12)', color: '#34d399' }
  if (z < -0.75)return { background: 'rgba(16,185,129,0.07)', color: '#6ee7b7' }
  return { background: 'transparent', color: '#94a3b8' }
}

function pctileBarColor(p: number): string {
  if (p > 75) return '#f87171'
  if (p < 25) return '#34d399'
  return '#fbbf24'
}

function r2Color(r2: number): string {
  if (r2 >= 0.6) return '#34d399'
  if (r2 >= 0.3) return '#fbbf24'
  return '#f87171'
}

function changeCellStyle(v: number | null): { color: string } {
  if (v === null) return { color: '#475569' }
  return { color: v > 0 ? '#f87171' : v < 0 ? '#34d399' : '#94a3b8' }
}

function fmtChange(v: number | null): string {
  if (v === null) return '—'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(1)} bp`
}

function fmtBeta(v: number): string {
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(3)}`
}

// ─── Carry/Vol vs Z-score Chart ───────────────────────────────────────────────

interface ChartDatum {
  x: number
  y: number
  label: string
  group: string
  beta: number
  value_bps: number
  carry1y_bps: number
  vol3m_bps: number
}

function bubbleRadius(beta: number): number {
  return Math.max(5, Math.min(20, Math.abs(beta) * 14 + 4))
}

const CURVE_COLOR = '#3b82f6'   // blue
const FLY_COLOR   = '#10b981'   // emerald

const BETA_VARS: { key: keyof BetaRow; label: string }[] = [
  { key: 'beta_1y10y_fwd',  label: '1y10y Fwd' },
  { key: 'beta_2y1y_fwd',   label: '2y1y Fwd'  },
  { key: 'beta_1m10y_vol',  label: '1m10y Vol'  },
  { key: 'beta_1y10y_vol',  label: '1y10y Vol'  },
]

function makeShape(isFly: boolean, focusLabel: string | null, onBubbleClick: (label: string) => void) {
  const baseColor = isFly ? FLY_COLOR : CURVE_COLOR
  return function Shape(props: any) {
    const { cx, cy, payload } = props
    const r = bubbleRadius(payload.beta ?? 0)
    const isFocused  = focusLabel === null || focusLabel === payload.label
    const isSelected = focusLabel === payload.label
    const radius = isSelected ? r + 2 : r
    return (
      <g opacity={isFocused ? 1 : 0.15} style={{ cursor: 'pointer' }} onClick={() => onBubbleClick(payload.label)}>
        <circle cx={cx} cy={cy} r={radius} fill={baseColor} stroke={isSelected ? '#fff' : baseColor}
          strokeWidth={isSelected ? 1.5 : 0} strokeOpacity={0.6} fillOpacity={isSelected ? 1 : 0.82} />
        <text x={cx + radius + 4} y={cy} dominantBaseline="middle"
          fontSize={isSelected ? 10 : 9} fontWeight={isSelected ? 700 : 400}
          fill={isSelected ? '#f1f5f9' : '#94a3b8'}
          style={{ pointerEvents: 'none', userSelect: 'none' }}>{payload.label}</text>
      </g>
    )
  }
}

function makeCarryVolTooltip(betaVarLabel: string) {
  return function CarryVolTooltip({ active, payload }: any) {
    if (!active || !payload?.length) return null
    const d: ChartDatum = payload[0].payload
    const betaLbl = `β ${betaVarLabel}`.padEnd(12)
    return (
      <div style={{
        background: 'rgba(8,13,26,0.96)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8,
        padding: '10px 14px',
        fontSize: 12,
      }}>
        <div style={{ color: '#e2e8f0', fontWeight: 600, marginBottom: 6, fontFamily: 'monospace' }}>{d.label}</div>
        <div style={{ color: '#64748b' }}>Z-score (1y)&nbsp;&nbsp;<span style={{ color: '#f1f5f9' }}>{d.x.toFixed(2)}</span></div>
        <div style={{ color: '#64748b' }}>C/V ratio&nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: d.y > 0 ? '#34d399' : '#f87171' }}>{d.y.toFixed(2)}</span></div>
        <div style={{ color: '#64748b' }}>Carry (1y)&nbsp;&nbsp;&nbsp;<span style={{ color: '#cbd5e1' }}>{d.carry1y_bps.toFixed(1)} bp</span></div>
        <div style={{ color: '#64748b' }}>3m RVol&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: '#cbd5e1' }}>{d.vol3m_bps.toFixed(1)} bp</span></div>
        <div style={{ color: '#64748b' }}>Level&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: '#cbd5e1' }}>{d.value_bps.toFixed(1)} bp</span></div>
        <div style={{ color: '#64748b' }}>{betaLbl}&nbsp;<span style={{ color: '#cbd5e1' }}>{d.beta.toFixed(3)}</span></div>
      </div>
    )
  }
}

const CHART_H = 440
const CHART_MARGIN = { top: 16, right: 100, bottom: 44, left: 56 }

function CarryVolChart({ rvMonitor, betaMonitor, focusLabel, onBubbleClick, betaVar, groupFilter }: {
  rvMonitor: RVRow[]
  betaMonitor: BetaRow[]
  focusLabel: string | null
  onBubbleClick: (label: string) => void
  betaVar: string
  groupFilter: 'all' | 'curve' | 'fly'
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  // drag stores pixel coords relative to the overlay div (= plot area)
  const [drag, setDrag] = useState<{ px1: number; py1: number; px2: number; py2: number } | null>(null)
  const [zoomDomain, setZoomDomain] = useState<{ x: [number, number]; y: [number, number] } | null>(null)
  const [zoomMode, setZoomMode] = useState(false)

  const betaByLabel = useMemo(
    () => Object.fromEntries(betaMonitor.map(b => [b.label, b])),
    [betaMonitor],
  )

  const betaVarLabel = BETA_VARS.find(b => b.key === betaVar)?.label ?? betaVar

  const allData = useMemo<ChartDatum[]>(() =>
    rvMonitor
      .filter(r => r.carry_vol_ratio !== null)
      .filter(r => groupFilter === 'all' || r.group === groupFilter)
      .map(r => ({
        x: r.zscore_1y,
        y: r.carry_vol_ratio as number,
        label: r.label,
        group: r.group,
        beta: (betaByLabel[r.label]?.[betaVar as keyof BetaRow] as number) ?? 0,
        value_bps: r.value_bps,
        carry1y_bps: r.carry1y_bps,
        vol3m_bps: r.vol3m_bps,
      })),
    [rvMonitor, betaByLabel, betaVar, groupFilter],
  )

  const TooltipContent = useMemo(() => makeCarryVolTooltip(betaVarLabel), [betaVarLabel])

  const curves = allData.filter(d => d.group === 'curve')
  const flies  = allData.filter(d => d.group === 'fly')

  const curveShape = useMemo(() => makeShape(false, focusLabel, onBubbleClick), [focusLabel, onBubbleClick])
  const flyShape   = useMemo(() => makeShape(true,  focusLabel, onBubbleClick), [focusLabel, onBubbleClick])

  const xs = allData.map(d => d.x)
  const ys = allData.map(d => d.y)
  const xPad = 0.4, yPad = 0.5
  const baseXMin = xs.length ? Math.min(...xs) - xPad : -3
  const baseXMax = xs.length ? Math.max(...xs) + xPad : 3
  const baseYMin = ys.length ? Math.min(...ys) - yPad : -2
  const baseYMax = ys.length ? Math.max(...ys) + yPad : 2

  const [xLo, xHi] = zoomDomain?.x ?? [baseXMin, baseXMax]
  const [yLo, yHi] = zoomDomain?.y ?? [baseYMin, baseYMax]

  // ── Overlay-based drag-to-zoom ─────────────────────────────────────────────
  function handleOverlayMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    setDrag({ px1: px, py1: py, px2: px, py2: py })
    e.preventDefault()
  }

  function handleOverlayMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!drag) return
    const rect = e.currentTarget.getBoundingClientRect()
    setDrag(d => d ? { ...d, px2: e.clientX - rect.left, py2: e.clientY - rect.top } : null)
  }

  function handleOverlayMouseUp() {
    if (drag && overlayRef.current) {
      const w = overlayRef.current.clientWidth
      const h = overlayRef.current.clientHeight
      const rx1 = Math.min(drag.px1, drag.px2) / w
      const rx2 = Math.max(drag.px1, drag.px2) / w
      const ry1 = Math.min(drag.py1, drag.py2) / h
      const ry2 = Math.max(drag.py1, drag.py2) / h
      // Only zoom if selection is non-trivial (>2% of plot area)
      if (rx2 - rx1 > 0.02 || ry2 - ry1 > 0.02) {
        setZoomDomain({
          x: [xLo + rx1 * (xHi - xLo), xLo + rx2 * (xHi - xLo)],
          // screen y is inverted: top = yHi, bottom = yLo
          y: [yHi - ry2 * (yHi - yLo), yHi - ry1 * (yHi - yLo)],
        })
      }
    }
    setDrag(null)
  }

  return (
    <div>
      {/* Zoom controls */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4, gap: 8 }}>
        <button
          onClick={() => { setZoomMode(z => !z); setDrag(null) }}
          style={{
            background: zoomMode ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.06)',
            border: zoomMode ? '1px solid rgba(59,130,246,0.4)' : '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6, color: zoomMode ? '#93c5fd' : '#64748b',
            fontSize: 11, padding: '3px 10px', cursor: 'pointer',
          }}
        >
          {zoomMode ? '✕ Exit zoom' : '⊕ Zoom'}
        </button>
        {zoomDomain && (
          <button
            onClick={() => setZoomDomain(null)}
            style={{
              background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)',
              borderRadius: 6, color: '#93c5fd', fontSize: 11, padding: '3px 10px', cursor: 'pointer',
            }}
          >
            ↺ Reset zoom
          </button>
        )}
      </div>

      {/* Chart + overlay wrapper */}
      <div style={{ position: 'relative', width: '100%', height: CHART_H }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis
              type="number" dataKey="x" name="Z-score"
              domain={[xLo, xHi]} allowDataOverflow
              stroke="#475569" tick={{ fill: '#64748b', fontSize: 11 }}
              tickFormatter={(v: number) => v.toFixed(1)}
              label={{ value: '1Y Z-score of level', position: 'insideBottom', offset: -28, fill: '#475569', fontSize: 11 }}
            />
            <YAxis
              type="number" dataKey="y" name="C/V"
              domain={[yLo, yHi]} allowDataOverflow
              stroke="#475569" tick={{ fill: '#64748b', fontSize: 11 }}
              tickFormatter={(v: number) => v.toFixed(1)}
              label={{ value: '1y carry / 3m realised vol', angle: -90, position: 'insideLeft', offset: -40, fill: '#475569', fontSize: 11 }}
            />
            <Tooltip content={<TooltipContent />} cursor={false} />
            {/* quadrant shading */}
            <ReferenceArea x1={0} x2={xHi} y1={0} y2={yHi}
              fill="rgba(52,211,153,0.025)"
              label={{ value: 'Receive / Flatten ↗', position: 'insideTopRight', fill: '#34d39966', fontSize: 10, fontStyle: 'italic' }}
            />
            <ReferenceArea x1={xLo} x2={0} y1={yLo} y2={0}
              fill="rgba(248,113,113,0.025)"
              label={{ value: '↙ Pay / Steepen', position: 'insideBottomLeft', fill: '#f8717166', fontSize: 10, fontStyle: 'italic' }}
            />
            <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
            <Scatter data={curves} shape={curveShape} isAnimationActive={false} />
            <Scatter data={flies}  shape={flyShape}   isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>

        {/* Transparent overlay covering exactly the plot area.
            pointer-events:all only in zoom mode so bubbles stay clickable otherwise. */}
        <div
          ref={overlayRef}
          style={{
            position: 'absolute',
            left: CHART_MARGIN.left,
            top: CHART_MARGIN.top,
            right: CHART_MARGIN.right,
            bottom: CHART_MARGIN.bottom,
            cursor: drag ? 'crosshair' : (zoomMode ? 'zoom-in' : 'default'),
            pointerEvents: zoomMode ? 'all' : 'none',
            userSelect: 'none',
          }}
          onMouseDown={handleOverlayMouseDown}
          onMouseMove={handleOverlayMouseMove}
          onMouseUp={handleOverlayMouseUp}
          onMouseLeave={() => setDrag(null)}
        >
          {/* CSS selection rectangle — no coordinate conversion needed */}
          {drag && (
            <div style={{
              position: 'absolute',
              left: Math.min(drag.px1, drag.px2),
              top: Math.min(drag.py1, drag.py2),
              width: Math.abs(drag.px2 - drag.px1),
              height: Math.abs(drag.py2 - drag.py1),
              background: 'rgba(59,130,246,0.12)',
              border: '1px solid rgba(59,130,246,0.5)',
              pointerEvents: 'none',
            }} />
          )}
        </div>
      </div>

      {/* legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, justifyContent: 'center', marginTop: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width={14} height={14}><circle cx={7} cy={7} r={6} fill={CURVE_COLOR} fillOpacity={0.82} /></svg>
          <span style={{ color: '#64748b', fontSize: 11 }}>Curves</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width={14} height={14}><circle cx={7} cy={7} r={6} fill={FLY_COLOR} fillOpacity={0.82} /></svg>
          <span style={{ color: '#64748b', fontSize: 11 }}>Flies</span>
        </div>
        <span style={{ color: '#334155', fontSize: 10, fontStyle: 'italic' }}>
          Bubble size = |β {betaVarLabel}| &nbsp;·&nbsp; Positive carry → receiver/flattener
        </span>
      </div>
    </div>
  )
}

// ─── Structure Selector ───────────────────────────────────────────────────────

function StructureSelect({ rvMonitor, value, onChange, label = 'Focus on', includeGroups = false }: {
  rvMonitor: RVRow[]
  value: string | null
  onChange: (label: string | null) => void
  label?: string
  includeGroups?: boolean
}) {
  const curves = rvMonitor.filter(r => r.group === 'curve')
  const flies  = rvMonitor.filter(r => r.group === 'fly')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ color: '#475569', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          color: '#e2e8f0',
          fontSize: 12,
          padding: '5px 10px',
          outline: 'none',
          cursor: 'pointer',
          colorScheme: 'dark',
          minWidth: 200,
        }}
      >
        <option value="">All structures</option>
        {includeGroups && <option value="__all_curves__">── All Curves</option>}
        {includeGroups && <option value="__all_flies__">── All Flies</option>}
        <optgroup label="Curves">
          {curves.map(r => <option key={r.label} value={r.label}>{r.label}</option>)}
        </optgroup>
        <optgroup label="Flies">
          {flies.map(r => <option key={r.label} value={r.label}>{r.label}</option>)}
        </optgroup>
      </select>
      {value && (
        <button onClick={() => onChange(null)}
          style={{ color: '#475569', fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          ✕ clear
        </button>
      )}
    </div>
  )
}

// ─── Detail Chart ─────────────────────────────────────────────────────────────

function DetailTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{
      background: 'rgba(8,13,26,0.96)',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8,
      padding: '8px 12px',
      fontSize: 12,
    }}>
      <div style={{ color: '#64748b', marginBottom: 2 }}>{d.date}</div>
      <div style={{ color: '#f1f5f9', fontVariantNumeric: 'tabular-nums' }}>{(d.value as number).toFixed(1)} bp</div>
    </div>
  )
}

function fmtAxisDate(d: string): string {
  const dt = new Date(d)
  return dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
}

function DetailChart({ label, seriesData, rvRow, rvMonitor, onBack, onSwitch }: {
  label: string
  seriesData: SeriesPoint[]
  rvRow: RVRow
  rvMonitor: RVRow[]
  onBack: () => void
  onSwitch: (label: string) => void
}) {
  const values = seriesData.map(d => d.value)
  const mean   = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  const std    = Math.sqrt(variance)

  const refLines = [
    { y: mean + 2 * std, color: '#ef4444', dash: '3 3', tag: '+2σ' },
    { y: mean + std,     color: '#f59e0b', dash: '3 3', tag: '+1σ' },
    { y: mean,           color: 'rgba(255,255,255,0.45)', dash: '5 3', tag: 'μ' },
    { y: mean - std,     color: '#10b981', dash: '3 3', tag: '-1σ' },
    { y: mean - 2 * std, color: '#34d399', dash: '3 3', tag: '-2σ' },
  ]

  const stats = [
    { label: 'Current',   value: `${values[values.length - 1].toFixed(1)} bp`, color: '#f1f5f9' },
    { label: '1y Mean',   value: `${mean.toFixed(1)} bp`,                      color: '#94a3b8' },
    { label: '1y Std',    value: `${std.toFixed(1)} bp`,                       color: '#94a3b8' },
    { label: 'Z-score',   value: rvRow.zscore_1y.toFixed(2),                   color: zscoreStyle(rvRow.zscore_1y).color },
    { label: 'Carry (1y)',value: `${rvRow.carry1y_bps.toFixed(1)} bp`,         color: rvRow.carry1y_bps > 0 ? '#34d399' : '#f87171' },
    { label: '3m RVol',   value: `${rvRow.vol3m_bps.toFixed(1)} bp`,           color: '#94a3b8' },
    { label: 'C/V',       value: rvRow.carry_vol_ratio !== null ? rvRow.carry_vol_ratio.toFixed(2) : '—',
      color: (rvRow.carry_vol_ratio ?? 0) > 0 ? '#34d399' : '#f87171' },
  ]

  const tickInterval = Math.max(1, Math.floor(seriesData.length / 6))

  return (
    <div>
      {/* Header row: back + selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <button
          onClick={onBack}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 8, padding: '5px 12px',
            color: '#94a3b8', fontSize: 12, cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#e2e8f0' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#94a3b8' }}
        >
          ← Overview
        </button>
        <StructureSelect rvMonitor={rvMonitor} value={label} onChange={(l) => l && onSwitch(l)} label="Structure" includeGroups={false} />
        <span style={{
          fontFamily: 'monospace', fontWeight: 700, fontSize: 15, color: '#e2e8f0',
          background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)',
          borderRadius: 6, padding: '3px 10px',
        }}>{label}</span>
        <span style={{ color: '#475569', fontSize: 12 }}>{rvRow.group}</span>
      </div>

      {/* Stats strip */}
      <div style={{
        display: 'flex', gap: 0, marginBottom: 24,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 10, overflow: 'hidden',
      }}>
        {stats.map(({ label: lbl, value, color }, i) => (
          <div key={lbl} style={{
            flex: 1, padding: '12px 16px', textAlign: 'center',
            borderRight: i < stats.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
          }}>
            <div style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{lbl}</div>
            <div style={{ color, fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Line chart */}
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={seriesData} margin={{ top: 10, right: 56, bottom: 36, left: 48 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="date" stroke="#475569" tick={{ fill: '#64748b', fontSize: 10 }}
            tickFormatter={fmtAxisDate} interval={tickInterval}
            label={{ value: 'Date', position: 'insideBottom', offset: -24, fill: '#475569', fontSize: 11 }}
          />
          <YAxis
            stroke="#475569" tick={{ fill: '#64748b', fontSize: 11 }}
            tickFormatter={(v: number) => v.toFixed(0)} domain={['auto', 'auto']} width={44}
            label={{ value: 'Level (bp)', angle: -90, position: 'insideLeft', offset: -32, fill: '#475569', fontSize: 11 }}
          />
          <Tooltip content={<DetailTooltip />} />
          {refLines.map(({ y, color, dash, tag }) => (
            <ReferenceLine key={tag} y={y} stroke={color} strokeDasharray={dash} strokeWidth={1.2}
              label={{ value: tag, position: 'right', fill: color, fontSize: 9, fontWeight: 600 }}
            />
          ))}
          <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>

      {/* Reference key */}
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        {refLines.map(({ tag, color }) => (
          <div key={tag} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 20, height: 1.5, background: color, borderRadius: 1 }} />
            <span style={{ color: '#475569', fontSize: 10 }}>{tag}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: 24,
}

const thStyle: React.CSSProperties = {
  color: '#64748b',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  padding: '8px 12px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const tdBase: React.CSSProperties = {
  padding: '7px 12px',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
}

const groupHeaderTd: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)',
  color: '#475569',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  paddingLeft: 12,
  paddingTop: 6,
  paddingBottom: 6,
  fontWeight: 600,
}

// ─── RV Monitor Table ─────────────────────────────────────────────────────────

function RVMonitorTable({ rows }: { rows: RVRow[] }) {
  type SortKey = keyof RVRow
  const [sortKey, setSortKey] = useState<SortKey>('zscore_1y')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  function sortedRows(items: RVRow[]) {
    return [...items].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity
      const bv = b[sortKey] ?? -Infinity
      const cmp = typeof av === 'string'
        ? (av as string).localeCompare(bv as string)
        : (av as number) - (bv as number)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }

  const curves = sortedRows(rows.filter(r => r.group === 'curve'))
  const flies  = sortedRows(rows.filter(r => r.group === 'fly'))

  const renderRows = (items: RVRow[]) =>
    items.map((row) => {
      const zStyle   = zscoreStyle(row.zscore_1y)
      const barColor = pctileBarColor(row.pctile_1y)
      return (
        <tr
          key={row.label}
          style={{ cursor: 'default' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          <td style={{ ...tdBase, fontFamily: 'monospace', color: '#e2e8f0', textAlign: 'left' }}>{row.label}</td>
          <td style={{ ...tdBase, color: '#ffffff', textAlign: 'right' }}>{row.value_bps.toFixed(1)}</td>
          <td style={{ ...tdBase, ...changeCellStyle(row.d1d_bps), textAlign: 'right' }}>{fmtChange(row.d1d_bps)}</td>
          <td style={{ ...tdBase, ...changeCellStyle(row.d1w_bps), textAlign: 'right' }}>{fmtChange(row.d1w_bps)}</td>
          <td style={{ ...tdBase, ...changeCellStyle(row.d1m_bps), textAlign: 'right' }}>{fmtChange(row.d1m_bps)}</td>
          <td style={{ ...tdBase, color: '#94a3b8', textAlign: 'right' }}>{row.vol3m_bps.toFixed(1)}</td>
          <td style={{
            ...tdBase,
            textAlign: 'right',
            color: row.carry1y_bps > 0 ? '#34d399' : row.carry1y_bps < 0 ? '#f87171' : '#94a3b8',
          }}>{row.carry1y_bps.toFixed(1)}</td>
          <td style={{
            ...tdBase,
            textAlign: 'right',
            color: row.carry_vol_ratio === null
              ? '#475569'
              : row.carry_vol_ratio > 0 ? '#34d399' : row.carry_vol_ratio < 0 ? '#f87171' : '#94a3b8',
            fontWeight: row.carry_vol_ratio !== null && Math.abs(row.carry_vol_ratio) >= 0.5 ? 600 : 400,
          }}>{row.carry_vol_ratio === null ? '—' : row.carry_vol_ratio.toFixed(2)}</td>
          <td style={{ ...tdBase, ...zStyle, textAlign: 'right', borderRadius: 4 }}>{row.zscore_1y.toFixed(2)}</td>
          <td style={{ ...tdBase, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
              <span style={{ color: '#cbd5e1' }}>{row.pctile_1y.toFixed(1)}</span>
              <div style={{ width: 60, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${row.pctile_1y}%`, height: '100%', background: barColor, borderRadius: 2 }} />
              </div>
            </div>
          </td>
        </tr>
      )
    })

  const columns: { label: string; key: SortKey; align: 'left' | 'right' }[] = [
    { label: 'Expression',  key: 'label',           align: 'left' },
    { label: 'Value (bp)',  key: 'value_bps',        align: 'right' },
    { label: 'Δ1d',         key: 'd1d_bps',          align: 'right' },
    { label: 'Δ1w',         key: 'd1w_bps',          align: 'right' },
    { label: 'Δ1m',         key: 'd1m_bps',          align: 'right' },
    { label: '3m RVol',     key: 'vol3m_bps',        align: 'right' },
    { label: 'Carry (bp)',  key: 'carry1y_bps',      align: 'right' },
    { label: 'C/V',         key: 'carry_vol_ratio',  align: 'right' },
    { label: 'Z-score',     key: 'zscore_1y',        align: 'right' },
    { label: '%ile',        key: 'pctile_1y',        align: 'right' },
  ]

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} onClick={() => handleSort(col.key)}
                style={{
                  ...thStyle,
                  textAlign: col.align,
                  cursor: 'pointer',
                  userSelect: 'none',
                  color: sortKey === col.key ? '#93c5fd' : '#64748b',
                }}
              >
                {col.label}{sortKey === col.key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr><td colSpan={10} style={groupHeaderTd}>Curves</td></tr>
          {renderRows(curves)}
          <tr><td colSpan={10} style={{ ...groupHeaderTd, paddingTop: 12 }}>Flies</td></tr>
          {renderRows(flies)}
        </tbody>
      </table>
    </div>
  )
}

// ─── Beta Monitor Table ───────────────────────────────────────────────────────

function BetaMonitorTable({ rows }: { rows: BetaRow[] }) {
  type SortKey = keyof BetaRow
  const [sortKey, setSortKey] = useState<SortKey>('r2')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  function sortedRows(items: BetaRow[]) {
    return [...items].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity
      const bv = b[sortKey] ?? -Infinity
      const cmp = typeof av === 'string'
        ? (av as string).localeCompare(bv as string)
        : (av as number) - (bv as number)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }

  const curves = sortedRows(rows.filter(r => r.group === 'curve'))
  const flies  = sortedRows(rows.filter(r => r.group === 'fly'))

  const renderRows = (items: BetaRow[]) =>
    items.map((row) => {
      const rzStyle = zscoreStyle(row.residual_zscore)
      const r2c = r2Color(row.r2)
      return (
        <tr
          key={row.label}
          style={{ cursor: 'default' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          <td style={{ ...tdBase, fontFamily: 'monospace', color: '#e2e8f0', textAlign: 'left' }}>{row.label}</td>
          <td style={{ ...tdBase, color: '#cbd5e1', textAlign: 'right' }}>{fmtBeta(row.beta_1y10y_fwd)}</td>
          <td style={{ ...tdBase, color: '#cbd5e1', textAlign: 'right' }}>{fmtBeta(row.beta_2y1y_fwd)}</td>
          <td style={{ ...tdBase, color: '#cbd5e1', textAlign: 'right' }}>{fmtBeta(row.beta_1m10y_vol)}</td>
          <td style={{ ...tdBase, color: '#cbd5e1', textAlign: 'right' }}>{fmtBeta(row.beta_1y10y_vol)}</td>
          <td style={{ ...tdBase, color: r2c, textAlign: 'right', fontWeight: 600 }}>{Math.round(row.r2 * 100)}%</td>
          <td style={{ ...tdBase, ...rzStyle, textAlign: 'right', fontWeight: 700, borderRadius: 4 }}>{row.residual_zscore.toFixed(2)}</td>
        </tr>
      )
    })

  const columns: { label: string; key: SortKey; align: 'left' | 'right' }[] = [
    { label: 'Expression',   key: 'label',           align: 'left' },
    { label: 'β 1y10y_fwd',  key: 'beta_1y10y_fwd',  align: 'right' },
    { label: 'β 2y1y_fwd',   key: 'beta_2y1y_fwd',   align: 'right' },
    { label: 'β 1m10y_vol',  key: 'beta_1m10y_vol',  align: 'right' },
    { label: 'β 1y10y_vol',  key: 'beta_1y10y_vol',  align: 'right' },
    { label: 'R²',           key: 'r2',              align: 'right' },
    { label: 'Res. Z',       key: 'residual_zscore', align: 'right' },
  ]

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} onClick={() => handleSort(col.key)}
                style={{
                  ...thStyle,
                  textAlign: col.align,
                  cursor: 'pointer',
                  userSelect: 'none',
                  color: sortKey === col.key ? '#93c5fd' : '#64748b',
                }}
              >
                {col.label}{sortKey === col.key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr><td colSpan={8} style={groupHeaderTd}>Curves</td></tr>
          {renderRows(curves)}
          <tr><td colSpan={8} style={{ ...groupHeaderTd, paddingTop: 12 }}>Flies</td></tr>
          {renderRows(flies)}
        </tbody>
      </table>
    </div>
  )
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

// ─── Main Page ────────────────────────────────────────────────────────────────

const CURRENCIES = [
  { key: 'EUR', label: 'EUR', available: true },
  { key: 'GBP', label: 'GBP', available: false },
  { key: 'USD', label: 'USD', available: false },
]

export default function SwapsRV() {
  const [data, setData] = useState<SwapsRVData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [currency, setCurrency] = useState('EUR')
  const [selectedDate, setSelectedDate] = useState<string>('')
  const [focusLabel, setFocusLabel] = useState<string | null>(null)
  const [detailLabel, setDetailLabel] = useState<string | null>(null)
  const [betaVar, setBetaVar] = useState<string>('beta_1y10y_fwd')
  const navigate = useNavigate()

  function fetchData(isRefresh = false, date?: string) {
    const token = localStorage.getItem('access_token')
    if (!token) {
      navigate('/login', { replace: true })
      return
    }

    if (isRefresh) setRefreshing(true)
    else setLoading(true)

    const params = date ? `?date=${date}` : ''
    axios
      .get<SwapsRVData>(`/api/tools/swaps-rv${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((res) => {
        setData(res.data)
        if (!date) setSelectedDate(res.data.as_of)
      })
      .catch((err) => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        }
      })
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }

  useEffect(() => { fetchData() }, [navigate])

  return (
    <div className="min-h-screen" style={{ background: '#080d1a' }}>
      {/* Gradient overlay */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 50% -10%, rgba(59,130,246,0.06) 0%, transparent 55%)',
        }}
      />

      {/* Header */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-6 py-4"
        style={{
          background: 'rgba(8,13,26,0.85)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/')}
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-150"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.09)',
              color: '#94a3b8',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
              e.currentTarget.style.color = '#e2e8f0'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
              e.currentTarget.style.color = '#94a3b8'
            }}
          >
            ←
          </button>
          <div>
            <h1 className="text-base font-semibold text-white leading-tight">
              Swap RV Monitor
            </h1>
          </div>
        </div>

        {/* Currency toggle */}
        <div
          className="flex items-center"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: 3,
            gap: 2,
          }}
        >
          {CURRENCIES.map(({ key, label, available }) => (
            <button
              key={key}
              disabled={!available}
              onClick={() => available && setCurrency(key)}
              title={!available ? 'Coming soon' : undefined}
              style={{
                padding: '4px 14px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                border: 'none',
                cursor: available ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
                background: currency === key
                  ? 'rgba(59,130,246,0.25)'
                  : 'transparent',
                color: currency === key
                  ? '#93c5fd'
                  : available ? '#64748b' : '#334155',
                outline: currency === key ? '1px solid rgba(59,130,246,0.35)' : 'none',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {data && (
            <div className="flex items-center gap-2">
              <span style={{ color: '#475569', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                as of
              </span>
              <input
                type="date"
                value={selectedDate}
                min={data.min_date}
                max={data.max_date}
                onChange={(e) => {
                  const d = e.target.value
                  setSelectedDate(d)
                  if (d) fetchData(false, d)
                }}
                style={{
                  background: 'rgba(59,130,246,0.1)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  borderRadius: 8,
                  padding: '4px 10px',
                  color: '#93c5fd',
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  outline: 'none',
                  cursor: 'pointer',
                  colorScheme: 'dark',
                }}
              />
            </div>
          )}
          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#94a3b8',
            }}
            onMouseEnter={(e) => {
              if (!refreshing) {
                e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                e.currentTarget.style.color = '#e2e8f0'
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
              e.currentTarget.style.color = '#94a3b8'
            }}
          >
            <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>
              ↻
            </span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-32 text-slate-500 text-sm">
          <span className="animate-pulse">Loading swaps RV data…</span>
        </div>
      )}

      {/* Body */}
      {!loading && data && (
        <main
          className="relative"
          style={{
            maxWidth: '1536px',
            margin: '0 auto',
            padding: '32px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 40,
          }}
        >
          {/* A. Carry/Vol vs Z-score / Detail view */}
          <section>
            <div style={cardStyle}>
              {detailLabel && data.series[detailLabel] ? (
                <DetailChart
                  label={detailLabel}
                  seriesData={data.series[detailLabel]}
                  rvRow={data.rv_monitor.find(r => r.label === detailLabel)!}
                  rvMonitor={data.rv_monitor}
                  onBack={() => setDetailLabel(null)}
                  onSwitch={(l) => { setDetailLabel(l); setFocusLabel(l) }}
                />
              ) : (
                <>
                  {(() => {
                    const chartGroupFilter: 'all' | 'curve' | 'fly' =
                      focusLabel === '__all_curves__' ? 'curve' :
                      focusLabel === '__all_flies__'  ? 'fly'   : 'all'
                    const chartFocusLabel = (focusLabel === '__all_curves__' || focusLabel === '__all_flies__') ? null : focusLabel
                    return (
                      <>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
                          <div>
                            <h2 style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 600, margin: 0 }}>
                              Carry / Vol vs Z-score
                            </h2>
                            <p style={{ color: '#475569', fontSize: 12, marginTop: 4 }}>
                              Click a bubble to view its 1y history
                            </p>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ color: '#475569', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>Size by β</span>
                              <select value={betaVar} onChange={(e) => setBetaVar(e.target.value)} style={{
                                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                                borderRadius: 8, color: '#e2e8f0', fontSize: 12, padding: '5px 10px',
                                outline: 'none', cursor: 'pointer', colorScheme: 'dark',
                              }}>
                                {BETA_VARS.map(({ key, label }) => (
                                  <option key={key as string} value={key as string}>{label}</option>
                                ))}
                              </select>
                            </div>
                            <StructureSelect
                              rvMonitor={data.rv_monitor}
                              value={focusLabel}
                              onChange={setFocusLabel}
                              includeGroups={true}
                            />
                          </div>
                        </div>
                        <CarryVolChart
                          rvMonitor={data.rv_monitor}
                          betaMonitor={data.beta_monitor}
                          focusLabel={chartFocusLabel}
                          onBubbleClick={(l) => { setFocusLabel(l); setDetailLabel(l) }}
                          betaVar={betaVar}
                          groupFilter={chartGroupFilter}
                        />
                      </>
                    )
                  })()}
                </>
              )}
            </div>
          </section>

          {/* B. RV Monitor */}
          <section>
            <div style={cardStyle}>
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 600, margin: 0 }}>
                  RV Monitor
                </h2>
                <p style={{ color: '#475569', fontSize: 12, marginTop: 4 }}>
                  1y z-scores &amp; percentiles
                </p>
              </div>
              <RVMonitorTable rows={data.rv_monitor} />
            </div>
          </section>

          {/* C. Beta Monitor */}
          <section>
            <div style={cardStyle}>
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 600, margin: 0 }}>
                  Beta Monitor
                </h2>
                <p style={{ color: '#475569', fontSize: 12, marginTop: 4 }}>
                  OLS on 1y daily changes (bps)
                </p>
              </div>
              <BetaMonitorTable rows={data.beta_monitor} />
            </div>
          </section>
        </main>
      )}
    </div>
  )
}
