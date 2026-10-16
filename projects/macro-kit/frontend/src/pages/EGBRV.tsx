import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageTitle, { headerBar } from '../components/PageTitle'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import ExpressionDetail, { fmtBp, fmtSignedBp, type SeriesPoint, type StatGroupDef } from '../components/ExpressionDetail'
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RVRow {
  label: string
  group: string
  value_bps: number
  d1d_bps: number | null
  d1w_bps: number | null
  d1m_bps: number | null
  zscore_1y: number
  pctile_1y: number
  vol3m_bps: number
  carry1y_bps: number
  income_carry_bps: number
  roll_bps: number
  carry_vol_ratio: number | null
  bund_repo_sens: number
  oat_repo_sens: number
  btp_repo_sens: number
  bonos_repo_sens: number
}

type CarryMode = 'total' | 'income' | 'roll'

// Repo adjustment only affects income carry, not roll
function repoAdj(
  row: RVRow,
  bundSpreadBps: number, oatSpreadBps: number,
  btpSpreadBps: number,  bonosSpreadBps: number,
): number {
  return row.bund_repo_sens  * (bundSpreadBps  / 100)
       + row.oat_repo_sens   * (oatSpreadBps   / 100)
       + row.btp_repo_sens   * (btpSpreadBps   / 100)
       + row.bonos_repo_sens * (bonosSpreadBps / 100)
}

function adjCarry(
  row: RVRow,
  bundSpreadBps: number, oatSpreadBps: number,
  btpSpreadBps: number,  bonosSpreadBps: number,
  mode: CarryMode,
): number {
  const adj = repoAdj(row, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps)
  if (mode === 'income') return row.income_carry_bps + adj
  if (mode === 'roll')   return row.roll_bps   // repo doesn't affect roll
  return row.carry1y_bps + adj                 // total = income + roll
}

function adjCarryVolRatio(
  row: RVRow,
  bundSpreadBps: number, oatSpreadBps: number,
  btpSpreadBps: number,  bonosSpreadBps: number,
  mode: CarryMode,
): number | null {
  if (row.vol3m_bps <= 0) return null
  return adjCarry(row, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, mode) / row.vol3m_bps
}

interface BetaRow {
  label: string
  group: string
  beta_bund10y: number
  beta_spread10y: number
  beta_slope: number
  beta_vol1m10y: number
  r2: number
  residual_zscore: number
}

interface GroupMeta {
  label: string
  color: string
}

interface BondInfo {
  ticker: string
  target_years: number
  actual_years: number
  deviation_years: number
  maturity: string
  coupon: number
  yield_pct: number
  duration: number
  outstanding_mn: number
}

