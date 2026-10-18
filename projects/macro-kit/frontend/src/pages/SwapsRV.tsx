import { useEffect, useMemo, useRef, useState } from 'react'
import PageTitle from '../components/PageTitle'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from 'recharts'
import ExpressionDetail, { fmtBp, type SeriesPoint, type StatGroupDef } from '../components/ExpressionDetail'
import CurveRolldown, { type CurveData, type RollLeg } from '../components/CurveRolldown'
import RegressionDetail from '../components/RegressionDetail'
import FactorNeutral from '../components/FactorNeutral'
import TradeCandidates from '../components/TradeCandidates'
import { CarryRealisationDetail, CarryRealisationSummary } from '../components/CarryBacktest'

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
  carry_vol_ratio: number | null   // carry / 3m realised vol
  ivol_bps?: number | null         // implied vol of the structure, bp/yr (null: no swaption grid)
  carry_ivol_ratio?: number | null // carry / implied vol
  legs?: RollLeg[]     // per-leg roll-down behind carry1y_bps
  set?: 'core' | 'extended'
  // Factor-neutral version (curves level-neutral, flies level- and slope-neutral)
  neutral_weights?: number[] | null
  neutral_zscore_1y?: number | null
  neutral_unstable?: boolean | null
  factor_share?: number   // share of daily variance from the hedged factors, 0–1
}

interface BetaRow {
  label: string
  group: string
  beta_1y10y_fwd: number
  beta_2y1y_fwd: number
  beta_1m10y_vol: number | null   // null when the data source has no swaption vols
  beta_1y10y_vol: number | null
  r2: number
  residual_zscore: number
}

interface SwapsRVData {
  data_source?: 'bloomberg' | 'csv'
  beta_vars?: string[]            // regressors used, e.g. ["1y10y_fwd", "2y1y_fwd"]
  as_of: string
  data_timestamp?: string | null  // ISO time of the Bloomberg pull; only for the latest live day
  min_date: string
  max_date: string
  curve_snapshot: Record<string, CurveGroup>
  curve?: CurveData                // the as-of curve carry is computed on
  rv_monitor: RVRow[]
  beta_monitor: BetaRow[]
  universe?: Universe
  implied_vol?: { source: string; grid_date: string } | null   // null: no swaption grid for this currency
}

type Universe = 'core' | 'extended'
type VolBasis = 'realised' | 'implied'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zscoreStyle(z: number): { background: string; color: string; fontWeight?: string } {
  if (z > 1.5)  return { background: 'rgba(217,112,94,0.12)',  color: '#e2826f' }
  if (z > 0.75) return { background: 'rgba(214,173,102,0.12)', color: '#dfbb78' }
  if (z < -1.5) return { background: 'rgba(88,173,142,0.12)', color: '#6fc2a2' }
  if (z < -0.75)return { background: 'rgba(88,173,142,0.07)', color: '#8fd1b6' }
  return { background: 'transparent', color: '#c6ced8' }
}

function pctileBarColor(p: number): string {
  if (p > 75) return '#e2826f'
  if (p < 25) return '#6fc2a2'
  return '#dfbb78'
}

function r2Color(r2: number): string {
  if (r2 >= 0.6) return '#6fc2a2'
  if (r2 >= 0.3) return '#dfbb78'
  return '#e2826f'
}

function changeCellStyle(v: number | null): { color: string } {
  if (v === null) return { color: '#8995a2' }
  return { color: v > 0 ? '#e2826f' : v < 0 ? '#6fc2a2' : '#c6ced8' }
}

