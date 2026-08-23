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

interface SeriesPoint {
  date: string
  value: number
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
  series: Record<string, SeriesPoint[]>
  groups: Record<string, GroupMeta>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zscoreStyle(z: number): { background: string; color: string } {
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

// ─── Group color lookup ───────────────────────────────────────────────────────

function groupColor(group: string, groups: Record<string, GroupMeta>): string {
  return groups[group]?.color ?? '#94a3b8'
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
          fill={color} stroke={isSelected ? '#fff' : color}
          strokeWidth={isSelected ? 1.5 : 0} strokeOpacity={0.6}
          fillOpacity={isSelected ? 1 : 0.82} />
        <text x={cx + r + 4} y={cy} dominantBaseline="middle"
          fontSize={isSelected ? 10 : 9} fontWeight={isSelected ? 700 : 400}
          fill={isSelected ? '#f1f5f9' : '#94a3b8'}
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
      background: 'rgba(8,13,26,0.96)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: '10px 14px', fontSize: 12,
    }}>
      <div style={{ color: '#e2e8f0', fontWeight: 600, marginBottom: 6, fontFamily: 'monospace' }}>{d.label}</div>
      <div style={{ color: '#64748b' }}>Z-score (1y) <span style={{ color: '#f1f5f9' }}>{d.x.toFixed(2)}</span></div>
      <div style={{ color: '#64748b' }}>C/V ratio    <span style={{ color: d.y > 0 ? '#34d399' : '#f87171' }}>{d.y.toFixed(2)}</span></div>
      <div style={{ color: '#64748b' }}>Carry (1y)   <span style={{ color: '#cbd5e1' }}>{d.carry1y_bps.toFixed(1)} bp</span></div>
      <div style={{ color: '#64748b' }}>3m RVol      <span style={{ color: '#cbd5e1' }}>{d.vol3m_bps.toFixed(1)} bp</span></div>
      <div style={{ color: '#64748b' }}>Level        <span style={{ color: '#cbd5e1' }}>{d.value_bps.toFixed(1)} bp</span></div>
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
          style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.15)',
            background: zoomMode ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.05)',
            color: zoomMode ? '#93c5fd' : '#64748b', cursor: 'pointer' }}>
          {zoomMode ? 'Zoom ON' : 'Zoom'}
        </button>
        {zoomDomain && (
          <button onClick={() => setZoomDomain(null)}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(255,255,255,0.05)', color: '#64748b', cursor: 'pointer' }}>
            Reset
          </button>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <ResponsiveContainer width="100%" height={CHART_H}>
          <ScatterChart margin={CHART_MARGIN}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="x" type="number" domain={[xLo, xHi]} name="Z-score"
              label={{ value: 'Z-score (1y)', position: 'insideBottom', offset: -10, fill: '#64748b', fontSize: 12 }}
              tick={{ fill: '#64748b', fontSize: 11 }} />
            <YAxis dataKey="y" type="number" domain={[yLo, yHi]} name="C/V Ratio"
              label={{ value: 'Carry / Vol', angle: -90, position: 'insideLeft', offset: 10, fill: '#64748b', fontSize: 12 }}
              tick={{ fill: '#64748b', fontSize: 11 }} />
            <Tooltip content={<CarryVolTooltip />} />
            <ReferenceLine x={0}  stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
            <ReferenceLine y={0}  stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
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
              <div style={{ position: 'absolute', border: '1px solid rgba(59,130,246,0.6)',
                background: 'rgba(59,130,246,0.08)', ...dragBox, pointerEvents: 'none' }} />
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


// ─── Detail chart (1y time series) ───────────────────────────────────────────

function DetailLineTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'rgba(8,13,26,0.96)', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#64748b', marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#e2e8f0' }}>{payload[0].value?.toFixed(2)} bp</div>
    </div>
  )
}