interface EGBRVData {
  as_of: string
  min_date: string
  max_date: string
  data_source: string
  yield_mode: string
  bond_map: Record<string, Record<string, BondInfo | null>>
  rv_monitor: RVRow[]
  beta_monitor: BetaRow[]
  groups: Record<string, GroupMeta>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zscoreStyle(z: number): { background: string; color: string } {
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

function fmtBeta(v: number): string {
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(3)}`
}

// ─── Group color lookup ───────────────────────────────────────────────────────

function groupColor(group: string, groups: Record<string, GroupMeta>): string {
  return groups[group]?.color ?? '#c6ced8'
}

// ─── Carry/Vol Scatter Chart ─────────────────────────────────────────────────

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

const BETA_VARS: { key: keyof BetaRow; label: string }[] = [
  { key: 'beta_bund10y',   label: 'Bund 10y'       },
  { key: 'beta_spread10y', label: 'OAT−Bund 10y'   },
  { key: 'beta_slope',     label: 'Bund 2s10s'      },
  { key: 'beta_vol1m10y',  label: '1m10y Vol'       },
]

function makeShape(
  color: string,
  focusLabel: string | null,
  onBubbleClick: (label: string) => void,
) {
  return function Shape(props: any) {
    const { cx, cy, payload } = props
    const r = bubbleRadius(payload.beta ?? 0)
    const isFocused  = focusLabel === null || focusLabel === payload.label
    const isSelected = focusLabel === payload.label
    return (
      <g opacity={isFocused ? 1 : 0.15} style={{ cursor: 'pointer' }} onClick={() => onBubbleClick(payload.label)}>
        <circle cx={cx} cy={cy} r={isSelected ? r + 2 : r}
          fill={color} stroke={isSelected ? '#f4f7fa' : color}
          strokeWidth={isSelected ? 1.5 : 0} strokeOpacity={0.6}
          fillOpacity={isSelected ? 1 : 0.82} />
        <text x={cx + r + 4} y={cy} dominantBaseline="middle"
          fontSize={isSelected ? 10 : 9} fontWeight={isSelected ? 700 : 400}
          fill={isSelected ? '#eef2f6' : '#c6ced8'}
          style={{ pointerEvents: 'none', userSelect: 'none' }}>
          {payload.label}
        </text>
      </g>
    )
  }
}

function CarryVolTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d: ChartDatum = payload[0].payload
  return (
    <div style={{
      background: 'rgba(7,9,12,0.96)', border: '1px solid rgba(200,220,240,0.12)',
      borderRadius: 6, padding: '10px 14px', fontSize: 12,
    }}>
      <div style={{ color: '#e4eaf1', fontWeight: 600, marginBottom: 6, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{d.label}</div>
      <div style={{ color: '#9aa5b1' }}>Z-score (1y) <span style={{ color: '#eef2f6' }}>{d.x.toFixed(2)}</span></div>
      <div style={{ color: '#9aa5b1' }}>C/V ratio    <span style={{ color: d.y > 0 ? '#6fc2a2' : '#e2826f' }}>{d.y.toFixed(2)}</span></div>
      <div style={{ color: '#9aa5b1' }}>Carry (1y)   <span style={{ color: '#c3ccd6' }}>{d.carry1y_bps.toFixed(1)} bp</span></div>
      <div style={{ color: '#9aa5b1' }}>3m RVol      <span style={{ color: '#c3ccd6' }}>{d.vol3m_bps.toFixed(1)} bp</span></div>
      <div style={{ color: '#9aa5b1' }}>Level        <span style={{ color: '#c3ccd6' }}>{d.value_bps.toFixed(1)} bp</span></div>
    </div>
  )
}


const CHART_H = 420
const CHART_MARGIN = { top: 16, right: 100, bottom: 44, left: 56 }

function CarryVolChart({
  rvMonitor, betaMonitor, focusLabel, onBubbleClick, betaVar, groupFilter, groups,
}: {
  rvMonitor: RVRow[]
  betaMonitor: BetaRow[]
  focusLabel: string | null
  onBubbleClick: (label: string) => void
  betaVar: string
  groupFilter: string
  groups: Record<string, GroupMeta>
}) {
  const [zoomDomain, setZoomDomain] = useState<{ x: [number, number]; y: [number, number] } | null>(null)
  const [drag, setDrag] = useState<{ px1: number; py1: number; px2: number; py2: number } | null>(null)
  const [zoomMode, setZoomMode] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  const betaByLabel = useMemo(() => Object.fromEntries(betaMonitor.map(b => [b.label, b])), [betaMonitor])

  // Group data by group key
  const groupedData = useMemo<Record<string, ChartDatum[]>>(() => {
    const result: Record<string, ChartDatum[]> = {}
    rvMonitor
      .filter(r => r.carry_vol_ratio !== null)
      .filter(r => groupFilter === 'all' || r.group === groupFilter)
      .forEach(r => {
        const bRow = betaByLabel[r.label]
        const beta = bRow ? (bRow[betaVar as keyof BetaRow] as number) ?? 0 : 0
        const d: ChartDatum = {
          x: r.zscore_1y, y: r.carry_vol_ratio as number,
          label: r.label, group: r.group, beta,
          value_bps: r.value_bps, carry1y_bps: r.carry1y_bps, vol3m_bps: r.vol3m_bps,
        }
        if (!result[r.group]) result[r.group] = []
        result[r.group].push(d)
      })
    return result
  }, [rvMonitor, betaByLabel, betaVar, groupFilter])

  const allData = useMemo(() => Object.values(groupedData).flat(), [groupedData])
  const xs = allData.map(d => d.x)
  const ys = allData.map(d => d.y)
  const xPad = 0.4, yPad = 0.5
  const baseXMin = xs.length ? Math.min(...xs) - xPad : -3
  const baseXMax = xs.length ? Math.max(...xs) + xPad : 3
  const baseYMin = ys.length ? Math.min(...ys) - yPad : -2
  const baseYMax = ys.length ? Math.max(...ys) + yPad : 2
  const [xLo, xHi] = zoomDomain?.x ?? [baseXMin, baseXMax]
  const [yLo, yHi] = zoomDomain?.y ?? [baseYMin, baseYMax]

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!zoomMode) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left; const py = e.clientY - rect.top
    setDrag({ px1: px, py1: py, px2: px, py2: py }); e.preventDefault()
  }
  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!drag) return
    const rect = e.currentTarget.getBoundingClientRect()
    setDrag(d => d ? { ...d, px2: e.clientX - rect.left, py2: e.clientY - rect.top } : null)
  }
  function handleMouseUp() {
    if (drag && overlayRef.current) {
      const w = overlayRef.current.clientWidth; const h = overlayRef.current.clientHeight
      const rx1 = Math.min(drag.px1, drag.px2) / w; const rx2 = Math.max(drag.px1, drag.px2) / w
      const ry1 = Math.min(drag.py1, drag.py2) / h; const ry2 = Math.max(drag.py1, drag.py2) / h
      if (rx2 - rx1 > 0.02 || ry2 - ry1 > 0.02) {
        setZoomDomain({
          x: [xLo + rx1 * (xHi - xLo), xLo + rx2 * (xHi - xLo)],
          y: [yHi - ry2 * (yHi - yLo), yHi - ry1 * (yHi - yLo)],
        })
      }
    }
    setDrag(null)
  }

  const dragBox = drag ? {
    left:   `${Math.min(drag.px1, drag.px2)}px`,
    top:    `${Math.min(drag.py1, drag.py2)}px`,
    width:  `${Math.abs(drag.px2 - drag.px1)}px`,
    height: `${Math.abs(drag.py2 - drag.py1)}px`,
  } : null

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, justifyContent: 'flex-end' }}>
        <button onClick={() => setZoomMode(m => !m)}
          style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(200,220,240,0.15)',
            background: zoomMode ? 'rgba(106,169,204,0.2)' : 'rgba(200,220,240,0.05)',
            color: zoomMode ? '#a9d2e8' : '#9aa5b1', cursor: 'pointer' }}>
          {zoomMode ? 'Zoom ON' : 'Zoom'}
        </button>
        {zoomDomain && (
          <button onClick={() => setZoomDomain(null)}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(200,220,240,0.15)',
              background: 'rgba(200,220,240,0.05)', color: '#9aa5b1', cursor: 'pointer' }}>
            Reset
          </button>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <ScatterChart margin={CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
            <XAxis dataKey="x" type="number" domain={[xLo, xHi]} name="Z-score"
              label={{ value: 'Z-score (1y)', position: 'insideBottom', offset: -10, fill: '#9aa5b1', fontSize: 12 }}
              tick={{ fill: '#9aa5b1', fontSize: 11 }} />
            <YAxis dataKey="y" type="number" domain={[yLo, yHi]} name="C/V Ratio"
              label={{ value: 'Carry / Vol', angle: -90, position: 'insideLeft', offset: 10, fill: '#9aa5b1', fontSize: 12 }}
              tick={{ fill: '#9aa5b1', fontSize: 11 }} />
            <Tooltip content={<CarryVolTooltip />} />
            <ReferenceLine x={0}  stroke="rgba(200,220,240,0.15)" strokeDasharray="4 4" />
            <ReferenceLine y={0}  stroke="rgba(200,220,240,0.15)" strokeDasharray="4 4" />
            {Object.entries(groupedData).map(([grp, data]) => (
              <Scatter key={grp} data={data} fill={groupColor(grp, groups)}
                shape={makeShape(groupColor(grp, groups), focusLabel, onBubbleClick)} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
        {zoomMode && (
          <div ref={overlayRef}
            style={{ position: 'absolute', top: CHART_MARGIN.top, left: CHART_MARGIN.left,
              right: CHART_MARGIN.right, bottom: CHART_MARGIN.bottom,
              cursor: zoomMode ? 'crosshair' : 'default' }}
            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
            {dragBox && (
              <div style={{ position: 'absolute', border: '1px solid rgba(106,169,204,0.6)',
                background: 'rgba(106,169,204,0.08)', ...dragBox, pointerEvents: 'none' }} />
            )}
          </div>
        )}
      </div>
      <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center' }}>
        {Object.entries(groups).map(([grp, meta]) => (
          <span key={grp} style={{ fontSize: 11, color: meta.color, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color, display: 'inline-block' }} />
            {meta.label}
          </span>
        ))}
      </div>
    </div>
  )
}


// ─── Expression detail (overlay) ──────────────────────────────────────────────

const CARRY_MODE_LABEL: Record<CarryMode, string> = {
  total: 'Carry + Roll', income: 'Carry only', roll: 'Roll only',
}

function DetailModal({
  label, row, betaRow, series, groups, siblings, onSwitch, onClose,
  bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode,
}: {
  label: string
  row: RVRow
  betaRow?: BetaRow
  series: SeriesPoint[] | null
  groups: Record<string, GroupMeta>
  siblings: string[]               // labels in the current view, for prev / next
  onSwitch: (label: string) => void
  onClose: () => void
  bundSpreadBps: number
  oatSpreadBps: number
  btpSpreadBps: number
  bonosSpreadBps: number
  carryMode: CarryMode
}) {
  const [lookback, setLookback] = useState('1Y')
  const idx  = siblings.indexOf(label)
  const prev = idx > 0 ? siblings[idx - 1] : null
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && prev) { e.preventDefault(); onSwitch(prev) }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowDown') && next) { e.preventDefault(); onSwitch(next) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onClose, onSwitch])

  const col  = groupColor(row.group, groups)
  const adj  = repoAdj(row, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps)
  const tot  = row.carry1y_bps + adj
  const inc  = row.income_carry_bps + adj
  const cv   = adjCarryVolRatio(row, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode)
  const pnl  = (v: number) => v > 0 ? '#6fc2a2' : v < 0 ? '#e2826f' : '#c6ced8'
  const sens = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} bp`

  const extraGroups: StatGroupDef[] = [
    { title: `Carry /yr · ${CARRY_MODE_LABEL[carryMode]}`, items: [
      { label: 'Carry + Roll', value: fmtSignedBp(tot), color: pnl(tot) },
      { label: 'Income carry', value: fmtSignedBp(inc), color: pnl(inc) },
      { label: 'Roll-down',    value: fmtSignedBp(row.roll_bps), color: pnl(row.roll_bps) },
      { label: '3m RVol',      value: fmtBp(row.vol3m_bps), sub: 'ann.' },
      { label: 'Carry / Vol',  value: cv === null ? '—' : cv.toFixed(2), color: pnl(cv ?? 0) },
    ] },
    { title: 'Repo sensitivity (per +1%)', items: [
      { label: 'Bund repo',  value: sens(row.bund_repo_sens) },
      { label: 'OAT repo',   value: sens(row.oat_repo_sens) },
      { label: 'BTP repo',   value: sens(row.btp_repo_sens) },
      { label: 'Bonos repo', value: sens(row.bonos_repo_sens) },
    ] },
    ...(betaRow ? [{ title: 'Betas (daily Δ)', items: [
      { label: 'β Bund 10y',     value: fmtBeta(betaRow.beta_bund10y) },
      { label: 'β OAT-Bund 10y', value: fmtBeta(betaRow.beta_spread10y) },
      { label: 'β Bund 2s10s',   value: fmtBeta(betaRow.beta_slope) },
      { label: 'β 1m10y vol',    value: fmtBeta(betaRow.beta_vol1m10y) },
      { label: 'R²',             value: `${Math.round(betaRow.r2 * 100)}%`, color: r2Color(betaRow.r2) },
      { label: 'Residual Z',     value: betaRow.residual_zscore.toFixed(2), color: zscoreStyle(betaRow.residual_zscore).color },
    ] }] : []),
  ]

  const navBtn = (enabled: boolean): React.CSSProperties => ({
    background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.09)',
    borderRadius: 6, padding: '4px 10px', fontSize: 12,
    color: enabled ? '#c6ced8' : '#4d5661', cursor: enabled ? 'pointer' : 'default',
  })

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(3,5,8,0.72)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '48px 24px', overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog" aria-label={`${label} detail`}
        style={{
          width: '100%', maxWidth: 1280,
          background: '#0b0f14', border: '1px solid rgba(150,178,205,0.17)',
          borderRadius: 6, padding: 24,
        }}
      >
        {series === null ? (
          <div style={{ color: '#8995a2', fontSize: 13, padding: '80px 0', textAlign: 'center' }}>
            <span className="animate-pulse">Loading {label}…</span>
          </div>
        ) : (
          <ExpressionDetail
            history={series}
            lookback={lookback}
            onLookbackChange={setLookback}
            lineColor={col}
            extraGroups={extraGroups}
            footnote={<>
              Level and mean-reversion stats use the selected lookback; carry, 3m RVol and betas are the monitor's
              fixed-window figures. Carry includes your repo assumptions. ←/→ to step through the list, Esc to close.
            </>}
            header={<>
              <button style={navBtn(!!prev)} disabled={!prev} onClick={() => prev && onSwitch(prev)} title="Previous (←)">‹</button>
              <button style={navBtn(!!next)} disabled={!next} onClick={() => next && onSwitch(next)} title="Next (→)">›</button>
              <span style={{
                fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 600, fontSize: 15, color: '#e4eaf1',
                background: `${col}1f`, border: `1px solid ${col}55`, borderRadius: 6, padding: '3px 10px',
              }}>{label}</span>
              <span style={{ color: col, fontSize: 12 }}>{groups[row.group]?.label ?? row.group}</span>
            </>}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose} style={navBtn(true)}>Close · Esc</button>
        </div>
      </div>
    </div>
  )
}