function fmtChange(v: number | null): string {
  if (v === null) return '—'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(1)} bp`
}

function fmtBeta(v: number | null): string {
  if (v === null) return '—'
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
  ivol_bps: number | null
  cv_realised: number | null
  cv_implied: number | null
}

function bubbleRadius(beta: number): number {
  return Math.max(5, Math.min(20, Math.abs(beta) * 14 + 4))
}

const CURVE_COLOR = '#6aa9cc'   // blue
const FLY_COLOR   = '#58ad8e'   // emerald

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
        <circle cx={cx} cy={cy} r={radius} fill={baseColor} stroke={isSelected ? '#f4f7fa' : baseColor}
          strokeWidth={isSelected ? 1.5 : 0} strokeOpacity={0.6} fillOpacity={isSelected ? 1 : 0.82} />
        <text x={cx + radius + 4} y={cy} dominantBaseline="middle"
          fontSize={isSelected ? 10 : 9} fontWeight={isSelected ? 700 : 400}
          fill={isSelected ? '#eef2f6' : '#c6ced8'}
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
        background: 'rgba(7,9,12,0.96)',
        border: '1px solid rgba(200,220,240,0.12)',
        borderRadius: 6,
        padding: '10px 14px',
        fontSize: 12,
      }}>
        <div style={{ color: '#e4eaf1', fontWeight: 600, marginBottom: 6, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{d.label}</div>
        <div style={{ color: '#9aa5b1' }}>Z-score (1y)&nbsp;&nbsp;<span style={{ color: '#eef2f6' }}>{d.x.toFixed(2)}</span></div>
        <div style={{ color: '#9aa5b1' }}>C/RVol&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: (d.cv_realised ?? 0) > 0 ? '#6fc2a2' : '#e2826f' }}>{d.cv_realised?.toFixed(2) ?? '—'}</span></div>
        <div style={{ color: '#9aa5b1' }}>C/IVol&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: (d.cv_implied ?? 0) > 0 ? '#6fc2a2' : '#e2826f' }}>{d.cv_implied?.toFixed(2) ?? '—'}</span></div>
        <div style={{ color: '#9aa5b1' }}>Carry (1y)&nbsp;&nbsp;&nbsp;<span style={{ color: '#c3ccd6' }}>{d.carry1y_bps.toFixed(1)} bp</span></div>
        <div style={{ color: '#9aa5b1' }}>3m RVol&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: '#c3ccd6' }}>{d.vol3m_bps.toFixed(1)} bp</span></div>
        <div style={{ color: '#9aa5b1' }}>Implied vol&nbsp;&nbsp;<span style={{ color: '#c3ccd6' }}>{d.ivol_bps === null ? '—' : `${d.ivol_bps.toFixed(1)} bp`}</span></div>
        <div style={{ color: '#9aa5b1' }}>Level&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: '#c3ccd6' }}>{d.value_bps.toFixed(1)} bp</span></div>
        <div style={{ color: '#9aa5b1' }}>{betaLbl}&nbsp;<span style={{ color: '#c3ccd6' }}>{d.beta.toFixed(3)}</span></div>
      </div>
    )
  }
}

const CHART_H = 440
const CHART_MARGIN = { top: 16, right: 100, bottom: 44, left: 56 }

function CarryVolChart({ rvMonitor, betaMonitor, focusLabel, onBubbleClick, betaVar, groupFilter, volBasis }: {
  rvMonitor: RVRow[]
  betaMonitor: BetaRow[]
  focusLabel: string | null
  onBubbleClick: (label: string) => void
  betaVar: string
  groupFilter: 'all' | 'curve' | 'fly'
  volBasis: VolBasis
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  // drag stores pixel coords relative to the overlay div (= plot area)
  const [drag, setDrag] = useState<{ px1: number; py1: number; px2: number; py2: number } | null>(null)
  const [zoomDomain, setZoomDomain] = useState<{ x: [number, number]; y: [number, number] } | null>(null)
  const [zoomMode, setZoomMode] = useState(false)
  // A different y measure has a different range, so drop any zoom
  useEffect(() => { setZoomDomain(null) }, [volBasis])

  const betaByLabel = useMemo(
    () => Object.fromEntries(betaMonitor.map(b => [b.label, b])),
    [betaMonitor],
  )

  const betaVarLabel = BETA_VARS.find(b => b.key === betaVar)?.label ?? betaVar

  const allData = useMemo<ChartDatum[]>(() =>
    rvMonitor
      .filter(r => (volBasis === 'implied' ? r.carry_ivol_ratio : r.carry_vol_ratio) != null)
      .filter(r => groupFilter === 'all' || r.group === groupFilter)
      .map(r => ({
        x: r.zscore_1y,
        y: (volBasis === 'implied' ? r.carry_ivol_ratio : r.carry_vol_ratio) as number,
        label: r.label,
        group: r.group,
        beta: (betaByLabel[r.label]?.[betaVar as keyof BetaRow] as number) ?? 0,
        value_bps: r.value_bps,
        carry1y_bps: r.carry1y_bps,
        vol3m_bps: r.vol3m_bps,
        ivol_bps: r.ivol_bps ?? null,
        cv_realised: r.carry_vol_ratio,
        cv_implied: r.carry_ivol_ratio ?? null,
      })),
    [rvMonitor, betaByLabel, betaVar, groupFilter, volBasis],
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
            background: zoomMode ? 'rgba(106,169,204,0.25)' : 'rgba(200,220,240,0.06)',
            border: zoomMode ? '1px solid rgba(106,169,204,0.4)' : '1px solid rgba(200,220,240,0.1)',
            borderRadius: 6, color: zoomMode ? '#a9d2e8' : '#9aa5b1',
            fontSize: 11, padding: '3px 10px', cursor: 'pointer',
          }}
        >
          {zoomMode ? '✕ Exit zoom' : '⊕ Zoom'}
        </button>
        {zoomDomain && (
          <button
            onClick={() => setZoomDomain(null)}
            style={{
              background: 'rgba(106,169,204,0.15)', border: '1px solid rgba(106,169,204,0.3)',
              borderRadius: 6, color: '#a9d2e8', fontSize: 11, padding: '3px 10px', cursor: 'pointer',
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
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
            <XAxis
              type="number" dataKey="x" name="Z-score"
              domain={[xLo, xHi]} allowDataOverflow
              stroke="#8995a2" tick={{ fill: '#9aa5b1', fontSize: 11 }}
              tickFormatter={(v: number) => v.toFixed(1)}
              label={{ value: '1Y Z-score of level', position: 'insideBottom', offset: -28, fill: '#8995a2', fontSize: 11 }}
            />
            <YAxis
              type="number" dataKey="y" name="C/V"
              domain={[yLo, yHi]} allowDataOverflow
              stroke="#8995a2" tick={{ fill: '#9aa5b1', fontSize: 11 }}
              tickFormatter={(v: number) => v.toFixed(1)}
              label={{ value: volBasis === 'implied' ? '1y carry / implied vol' : '1y carry / 3m realised vol', angle: -90, position: 'insideLeft', offset: -40, fill: '#8995a2', fontSize: 11 }}
            />
            <Tooltip content={<TooltipContent />} cursor={false} />
            {/* quadrant shading */}
            <ReferenceArea x1={0} x2={xHi} y1={0} y2={yHi}
              fill="rgba(111,194,162,0.025)"
              label={{ value: 'Receive / Flatten ↗', position: 'insideTopRight', fill: '#34d39966', fontSize: 10, fontStyle: 'italic' }}
            />
            <ReferenceArea x1={xLo} x2={0} y1={yLo} y2={0}
              fill="rgba(226,130,111,0.025)"
              label={{ value: '↙ Pay / Steepen', position: 'insideBottomLeft', fill: '#f8717166', fontSize: 10, fontStyle: 'italic' }}
            />
            <ReferenceLine x={0} stroke="rgba(200,220,240,0.15)" strokeDasharray="4 4" />
            <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" strokeDasharray="4 4" />
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
              background: 'rgba(106,169,204,0.12)',
              border: '1px solid rgba(106,169,204,0.5)',
              pointerEvents: 'none',
            }} />
          )}
        </div>
      </div>

      {/* legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, justifyContent: 'center', marginTop: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width={14} height={14}><circle cx={7} cy={7} r={6} fill={CURVE_COLOR} fillOpacity={0.82} /></svg>
          <span style={{ color: '#9aa5b1', fontSize: 11 }}>Curves</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width={14} height={14}><circle cx={7} cy={7} r={6} fill={FLY_COLOR} fillOpacity={0.82} /></svg>
          <span style={{ color: '#9aa5b1', fontSize: 11 }}>Flies</span>
        </div>
        <span style={{ color: '#77828f', fontSize: 10, fontStyle: 'italic' }}>
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
      <span style={{ color: '#8995a2', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        style={{
          background: 'rgba(200,220,240,0.05)',
          border: '1px solid rgba(200,220,240,0.1)',
          borderRadius: 6,
          color: '#e4eaf1',
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
          style={{ color: '#8995a2', fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          ✕ clear
        </button>
      )}
    </div>
  )
}

// ─── Expression Detail ────────────────────────────────────────────────────────

function DetailChart({ label, history, rvRow, betaRow, rvMonitor, curve, asOf, currency, dataStamp, onBack, onSwitch }: {
  label: string
  curve?: CurveData
  asOf: string
  currency: string
  dataStamp?: string | null
  history: SeriesPoint[]
  rvRow: RVRow
  betaRow?: BetaRow
  rvMonitor: RVRow[]
  onBack: () => void
  onSwitch: (label: string) => void
}) {
  const carryGroup: StatGroupDef = {
    title: 'Carry & betas',
    items: [
      { label: 'Carry (1y)', value: fmtBp(rvRow.carry1y_bps), color: rvRow.carry1y_bps > 0 ? '#6fc2a2' : '#e2826f' },
      { label: '3m RVol',    value: fmtBp(rvRow.vol3m_bps), sub: 'ann.' },
      { label: 'Carry / RVol', value: rvRow.carry_vol_ratio !== null ? rvRow.carry_vol_ratio.toFixed(2) : '—',
        color: (rvRow.carry_vol_ratio ?? 0) > 0 ? '#6fc2a2' : '#e2826f' },
      { label: 'Implied vol', value: rvRow.ivol_bps != null ? fmtBp(rvRow.ivol_bps) : '—', sub: 'ann.' },
      { label: 'Carry / IVol', value: rvRow.carry_ivol_ratio != null ? rvRow.carry_ivol_ratio.toFixed(2) : '—',
        color: (rvRow.carry_ivol_ratio ?? 0) > 0 ? '#6fc2a2' : '#e2826f' },
      ...(betaRow ? [
        { label: 'β 1y10y fwd', value: fmtBeta(betaRow.beta_1y10y_fwd) },
        { label: 'Beta R²',     value: `${Math.round(betaRow.r2 * 100)}%`, color: r2Color(betaRow.r2) },
        { label: 'Residual Z',  value: betaRow.residual_zscore.toFixed(2), color: zscoreStyle(betaRow.residual_zscore).color },
      ] : []),
    ],
  }

  return (
    <>
      <ExpressionDetail
        history={history}
        extraGroups={[carryGroup]}
        footnote="Level and mean-reversion stats use the selected lookback; carry, vols and betas are the monitor's fixed-window figures. Implied vol: legs' ATM normal swaption vols with their 1y realised correlations. Positive carry → receiver / flattener."
        header={<>
          <button
            onClick={onBack}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'rgba(200,220,240,0.05)',
              border: '1px solid rgba(200,220,240,0.09)',
              borderRadius: 6, padding: '5px 12px',
              color: '#c6ced8', fontSize: 12, cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(200,220,240,0.1)'; e.currentTarget.style.color = '#e4eaf1' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(200,220,240,0.05)'; e.currentTarget.style.color = '#c6ced8' }}
          >
            ← Overview
          </button>
          <StructureSelect rvMonitor={rvMonitor} value={label} onChange={(l) => l && onSwitch(l)} label="Structure" includeGroups={false} />
          <span style={{
            fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 600, fontSize: 15, color: '#e4eaf1',
            background: 'rgba(106,169,204,0.12)', border: '1px solid rgba(106,169,204,0.25)',
            borderRadius: 6, padding: '3px 10px',
          }}>{label}</span>
          <span style={{ color: '#8995a2', fontSize: 12 }}>{rvRow.group}</span>
        </>}
      />
      <RegressionDetail currency={currency} label={label} asOf={asOf} dataStamp={dataStamp} />
      <FactorNeutral currency={currency} label={label} asOf={asOf} dataStamp={dataStamp} />
      {curve && rvRow.legs && (
        <CurveRolldown curve={curve} legs={rvRow.legs} carryBps={rvRow.carry1y_bps} asOf={asOf} />
      )}
      <CarryRealisationDetail currency={currency} label={label} asOf={asOf} dataStamp={dataStamp} />
    </>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: 'rgba(200,220,240,0.03)',
  border: '1px solid rgba(200,220,240,0.07)',
  borderRadius: 6,
  padding: 24,
}

const thStyle: React.CSSProperties = {
  color: '#9aa5b1',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  padding: '8px 12px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const tdBase: React.CSSProperties = {
  padding: '7px 12px',
  borderBottom: '1px solid rgba(200,220,240,0.04)',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
}

const groupHeaderTd: React.CSSProperties = {
  background: 'rgba(200,220,240,0.02)',
  color: '#8995a2',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  paddingLeft: 12,
  paddingTop: 6,
  paddingBottom: 6,
  fontWeight: 600,
}

// ─── RV Monitor Table ─────────────────────────────────────────────────────────

function RVMonitorTable({ rows, selected, onSelect }: {
  rows: RVRow[]
  selected: string | null
  onSelect: (label: string) => void
}) {
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
          onClick={() => onSelect(row.label)}
          title={`Show ${row.label} history`}
          style={{
            cursor: 'pointer',
            background: selected === row.label ? 'rgba(106,169,204,0.08)' : 'transparent',
          }}
          onMouseEnter={(e) => { if (selected !== row.label) e.currentTarget.style.background = 'rgba(200,220,240,0.03)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = selected === row.label ? 'rgba(106,169,204,0.08)' : 'transparent' }}
        >
          <td style={{ ...tdBase, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1', textAlign: 'left' }}>{row.label}</td>
          <td style={{ ...tdBase, color: '#f4f7fa', textAlign: 'right' }}>{row.value_bps.toFixed(1)}</td>
          <td style={{ ...tdBase, ...changeCellStyle(row.d1d_bps), textAlign: 'right' }}>{fmtChange(row.d1d_bps)}</td>
          <td style={{ ...tdBase, ...changeCellStyle(row.d1w_bps), textAlign: 'right' }}>{fmtChange(row.d1w_bps)}</td>
          <td style={{ ...tdBase, ...changeCellStyle(row.d1m_bps), textAlign: 'right' }}>{fmtChange(row.d1m_bps)}</td>
          <td style={{ ...tdBase, color: '#c6ced8', textAlign: 'right' }}>{row.vol3m_bps.toFixed(1)}</td>
          <td style={{
            ...tdBase,
            textAlign: 'right',
            color: row.carry1y_bps > 0 ? '#6fc2a2' : row.carry1y_bps < 0 ? '#e2826f' : '#c6ced8',
          }}>{row.carry1y_bps.toFixed(1)}</td>
          <td style={{
            ...tdBase,
            textAlign: 'right',
            color: row.carry_vol_ratio === null
              ? '#8995a2'
              : row.carry_vol_ratio > 0 ? '#6fc2a2' : row.carry_vol_ratio < 0 ? '#e2826f' : '#c6ced8',
            fontWeight: row.carry_vol_ratio !== null && Math.abs(row.carry_vol_ratio) >= 0.5 ? 600 : 400,
          }}>{row.carry_vol_ratio === null ? '—' : row.carry_vol_ratio.toFixed(2)}</td>
          <td style={{ ...tdBase, color: '#c6ced8', textAlign: 'right' }}>{row.ivol_bps == null ? '—' : row.ivol_bps.toFixed(1)}</td>
          <td style={{
            ...tdBase,
            textAlign: 'right',
            color: row.carry_ivol_ratio == null
              ? '#8995a2'
              : row.carry_ivol_ratio > 0 ? '#6fc2a2' : row.carry_ivol_ratio < 0 ? '#e2826f' : '#c6ced8',
            fontWeight: row.carry_ivol_ratio != null && Math.abs(row.carry_ivol_ratio) >= 0.5 ? 600 : 400,
          }}>{row.carry_ivol_ratio == null ? '—' : row.carry_ivol_ratio.toFixed(2)}</td>
          <td style={{ ...tdBase, ...zStyle, textAlign: 'right', borderRadius: 4 }}>{row.zscore_1y.toFixed(2)}</td>
          <td style={{ ...tdBase, textAlign: 'right' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
              <span style={{ color: '#c3ccd6' }}>{row.pctile_1y.toFixed(1)}</span>
              <div style={{ width: 60, height: 4, background: 'rgba(200,220,240,0.08)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${row.pctile_1y}%`, height: '100%', background: barColor, borderRadius: 2 }} />
              </div>
            </div>
          </td>
          {row.neutral_zscore_1y == null ? (
            <td style={{ ...tdBase, color: '#8995a2', textAlign: 'right' }}>—</td>
          ) : row.neutral_unstable ? (
            <td
              style={{ ...tdBase, color: '#8995a2', textAlign: 'right' }}
              title={`Unstable hedge: weights ${row.neutral_weights?.map(w => w.toFixed(2)).join(' / ')} — the factors barely separate the legs, so the neutral version is close to an outright position`}
            >{row.neutral_zscore_1y.toFixed(2)}*</td>
          ) : (
            <td
              style={{ ...tdBase, ...zscoreStyle(row.neutral_zscore_1y), textAlign: 'right', borderRadius: 4 }}
              title={`Neutral weights ${row.neutral_weights?.map(w => w.toFixed(2)).join(' / ')}`}
            >{row.neutral_zscore_1y.toFixed(2)}</td>
          )}
          <td style={{
            ...tdBase, textAlign: 'right',
            color: (row.factor_share ?? 0) >= 0.3 ? '#dfbb78' : '#c6ced8',
          }}>{row.factor_share == null ? '—' : `${Math.round(row.factor_share * 100)}%`}</td>
        </tr>
      )
    })

  const columns: { label: string; key: SortKey; align: 'left' | 'right'; title?: string }[] = [
    { label: 'Expression',  key: 'label',           align: 'left' },
    { label: 'Value (bp)',  key: 'value_bps',        align: 'right' },
    { label: 'Δ1d',         key: 'd1d_bps',          align: 'right' },
    { label: 'Δ1w',         key: 'd1w_bps',          align: 'right' },
    { label: 'Δ1m',         key: 'd1m_bps',          align: 'right' },
    { label: '3m RVol',     key: 'vol3m_bps',        align: 'right' },
    { label: 'Carry (bp)',  key: 'carry1y_bps',      align: 'right' },
    { label: 'C/RVol',      key: 'carry_vol_ratio',  align: 'right',
      title: '1y carry ÷ 3m realised vol (annualised)' },
    { label: 'IVol',        key: 'ivol_bps',         align: 'right',
      title: "Implied vol of the structure (bp/yr): each leg's ATM normal swaption vol (expiry = the forward's start, 1y for spot legs; tenor = the leg's) combined with the legs' 1y realised correlations" },
    { label: 'C/IVol',      key: 'carry_ivol_ratio', align: 'right',
      title: '1y carry ÷ implied vol' },
    { label: 'Z-score',     key: 'zscore_1y',        align: 'right' },
    { label: '%ile',        key: 'pctile_1y',        align: 'right' },
    { label: 'Z neutral',   key: 'neutral_zscore_1y', align: 'right',
      title: '1y Z-score of the factor-neutral version: curves hedged for level, flies for level and slope (PCA of the par curve over the last year). * = unstable hedge' },
    { label: 'Factor %',    key: 'factor_share',     align: 'right',
      title: 'Share of the daily variance (last year) explained by the factors the neutral version hedges: how much of the standard structure is a level (and slope) bet' },
  ]

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} onClick={() => handleSort(col.key)} title={col.title}
                style={{
                  ...thStyle,
                  textAlign: col.align,
                  cursor: 'pointer',
                  userSelect: 'none',
                  color: sortKey === col.key ? '#a9d2e8' : '#9aa5b1',
                }}
              >
                {col.label}{sortKey === col.key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr><td colSpan={14} style={groupHeaderTd}>Curves</td></tr>
          {renderRows(curves)}
          <tr><td colSpan={14} style={{ ...groupHeaderTd, paddingTop: 12 }}>Flies</td></tr>
          {renderRows(flies)}
        </tbody>
      </table>
    </div>
  )
}