function DetailChart({ series, label, color }: { series: SeriesPoint[]; label: string; color: string }) {
  const values = series.map(d => d.value)
  const mean   = values.reduce((a, b) => a + b, 0) / values.length
  const yMin   = Math.min(...values)
  const yMax   = Math.max(...values)
  const pad    = (yMax - yMin) * 0.08 || 2
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontFamily: 'monospace', color: '#e2e8f0', fontSize: 14, marginBottom: 12 }}>
        {label} — 1y history
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={series} margin={{ top: 8, right: 20, bottom: 20, left: 40 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 10 }}
            tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
          <YAxis domain={[yMin - pad, yMax + pad]} tick={{ fill: '#64748b', fontSize: 11 }}
            tickFormatter={v => `${v.toFixed(0)}`} />
          <Tooltip content={<DetailLineTooltip />} />
          <ReferenceLine y={mean} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
          <Line type="monotone" dataKey="value" stroke={color} dot={false} strokeWidth={1.5} />
        </LineChart>
      </ResponsiveContainer>
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
    padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#475569',
    fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid rgba(255,255,255,0.07)',
    position: 'sticky', top: 0, background: '#0d1425', zIndex: 1,
  }
  const thL: React.CSSProperties = { ...th, textAlign: 'left' }
  const td: React.CSSProperties = {
    padding: '6px 10px', textAlign: 'right', fontSize: 12,
    fontFamily: 'monospace', borderBottom: '1px solid rgba(255,255,255,0.04)',
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
                style={{ cursor: 'pointer', background: isSel ? 'rgba(59,130,246,0.07)' : 'transparent' }}>
                <td style={{ ...tdL, color: col, fontWeight: isSel ? 600 : 400 }}>{r.label}</td>
                <td style={{ ...td, color: '#e2e8f0' }}>{r.value_bps.toFixed(1)}</td>
                <td style={{ ...td, ...changeCellStyle(r.d1d_bps) }}>{fmtChange(r.d1d_bps)}</td>
                <td style={{ ...td, ...changeCellStyle(r.d1w_bps) }}>{fmtChange(r.d1w_bps)}</td>
                <td style={{ ...td, ...changeCellStyle(r.d1m_bps) }}>{fmtChange(r.d1m_bps)}</td>
                <td style={{ ...td, ...zs, borderRadius: 4 }}>{r.zscore_1y.toFixed(2)}</td>
                <td style={td}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                    <span style={{ color: '#94a3b8' }}>{r.pctile_1y.toFixed(0)}%</span>
                    <div style={{ width: 40, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2 }}>
                      <div style={{ width: `${r.pctile_1y}%`, height: '100%',
                        background: pctileBarColor(r.pctile_1y), borderRadius: 2 }} />
                    </div>
                  </div>
                </td>
                <td style={{ ...td, color: '#94a3b8' }}>{r.vol3m_bps.toFixed(1)}</td>
                <td style={{ ...td, color: carry > 0 ? '#34d399' : '#f87171' }}>
                  {carry > 0 ? '+' : ''}{carry.toFixed(1)}
                </td>
                <td style={{ ...td, color: cv !== null && cv > 0 ? '#34d399' : '#f87171' }}>
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

function BetaTable({ rows, groups }: { rows: BetaRow[]; groups: Record<string, GroupMeta> }) {
  const th: React.CSSProperties = {
    padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#475569',
    fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid rgba(255,255,255,0.07)',
    position: 'sticky', top: 0, background: '#0d1425', zIndex: 1,
  }
  const thL: React.CSSProperties = { ...th, textAlign: 'left' }
  const td: React.CSSProperties = {
    padding: '6px 10px', textAlign: 'right', fontSize: 12,
    fontFamily: 'monospace', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap',
  }
  const tdL: React.CSSProperties = { ...td, textAlign: 'left', fontFamily: 'inherit' }

  function betaColor(v: number) { return v > 0 ? '#93c5fd' : '#f9a8d4' }
  function resZColor(z: number) { return Math.abs(z) > 1.5 ? '#fbbf24' : '#94a3b8' }

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
            <tr key={r.label}>
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

function CarryRankTable({ rows, groups, bundSpreadBps, oatSpreadBps, btpSpreadBps, bonosSpreadBps, carryMode }: {
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
    padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#475569',
    fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid rgba(255,255,255,0.07)',
    position: 'sticky', top: 0, background: '#0d1425', zIndex: 1,
  }
  const thL: React.CSSProperties = { ...th, textAlign: 'left' }
  const td: React.CSSProperties = {
    padding: '6px 10px', textAlign: 'right', fontSize: 12,
    fontFamily: 'monospace', borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap',
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
              <tr key={r.label}>
                <td style={{ ...td, textAlign: 'center', color: '#475569' }}>{i + 1}</td>
                <td style={{ ...tdL, color: col }}>{r.label}</td>
                <td style={{ ...td, color: col, fontSize: 10 }}>{groups[r.group]?.label ?? r.group}</td>
                <td style={{ ...td, color: '#e2e8f0' }}>{r.value_bps.toFixed(1)}</td>
                <td style={{ ...td, ...zscoreStyle(r.zscore_1y) }}>{r.zscore_1y.toFixed(2)}</td>
                <td style={{ ...td, color: carry > 0 ? '#34d399' : '#f87171' }}>
                  {carry > 0 ? '+' : ''}{carry.toFixed(1)} bp
                </td>
                <td style={{ ...td, color: '#94a3b8' }}>{r.vol3m_bps.toFixed(1)}</td>
                <td style={{ ...td, color: cv > 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>
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
  if (dev < 0.25) return '#34d399'
  if (dev < 0.75) return '#fbbf24'
  return '#f87171'
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
      background: 'rgba(99,102,241,0.05)',
      border: '1px solid rgba(99,102,241,0.2)',
      borderRadius: 12, padding: '14px 20px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: '#a5b4fc', fontWeight: 600 }}>
          Bond Reference
        </span>
        <span style={{ fontSize: 11, color: '#475569' }}>
          Individual bonds selected by closest remaining maturity
        </span>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 10px', borderRadius: 5,
            border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)',
            color: '#64748b', cursor: 'pointer' }}>
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 16, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#475569',
                  borderBottom: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'nowrap' }}>
                  Country
                </th>
                {allTenors.map(t => (
                  <th key={t} style={{ textAlign: 'center', padding: '6px 10px', color: '#475569',
                    borderBottom: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'nowrap' }}>
                    {t}y
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {countries.map(country => (
                <tr key={country}>
                  <td style={{ padding: '6px 10px', color: '#94a3b8', fontWeight: 600,
                    borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap' }}>
                    {COUNTRY_SHORT[country]} ({country})
                  </td>
                  {allTenors.map(t => {
                    const info = bondMap[country]?.[String(t)] ?? null
                    if (!info) {
                      return (
                        <td key={t} style={{ padding: '6px 10px', textAlign: 'center',
                          borderBottom: '1px solid rgba(255,255,255,0.04)', color: '#334155' }}>
                          —
                        </td>
                      )
                    }
                    // Extract short ticker label: "DBR 0 08/15/2034 Govt" → "DBR 08/2034"
                    const parts = info.ticker.split(' ')
                    const shortLabel = parts.length >= 3 ? `${parts[0]} ${parts[parts.length - 2].slice(3)}` : info.ticker
                    return (
                      <td key={t} style={{ padding: '6px 10px', textAlign: 'center',
                        borderBottom: '1px solid rgba(255,255,255,0.04)', whiteSpace: 'nowrap' }}
                        title={`${info.ticker}\nMaturity: ${info.maturity}\nActual: ${info.actual_years.toFixed(2)}y\nYield: ${info.yield_pct.toFixed(3)}%\nDuration: ${info.duration.toFixed(2)}\nOutstanding: ${(info.outstanding_mn / 1000).toFixed(0)} bn`}>
                        <div style={{ color: '#e2e8f0', fontFamily: 'monospace', fontSize: 10 }}>
                          {shortLabel}
                        </div>
                        <div style={{ color: deviationColor(info.deviation_years), fontSize: 10, marginTop: 2 }}>
                          {info.actual_years.toFixed(2)}y
                          {info.deviation_years > 0.1 && (
                            <span style={{ color: '#475569' }}> ({info.deviation_years > 0 ? '+' : ''}{info.deviation_years.toFixed(2)})</span>
                          )}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 10, color: '#334155' }}>
            Colour = deviation from target tenor: <span style={{ color: '#34d399' }}>green &lt;0.25y</span> · <span style={{ color: '#fbbf24' }}>amber &lt;0.75y</span> · <span style={{ color: '#f87171' }}>red ≥0.75y</span>.
            Hover a cell for full ticker, yield, duration, and outstanding.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main page component ──────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: '24px 28px',
  marginBottom: 24,
}

const stickyBg = '#080d1a'

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

  useEffect(() => {
    const token = localStorage.getItem('access_token')
    if (!token) { navigate('/login', { replace: true }); return }
    setLoading(true)
    axios.get('/api/tools/egb-rv', {
      headers: { Authorization: `Bearer ${token}` },
      params: { use_individual_bonds: useIndividualBonds },
    })
      .then(res => { setData(res.data); setError(null) })
      .catch(err => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        } else {
          setError(err.response?.data?.detail ?? err.message)
        }
      })
      .finally(() => setLoading(false))
  }, [useIndividualBonds])

  const focusSeries = useMemo(() => {
    if (!focusLabel || !data?.series[focusLabel]) return null
    return data.series[focusLabel]
  }, [focusLabel, data])

  const focusRow = useMemo(() =>
    focusLabel && data ? data.rv_monitor.find(r => r.label === focusLabel) ?? null : null,
    [focusLabel, data])

  function handleRowClick(label: string) {
    setFocusLabel(prev => prev === label ? null : label)
  }

  const tabStyle = (id: TabId): React.CSSProperties => ({
    padding: '6px 18px', borderRadius: 8, fontSize: 13, fontWeight: 500,
    border: '1px solid', cursor: 'pointer',
    borderColor: tab === id ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.1)',
    background:  tab === id ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)',
    color:       tab === id ? '#93c5fd' : '#64748b',
  })

  const grpBtnStyle = (key: string): React.CSSProperties => ({
    padding: '4px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
    border: '1px solid', fontWeight: 500,
    borderColor: groupFilter === key ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)',
    background:  groupFilter === key ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)',
    color:       groupFilter === key ? '#e2e8f0' : '#64748b',
  })

  return (
    <div style={{ minHeight: '100vh', background: stickyBg, color: '#e2e8f0', padding: '0 0 80px 0' }}>

      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 100, background: stickyBg,
        borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '14px 32px',
        display: 'flex', alignItems: 'center', gap: 16 }}>
        <button onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 20 }}>
          ←
        </button>
        <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.5px' }}>EGB RV Monitor</span>
        <span style={{ fontSize: 12, color: '#475569' }}>Bund · OAT · BTP · Bonos · BE · PGB · NL · AT · FI</span>
        {data && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#475569' }}>as of {data.as_of}</span>
        )}
        {/* Individual bonds toggle */}
        <button
          onClick={() => setUseIndividualBonds(v => !v)}
          title={useIndividualBonds ? 'Using individual bonds (click to switch to generic)' : 'Using generic BBG tickers (click to switch to individual bonds)'}
          style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 20, cursor: 'pointer',
            border: `1px solid ${useIndividualBonds ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.15)'}`,
            background: useIndividualBonds ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)',
            color: useIndividualBonds ? '#a5b4fc' : '#64748b',
          }}>
          {useIndividualBonds ? 'Individual bonds' : 'Generic tickers'}
        </button>
        {data && (
          <span style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 20,
            background: data.data_source === 'bloomberg' ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
            color:      data.data_source === 'bloomberg' ? '#34d399' : '#fbbf24',
            border: `1px solid ${data.data_source === 'bloomberg' ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)'}`,
          }}>
            {data.data_source === 'bloomberg'
              ? (data.yield_mode === 'individual_bonds' ? 'Live · Individual bonds' : 'Live · Generic tickers')
              : 'Simulated data'}
          </span>
        )}
      </div>

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 32px 0' }}>

        {loading && (
          <div style={{ textAlign: 'center', padding: 80, color: '#475569' }}>Loading…</div>
        )}
        {error && (
          <div style={{ color: '#f87171', padding: 24, background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8 }}>Error: {error}</div>
        )}

        {data && !loading && (
          <>
            {/* Group filter + Tab switcher */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24, alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                <button style={grpBtnStyle('all')} onClick={() => setGroupFilter('all')}>All</button>
                {Object.entries(data.groups).map(([key, meta]) => (
                  <button key={key} style={{ ...grpBtnStyle(key),
                    borderColor: groupFilter === key ? meta.color : 'rgba(255,255,255,0.1)',
                    color:       groupFilter === key ? meta.color : '#64748b',
                    background:  groupFilter === key ? `${meta.color}22` : 'rgba(255,255,255,0.03)',
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
                <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>Carry view:</span>
                {([['total', 'Carry + Roll'], ['income', 'Carry only'], ['roll', 'Roll only']] as [CarryMode, string][]).map(([mode, label]) => (
                  <button key={mode} onClick={() => setCarryMode(mode)}
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
                      border: '1px solid',
                      borderColor: carryMode === mode ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.1)',
                      background:  carryMode === mode ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                      color:       carryMode === mode ? '#a5b4fc' : '#64748b' }}>
                    {label}
                  </button>
                ))}
                <span style={{ marginLeft: 8, fontSize: 12, color: '#64748b', fontWeight: 500 }}>Repo assumptions</span>
                <button onClick={() => setShowAssumptions(s => !s)}
                  style={{ fontSize: 11, padding: '2px 10px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.1)',
                    background: showAssumptions ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)',
                    color: '#64748b', cursor: 'pointer' }}>
                  {showAssumptions ? 'Hide' : 'Edit'}
                </button>
                {(bundSpreadBps !== 0 || oatSpreadBps !== 0 || btpSpreadBps !== 0 || bonosSpreadBps !== 0) && (
                  <span style={{ fontSize: 11, color: '#fbbf24' }}>
                    {[['Bund', bundSpreadBps], ['OAT', oatSpreadBps], ['BTP', btpSpreadBps], ['Bonos', bonosSpreadBps]]
                      .filter(([, v]) => (v as number) !== 0)
                      .map(([lbl, v]) => `${lbl}: ${(v as number) > 0 ? '+' : ''}${v} bp`)
                      .join(' | ')
                    } vs ESTR
                  </span>
                )}
                {(bundSpreadBps !== 0 || oatSpreadBps !== 0 || btpSpreadBps !== 0 || bonosSpreadBps !== 0) && (
                  <button onClick={() => { setBundSpreadBps(0); setOatSpreadBps(0); setBtpSpreadBps(0); setBonosSpreadBps(0) }}
                    style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.1)',
                      background: 'transparent', color: '#475569', cursor: 'pointer' }}>
                    Reset
                  </button>
                )}
              </div>
              {showAssumptions && (
                <div style={{ marginTop: 14, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                  {([
                    { label: 'Bund repo vs ESTR (bp)',  value: bundSpreadBps,  set: setBundSpreadBps,  color: '#3b82f6' },
                    { label: 'OAT repo vs ESTR (bp)',   value: oatSpreadBps,   set: setOatSpreadBps,   color: '#8b5cf6' },
                    { label: 'BTP repo vs ESTR (bp)',   value: btpSpreadBps,   set: setBtpSpreadBps,   color: '#10b981' },
                    { label: 'Bonos repo vs ESTR (bp)', value: bonosSpreadBps, set: setBonosSpreadBps, color: '#f59e0b' },
                  ] as { label: string; value: number; set: (v: number) => void; color: string }[]).map(({ label, value, set, color }) => (
                    <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span style={{ fontSize: 11, color: '#64748b' }}>{label}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="range" min={-100} max={50} step={1} value={value}
                          onChange={e => set(Number(e.target.value))}
                          style={{ width: 140, accentColor: color }} />
                        <input type="number" value={value} min={-100} max={50} step={1}
                          onChange={e => set(Number(e.target.value))}
                          style={{ width: 56, padding: '3px 6px', borderRadius: 5, fontSize: 12,
                            border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)',
                            color: value < 0 ? '#34d399' : value > 0 ? '#f87171' : '#94a3b8',
                            textAlign: 'right', fontFamily: 'monospace' }} />
                        <span style={{ fontSize: 11, color: '#475569' }}>bp</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', width: 140, fontSize: 10, color: '#334155' }}>
                        <span>−100</span><span>0</span><span>+50</span>
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: '#334155', alignSelf: 'flex-end', maxWidth: 280, lineHeight: 1.5 }}>
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
                <div style={{ fontSize: 14, color: '#94a3b8', marginBottom: 16 }}>
                  Click a row to view its 1-year history below.
                  Carry = coupon carry + roll-down per unit DV01, annualised (bps/yr).
                </div>
                <RVTable rows={filteredRV} focusLabel={focusLabel} onRowClick={handleRowClick}
                  groups={data.groups} bundSpreadBps={bundSpreadBps} oatSpreadBps={oatSpreadBps}
                  btpSpreadBps={btpSpreadBps} bonosSpreadBps={bonosSpreadBps} carryMode={carryMode} />
                {focusSeries && focusRow && (
                  <DetailChart
                    series={focusSeries} label={focusLabel!}
                    color={groupColor(focusRow.group, data.groups)} />
                )}
              </div>
            )}

            {/* Carry Rank tab */}
            {tab === 'carry' && (
              <div style={cardStyle}>
                <div style={{ fontSize: 14, color: '#94a3b8', marginBottom: 16 }}>
                  Expressions ranked by carry-to-vol ratio (highest first).
                  C/V &gt; 0 = the carry works in your favour at current z-score.
                </div>
                <CarryRankTable rows={filteredRV} groups={data.groups}
                  bundSpreadBps={bundSpreadBps} oatSpreadBps={oatSpreadBps}
                  btpSpreadBps={btpSpreadBps} bonosSpreadBps={bonosSpreadBps} carryMode={carryMode} />
              </div>
            )}

            {/* Scatter tab */}
            {tab === 'scatter' && (
              <div style={cardStyle}>
                <div style={{ display: 'flex', gap: 16, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: '#94a3b8' }}>Bubble size = |β| for:</span>
                  {BETA_VARS.map(bv => (
                    <button key={bv.key}
                      onClick={() => setBetaVar(bv.key)}
                      style={{ fontSize: 11, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
                        border: '1px solid', fontWeight: 500,
                        borderColor: betaVar === bv.key ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.1)',
                        background:  betaVar === bv.key ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                        color:       betaVar === bv.key ? '#a5b4fc' : '#64748b' }}>
                      {bv.label}
                    </button>
                  ))}
                  {focusLabel && (
                    <button onClick={() => setFocusLabel(null)}
                      style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 10px', borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)',
                        color: '#64748b', cursor: 'pointer' }}>
                      Clear selection
                    </button>
                  )}
                </div>
                <CarryVolChart
                  rvMonitor={filteredRV} betaMonitor={filteredBeta}
                  focusLabel={focusLabel} onBubbleClick={handleRowClick}
                  betaVar={betaVar} groupFilter={groupFilter} groups={data.groups} />
                {focusSeries && focusRow && (
                  <DetailChart
                    series={focusSeries} label={focusLabel!}
                    color={groupColor(focusRow.group, data.groups)} />
                )}
              </div>
            )}

            {/* Beta tab */}
            {tab === 'beta' && (
              <div style={cardStyle}>
                <div style={{ fontSize: 14, color: '#94a3b8', marginBottom: 16 }}>
                  OLS regression of daily changes on: Bund 10y, OAT−Bund 10y, Bund 2s10s, EUR 1m10y vol.
                  Resid Z = z-score of cumulative residual (signals mean reversion vs trend).
                </div>
                <BetaTable rows={filteredBeta} groups={data.groups} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