// ─── RV Monitor table ─────────────────────────────────────────────────────────

function RVTable({
  rows, focusLabel, onRowClick, groups,
  bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode,
}: {
  rows: RVRow[]
  focusLabel: string | null
  onRowClick: (label: string) => void
  groups: Record<string, GroupMeta>
  bundSpreadBps: number
  oatSpreadBps: number
  btpSpreadBps: number
  bonosSpreadBps: number
  carryMode: CarryMode
}) {
  const th: React.CSSProperties = {
    padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#8995a2',
    fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid rgba(200,220,240,0.07)',
    position: 'sticky', top: 0, background: '#0b0f14', zIndex: 1,
  }
  const thL: React.CSSProperties = { ...th, textAlign: 'left' }
  const td: React.CSSProperties = {
    padding: '6px 10px', textAlign: 'right', fontSize: 12,
    fontFamily: "'Geist Mono', ui-monospace, monospace", borderBottom: '1px solid rgba(200,220,240,0.04)',
    whiteSpace: 'nowrap',
  }
  const tdL: React.CSSProperties = { ...td, textAlign: 'left', fontFamily: 'inherit' }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={thL}>Expression</th>
            <th style={th}>Level</th>
            <th style={th}>1d</th>
            <th style={th}>1w</th>
            <th style={th}>1m</th>
            <th style={th}>Z (1y)</th>
            <th style={th}>Pctile</th>
            <th style={th}>3m RVol</th>
            <th style={th}>{carryMode === 'total' ? 'Carry+Roll' : carryMode === 'income' ? 'Carry only' : 'Roll only'}/yr</th>
            <th style={th}>C/V</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const zs    = zscoreStyle(r.zscore_1y)
            const col   = groupColor(r.group, groups)
            const isSel = focusLabel === r.label
            const carry = adjCarry(r, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode)
            const cv    = adjCarryVolRatio(r, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode)
            return (
              <tr key={r.label}
                onClick={() => onRowClick(r.label)}
                style={{ cursor: 'pointer', background: isSel ? 'rgba(106,169,204,0.07)' : 'transparent' }}>
                <td style={{ ...tdL, color: col, fontWeight: isSel ? 600 : 400 }}>{r.label}</td>
                <td style={{ ...td, color: '#e4eaf1' }}>{r.value_bps.toFixed(1)}</td>
                <td style={{ ...td, ...changeCellStyle(r.d1d_bps) }}>{fmtChange(r.d1d_bps)}</td>
                <td style={{ ...td, ...changeCellStyle(r.d1w_bps) }}>{fmtChange(r.d1w_bps)}</td>
                <td style={{ ...td, ...changeCellStyle(r.d1m_bps) }}>{fmtChange(r.d1m_bps)}</td>
                <td style={{ ...td, ...zs, borderRadius: 4 }}>{r.zscore_1y.toFixed(2)}</td>
                <td style={td}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                    <span style={{ color: '#c6ced8' }}>{r.pctile_1y.toFixed(0)}%</span>
                    <div style={{ width: 40, height: 4, background: 'rgba(200,220,240,0.08)', borderRadius: 2 }}>
                      <div style={{ width: `${r.pctile_1y}%`, height: '100%',
                        background: pctileBarColor(r.pctile_1y), borderRadius: 2 }} />
                    </div>
                  </div>
                </td>
                <td style={{ ...td, color: '#c6ced8' }}>{r.vol3m_bps.toFixed(1)}</td>
                <td style={{ ...td, color: carry > 0 ? '#6fc2a2' : '#e2826f' }}>
                  {carry > 0 ? '+' : ''}{carry.toFixed(1)}
                </td>
                <td style={{ ...td, color: cv !== null && cv > 0 ? '#6fc2a2' : '#e2826f' }}>
                  {cv !== null ? (cv > 0 ? '+' : '') + cv.toFixed(2) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


// ─── Beta Monitor table ───────────────────────────────────────────────────────

function BetaTable({ rows, groups, focusLabel, onRowClick }: {
  rows: BetaRow[]
  groups: Record<string, GroupMeta>
  focusLabel: string | null
  onRowClick: (label: string) => void
}) {
  const th: React.CSSProperties = {
    padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#8995a2',
    fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid rgba(200,220,240,0.07)',
    position: 'sticky', top: 0, background: '#0b0f14', zIndex: 1,
  }
  const thL: React.CSSProperties = { ...th, textAlign: 'left' }
  const td: React.CSSProperties = {
    padding: '6px 10px', textAlign: 'right', fontSize: 12,
    fontFamily: "'Geist Mono', ui-monospace, monospace", borderBottom: '1px solid rgba(200,220,240,0.04)', whiteSpace: 'nowrap',
  }
  const tdL: React.CSSProperties = { ...td, textAlign: 'left', fontFamily: 'inherit' }

  function betaColor(v: number) { return v > 0 ? '#a9d2e8' : '#e2bdd2' }
  function resZColor(z: number) { return Math.abs(z) > 1.5 ? '#dfbb78' : '#c6ced8' }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={thL}>Expression</th>
            <th style={th}>β Bund 10y</th>
            <th style={th}>β OAT-Bund</th>
            <th style={th}>β 2s10s</th>
            <th style={th}>β 1m10y Vol</th>
            <th style={th}>R²</th>
            <th style={th}>Resid Z</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label} onClick={() => onRowClick(r.label)}
              style={{ cursor: 'pointer', background: focusLabel === r.label ? 'rgba(106,169,204,0.07)' : 'transparent' }}>
              <td style={{ ...tdL, color: groupColor(r.group, groups) }}>{r.label}</td>
              <td style={{ ...td, color: betaColor(r.beta_bund10y) }}>{fmtBeta(r.beta_bund10y)}</td>
              <td style={{ ...td, color: betaColor(r.beta_spread10y) }}>{fmtBeta(r.beta_spread10y)}</td>
              <td style={{ ...td, color: betaColor(r.beta_slope) }}>{fmtBeta(r.beta_slope)}</td>
              <td style={{ ...td, color: betaColor(r.beta_vol1m10y) }}>{fmtBeta(r.beta_vol1m10y)}</td>
              <td style={{ ...td, color: r2Color(r.r2) }}>{r.r2.toFixed(3)}</td>
              <td style={{ ...td, color: resZColor(r.residual_zscore) }}>
                {(r.residual_zscore > 0 ? '+' : '') + r.residual_zscore.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Carry Decomposition Table ────────────────────────────────────────────────
// Shows carry ranked by C/V ratio — useful for identifying the best-carry trades

function CarryRankTable({ rows, groups, focusLabel, onRowClick, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode }: {
  focusLabel: string | null
  onRowClick: (label: string) => void
  rows: RVRow[]
  groups: Record<string, GroupMeta>
  bundSpreadBps: number
  oatSpreadBps: number
  btpSpreadBps: number
  bonosSpreadBps: number
  carryMode: CarryMode
}) {
  const sorted = [...rows]
    .filter(r => r.carry_vol_ratio !== null)
    .sort((a, b) => (adjCarryVolRatio(b, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode) ?? 0) - (adjCarryVolRatio(a, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode) ?? 0))

  const th: React.CSSProperties = {
    padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#8995a2',
    fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid rgba(200,220,240,0.07)',
    position: 'sticky', top: 0, background: '#0b0f14', zIndex: 1,
  }
  const thL: React.CSSProperties = { ...th, textAlign: 'left' }
  const td: React.CSSProperties = {
    padding: '6px 10px', textAlign: 'right', fontSize: 12,
    fontFamily: "'Geist Mono', ui-monospace, monospace", borderBottom: '1px solid rgba(200,220,240,0.04)', whiteSpace: 'nowrap',
  }
  const tdL: React.CSSProperties = { ...td, textAlign: 'left', fontFamily: 'inherit' }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'center', width: 36 }}>#</th>
            <th style={thL}>Expression</th>
            <th style={th}>Group</th>
            <th style={th}>Level</th>
            <th style={th}>Z (1y)</th>
            <th style={th}>Carry/yr</th>
            <th style={th}>3m RVol</th>
            <th style={th}>C/V</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const carry = adjCarry(r, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode)
            const cv    = adjCarryVolRatio(r, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode) ?? 0
            const col   = groupColor(r.group, groups)
            return (
              <tr key={r.label} onClick={() => onRowClick(r.label)}
                style={{ cursor: 'pointer', background: focusLabel === r.label ? 'rgba(106,169,204,0.07)' : 'transparent' }}>
                <td style={{ ...td, textAlign: 'center', color: '#8995a2' }}>{i + 1}</td>
                <td style={{ ...tdL, color: col }}>{r.label}</td>
                <td style={{ ...td, color: col, fontSize: 10 }}>{groups[r.group]?.label ?? r.group}</td>
                <td style={{ ...td, color: '#e4eaf1' }}>{r.value_bps.toFixed(1)}</td>
                <td style={{ ...td, ...zscoreStyle(r.zscore_1y) }}>{r.zscore_1y.toFixed(2)}</td>
                <td style={{ ...td, color: carry > 0 ? '#6fc2a2' : '#e2826f' }}>
                  {carry > 0 ? '+' : ''}{carry.toFixed(1)} bp
                </td>
                <td style={{ ...td, color: '#c6ced8' }}>{r.vol3m_bps.toFixed(1)}</td>
                <td style={{ ...td, color: cv > 0 ? '#6fc2a2' : '#e2826f', fontWeight: 600 }}>
                  {cv > 0 ? '+' : ''}{cv.toFixed(2)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


// ─── Bond Reference Panel ─────────────────────────────────────────────────────

const COUNTRY_ORDER = ['Bund', 'OAT', 'BTP', 'Bonos', 'Belgium', 'Portugal', 'Netherlands', 'Austria', 'Finland']
const COUNTRY_SHORT: Record<string, string> = {
  Bund: 'DE', OAT: 'FR', BTP: 'IT', Bonos: 'ES', Belgium: 'BE',
  Portugal: 'PT', Netherlands: 'NL', Austria: 'AT', Finland: 'FI',
}

function deviationColor(dev: number): string {
  if (dev < 0.25) return '#6fc2a2'
  if (dev < 0.75) return '#dfbb78'
  return '#e2826f'
}

function BondReferencePanel({ bondMap }: { bondMap: Record<string, Record<string, BondInfo | null>> }) {
  const [expanded, setExpanded] = useState(false)

  // Collect all tenors across all countries
  const allTenors = Array.from(
    new Set(Object.values(bondMap).flatMap(m => Object.keys(m).map(Number)))
  ).sort((a, b) => a - b)

  const countries = COUNTRY_ORDER.filter(c => bondMap[c])

  return (
    <div style={{
      background: 'rgba(139,143,216,0.05)',
      border: '1px solid rgba(139,143,216,0.2)',
      borderRadius: 6, padding: '14px 20px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: '#b9bdea', fontWeight: 600 }}>
          Bond Reference
        </span>
        <span style={{ fontSize: 11, color: '#8995a2' }}>
          Individual bonds selected by closest remaining maturity
        </span>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 10px', borderRadius: 5,
            border: '1px solid rgba(200,220,240,0.1)', background: 'rgba(200,220,240,0.03)',
            color: '#9aa5b1', cursor: 'pointer' }}>
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 16, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#8995a2',
                  borderBottom: '1px solid rgba(200,220,240,0.07)', whiteSpace: 'nowrap' }}>
                  Country
                </th>
                {allTenors.map(t => (
                  <th key={t} style={{ textAlign: 'center', padding: '6px 10px', color: '#8995a2',
                    borderBottom: '1px solid rgba(200,220,240,0.07)', whiteSpace: 'nowrap' }}>
                    {t}y
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {countries.map(country => (
                <tr key={country}>
                  <td style={{ padding: '6px 10px', color: '#c6ced8', fontWeight: 600,
                    borderBottom: '1px solid rgba(200,220,240,0.04)', whiteSpace: 'nowrap' }}>
                    {COUNTRY_SHORT[country]} ({country})
                  </td>
                  {allTenors.map(t => {
                    const info = bondMap[country]?.[String(t)] ?? null
                    if (!info) {
                      return (
                        <td key={t} style={{ padding: '6px 10px', textAlign: 'center',
                          borderBottom: '1px solid rgba(200,220,240,0.04)', color: '#77828f' }}>
                          —
                        </td>
                      )
                    }
                    // Extract short ticker label: "DBR 0 08/15/2034 Govt" → "DBR 08/2034"
                    const parts = info.ticker.split(' ')
                    const shortLabel = parts.length >= 3 ? `${parts[0]} ${parts[parts.length - 2].slice(3)}` : info.ticker
                    return (
                      <td key={t} style={{ padding: '6px 10px', textAlign: 'center',
                        borderBottom: '1px solid rgba(200,220,240,0.04)', whiteSpace: 'nowrap' }}
                        title={`${info.ticker}\nMaturity: ${info.maturity}\nActual: ${info.actual_years.toFixed(2)}y\nYield: ${info.yield_pct.toFixed(3)}%\nDuration: ${info.duration.toFixed(2)}\nOutstanding: ${(info.outstanding_mn / 1000).toFixed(0)} bn`}>
                        <div style={{ color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 10 }}>
                          {shortLabel}
                        </div>
                        <div style={{ color: deviationColor(info.deviation_years), fontSize: 10, marginTop: 2 }}>
                          {info.actual_years.toFixed(2)}y
                          {info.deviation_years > 0.1 && (
                            <span style={{ color: '#8995a2' }}> ({info.deviation_years > 0 ? '+' : ''}{info.deviation_years.toFixed(2)})</span>
                          )}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 10, color: '#77828f' }}>
            Colour = deviation from target tenor: <span style={{ color: '#6fc2a2' }}>green &lt;0.25y</span> · <span style={{ color: '#dfbb78' }}>amber &lt;0.75y</span> · <span style={{ color: '#e2826f' }}>red ≥0.75y</span>.
            Hover a cell for full ticker, yield, duration, and outstanding.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main page component ──────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: 'rgba(200,220,240,0.03)',
  border: '1px solid rgba(200,220,240,0.07)',
  borderRadius: 6,
  padding: '24px 28px',
  marginBottom: 24,
}

const stickyBg = '#07090c'

type TabId = 'rv' | 'carry' | 'beta' | 'scatter'

export default function EGBRV() {
  const navigate = useNavigate()

  const [data, setData]             = useState<EGBRVData | null>(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [useIndividualBonds, setUseIndividualBonds] = useState(false)

  const [tab, setTab]                 = useState<TabId>('rv')
  const [focusLabel, setFocusLabel]   = useState<string | null>(null)
  const [betaVar, setBetaVar]         = useState<string>('beta_bund10y')
  const [groupFilter, setGroupFilter] = useState<string>('all')
  const [bundSpreadBps, setBundSpreadBps]   = useState<number>(0)
  const [oatSpreadBps, setOatSpreadBps]     = useState<number>(0)
  const [btpSpreadBps, setBtpSpreadBps]     = useState<number>(0)
  const [bonosSpreadBps, setBonosSpreadBps] = useState<number>(0)
  const [showAssumptions, setShowAssumptions] = useState(false)
  const [carryMode, setCarryMode] = useState<CarryMode>('total')

  // Filtered rows for the current group selection
  const filteredRV   = useMemo(() =>
    data ? (groupFilter === 'all' ? data.rv_monitor : data.rv_monitor.filter(r => r.group === groupFilter))
         : [], [data, groupFilter])
  const filteredBeta = useMemo(() =>
    data ? (groupFilter === 'all' ? data.beta_monitor : data.beta_monitor.filter(r => r.group === groupFilter))
         : [], [data, groupFilter])

  const [refreshKey, setRefreshKey] = useState(0)
  const [detailLabel, setDetailLabel] = useState<string | null>(null)
  const [detailSeries, setDetailSeries] = useState<SeriesPoint[] | null>(null)
  // Series are fetched per expression on demand; cleared whenever the monitor data reloads
  const seriesCache = useRef<Record<string, SeriesPoint[]>>({})

  function handleAuthError(err: unknown): boolean {
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      localStorage.removeItem('access_token')
      navigate('/login', { replace: true })
      return true
    }
    return false
  }

  useEffect(() => {
    const token = localStorage.getItem('access_token')
    if (!token) { navigate('/login', { replace: true }); return }
    setLoading(true)
    seriesCache.current = {}
    axios.get('/api/tools/egb-rv', {
      headers: { Authorization: `Bearer ${token}` },
      params: { use_individual_bonds: useIndividualBonds, refresh: refreshKey > 0 },
    })
      .then(res => { setData(res.data); setError(null) })
      .catch(err => {
        if (!handleAuthError(err)) setError(err.response?.data?.detail ?? err.message)
      })
      .finally(() => setLoading(false))
  }, [useIndividualBonds, refreshKey])

  useEffect(() => {
    if (!detailLabel || !data) { setDetailSeries(null); return }
    const cached = seriesCache.current[detailLabel]
    if (cached) { setDetailSeries(cached); return }
    const token = localStorage.getItem('access_token')
    if (!token) return
    let cancelled = false
    setDetailSeries(null)
    axios.get<SeriesPoint[]>('/api/tools/egb-rv/series', {
      headers: { Authorization: `Bearer ${token}` },
      params: { label: detailLabel, use_individual_bonds: useIndividualBonds },
    })
      .then(res => {
        seriesCache.current[detailLabel] = res.data
        if (!cancelled) setDetailSeries(res.data)
      })
      .catch(err => { handleAuthError(err) })
    return () => { cancelled = true }
  }, [detailLabel, data])

  // Labels in the order the current tab shows them — drives prev / next in the detail overlay
  const detailSiblings = useMemo(() => {
    if (tab === 'beta') return filteredBeta.map(r => r.label)
    if (tab === 'carry') {
      const cvOf = (r: RVRow) => adjCarryVolRatio(r, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode) ?? 0
      return filteredRV.filter(r => r.carry_vol_ratio !== null).sort((a, b) => cvOf(b) - cvOf(a)).map(r => r.label)
    }
    return filteredRV.map(r => r.label)
  }, [tab, filteredRV, filteredBeta, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode])

  const detailRow = detailLabel && data ? data.rv_monitor.find(r => r.label === detailLabel) ?? null : null

  function handleRowClick(label: string) {
    setFocusLabel(label)
    setDetailLabel(label)
  }

  const closeDetail = useCallback(() => setDetailLabel(null), [])
  const switchDetail = useCallback((label: string) => { setFocusLabel(label); setDetailLabel(label) }, [])

  const tabStyle = (id: TabId): React.CSSProperties => ({
    padding: '6px 18px', borderRadius: 6, fontSize: 13, fontWeight: 500,
    border: '1px solid', cursor: 'pointer',
    borderColor: tab === id ? 'rgba(106,169,204,0.5)' : 'rgba(200,220,240,0.1)',
    background:  tab === id ? 'rgba(106,169,204,0.15)' : 'rgba(200,220,240,0.03)',
    color:       tab === id ? '#a9d2e8' : '#9aa5b1',
  })

  const grpBtnStyle = (key: string): React.CSSProperties => ({
    padding: '4px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
    border: '1px solid', fontWeight: 500,
    borderColor: groupFilter === key ? 'rgba(200,220,240,0.3)' : 'rgba(200,220,240,0.1)',
    background:  groupFilter === key ? 'rgba(200,220,240,0.1)' : 'rgba(200,220,240,0.03)',
    color:       groupFilter === key ? '#e4eaf1' : '#9aa5b1',
  })

  return (
    <div style={{ minHeight: '100vh', background: stickyBg, color: '#e4eaf1', padding: '0 0 80px 0' }}>

      {/* Header */}
      <div style={{ ...headerBar, padding: '12px 32px',
        display: 'flex', alignItems: 'center', gap: 16 }}>
        <PageTitle category="Futures / Swaps / Vol" categoryId="futures-swaps-vol" title="EGB RV Monitor" subtitle="Bund · OAT · BTP · Bonos · BE · PGB · NL · AT · FI" />
        {data && (
          <span className="hub-num" style={{ marginLeft: 'auto', fontSize: 11, color: '#9aa5b1' }}>As of {data.as_of}</span>
        )}
        {/* Individual bonds toggle */}
        <button
          onClick={() => setUseIndividualBonds(v => !v)}
          title={useIndividualBonds ? 'Using individual bonds (click to switch to generic)' : 'Using generic BBG tickers (click to switch to individual bonds)'}
          style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${useIndividualBonds ? 'rgba(139,143,216,0.5)' : 'rgba(200,220,240,0.15)'}`,
            background: useIndividualBonds ? 'rgba(139,143,216,0.15)' : 'rgba(200,220,240,0.05)',
            color: useIndividualBonds ? '#b9bdea' : '#9aa5b1',
          }}>
          {useIndividualBonds ? 'Individual bonds' : 'Generic tickers'}
        </button>
        <button
          onClick={() => setRefreshKey(k => k + 1)}
          disabled={loading}
          title="Re-pull data (results are cached for 15 min)"
          style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1,
            border: '1px solid rgba(200,220,240,0.15)',
            background: 'rgba(200,220,240,0.05)', color: '#9aa5b1',
          }}>
          ↻ Refresh
        </button>
        {data && (
          <span style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 6,
            background: data.data_source === 'bloomberg' ? 'rgba(88,173,142,0.15)' : 'rgba(214,173,102,0.15)',
            color:      data.data_source === 'bloomberg' ? '#6fc2a2' : '#dfbb78',
            border: `1px solid ${data.data_source === 'bloomberg' ? 'rgba(88,173,142,0.3)' : 'rgba(214,173,102,0.3)'}`,
          }}>
            {data.data_source === 'bloomberg'
              ? (data.yield_mode === 'individual_bonds' ? 'Live · Individual bonds' : 'Live · Generic tickers')
              : 'Simulated data'}
          </span>
        )}
      </div>

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 32px 0' }}>

        {loading && (
          <div style={{ textAlign: 'center', padding: 80, color: '#8995a2' }}>Loading…</div>
        )}
        {error && (
          <div style={{ color: '#e2826f', padding: 24, background: 'rgba(217,112,94,0.08)',
            border: '1px solid rgba(217,112,94,0.2)', borderRadius: 6 }}>Error: {error}</div>
        )}

        {data && !loading && (
          <>
            {/* Group filter + Tab switcher */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24, alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                <button style={grpBtnStyle('all')} onClick={() => setGroupFilter('all')}>All</button>
                {Object.entries(data.groups).map(([key, meta]) => (
                  <button key={key} style={{ ...grpBtnStyle(key),
                    borderColor: groupFilter === key ? meta.color : 'rgba(200,220,240,0.1)',
                    color:       groupFilter === key ? meta.color : '#9aa5b1',
                    background:  groupFilter === key ? `${meta.color}22` : 'rgba(200,220,240,0.03)',
                  }} onClick={() => setGroupFilter(key)}>
                    {meta.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['rv','carry','scatter','beta'] as TabId[]).map(id => (
                  <button key={id} style={tabStyle(id)} onClick={() => setTab(id)}>
                    {id === 'rv' ? 'RV Monitor' : id === 'carry' ? 'Carry Rank' : id === 'scatter' ? 'Scatter' : 'Beta'}
                  </button>
                ))}
              </div>
            </div>

            {/* Repo Assumptions Panel */}
            <div style={{ ...cardStyle, marginBottom: 16, padding: '14px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: '#9aa5b1', fontWeight: 500 }}>Carry view:</span>
                {([['total', 'Carry + Roll'], ['income', 'Carry only'], ['roll', 'Roll only']] as [CarryMode, string][]).map(([mode, label]) => (
                  <button key={mode} onClick={() => setCarryMode(mode)}
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
                      border: '1px solid',
                      borderColor: carryMode === mode ? 'rgba(139,143,216,0.5)' : 'rgba(200,220,240,0.1)',
                      background:  carryMode === mode ? 'rgba(139,143,216,0.15)' : 'rgba(200,220,240,0.03)',
                      color:       carryMode === mode ? '#b9bdea' : '#9aa5b1' }}>
                    {label}
                  </button>
                ))}
                <span style={{ marginLeft: 8, fontSize: 12, color: '#9aa5b1', fontWeight: 500 }}>Repo assumptions</span>
                <button onClick={() => setShowAssumptions(s => !s)}
                  style={{ fontSize: 11, padding: '2px 10px', borderRadius: 5, border: '1px solid rgba(200,220,240,0.1)',
                    background: showAssumptions ? 'rgba(200,220,240,0.08)' : 'rgba(200,220,240,0.03)',
                    color: '#9aa5b1', cursor: 'pointer' }}>
                  {showAssumptions ? 'Hide' : 'Edit'}
                </button>
                {(bundSpreadBps !== 0 || oatSpreadBps !== 0 || btpSpreadBps !== 0 || bonosSpreadBps !== 0) && (
                  <span style={{ fontSize: 11, color: '#dfbb78' }}>
                    {[['Bund', bundSpreadBps], ['OAT', oatSpreadBps], ['BTP', btpSpreadBps], ['Bonos', bonosSpreadBps]]
                      .filter(([, v]) => (v as number) !== 0)
                      .map(([lbl, v]) => `${lbl}: ${(v as number) > 0 ? '+' : ''}${v} bp`)
                      .join(' | ')
                    } vs ESTR
                  </span>
                )}
                {(bundSpreadBps !== 0 || oatSpreadBps !== 0 || btpSpreadBps !== 0 || bonosSpreadBps !== 0) && (
                  <button onClick={() => { setBundSpreadBps(0); setOatSpreadBps(0); setBtpSpreadBps(0); setBonosSpreadBps(0) }}
                    style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid rgba(200,220,240,0.1)',
                      background: 'transparent', color: '#8995a2', cursor: 'pointer' }}>
                    Reset
                  </button>
                )}
              </div>
              {showAssumptions && (
                <div style={{ marginTop: 14, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                  {([
                    { label: 'Bund repo vs ESTR (bp)',  value: bundSpreadBps,  set: setBundSpreadBps,  color: '#6aa9cc' },
                    { label: 'OAT repo vs ESTR (bp)',   value: oatSpreadBps,   set: setOatSpreadBps,   color: '#a08bd2' },
                    { label: 'BTP repo vs ESTR (bp)',   value: btpSpreadBps,   set: setBtpSpreadBps,   color: '#58ad8e' },
                    { label: 'Bonos repo vs ESTR (bp)', value: bonosSpreadBps, set: setBonosSpreadBps, color: '#d6ad66' },
                  ] as { label: string; value: number; set: (v: number) => void; color: string }[]).map(({ label, value, set, color }) => (
                    <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span style={{ fontSize: 11, color: '#9aa5b1' }}>{label}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="range" min={-100} max={50} step={1} value={value}
                          onChange={e => set(Number(e.target.value))}
                          style={{ width: 140, accentColor: color }} />
                        <input type="number" value={value} min={-100} max={50} step={1}
                          onChange={e => set(Number(e.target.value))}
                          style={{ width: 56, padding: '3px 6px', borderRadius: 5, fontSize: 12,
                            border: '1px solid rgba(200,220,240,0.15)', background: 'rgba(200,220,240,0.06)',
                            color: value < 0 ? '#6fc2a2' : value > 0 ? '#e2826f' : '#c6ced8',
                            textAlign: 'right', fontFamily: "'Geist Mono', ui-monospace, monospace" }} />
                        <span style={{ fontSize: 11, color: '#8995a2' }}>bp</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', width: 140, fontSize: 10, color: '#77828f' }}>
                        <span>−100</span><span>0</span><span>+50</span>
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: '#77828f', alignSelf: 'flex-end', maxWidth: 280, lineHeight: 1.5 }}>
                    Negative = repo below ESTR (e.g. Bund special).
                    OAT bloc covers BE/NL/AT/FI. Bonos bloc covers Portugal.
                    Carry adjusts instantly — no refetch needed.
                  </div>
                </div>
              )}
            </div>

            {/* Bond Reference panel — only in individual bonds mode */}
            {data.yield_mode === 'individual_bonds' && Object.keys(data.bond_map).length > 0 && (
              <BondReferencePanel bondMap={data.bond_map} />
            )}

            {/* RV Monitor tab */}
            {tab === 'rv' && (
              <div style={cardStyle}>
                <div style={{ fontSize: 14, color: '#c6ced8', marginBottom: 16 }}>
                  Click any row (here, in Carry Rank or Beta) or a scatter bubble for its history and summary stats.
                  Carry = coupon carry + roll-down per unit DV01, annualised (bps/yr).
                </div>
                <RVTable rows={filteredRV} focusLabel={focusLabel} onRowClick={handleRowClick}
                  groups={data.groups} bundSpreadBps={bundSpreadBps} oatSpreadBps={oatSpreadBps}
                  btpSpreadBps={btpSpreadBps} bonosSpreadBps={bonosSpreadBps} carryMode={carryMode} />
              </div>
            )}

            {/* Carry Rank tab */}
            {tab === 'carry' && (
              <div style={cardStyle}>
                <div style={{ fontSize: 14, color: '#c6ced8', marginBottom: 16 }}>
                  Expressions ranked by carry-to-vol ratio (highest first).
                  C/V &gt; 0 = the carry works in your favour at current z-score.
                </div>
                <CarryRankTable rows={filteredRV} groups={data.groups} focusLabel={focusLabel} onRowClick={handleRowClick}
                  bundSpreadBps={bundSpreadBps} oatSpreadBps={oatSpreadBps}
                  btpSpreadBps={btpSpreadBps} bonosSpreadBps={bonosSpreadBps} carryMode={carryMode} />
              </div>
            )}

            {/* Scatter tab */}
            {tab === 'scatter' && (
              <div style={cardStyle}>
                <div style={{ display: 'flex', gap: 16, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: '#c6ced8' }}>Bubble size = |β| for:</span>
                  {BETA_VARS.map(bv => (
                    <button key={bv.key}
                      onClick={() => setBetaVar(bv.key)}
                      style={{ fontSize: 11, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
                        border: '1px solid', fontWeight: 500,
                        borderColor: betaVar === bv.key ? 'rgba(139,143,216,0.5)' : 'rgba(200,220,240,0.1)',
                        background:  betaVar === bv.key ? 'rgba(139,143,216,0.15)' : 'rgba(200,220,240,0.03)',
                        color:       betaVar === bv.key ? '#b9bdea' : '#9aa5b1' }}>
                      {bv.label}
                    </button>
                  ))}
                  {focusLabel && (
                    <button onClick={() => setFocusLabel(null)}
                      style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 10px', borderRadius: 6,
                        border: '1px solid rgba(200,220,240,0.15)', background: 'rgba(200,220,240,0.05)',
                        color: '#9aa5b1', cursor: 'pointer' }}>
                      Clear selection
                    </button>
                  )}
                </div>
                <CarryVolChart
                  rvMonitor={filteredRV} betaMonitor={filteredBeta}
                  focusLabel={focusLabel} onBubbleClick={handleRowClick}
                  betaVar={betaVar} groupFilter={groupFilter} groups={data.groups} />
              </div>
            )}

            {/* Beta tab */}
            {tab === 'beta' && (
              <div style={cardStyle}>
                <div style={{ fontSize: 14, color: '#c6ced8', marginBottom: 16 }}>
                  OLS regression of daily changes on: Bund 10y, OAT−Bund 10y, Bund 2s10s, EUR 1m10y vol.
                  Resid Z = z-score of cumulative residual (signals mean reversion vs trend).
                </div>
                <BetaTable rows={filteredBeta} groups={data.groups} focusLabel={focusLabel} onRowClick={handleRowClick} />
              </div>
            )}
          </>
        )}
      </div>

      {data && detailLabel && detailRow && (
        <DetailModal
          label={detailLabel}
          row={detailRow}
          betaRow={data.beta_monitor.find(b => b.label === detailLabel)}
          series={detailSeries}
          groups={data.groups}
          siblings={detailSiblings}
          onSwitch={switchDetail}
          onClose={closeDetail}
          bundSpreadBps={bundSpreadBps} oatSpreadBps={oatSpreadBps}
          btpSpreadBps={btpSpreadBps} bonosSpreadBps={bonosSpreadBps}
          carryMode={carryMode}
        />
      )}
    </div>
  )
}