// ─── Beta Monitor Table ───────────────────────────────────────────────────────

function BetaMonitorTable({ rows, selected, onSelect }: {
  rows: BetaRow[]
  selected: string | null
  onSelect: (label: string) => void
}) {
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
          onClick={() => onSelect(row.label)}
          title={`Show ${row.label} history`}
          style={{
            cursor: 'pointer',
            background: selected === row.label ? 'rgba(106,169,204,0.08)' : 'transparent',
          }}
          onMouseEnter={(e) => { if (selected !== row.label) e.currentTarget.style.background = 'rgba(200,220,240,0.03)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = selected === row.label ? 'rgba(106,169,204,0.08)' : 'transparent' }}
        >
          <td style={{ ...tdBase, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1', textAlign: 'left' }}>{row.label}</td>
          <td style={{ ...tdBase, color: '#c3ccd6', textAlign: 'right' }}>{fmtBeta(row.beta_1y10y_fwd)}</td>
          <td style={{ ...tdBase, color: '#c3ccd6', textAlign: 'right' }}>{fmtBeta(row.beta_2y1y_fwd)}</td>
          <td style={{ ...tdBase, color: '#c3ccd6', textAlign: 'right' }}>{fmtBeta(row.beta_1m10y_vol)}</td>
          <td style={{ ...tdBase, color: '#c3ccd6', textAlign: 'right' }}>{fmtBeta(row.beta_1y10y_vol)}</td>
          <td style={{ ...tdBase, color: r2c, textAlign: 'right', fontWeight: 600 }}>{Math.round(row.r2 * 100)}%</td>
          <td style={{ ...tdBase, ...rzStyle, textAlign: 'right', fontWeight: 600, borderRadius: 4 }}>{row.residual_zscore.toFixed(2)}</td>
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
                  color: sortKey === col.key ? '#a9d2e8' : '#9aa5b1',
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
  { key: 'EUR', label: 'EUR' },
  { key: 'GBP', label: 'GBP' },
  { key: 'USD', label: 'USD' },
]

export default function SwapsRV() {
  const [data, setData] = useState<SwapsRVData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [noData, setNoData] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [currency, setCurrency] = useState('EUR')
  const [tab, setTab] = useState<'currency' | 'candidates'>('currency')   // Candidates: every currency's trade candidates
  const [selectedDate, setSelectedDate] = useState<string>('')
  const [focusLabel, setFocusLabel] = useState<string | null>(null)
  const [detailLabel, setDetailLabel] = useState<string | null>(null)
  const [universe, setUniverse] = useState<Universe>('core')
  // History of the structure open in the detail view, fetched on demand
  const [detailHistory, setDetailHistory] = useState<{ key: string; points: SeriesPoint[] } | null>(null)
  const [betaVar, setBetaVar] = useState<string>('beta_1y10y_fwd')
  const [volBasis, setVolBasis] = useState<VolBasis>('realised')
  const effectiveVolBasis: VolBasis = data?.implied_vol ? volBasis : 'realised'
  const detailRef = useRef<HTMLElement>(null)
  const navigate = useNavigate()

  // Only offer the betas the backend actually estimated (vols can be missing)
  const betaOptions = data?.beta_vars
    ? BETA_VARS.filter(b => data.beta_vars!.includes((b.key as string).replace(/^beta_/, '')))
    : BETA_VARS
  const volsMissing = data?.beta_vars !== undefined && betaOptions.length < BETA_VARS.length

  // Full history of the open structure, loaded when its detail view opens
  const historyKey = detailLabel && data ? `${currency}|${detailLabel}|${data.as_of}|${data.data_timestamp ?? ''}` : null
  useEffect(() => {
    if (!historyKey || !detailLabel || !data) return
    let cancelled = false
    const params = new URLSearchParams({ currency, label: detailLabel, date: data.as_of })
    axios
      .get<{ points: SeriesPoint[] }>(`/api/tools/swaps-rv/history?${params}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('access_token') ?? ''}` },
      })
      .then(res => { if (!cancelled) setDetailHistory({ key: historyKey, points: res.data.points }) })
      .catch(() => { if (!cancelled) setDetailHistory({ key: historyKey, points: [] }) })
    return () => { cancelled = true }
  }, [historyKey])   // eslint-disable-line react-hooks/exhaustive-deps
  const openHistory = detailHistory && detailHistory.key === historyKey ? detailHistory.points : null

  function openDetail(label: string) {
    setFocusLabel(label)
    setDetailLabel(label)
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function fetchData(isRefresh = false, date?: string, ccy?: string, uni?: Universe) {
    const token = localStorage.getItem('access_token')
    if (!token) {
      navigate('/login', { replace: true })
      return
    }

    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setNoData(false)

    const activeCcy = ccy ?? currency
    const params = new URLSearchParams({ currency: activeCcy, universe: uni ?? universe })
    if (date) params.set('date', date)
    if (isRefresh) params.set('refresh', 'true')   // bypass the backend's live-data cache
    axios
      .get<SwapsRVData>(`/api/tools/swaps-rv?${params}`, {
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
        } else {
          setData(null)
          setNoData(true)
          // Say why: an unreachable server or a server error is not missing data
          if (axios.isAxiosError(err) && !err.response) {
            setLoadError('Cannot reach the backend server. Check that it is running, then press Refresh.')
          } else if (axios.isAxiosError(err)) {
            const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail
            setLoadError(`Server error ${err.response?.status}${typeof detail === 'string' ? `: ${detail}` : ''}`)
          } else {
            setLoadError(String(err))
          }
        }
      })
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }

  function switchUniverse(u: Universe) {
    setUniverse(u)
    fetchData(false, selectedDate || undefined, undefined, u)
  }

  function switchCurrency(ccy: string, openLabel: string | null = null) {
    setTab('currency')
    setCurrency(ccy)
    setData(null)
    setSelectedDate('')
    setFocusLabel(openLabel)
    setDetailLabel(openLabel)
    setBetaVar('beta_1y10y_fwd')
    fetchData(false, undefined, ccy)
  }

  // From the Candidates tab: open the structure's detail view in its currency
  function openCandidate(ccy: string, label: string) {
    window.scrollTo({ top: 0 })
    if (ccy !== currency) switchCurrency(ccy, label)
    else { setTab('currency'); setFocusLabel(label); setDetailLabel(label) }
  }

  useEffect(() => { fetchData() }, [navigate])

  return (
    <div className="min-h-screen" style={{ background: '#07090c' }}>
      {/* Gradient overlay */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 50% -10%, rgba(106,169,204,0.06) 0%, transparent 55%)',
        }}
      />

      {/* Header */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-6 py-4"
        style={{
          background: 'rgba(7,9,12,0.85)',
          borderBottom: '1px solid rgba(200,220,240,0.07)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <PageTitle category="Futures / Swaps / Vol" categoryId="futures-swaps-vol" title="Swap RV Monitor" subtitle="Carry · roll · OIS-discounted curves and flies" />

        {/* Currency toggle */}
        <div
          className="flex items-center"
          style={{
            background: 'rgba(200,220,240,0.04)',
            border: '1px solid rgba(200,220,240,0.08)',
            borderRadius: 6,
            padding: 3,
            gap: 2,
          }}
        >
          {[...CURRENCIES, { key: 'candidates', label: 'Candidates' }].map(({ key, label }) => {
            const active = key === 'candidates' ? tab === 'candidates' : tab === 'currency' && currency === key
            return (
              <button
                key={key}
                onClick={() => {
                  if (active) return
                  if (key === 'candidates') setTab('candidates')
                  else if (key === currency) setTab('currency')
                  else switchCurrency(key)
                }}
                title={key === 'candidates' ? 'Trade candidates across EUR, GBP and USD' : undefined}
                style={{
                  padding: '4px 14px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  border: 'none',
                  marginLeft: key === 'candidates' ? 6 : 0,
                  cursor: active ? 'default' : 'pointer',
                  transition: 'all 0.15s',
                  background: active ? 'rgba(106,169,204,0.25)' : 'transparent',
                  color: active ? '#a9d2e8' : '#9aa5b1',
                  outline: active ? '1px solid rgba(106,169,204,0.35)' : 'none',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        {/* Universe toggle */}
        <div
          className="flex items-center"
          title="Core: the curated structures. Extended: core plus a generated grid of spot and forward curves and flies."
          style={{ background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6, padding: 3, gap: 2 }}
        >
          {(['core', 'extended'] as Universe[]).map(u => (
            <button
              key={u}
              onClick={() => universe !== u && switchUniverse(u)}
              style={{
                padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, border: 'none',
                cursor: universe === u ? 'default' : 'pointer',
                background: universe === u ? 'rgba(106,169,204,0.25)' : 'transparent',
                color: universe === u ? '#a9d2e8' : '#9aa5b1',
                outline: universe === u ? '1px solid rgba(106,169,204,0.35)' : 'none',
              }}
            >
              {u === 'core' ? 'Core' : 'Extended'}
              {data && data.universe === u && (
                <span style={{ marginLeft: 6, fontWeight: 400, color: '#8995a2' }}>{data.rv_monitor.length}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {data?.data_source && (
            <span
              title={data.data_source === 'bloomberg' ? 'Live Bloomberg data' : 'Bloomberg unavailable: showing stored CSV data'}
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                padding: '3px 8px',
                borderRadius: 6,
                color: data.data_source === 'bloomberg' ? '#6fc2a2' : '#dfbb78',
                background: data.data_source === 'bloomberg' ? 'rgba(88,173,142,0.12)' : 'rgba(214,173,102,0.12)',
              }}
            >
              {data.data_source === 'bloomberg' ? 'Live' : 'CSV'}
            </span>
          )}
          {data && (
            <div className="flex items-center gap-2">
              <span style={{ color: '#8995a2', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
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
                  background: 'rgba(106,169,204,0.1)',
                  border: '1px solid rgba(106,169,204,0.2)',
                  borderRadius: 6,
                  padding: '4px 10px',
                  color: '#a9d2e8',
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  outline: 'none',
                  cursor: 'pointer',
                  colorScheme: 'dark',
                }}
              />
              {data.data_timestamp && (
                <span
                  title={`Bloomberg data pulled ${new Date(data.data_timestamp).toLocaleString()}`}
                  style={{ color: '#a9d2e8', fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace" }}
                >
                  {new Date(data.data_timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          )}
          <button
            onClick={() => fetchData(true, selectedDate && selectedDate !== data?.as_of ? selectedDate : undefined)}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: 'rgba(200,220,240,0.06)',
              border: '1px solid rgba(200,220,240,0.1)',
              color: '#c6ced8',
            }}
            onMouseEnter={(e) => {
              if (!refreshing) {
                e.currentTarget.style.background = 'rgba(200,220,240,0.1)'
                e.currentTarget.style.color = '#e4eaf1'
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(200,220,240,0.06)'
              e.currentTarget.style.color = '#c6ced8'
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
      {tab === 'currency' && loading && (
        <div className="flex items-center justify-center py-32 text-slate-500 text-sm">
          <span className="animate-pulse">Loading {currency} swaps RV data…</span>
        </div>
      )}

      {/* No data */}
      {tab === 'currency' && !loading && noData && (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
          <div style={{ color: '#8995a2', fontSize: 14 }}>
            Could not load {currency} swaps RV data.
          </div>
          {loadError && (
            <div style={{ color: '#77828f', fontSize: 12, textAlign: 'center', maxWidth: 480 }}>
              {loadError}
            </div>
          )}
        </div>
      )}

      {/* Candidates tab: every currency's trade candidates */}
      {tab === 'candidates' && (
        <main className="relative" style={{ maxWidth: '1536px', margin: '0 auto', padding: '32px 24px' }}>
          <div style={cardStyle}>
            <TradeCandidates
              currencies={CURRENCIES.map(c => c.key)}
              universe={universe}
              asOf={selectedDate && data && selectedDate !== data.max_date ? selectedDate : undefined}
              dataStamp={data?.data_timestamp}
              onSelect={openCandidate}
            />
          </div>
        </main>
      )}

      {/* Body */}
      {tab === 'currency' && !loading && data && (
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
          <section ref={detailRef} style={{ scrollMarginTop: 88 }}>
            <div style={cardStyle}>
              {detailLabel && data.rv_monitor.some(r => r.label === detailLabel) && openHistory === null ? (
                <div style={{ color: '#8995a2', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>Loading {detailLabel} history…</div>
              ) : detailLabel && openHistory && openHistory.length > 1 && data.rv_monitor.some(r => r.label === detailLabel) ? (
                <DetailChart
                  label={detailLabel}
                  history={openHistory}
                  rvRow={data.rv_monitor.find(r => r.label === detailLabel)!}
                  betaRow={data.beta_monitor.find(b => b.label === detailLabel)}
                  rvMonitor={data.rv_monitor}
                  curve={data.curve}
                  asOf={data.as_of}
                  currency={currency}
                  dataStamp={data.data_timestamp}
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
                            <h2 style={{ color: '#eef2f6', fontSize: 16, fontWeight: 600, margin: 0 }}>
                              Carry / Vol vs Z-score
                            </h2>
                            <p style={{ color: '#8995a2', fontSize: 12, marginTop: 4 }}>
                              Click a bubble or a table row to view its history and summary stats
                            </p>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                              title={data.implied_vol ? `Implied vols: ${data.implied_vol.source}, ${data.implied_vol.grid_date}` : 'No swaption vol grid for this currency: realised vol only'}>
                              <span style={{ color: '#8995a2', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>Vol</span>
                              <div style={{ display: 'flex', background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6, padding: 2, gap: 2 }}>
                                {(['realised', 'implied'] as VolBasis[]).map(v => {
                                  const on = effectiveVolBasis === v
                                  const disabled = v === 'implied' && !data.implied_vol
                                  return (
                                    <button key={v} disabled={disabled} onClick={() => setVolBasis(v)} style={{
                                      padding: '3px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: 'none',
                                      cursor: disabled ? 'not-allowed' : on ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
                                      background: on ? 'rgba(106,169,204,0.25)' : 'transparent',
                                      color: on ? '#a9d2e8' : '#9aa5b1',
                                    }}>{v === 'realised' ? 'Realised' : 'Implied'}</button>
                                  )
                                })}
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ color: '#8995a2', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>Size by β</span>
                              <select value={betaVar} onChange={(e) => setBetaVar(e.target.value)} style={{
                                background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.1)',
                                borderRadius: 6, color: '#e4eaf1', fontSize: 12, padding: '5px 10px',
                                outline: 'none', cursor: 'pointer', colorScheme: 'dark',
                              }}>
                                {betaOptions.map(({ key, label }) => (
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
                          onBubbleClick={openDetail}
                          betaVar={betaVar}
                          groupFilter={chartGroupFilter}
                          volBasis={effectiveVolBasis}
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
                <h2 style={{ color: '#eef2f6', fontSize: 16, fontWeight: 600, margin: 0 }}>
                  RV Monitor
                </h2>
                <p style={{ color: '#8995a2', fontSize: 12, marginTop: 4 }}>
                  1y z-scores &amp; percentiles · click a row for its history
                </p>
              </div>
              <RVMonitorTable rows={data.rv_monitor} selected={detailLabel} onSelect={openDetail} />
            </div>
          </section>

          {/* C. Beta Monitor */}
          <section>
            <div style={cardStyle}>
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ color: '#eef2f6', fontSize: 16, fontWeight: 600, margin: 0 }}>
                  Beta Monitor
                </h2>
                <p style={{ color: '#8995a2', fontSize: 12, marginTop: 4 }}>
                  OLS on 1y daily changes (bps)
                  {volsMissing && ' · swaption vols unavailable from the data source, regressed on forwards only'}
                </p>
              </div>
              <BetaMonitorTable rows={data.beta_monitor} selected={detailLabel} onSelect={openDetail} />
            </div>
          </section>

          {/* D. Carry Realisation */}
          <section>
            <div style={cardStyle}>
              <CarryRealisationSummary
                currency={currency}
                universe={universe}
                asOf={data.as_of}
                dataStamp={data.data_timestamp}
                selected={detailLabel}
                onSelect={openDetail}
              />
            </div>
          </section>
        </main>
      )}
    </div>
  )
}
