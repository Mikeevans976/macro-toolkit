import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import PageTitle, { headerBar } from '../components/PageTitle'
import {
  LineChart, Line, BarChart, Bar, Cell, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Area,
  Scatter, ScatterChart,
} from 'recharts'
import { toLocalISODate } from '../lib/dates'

// ─── Error boundary ───────────────────────────────────────────────────────────

class PCAErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[PCAAnalysis] render error:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', background: '#07090c', color: '#e2826f',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <div style={{ maxWidth: 700, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>PCA Analysis — Render Error</div>
            <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', color: '#ecaa9c',
              background: 'rgba(217,112,94,0.08)', border: '1px solid rgba(217,112,94,0.2)',
              borderRadius: 6, padding: 16 }}>
              {this.state.error.message}{'\n\n'}{this.state.error.stack}
            </pre>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface EigenvectorDef {
  factor: number
  label: string
  loadings: Record<string, number>
}

interface OUParams {
  mu: number
  theta: number
  sigma: number
  half_life_weeks: number
  current: number
  zscore: number
}

interface OUForecastPoint {
  week: number
  mean: number
  upper_1s: number
  lower_1s: number
  upper_2s: number
  lower_2s: number
}

interface ExternalVar {
  ticker: string
  label: string
  dates: string[]
  values: (number | null)[]
}

interface PCAResponse {
  curve_id: string
  curve_label: string
  ticker_labels?: Record<string, string>   // custom mode: maps "0","1",... → user labels
  input_mode: 'levels' | 'changes'
  tenors: number[]
  ticker_map: Record<string, string>
  default_bpvs: Record<string, number>
  data_source: string
  start_date: string
  end_date: string
  n_obs: number
  yield_history: { date: string; yields: Record<string, number> }[]
  daily_yield_history?: { date: string; yields: Record<string, number> }[]
  eigenvalues: { values: number[]; cumulative: number[] }
  eigenvectors: EigenvectorDef[]
  factor_history: { date: string; f1: number; f2: number; f3: number }[]
  ou_params: { f1: OUParams; f2: OUParams; f3: OUParams }
  ou_forecasts: { f1: OUForecastPoint[]; f2: OUForecastPoint[]; f3: OUForecastPoint[] }
  residuals: {
    n_factors_used: number
    current_bp: Record<string, number>
    history: { date: string; residuals: Record<string, number> }[]
  }
  correlation_matrix: Record<string, Record<string, number>>
  external_vars?: ExternalVar[]
  stability?: {
    condition_number: number
    roll_window_weeks: number
    history: ({ date: string; pc1: number; pc2: number; pc3: number } & Record<string, number | string>)[]
  }
}

interface SavedTrade {
  name: string
  curveLabel: string
  factor: 0 | 1 | 2
  direction: 1 | -1
  magnitude: number
  legs: number[]
  legParams: Record<number, { notional: number; bpv: number; side: 1 | -1 }>
  entryDate: string       // ISO date YYYY-MM-DD
  entryLevel: number      // factor score at entry
  takeProfit: number      // factor score TP
  stopLoss: number        // factor score SL
  rr: number              // reward-to-risk ratio
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BG = '#07090c'
const F1_COLOR = '#8b8fd8'
const F2_COLOR = '#7cc3dc'
const F3_COLOR = '#5fb592'
const RICH_COLOR = '#d9705e'
const CHEAP_COLOR = '#5fb592'

const CURVES = [
  { id: 'bund', label: 'Bund' },
  { id: 'oat',  label: 'OAT' },
  { id: 'btp',  label: 'BTP' },
  { id: 'bonos', label: 'Bonos' },
  { id: 'ust',  label: 'UST' },
  { id: 'gilt', label: 'Gilt' },
]

const ALL_TENORS = [2, 5, 7, 10, 15, 20, 30]
const DEFAULT_TENORS = [2, 5, 7, 10]

const cardStyle: React.CSSProperties = {
  background: '#0b0f14',
  border: '1px solid rgba(150,178,205,0.09)',
  borderRadius: 6,
  padding: '20px 24px',
  marginBottom: 20,
}

type TabId = 'structure' | 'dynamics' | 'trade' | 'correlations' | 'hedge' | 'impact' | 'fresiduals' | 'stability' | 'freplication' | 'guide'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function zscoreColor(z: number): string {
  if (Math.abs(z) >= 2) return RICH_COLOR
  if (Math.abs(z) >= 1) return '#dfbb78'
  return CHEAP_COLOR
}

function zscoreBadge(z: number): React.CSSProperties {
  const color = zscoreColor(z)
  return {
    display: 'inline-block', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600,
    background: `${color}22`, color, border: `1px solid ${color}44`, fontFamily: "'Geist Mono', ui-monospace, monospace",
  }
}

function fmtZ(z: number): string {
  return (z >= 0 ? '+' : '') + z.toFixed(2) + 'σ'
}


function factorColor(i: number): string {
  return [F1_COLOR, F2_COLOR, F3_COLOR][i] ?? '#c6ced8'
}

// ─── OU fit (client-side) ─────────────────────────────────────────────────────

// Return display label for a tenor key: uses ticker_labels in custom mode, else "${t}y"
function tLabel(t: number, data?: PCAResponse | null): string {
  const lbl = data?.ticker_labels?.[String(t)]
  return lbl ?? `${t}y`
}

function fitOU(x: number[]): { mu: number; theta: number; sigma: number; halfLifeWeeks: number } {
  const n = x.length - 1
  if (n < 2) return { mu: 0, theta: 0.1, sigma: 1, halfLifeWeeks: 7 }
  let sxy = 0, sx = 0, sy = 0, sxx = 0
  for (let i = 0; i < n; i++) { sxy += x[i] * x[i + 1]; sx += x[i]; sy += x[i + 1]; sxx += x[i] * x[i] }
  const denom = n * sxx - sx * sx
  if (Math.abs(denom) < 1e-12) return { mu: 0, theta: 0.1, sigma: 1, halfLifeWeeks: 7 }
  const b = (n * sxy - sx * sy) / denom
  const a = (sy - b * sx) / n
  const bClamped = Math.max(1e-6, Math.min(1 - 1e-6, b))
  const theta = -Math.log(bClamped)
  const mu = a / (1 - bClamped)
  const halfLife = Math.log(2) / theta
  let ssRes = 0
  for (let i = 0; i < n; i++) { const pred = a + b * x[i]; ssRes += (x[i + 1] - pred) ** 2 }
  const sigmaEps = Math.sqrt(ssRes / n)
  const sigma = sigmaEps * Math.sqrt(2 * theta / (1 - Math.exp(-2 * theta)))
  return { mu, theta, sigma, halfLifeWeeks: halfLife }
}

// ─── Tooltip helpers ──────────────────────────────────────────────────────────

function SimpleTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'rgba(7,9,12,0.96)', border: '1px solid rgba(200,220,240,0.12)',
      borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#9aa5b1', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color ?? '#e4eaf1' }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(2) : p.value}
        </div>
      ))}
    </div>
  )
}

// ─── Tab 1: Factor Structure ──────────────────────────────────────────────────

function EigenvalueChart({ eigenvalues }: { eigenvalues: { values: number[]; cumulative: number[] } }) {
  const values = eigenvalues?.values ?? []
  const cumulative = eigenvalues?.cumulative ?? []
  const total = values.reduce((a, b) => a + b, 0) || 1
  const data = values.map((v, i) => ({
    name: `F${i + 1}`,
    pct: parseFloat(((v / total) * 100).toFixed(1)),
    cum: parseFloat(((cumulative[i] ?? 0)).toFixed(1)),
  }))

  const CustomLabel = ({ x, y, width, value }: any) => (
    <text x={x + width / 2} y={y - 4} textAnchor="middle" fill="#c6ced8" fontSize={11}>
      {value}%
    </text>
  )

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 20, right: 30, bottom: 10, left: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
          <XAxis dataKey="name" tick={{ fill: '#9aa5b1', fontSize: 12 }} />
          <YAxis yAxisId="left" domain={[0, 100]} tick={{ fill: '#9aa5b1', fontSize: 11 }}
            tickFormatter={v => `${v}%`} />
          <YAxis yAxisId="right" orientation="right" domain={[0, 100]}
            tick={{ fill: '#9aa5b1', fontSize: 11 }} tickFormatter={v => `${v}%`} />
          <Tooltip content={<SimpleTooltip />} />
          <Bar yAxisId="left" dataKey="pct" name="% Var" fill="#8b8fd8" fillOpacity={0.8}
            label={<CustomLabel />} />
          <Line yAxisId="right" dataKey="cum" name="Cumulative %" stroke="#dfbb78"
            dot={{ r: 4, fill: '#dfbb78' }} strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 12 }}>
        <thead>
          <tr>
            {['Factor', 'Label', '% Var', 'Cumulative'].map(h => (
              <th key={h} style={{ padding: '6px 10px', color: '#8995a2', textAlign: 'right',
                borderBottom: '1px solid rgba(200,220,240,0.07)', fontSize: 11,
                ...(h === 'Factor' || h === 'Label' ? { textAlign: 'left' } : {}) }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={d.name}>
              <td style={{ padding: '5px 10px', color: factorColor(i), fontWeight: 600 }}>{d.name}</td>
              <td style={{ padding: '5px 10px', color: '#c6ced8' }}>
                {['Level', 'Slope', 'Curvature', 'F4', 'F5'][i] ?? `F${i + 1}`}
              </td>
              <td style={{ padding: '5px 10px', textAlign: 'right', color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{d.pct}%</td>
              <td style={{ padding: '5px 10px', textAlign: 'right', color: '#dfbb78', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{d.cum}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EigenvectorChart({ eigenvectors, tenors, pcaData }: { eigenvectors: EigenvectorDef[]; tenors: number[]; pcaData?: PCAResponse | null }) {
  const safeTenors = tenors ?? []
  const safeEigenvectors = eigenvectors ?? []
  const isCustom = !!pcaData?.ticker_labels && Object.keys(pcaData.ticker_labels).length > 0
  const data = safeTenors.map(t => {
    const pt: Record<string, number | string> = { tenor: tLabel(t, pcaData) }
    safeEigenvectors.slice(0, 3).forEach((ev, i) => {
      pt[`F${i + 1}`] = parseFloat(((ev?.loadings?.[String(t)] ?? 0)).toFixed(4))
    })
    return pt
  })

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 10, right: 20, bottom: 20, left: 40 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
        <XAxis dataKey="tenor" tick={{ fill: '#9aa5b1', fontSize: 11 }}
          label={isCustom ? undefined : { value: 'Tenor (years)', position: 'insideBottom', offset: -10, fill: '#9aa5b1', fontSize: 12 }} />
        <YAxis tick={{ fill: '#9aa5b1', fontSize: 11 }} tickFormatter={v => v.toFixed(2)} />
        <Tooltip content={<SimpleTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" strokeDasharray="4 4" />
        {safeEigenvectors.slice(0, 3).map((ev, i) => (
          <Line key={ev.factor} type="monotone" dataKey={`F${i + 1}`}
            name={`F${i + 1} ${ev.label}`} stroke={factorColor(i)}
            dot={{ r: 4 }} strokeWidth={2} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

function CorrelationHeatmap({ matrix, tenors, pcaData }: {
  matrix: Record<string, Record<string, number>>
  tenors: number[]
  pcaData?: PCAResponse | null
}) {
  function cellColor(v: number): string {
    // Dark ground → periwinkle (positive) / glacier (negative)
    const abs = Math.min(1, Math.abs(v))
    const [r0, g0, b0] = [21, 27, 35]
    const [r1, g1, b1] = v >= 0 ? [139, 143, 216] : [111, 180, 210]
    const r = Math.round(r0 + abs * (r1 - r0))
    const g = Math.round(g0 + abs * (g1 - g0))
    const b = Math.round(b0 + abs * (b1 - b0))
    return `rgb(${r},${g},${b})`
  }

  function textColor(v: number): string {
    return Math.abs(v) > 0.7 ? '#07090c' : '#e4eaf1'
  }

  const cellSize = Math.min(72, Math.floor(480 / tenors.length))

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, margin: '0 auto' }}>
        <thead>
          <tr>
            <th style={{ padding: '4px 8px', color: '#8995a2', fontSize: 11, fontWeight: 500 }}></th>
            {tenors.map(t => (
              <th key={t} style={{ padding: '4px 6px', color: '#c6ced8', fontSize: 11,
                fontWeight: 500, textAlign: 'center', width: cellSize }}>
                {tLabel(t, pcaData)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tenors.map(row => (
            <tr key={row}>
              <td style={{ padding: '4px 8px', color: '#c6ced8', fontSize: 11,
                fontWeight: 500, whiteSpace: 'nowrap', textAlign: 'right' }}>
                {tLabel(row, pcaData)}
              </td>
              {tenors.map(col => {
                const v = matrix?.[String(row)]?.[String(col)] ?? 0
                const isDiag = row === col
                return (
                  <td key={col} style={{
                    width: cellSize, height: cellSize,
                    background: isDiag ? '#8b8fd8' : cellColor(v),
                    textAlign: 'center', verticalAlign: 'middle',
                    padding: 0,
                    border: '2px solid #07090c',
                    borderRadius: 4,
                    fontFamily: "'Geist Mono', ui-monospace, monospace",
                    fontSize: cellSize > 56 ? 11 : 10,
                    fontWeight: isDiag ? 700 : 400,
                    color: isDiag ? '#f4f7fa' : textColor(v),
                  }}>
                    {isDiag ? '1.00' : v.toFixed(2)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'center' }}>
        <span style={{ fontSize: 10, color: '#8995a2' }}>−1</span>
        <div style={{
          width: 160, height: 10, borderRadius: 5,
          background: 'linear-gradient(to right, rgb(111,180,210), rgb(21,27,35), rgb(139,143,216))',
        }} />
        <span style={{ fontSize: 10, color: '#8995a2' }}>+1</span>
        <div style={{ width: 14, height: 14, background: '#8b8fd8', borderRadius: 3, marginLeft: 12 }} />
        <span style={{ fontSize: 10, color: '#8995a2' }}>diagonal (self)</span>
      </div>
    </div>
  )
}

// ─── Hierarchical clustering (Ward linkage) ───────────────────────────────────

interface LinkageStep { a: number; b: number; dist: number; size: number }

function wardCluster(pts: number[][]): LinkageStep[] {
  const n = pts.length
  const members: number[][] = pts.map((_, i) => [i])
  const centroids: number[][] = pts.map(p => [...p])
  const sizes: number[] = new Array(n).fill(1)
  let active = Array.from({ length: n }, (_, i) => i)
  const steps: LinkageStep[] = []
  let next = n

  while (active.length > 1) {
    let best = Infinity, ai = -1, aj = -1
    for (let ii = 0; ii < active.length; ii++) {
      for (let jj = ii + 1; jj < active.length; jj++) {
        const ci = active[ii], cj = active[jj]
        const ni = sizes[ci], nj = sizes[cj]
        const d2 = centroids[ci].reduce((s, v, k) => s + (v - centroids[cj][k]) ** 2, 0)
        const ward = (ni * nj / (ni + nj)) * d2
        if (ward < best) { best = ward; ai = ci; aj = cj }
      }
    }
    const ni = sizes[ai], nj = sizes[aj]
    const ns = ni + nj
    centroids[next] = centroids[ai].map((v, k) => (v * ni + centroids[aj][k] * nj) / ns)
    sizes[next] = ns
    members[next] = [...(members[ai] ?? []), ...(members[aj] ?? [])]
    steps.push({ a: ai, b: aj, dist: Math.sqrt(best), size: ns })
    active = active.filter(x => x !== ai && x !== aj)
    active.push(next++)
  }
  return steps
}

function clusterAssign(steps: LinkageStep[], n: number, k: number): number[] {
  // Replay first n-k merges; remaining active sets are the k clusters
  const sets: Map<number, number[]> = new Map(Array.from({ length: n }, (_, i) => [i, [i]]))
  let next = n
  for (let s = 0; s < n - k; s++) {
    const { a, b } = steps[s]
    const merged = [...(sets.get(a) ?? []), ...(sets.get(b) ?? [])]
    sets.delete(a); sets.delete(b)
    sets.set(next++, merged)
  }
  const labels = new Array(n).fill(0)
  let label = 0
  for (const members of sets.values()) {
    for (const m of members) labels[m] = label
    label++
  }
  return labels
}

// ─── Dendrogram SVG ───────────────────────────────────────────────────────────

function Dendrogram({ steps, tenorLabels, clusterLabels, colors }: {
  steps: LinkageStep[]
  tenorLabels: string[]
  clusterLabels: number[]
  colors: string[]
}) {
  const n = tenorLabels.length
  const W = 640, H = 260
  const marginL = 20, marginR = 20, marginT = 20, marginB = 50

  // Build tree children map
  const children: Map<number, [number, number]> = new Map()
  steps.forEach(({ a, b }, i) => children.set(n + i, [a, b]))
  const root = n + steps.length - 1

  // Leaf order via tree traversal
  function leaves(node: number): number[] {
    if (node < n) return [node]
    const [l, r] = children.get(node)!
    return [...leaves(l), ...leaves(r)]
  }
  const leafOrder = leaves(root)
  const leafPos: Map<number, number> = new Map(leafOrder.map((id, i) => [id, i]))

  // x-position of any node = average of its leaves
  function nodeX(node: number): number {
    const ls = leaves(node)
    return ls.reduce((s, id) => s + leafPos.get(id)!, 0) / ls.length
  }

  const maxDist = steps[steps.length - 1]?.dist ?? 1
  const innerW = W - marginL - marginR
  const innerH = H - marginT - marginB

  function toSvgX(col: number) { return marginL + col / (n - 1) * innerW }
  function toSvgY(dist: number) { return marginT + (1 - dist / (maxDist * 1.05)) * innerH }

  // Collect line segments
  const segs: { x1:number; y1:number; x2:number; y2:number; color:string }[] = []
  // Determine cluster color for each internal node
  const nodeColor: Map<number, string> = new Map(
    Array.from({ length: n }, (_, i) => [i, colors[clusterLabels[i]]])
  )
  steps.forEach(({ a, b, dist }, i) => {
    const nodeId = n + i
    const xa = toSvgX(nodeX(a)), xb = toSvgX(nodeX(b))
    const xm = toSvgX(nodeX(nodeId))
    const ya = toSvgY(a < n ? 0 : steps[a - n]?.dist ?? 0)
    const yb = toSvgY(b < n ? 0 : steps[b - n]?.dist ?? 0)
    const ym = toSvgY(dist)
    const ca = nodeColor.get(a) ?? '#9aa5b1'
    const cb = nodeColor.get(b) ?? '#9aa5b1'
    const cm = ca === cb ? ca : '#9aa5b1'
    nodeColor.set(nodeId, cm)
    segs.push({ x1: xa, y1: ya, x2: xa, y2: ym, color: ca })
    segs.push({ x1: xb, y1: yb, x2: xb, y2: ym, color: cb })
    segs.push({ x1: xa, y1: ym, x2: xb, y2: ym, color: cm })
    void xm
  })

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      {segs.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
          stroke={s.color} strokeWidth={1.8} strokeLinecap="round" />
      ))}
      {leafOrder.map((id, i) => (
        <g key={id}>
          <circle cx={toSvgX(i)} cy={toSvgY(0)} r={5}
            fill={colors[clusterLabels[id]]} stroke="#07090c" strokeWidth={1.5} />
          <text x={toSvgX(i)} y={toSvgY(0) + 18} textAnchor="middle"
            fill="#c6ced8" fontSize={11} fontFamily="'Geist Mono', ui-monospace, monospace">
            {tenorLabels[id]}
          </text>
        </g>
      ))}
      {/* Y-axis ticks */}
      {[0, 0.25, 0.5, 0.75, 1.0].map(frac => {
        const dist = frac * maxDist * 1.05
        const y = toSvgY(dist)
        return (
          <g key={frac}>
            <line x1={marginL - 4} y1={y} x2={marginL} y2={y} stroke="#2a333d" strokeWidth={1} />
            <text x={marginL - 6} y={y + 4} textAnchor="end" fill="#8995a2" fontSize={9}>
              {dist.toFixed(2)}
            </text>
          </g>
        )
      })}
      <text x={8} y={H / 2} textAnchor="middle" fill="#8995a2" fontSize={10}
        transform={`rotate(-90, 8, ${H / 2})`}>Ward dist</text>
    </svg>
  )
}

// ─── 3D Scatter (SVG, drag-to-rotate) ────────────────────────────────────────

function Scatter3D({ points, labels, clusters, colors }: {
  points: [number, number, number][]
  labels: string[]
  clusters: number[]
  colors: string[]
}) {
  const [az, setAz] = useState(0.7)
  const [el, setEl] = useState(0.4)
  const drag = useState<{ x: number; y: number; az: number; el: number } | null>(null)
  const [dragState, setDragState] = drag

  const W = 560, H = 400
  const cx = W / 2, cy = H / 2, scale = 170

  function project([x, y, z]: [number, number, number]): [number, number, number] {
    const cosAz = Math.cos(az), sinAz = Math.sin(az)
    const cosEl = Math.cos(el), sinEl = Math.sin(el)
    const x1 = x * cosAz - y * sinAz
    const y1 = x * sinAz + y * cosAz
    const px = cx + (x1 * scale)
    const py = cy - (y1 * sinEl + z * cosEl) * scale
    const depth = y1 * cosEl - z * sinEl
    return [px, py, depth]
  }

  // Normalize points to [-1,1] range per axis
  const normalize = (pts: [number,number,number][]): [number,number,number][] => {
    const axes = [0, 1, 2].map(k => {
      const vals = pts.map(p => p[k])
      const mn = Math.min(...vals), mx = Math.max(...vals)
      return { mn, range: mx - mn || 1 }
    })
    return pts.map(p => axes.map((ax, k) => 2 * (p[k] - ax.mn) / ax.range - 1) as [number,number,number])
  }

  const normPts = normalize(points)

  // Draw axes (unit vectors)
  const axisEnds: [number,number,number][] = [[1.2,0,0],[0,1.2,0],[0,0,1.2]]
  const axisLabels = ['PC1','PC2','PC3']
  const axisColors = ['#8b8fd8','#7cc3dc','#5fb592']

  // Sort points by depth for painter's algorithm
  const projected = normPts.map((p, i) => ({ i, ...(() => { const [px,py,d] = project(p); return {px,py,d} })() }))
  const sorted = [...projected].sort((a, b) => a.d - b.d)

  return (
    <div>
      <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 8 }}>
        Drag to rotate · Points = yield tenors · Axes = PC1 / PC2 / PC3 loadings (normalised)
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', cursor: dragState ? 'grabbing' : 'grab', borderRadius: 6 }}
        onMouseDown={e => setDragState({ x: e.clientX, y: e.clientY, az, el })}
        onMouseMove={e => {
          if (!dragState) return
          const dx = (e.clientX - dragState.x) / 200
          const dy = (e.clientY - dragState.y) / 200
          setAz(dragState.az + dx)
          setEl(Math.max(-Math.PI/2, Math.min(Math.PI/2, dragState.el - dy)))
        }}
        onMouseUp={() => setDragState(null)}
        onMouseLeave={() => setDragState(null)}>
        <rect width={W} height={H} fill="rgba(200,220,240,0.01)" rx={8} />
        {/* Axis lines from origin */}
        {axisEnds.map((end, k) => {
          const [ox, oy] = project([0,0,0])
          const [ex, ey] = project(end)
          const [lx, ly] = project(end.map(v => v * 1.35) as [number,number,number])
          return (
            <g key={k}>
              <line x1={ox} y1={oy} x2={ex} y2={ey} stroke={axisColors[k]} strokeWidth={1.5} strokeDasharray="4 2" />
              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
                fill={axisColors[k]} fontSize={12} fontWeight={700}>{axisLabels[k]}</text>
            </g>
          )
        })}
        {/* Origin */}
        {(() => { const [ox, oy] = project([0,0,0]); return <circle cx={ox} cy={oy} r={3} fill="#2a333d" /> })()}
        {/* Data points (painter's algorithm) */}
        {sorted.map(({ i, px, py }) => (
          <g key={i}>
            <circle cx={px} cy={py} r={8} fill={colors[clusters[i]]} stroke="#07090c" strokeWidth={1.5} opacity={0.9} />
            <text x={px} y={py - 13} textAnchor="middle" fill={colors[clusters[i]]}
              fontSize={11} fontWeight={600} style={{ pointerEvents: 'none' }}>
              {labels[i]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ─── Cluster Analysis section ─────────────────────────────────────────────────

const CLUSTER_COLORS = ['#8b8fd8','#d6ad66','#58ad8e','#d9705e','#a08bd2','#d48853']

function ClusterAnalysis({ data }: { data: PCAResponse }) {
  const [k, setK] = useState(3)

  const tenors = data.tenors ?? []
  const ev = data.eigenvectors ?? []
  const ev1 = ev.find(e => e.factor === 1)
  const ev2 = ev.find(e => e.factor === 2)
  const ev3 = ev.find(e => e.factor === 3)

  const points = useMemo((): [number,number,number][] =>
    tenors.map(t => [
      ev1?.loadings[String(t)] ?? 0,
      ev2?.loadings[String(t)] ?? 0,
      ev3?.loadings[String(t)] ?? 0,
    ]), [tenors, ev1, ev2, ev3])

  const steps = useMemo(() => wardCluster(points), [points])
  const clusters = useMemo(() => clusterAssign(steps, tenors.length, k), [steps, tenors.length, k])
  const labels = tenors.map(t => tLabel(t, data))

  if (tenors.length < 2) return null

  return (
    <div className="hub-frame" style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1' }}>Cluster Analysis — PC Sensitivity</div>
          <div style={{ fontSize: 12, color: '#8995a2', marginTop: 4 }}>
            Ward hierarchical clustering on (PC1, PC2, PC3) loadings
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#9aa5b1' }}>Clusters:</span>
          {[2,3,4,5].map(n => (
            <button key={n} onClick={() => setK(n)} style={{
              padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
              border: `1px solid ${k === n ? 'rgba(134,192,222,0.6)' : 'rgba(200,220,240,0.1)'}`,
              background: k === n ? 'rgba(134,192,222,0.15)' : 'transparent',
              color: k === n ? '#bfe0ef' : '#9aa5b1',
            }}>{n}</button>
          ))}
        </div>
      </div>

      {/* Cluster legend */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
        {Array.from({ length: k }, (_, ci) => {
          const members = tenors.filter((_, i) => clusters[i] === ci).map(t => tLabel(t, data))
          return (
            <div key={ci} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: CLUSTER_COLORS[ci] }} />
              <span style={{ fontSize: 12, color: '#c6ced8' }}>
                Cluster {ci + 1}: <b style={{ color: CLUSTER_COLORS[ci] }}>{members.join(', ')}</b>
              </span>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* 3D scatter */}
        <div>
          <div style={{ fontSize: 12, color: '#9aa5b1', marginBottom: 8, fontWeight: 600 }}>
            3D Loading Space
          </div>
          <Scatter3D points={points} labels={labels} clusters={clusters} colors={CLUSTER_COLORS} />
        </div>
        {/* Dendrogram */}
        <div>
          <div style={{ fontSize: 12, color: '#9aa5b1', marginBottom: 8, fontWeight: 600 }}>
            Dendrogram (Ward linkage)
          </div>
          <Dendrogram steps={steps} tenorLabels={labels} clusterLabels={clusters} colors={CLUSTER_COLORS} />
        </div>
      </div>
    </div>
  )
}

// ─── Tab 5: Factor Correlations ───────────────────────────────────────────────

const EXT_VAR_COLORS = ['#d6ad66', '#d9705e', '#58ad8e', '#a08bd2', '#d48853', '#7cc3dc']

const ROLL_WINDOWS = [
  { label: '13W', weeks: 13 },
  { label: '26W', weeks: 26 },
  { label: '52W', weeks: 52 },
  { label: '104W', weeks: 104 },
]

function pearsonCorr(x: number[], y: number[]): number {
  const n = x.length
  if (n < 2) return 0
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let num = 0, dx2 = 0, dy2 = 0
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my)
    dx2 += (x[i] - mx) ** 2
    dy2 += (y[i] - my) ** 2
  }
  const denom = Math.sqrt(dx2 * dy2)
  return denom < 1e-12 ? 0 : num / denom
}

// Simple OLS: y = α + β·x  (factor as dependent, external var as independent)
function simpleOLS(x: number[], y: number[]): { beta: number; alpha: number; tStat: number; r2: number } {
  const n = x.length
  if (n < 3) return { beta: 0, alpha: 0, tStat: 0, r2: 0 }
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my)
    sxx += (x[i] - mx) ** 2
    syy += (y[i] - my) ** 2
  }
  if (sxx < 1e-12) return { beta: 0, alpha: 0, tStat: 0, r2: 0 }
  const beta = sxy / sxx
  const alpha = my - beta * mx
  const r2 = syy > 1e-12 ? (sxy ** 2) / (sxx * syy) : 0
  let ssr = 0
  for (let i = 0; i < n; i++) { const res = y[i] - (alpha + beta * x[i]); ssr += res ** 2 }
  const mse = ssr / (n - 2)
  const seBeta = Math.sqrt(mse / sxx)
  return { beta, alpha, tStat: seBeta > 1e-12 ? beta / seBeta : 0, r2 }
}

// Gaussian elimination with partial pivoting — solves A·β = b, returns β or null if singular
function gaussianElim(A: number[][], b: number[]): number[] | null {
  const n = A.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let maxRow = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row
    }
    ;[M[col], M[maxRow]] = [M[maxRow], M[col]]
    if (Math.abs(M[col][col]) < 1e-12) return null
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const f = M[row][col] / M[col][col]
      for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

// Multi-variate OLS: f = α + Σ wⱼ·xⱼ
// X: n×k matrix (rows = observations, cols = predictors)
function multiOLS(
  X: number[][],
  y: number[],
): { weights: number[]; alpha: number; r2: number; adjR2: number } {
  const n = y.length
  const k = X[0]?.length ?? 0
  const empty = { weights: new Array(k).fill(0), alpha: 0, r2: 0, adjR2: 0 }
  if (n < k + 2) return empty
  // Augmented design matrix [1 | X], shape n×(p) where p = k+1
  const Xa = X.map(row => [1, ...row])
  const p = k + 1
  const XtX: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => Xa.reduce((s, row) => s + row[i] * row[j], 0))
  )
  const Xty: number[] = Array.from({ length: p }, (_, i) =>
    Xa.reduce((s, row, t) => s + row[i] * y[t], 0)
  )
  const beta = gaussianElim(XtX, Xty)
  if (!beta) return empty
  const alpha = beta[0]
  const weights = beta.slice(1)
  const yMean = y.reduce((s, v) => s + v, 0) / n
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0)
  const ssRes = y.reduce((s, v, t) => {
    const pred = alpha + weights.reduce((ps, w, j) => ps + w * X[t][j], 0)
    return s + (v - pred) ** 2
  }, 0)
  const r2 = ssTot > 1e-12 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0
  const adjR2 = Math.max(0, 1 - (1 - r2) * (n - 1) / Math.max(n - k - 1, 1))
  return { weights, alpha, r2, adjR2 }
}

function rollingCorr(x: number[], y: number[], w: number): (number | null)[] {
  return x.map((_, i) => {
    if (i < w - 1) return null
    return pearsonCorr(x.slice(i - w + 1, i + 1), y.slice(i - w + 1, i + 1))
  })
}


// ─── PCA-neutral hedge math ───────────────────────────────────────────────────

function matTranspose(A: number[][]): number[][] {
  if (!A.length || !A[0].length) return []
  return A[0].map((_, j) => A.map(row => row[j]))
}

function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length, n = B[0]?.length ?? 0, p = B.length
  return Array.from({ length: m }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      Array.from({ length: p }, (_, l) => A[i][l] * B[l][j]).reduce((s, x) => s + x, 0)
    )
  )
}

function matVecMul(A: number[][], v: number[]): number[] {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0))
}

// Gauss-Jordan on square n×n augmented system [A|b], returns solution vector.
// Returns zero vector if matrix is singular.
function gaussSolve(A: number[][], b: number[]): number[] {
  const n = b.length
  const aug = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let maxRow = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row
    }
    ;[aug[col], aug[maxRow]] = [aug[maxRow], aug[col]]
    if (Math.abs(aug[col][col]) < 1e-14) continue
    const piv = aug[col][col]
    for (let c = col; c <= n; c++) aug[col][c] /= piv
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const fac = aug[row][col]
      for (let c = col; c <= n; c++) aug[row][c] -= fac * aug[col][c]
    }
  }
  return b.map((_, i) => aug[i][n])
}

// Solve A w = b for k×m A (k constraints, m unknowns).
// Dispatches: exact (m=k), min-norm (m>k), least-squares (m<k).
function solveHedge(
  A: number[][],
  b: number[],
): { weights: number[]; type: 'exact' | 'min-norm' | 'least-squares' } {
  const k = A.length
  const m = A[0]?.length ?? 0
  if (m === 0) return { weights: [], type: 'exact' }
  const At = matTranspose(A)
  if (m === k) {
    return { weights: gaussSolve(A, b), type: 'exact' }
  } else if (m > k) {
    // Min-norm: w = Aᵀ (AAᵀ)⁻¹ b
    const AAt = matMul(A, At)
    const z = gaussSolve(AAt, b)
    return { weights: matVecMul(At, z), type: 'min-norm' }
  } else {
    // Least-squares: w = (AᵀA)⁻¹ Aᵀ b
    const AtA = matMul(At, A)
    const Atb = matVecMul(At, b)
    return { weights: gaussSolve(AtA, Atb), type: 'least-squares' }
  }
}

// ─── Tab 6: Hedge Ratios ──────────────────────────────────────────────────────

interface HedgeLeg {
  id: number
  tenor: number
  bpv: number
  isAnchor: boolean
  direction: 1 | -1        // Long = +1, Short = -1
  anchorNotional: number   // only used when isAnchor=true
}

interface HedgeResult {
  legs: HedgeLeg[]
  weights: number[]        // actual notionals (anchor = direction × notional, free scaled)
  kFactors: number
  factorExposures: number[] // normalised by anchorNotional so threshold is scale-invariant
  totalDv01: number
  systemType: 'exact' | 'min-norm' | 'least-squares'
  history: { date: string; value: number }[]
}

function HedgeRatiosTab({ data }: { data: PCAResponse }) {
  const tenors = data.tenors ?? []
  const nFactorsAvail = Math.min(data.eigenvectors?.length ?? 3, 3)
  const nextId = useRef(3)

  const [legs, setLegs] = useState<HedgeLeg[]>(() => {
    const bpvs = data.default_bpvs ?? {}
    return [
      { id: 0, tenor: tenors[0] ?? 2,                             bpv: bpvs[String(tenors[0])] ?? 200,                                             isAnchor: false, direction:  1, anchorNotional: 1 },
      { id: 1, tenor: tenors[Math.floor(tenors.length / 2)] ?? 5, bpv: bpvs[String(tenors[Math.floor(tenors.length / 2)])] ?? 450,                  isAnchor: true,  direction:  1, anchorNotional: 1 },
      { id: 2, tenor: tenors[tenors.length - 1] ?? 10,            bpv: bpvs[String(tenors[tenors.length - 1])] ?? 850,                              isAnchor: false, direction: -1, anchorNotional: 1 },
    ]
  })
  const [kFactors, setKFactors] = useState(2)
  const [result, setResult] = useState<HedgeResult | null>(null)
  const [historyStart, setHistoryStart] = useState('')
  const [historyEnd,   setHistoryEnd]   = useState('')
  const [diagStart,    setDiagStart]    = useState('')
  const [diagEnd,      setDiagEnd]      = useState('')

  const anchorIdx = legs.findIndex(l => l.isAnchor)
  const freeLegCount = legs.length - 1

  const validationError: string | null =
    anchorIdx < 0 ? 'Select one leg as the anchor (reference).' :
    new Set(legs.map(l => l.tenor)).size < legs.length ? 'All legs must use different tenors.' :
    null

  function addLeg() {
    const used = new Set(legs.map(l => l.tenor))
    const available = tenors.find(t => !used.has(t))
    if (!available) return
    setLegs(prev => [...prev, {
      id: nextId.current++, tenor: available,
      bpv: data.default_bpvs?.[String(available)] ?? 300,
      isAnchor: false, direction: 1, anchorNotional: 1,
    }])
  }

  function removeLeg(id: number) {
    if (legs.length <= 2) return
    setLegs(prev => {
      const next = prev.filter(l => l.id !== id)
      if (!next.some(l => l.isAnchor)) next[0] = { ...next[0], isAnchor: true }
      return next
    })
  }

  function updateLeg(id: number, patch: Partial<Omit<HedgeLeg, 'id'>>) {
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l))
  }

  function setAnchor(id: number) {
    setLegs(prev => prev.map(l => ({ ...l, isAnchor: l.id === id })))
  }

  // Factor sensitivity = BPV × eigenvector loading (the "DPS01" per unit factor shift)
  function factorSens(leg: HedgeLeg, factorIdx: number): number {
    const ev = data.eigenvectors?.[factorIdx]
    return leg.bpv * (ev?.loadings[String(leg.tenor)] ?? 0)
  }

  function computeHedge() {
    if (validationError) return
    const anchor = legs[anchorIdx]
    const free = legs.filter(l => !l.isAnchor)
    const evs = (data.eigenvectors ?? []).slice(0, effectiveK)

    // Effective anchor weight (signed notional)
    const anchorW = anchor.direction * anchor.anchorNotional

    // A[j][i] = BPV_i × e_j(tenor_i) for free legs
    const A: number[][] = evs.map(ev =>
      free.map(leg => leg.bpv * (ev.loadings[String(leg.tenor)] ?? 0))
    )
    // b[j] = -anchorW × BPV_anchor × e_j(anchor)
    const b: number[] = evs.map(ev =>
      -(anchorW * anchor.bpv * (ev.loadings[String(anchor.tenor)] ?? 0))
    )

    const { weights: freeWeights, type: systemType } = solveHedge(A, b)

    // Map back: anchor = anchorW, free legs = computed (in same scale as anchorW)
    let fi = 0
    const weights = legs.map(l => l.isAnchor ? anchorW : freeWeights[fi++])

    // Factor exposures normalised by anchorNotional (scale-invariant)
    const factorExposures = (data.eigenvectors ?? []).slice(0, nFactorsAvail).map(ev =>
      legs.reduce((s, leg, i) => s + weights[i] * leg.bpv * (ev.loadings[String(leg.tenor)] ?? 0), 0)
      / anchor.anchorNotional
    )

    const totalDv01 = legs.reduce((s, leg, i) => s + weights[i] * leg.bpv, 0)

    // History: use daily_yield_history (business days) if available, else fall back
    const yieldSource = (data.daily_yield_history && data.daily_yield_history.length > 0)
      ? data.daily_yield_history
      : data.yield_history ?? []
    const history = yieldSource.map(pt => {
      let val = 0
      for (let i = 0; i < legs.length; i++) {
        const y = pt.yields[String(legs[i].tenor)]
        if (y == null) return null
        val += (weights[i] / anchor.anchorNotional) * y
      }
      return { date: pt.date, value: val * 100 }
    }).filter((d): d is { date: string; value: number } => d !== null)

    setResult({ legs: [...legs], weights, kFactors: effectiveK, factorExposures, totalDv01, systemType, history })
  }

  const maxK = Math.min(freeLegCount, nFactorsAvail)
  const effectiveK = Math.min(kFactors, maxK)

  // OU fit on trade history
  const ouTrade = useMemo(() => {
    if (!result || result.history.length < 10) return null
    return fitOU(result.history.map(d => d.value))
  }, [result])

  const thS: React.CSSProperties = {
    padding: '7px 8px', fontSize: 11, color: '#8995a2',
    fontWeight: 500, borderBottom: '1px solid rgba(200,220,240,0.07)', textAlign: 'right',
  }
  const tdS: React.CSSProperties = {
    padding: '6px 8px', fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace",
    borderBottom: '1px solid rgba(200,220,240,0.04)', textAlign: 'right',
  }

  const systemLabels: Record<string, string> = {
    'exact':         'Exact solution — unique PCA-neutral weights',
    'min-norm':      'Minimum-norm — underdetermined (fewer constraints than free legs)',
    'least-squares': 'Least-squares — overdetermined (more constraints than free legs)',
  }

  const dirBtn = (leg: HedgeLeg, dir: 1 | -1) => ({
    padding: '3px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
    border: `1px solid ${leg.direction === dir
      ? (dir === 1 ? 'rgba(95,181,146,0.4)' : 'rgba(217,112,94,0.4)')
      : 'rgba(200,220,240,0.1)'}`,
    background: leg.direction === dir
      ? (dir === 1 ? 'rgba(95,181,146,0.12)' : 'rgba(217,112,94,0.1)')
      : 'rgba(200,220,240,0.03)',
    color: leg.direction === dir
      ? (dir === 1 ? CHEAP_COLOR : RICH_COLOR)
      : '#8995a2',
    fontWeight: leg.direction === dir ? 600 : 400,
  } as React.CSSProperties)

  return (
    <div>
      {/* Leg configurator */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1' }}>Trade Legs</div>
          <button onClick={addLeg} disabled={legs.length >= tenors.length}
            style={{ padding: '5px 14px', borderRadius: 7, border: '1px solid rgba(139,143,216,0.4)',
              background: legs.length >= tenors.length ? 'rgba(200,220,240,0.03)' : 'rgba(139,143,216,0.12)',
              color: legs.length >= tenors.length ? '#8995a2' : '#b9bdea',
              fontSize: 12, cursor: legs.length >= tenors.length ? 'not-allowed' : 'pointer' }}>
            + Add leg
          </button>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ ...thS, textAlign: 'left' }}>Tenor</th>
                <th style={thS}>BPV</th>
                <th style={{ ...thS, color: factorColor(0) }}>PC1 sens</th>
                <th style={{ ...thS, color: factorColor(1) }}>PC2 sens</th>
                <th style={{ ...thS, color: factorColor(2) }}>PC3 sens</th>
                <th style={{ ...thS, textAlign: 'center' }}>Direction</th>
                <th style={{ ...thS, textAlign: 'center' }}>Notional (mn)</th>
                <th style={{ ...thS, textAlign: 'center' }}>Anchor</th>
                <th style={{ ...thS, textAlign: 'center' }}>✕</th>
              </tr>
            </thead>
            <tbody>
              {legs.map(leg => {
                const s1 = factorSens(leg, 0)
                const s2 = factorSens(leg, 1)
                const s3 = factorSens(leg, 2)
                return (
                  <tr key={leg.id}>
                    <td style={{ ...tdS, textAlign: 'left' }}>
                      <select value={leg.tenor} onChange={e => updateLeg(leg.id, { tenor: Number(e.target.value) })}
                        style={{ padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.15)',
                          background: '#0b0f14', color: '#e4eaf1', fontSize: 12, cursor: 'pointer' }}>
                        {tenors.map(t => <option key={t} value={t}>{tLabel(t, data)}</option>)}
                      </select>
                    </td>
                    <td style={{ ...tdS, textAlign: 'center' }}>
                      <input type="number" value={leg.bpv} step={0.001} min={0.0001}
                        onChange={e => updateLeg(leg.id, { bpv: Number(e.target.value) })}
                        style={{ padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.15)',
                          background: '#0b0f14', color: '#e4eaf1', fontSize: 12, width: 80,
                          fontFamily: "'Geist Mono', ui-monospace, monospace", textAlign: 'right' }} />
                    </td>
                    {/* Factor sensitivities (read-only) */}
                    {[s1, s2, s3].map((s, fi) => (
                      <td key={fi} style={{ ...tdS, color: factorColor(fi), fontSize: 11 }}>
                        {s >= 0 ? '+' : ''}{s.toFixed(4)}
                      </td>
                    ))}
                    {/* Direction toggle */}
                    <td style={{ ...tdS, textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                        <button onClick={() => updateLeg(leg.id, { direction: 1 })} style={dirBtn(leg, 1)}>L</button>
                        <button onClick={() => updateLeg(leg.id, { direction: -1 })} style={dirBtn(leg, -1)}>S</button>
                      </div>
                    </td>
                    {/* Notional — only editable for anchor */}
                    <td style={{ ...tdS, textAlign: 'center' }}>
                      {leg.isAnchor ? (
                        <input type="number" value={leg.anchorNotional} step={1} min={1}
                          onChange={e => updateLeg(leg.id, { anchorNotional: Number(e.target.value) })}
                          style={{ padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.15)',
                            background: '#0b0f14', color: '#e4eaf1', fontSize: 12, width: 70,
                            fontFamily: "'Geist Mono', ui-monospace, monospace", textAlign: 'right' }} />
                      ) : (
                        <span style={{ color: '#8995a2' }}>—</span>
                      )}
                    </td>
                    <td style={{ ...tdS, textAlign: 'center' }}>
                      <input type="radio" name="anchor" checked={leg.isAnchor}
                        onChange={() => setAnchor(leg.id)}
                        style={{ accentColor: '#8b8fd8', cursor: 'pointer', width: 15, height: 15 }} />
                    </td>
                    <td style={{ ...tdS, textAlign: 'center' }}>
                      <button onClick={() => removeLeg(leg.id)} disabled={legs.length <= 2}
                        style={{ padding: '2px 8px', borderRadius: 5, border: '1px solid rgba(217,112,94,0.3)',
                          background: 'rgba(217,112,94,0.08)',
                          color: legs.length <= 2 ? '#8995a2' : '#e2826f',
                          fontSize: 11, cursor: legs.length <= 2 ? 'not-allowed' : 'pointer' }}>
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* k-factor selector */}
        <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#c6ced8' }}>Hedge against</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {Array.from({ length: maxK }, (_, i) => i + 1).map(k => (
              <button key={k} onClick={() => setKFactors(k)}
                style={{ padding: '5px 14px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${effectiveK === k ? 'rgba(134,192,222,0.5)' : 'rgba(200,220,240,0.1)'}`,
                  background: effectiveK === k ? 'rgba(134,192,222,0.18)' : 'rgba(200,220,240,0.03)',
                  color: effectiveK === k ? '#bfe0ef' : '#9aa5b1',
                  fontWeight: effectiveK === k ? 600 : 400 }}>
                {k === 1 ? 'PC1 (Level)' : k === 2 ? 'PC1+PC2' : 'PC1+PC2+PC3'}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 11, color: '#8995a2' }}>
            {freeLegCount} free leg{freeLegCount !== 1 ? 's' : ''} · {effectiveK} constraint{effectiveK !== 1 ? 's' : ''}
            {freeLegCount === effectiveK ? ' → exact' : freeLegCount > effectiveK ? ' → min-norm' : ' → least-squares'}
          </span>
        </div>

        {validationError && (
          <div style={{ color: RICH_COLOR, fontSize: 12, marginTop: 10 }}>{validationError}</div>
        )}

        <button onClick={computeHedge} disabled={!!validationError}
          style={{ marginTop: 16, padding: '8px 24px', borderRadius: 6, border: 'none',
            cursor: validationError ? 'not-allowed' : 'pointer',
            background: validationError ? 'rgba(200,220,240,0.05)' : 'rgba(139,143,216,0.8)',
            color: validationError ? '#8995a2' : '#f4f7fa', fontSize: 13, fontWeight: 600 }}>
          Compute PCA-Neutral Hedge
        </button>
      </div>

      {/* Results */}
      {result && (() => {
        const anchor = result.legs[result.legs.findIndex(l => l.isAnchor)]
        const currentVal = result.history.length > 0 ? result.history[result.history.length - 1].value : null
        const ouSigmaStat = ouTrade ? ouTrade.sigma / Math.sqrt(2 * ouTrade.theta) : null
        const tradeZ = ouTrade && ouSigmaStat && currentVal !== null
          ? (currentVal - ouTrade.mu) / ouSigmaStat : null
        return (
          <>
            {/* Weights table */}
            <div className="hub-frame" style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1' }}>PCA-Neutral Weights</div>
                <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6,
                  background: result.systemType === 'exact' ? 'rgba(95,181,146,0.1)' : 'rgba(223,187,120,0.1)',
                  color: result.systemType === 'exact' ? CHEAP_COLOR : '#dfbb78',
                  border: `1px solid ${result.systemType === 'exact' ? 'rgba(95,181,146,0.25)' : 'rgba(223,187,120,0.25)'}` }}>
                  {systemLabels[result.systemType]}
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ ...thS, textAlign: 'left' }}>Leg</th>
                      <th style={thS}>Tenor</th>
                      <th style={thS}>BPV</th>
                      <th style={thS}>Role</th>
                      <th style={thS}>Direction</th>
                      <th style={thS}>Notional (mn)</th>
                      <th style={thS}>DV01 contrib</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.legs.map((leg, i) => {
                      const w = result.weights[i]
                      const dv01c = w * leg.bpv
                      const isLong = w >= 0
                      return (
                        <tr key={leg.id}>
                          <td style={{ ...tdS, textAlign: 'left', color: '#c6ced8' }}>Leg {i + 1}</td>
                          <td style={{ ...tdS, color: '#e4eaf1', fontWeight: 600 }}>{leg.tenor}y</td>
                          <td style={{ ...tdS, color: '#9aa5b1' }}>{leg.bpv}</td>
                          <td style={{ ...tdS }}>
                            {leg.isAnchor
                              ? <span style={{ color: F1_COLOR, fontWeight: 600 }}>Anchor</span>
                              : <span style={{ color: '#c6ced8' }}>Free</span>}
                          </td>
                          <td style={{ ...tdS, textAlign: 'center' }}>
                            <span style={{ color: isLong ? CHEAP_COLOR : RICH_COLOR, fontWeight: 600 }}>
                              {isLong ? 'Long' : 'Short'}
                            </span>
                          </td>
                          <td style={{ ...tdS, color: isLong ? CHEAP_COLOR : RICH_COLOR, fontWeight: 600 }}>
                            {w >= 0 ? '+' : ''}{w.toFixed(3)}
                          </td>
                          <td style={{ ...tdS, color: dv01c < 0 ? RICH_COLOR : CHEAP_COLOR }}>
                            {dv01c >= 0 ? '+' : ''}{dv01c.toFixed(4)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={6} style={{ ...tdS, textAlign: 'right', color: '#8995a2', fontWeight: 500 }}>Total DV01</td>
                      <td style={{ ...tdS, color: Math.abs(result.totalDv01 / anchor.anchorNotional) < 0.001 ? CHEAP_COLOR : '#dfbb78', fontWeight: 600 }}>
                        {result.totalDv01 >= 0 ? '+' : ''}{result.totalDv01.toFixed(4)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Factor exposure verification */}
            <div className="hub-frame" style={cardStyle}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 14 }}>
                Factor Exposure Check
              </div>
              <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 12 }}>
                Net exposure per PC after hedge weights, normalised per unit of anchor notional. Hedged factors should be ≈ 0.
              </div>
              <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {['Factor', 'Label', 'Net exposure (normalised)', 'Hedged?'].map(h => (
                      <th key={h} style={{ ...thS, textAlign: h === 'Factor' || h === 'Label' ? 'left' : 'center' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.factorExposures.map((exp, j) => {
                    const isHedged = j < result.kFactors
                    const isNear0 = Math.abs(exp) < 0.5
                    return (
                      <tr key={j}>
                        <td style={{ ...tdS, textAlign: 'left', color: factorColor(j), fontWeight: 600 }}>PC{j + 1}</td>
                        <td style={{ ...tdS, textAlign: 'left', color: '#c6ced8' }}>
                          {['Level', 'Slope', 'Curvature'][j] ?? `F${j + 1}`}
                        </td>
                        <td style={{ ...tdS, textAlign: 'center',
                          color: isNear0 ? CHEAP_COLOR : isHedged ? RICH_COLOR : '#c6ced8',
                          fontWeight: 600 }}>
                          {exp >= 0 ? '+' : ''}{exp.toFixed(5)}
                        </td>
                        <td style={{ ...tdS, textAlign: 'center' }}>
                          {isHedged
                            ? <span style={{ color: isNear0 ? CHEAP_COLOR : RICH_COLOR }}>
                                {isNear0 ? '✓ Hedged' : '✗ Check BPVs'}
                              </span>
                            : <span style={{ color: '#8995a2' }}>Not targeted</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Trade history */}
            {result.history.length > 0 && (() => {
              const histSlice = result.history.filter(d =>
                (!historyStart || d.date >= historyStart) && (!historyEnd || d.date <= historyEnd)
              )
              const dateInputStyle: React.CSSProperties = {
                padding: '3px 7px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.12)',
                background: '#0b0f14', color: '#e4eaf1', fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace",
              }
              return (
              <div className="hub-frame" style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1' }}>Trade history (bp, per unit anchor)</div>
                  {currentVal !== null && (
                    <span style={{ fontSize: 16, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace",
                      color: currentVal >= 0 ? CHEAP_COLOR : RICH_COLOR }}>
                      {currentVal > 0 ? '+' : ''}{currentVal.toFixed(1)} bp
                    </span>
                  )}
                  {tradeZ !== null && (
                    <span style={zscoreBadge(tradeZ)}>{fmtZ(tradeZ)}</span>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#8995a2' }}>From</span>
                    <input type="date" value={historyStart} onChange={e => setHistoryStart(e.target.value)} style={dateInputStyle} />
                    <span style={{ fontSize: 11, color: '#8995a2' }}>to</span>
                    <input type="date" value={historyEnd} onChange={e => setHistoryEnd(e.target.value)} style={dateInputStyle} />
                    {(historyStart || historyEnd) && (
                      <button onClick={() => { setHistoryStart(''); setHistoryEnd('') }}
                        style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                          border: '1px solid rgba(200,220,240,0.1)', background: 'rgba(200,220,240,0.04)', color: '#9aa5b1' }}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                {(() => {
                  const n = histSlice.length
                  // ~12 axis ticks regardless of length
                  const interval = Math.max(1, Math.floor(n / 12))
                  return (
                    <ResponsiveContainer width="100%" height={220}>
                      <ComposedChart data={histSlice}
                        margin={{ top: 8, right: 20, bottom: 20, left: 44 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: '#9aa5b1', fontSize: 9 }}
                          interval={interval}
                          tickFormatter={(d: string) => d.slice(0, 7)}
                        />
                        <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }} tickFormatter={v => `${v.toFixed(0)}bp`} />
                        <Tooltip content={<SimpleTooltip />} />
                        {ouTrade && (
                          <ReferenceLine y={ouTrade.mu} stroke="rgba(200,220,240,0.25)" strokeDasharray="4 4"
                            label={{ value: 'μ', position: 'right', fill: '#9aa5b1', fontSize: 10 }} />
                        )}
                        <Line type="monotone" dataKey="value" name="Trade (bp)" stroke={F1_COLOR}
                          dot={false} strokeWidth={1.5} connectNulls={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  )
                })()}

                {ouTrade && currentVal !== null && (
                  <div style={{ display: 'flex', gap: 20, marginTop: 16, flexWrap: 'wrap' }}>
                    {[
                      { label: 'Current (bp)', value: currentVal.toFixed(1), color: currentVal >= 0 ? CHEAP_COLOR : RICH_COLOR },
                      { label: 'OU Mean (bp)', value: ouTrade.mu.toFixed(1), color: '#e4eaf1' },
                      { label: 'Expected P&L (bp)', value: (ouTrade.mu - currentVal > 0 ? '+' : '') + (ouTrade.mu - currentVal).toFixed(1),
                        color: ouTrade.mu > currentVal ? CHEAP_COLOR : RICH_COLOR },
                      { label: 'Half-life', value: `${ouTrade.halfLifeWeeks.toFixed(1)}w`, color: '#e4eaf1' },
                      ...(tradeZ !== null ? [{ label: 'Z-score', value: fmtZ(tradeZ), color: zscoreColor(tradeZ) }] : []),
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{ textAlign: 'center', background: 'rgba(200,220,240,0.03)',
                        border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '10px 16px' }}>
                        <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: 15, fontWeight: 600, color, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{value}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
            })()}

            {/* Factor Diagnostics */}
            {result.history.length > 0 && (() => {
              const diagDateInputStyle: React.CSSProperties = {
                padding: '3px 7px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.12)',
                background: '#0b0f14', color: '#e4eaf1', fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace",
              }

              // BPV-neutral weights: 1 constraint (sum BPV = 0), min-norm over free legs
              const freeLegs = result.legs.filter(l => !l.isAnchor)
              const anchorWgt = result.weights[result.legs.findIndex(l => l.isAnchor)]
              const bpvRhs = -anchorWgt * anchor.bpv
              const bpvFreeSum2 = freeLegs.reduce((s, l) => s + l.bpv ** 2, 0)
              let bfi = 0
              const bpvAllWeights = result.legs.map(l =>
                l.isAnchor ? anchorWgt : freeLegs[bfi++].bpv * bpvRhs / bpvFreeSum2
              )
              const bpvNorm = anchor.anchorNotional

              // Join yield_history (weekly) with factor_history by date
              const fhMap = new Map<string, { f1: number; f2: number; f3: number }>()
              for (const pt of data.factor_history ?? []) fhMap.set(pt.date, pt)

              const scatterPts: { date: string; f1: number; f2: number; f3: number; pcaVal: number; bpvVal: number }[] = []
              for (const pt of data.yield_history ?? []) {
                const fh = fhMap.get(pt.date)
                if (!fh) continue
                if (diagStart && pt.date < diagStart) continue
                if (diagEnd   && pt.date > diagEnd)   continue
                let pcaV = 0, bpvV = 0
                let valid = true
                for (let i = 0; i < result.legs.length; i++) {
                  const leg = result.legs[i]
                  const y = pt.yields[String(leg.tenor)]
                  if (y == null) { valid = false; break }
                  // BPV-weighted: Cov(sum w_i*BPV_i*yield_i, f_j) ∝ sum w_i*BPV_i*ev_j = 0 for hedged j
                  pcaV += (result.weights[i] * leg.bpv / anchor.anchorNotional) * y * 100
                  bpvV += (bpvAllWeights[i] * leg.bpv / bpvNorm) * y * 100
                }
                if (valid) scatterPts.push({ date: pt.date, f1: fh.f1, f2: fh.f2, f3: fh.f3, pcaVal: pcaV, bpvVal: bpvV })
              }

              const fKeys: ('f1' | 'f2' | 'f3')[] = ['f1', 'f2', 'f3']
              const fLabels = ['Factor 1 (Level)', 'Factor 2 (Slope)', 'Factor 3 (Curvature)']
              const fColors = [F1_COLOR, F2_COLOR, F3_COLOR]

              return (
                <div className="hub-frame" style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 6, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1' }}>
                      Factor Diagnostics
                    </div>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#8995a2' }}>From</span>
                      <input type="date" value={diagStart} onChange={e => setDiagStart(e.target.value)} style={diagDateInputStyle} />
                      <span style={{ fontSize: 11, color: '#8995a2' }}>to</span>
                      <input type="date" value={diagEnd} onChange={e => setDiagEnd(e.target.value)} style={diagDateInputStyle} />
                      {(diagStart || diagEnd) && (
                        <button onClick={() => { setDiagStart(''); setDiagEnd('') }}
                          style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                            border: '1px solid rgba(200,220,240,0.1)', background: 'rgba(200,220,240,0.04)', color: '#9aa5b1' }}>
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
                    BPV-weighted trade value vs each factor — left: PCA-neutral, right: BPV-neutral. OLS line + R².
                    PCA-neutral neutralises Cov(∑ w·BPV·y, f_j) for hedged factors → R² ≈ 0 for PC1/PC2.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px 32px' }}>
                    {fKeys.map((fk, fi) => {
                      const xs = scatterPts.map(p => p[fk])
                      const pcaYs = scatterPts.map(p => p.pcaVal)
                      const bpvYs = scatterPts.map(p => p.bpvVal)
                      const pcaOLS = simpleOLS(xs, pcaYs)
                      const bpvOLS = simpleOLS(xs, bpvYs)
                      const xmin = Math.min(...xs), xmax = Math.max(...xs)
                      const pcaDots = scatterPts.map(p => ({ x: p[fk], y: p.pcaVal }))
                      const bpvDots = scatterPts.map(p => ({ x: p[fk], y: p.bpvVal }))
                      const pcaRegLine = [
                        { x: xmin, y: pcaOLS.beta * xmin + pcaOLS.alpha },
                        { x: xmax, y: pcaOLS.beta * xmax + pcaOLS.alpha },
                      ]
                      const bpvRegLine = [
                        { x: xmin, y: bpvOLS.beta * xmin + bpvOLS.alpha },
                        { x: xmax, y: bpvOLS.beta * xmax + bpvOLS.alpha },
                      ]
                      const fmtCoef = (v: number) => {
                        if (Math.abs(v) < 1e-4) return '≈0'
                        if (Math.abs(v) < 0.01) return v.toExponential(2)
                        return v.toFixed(2)
                      }
                      const pcaEq = `y = ${fmtCoef(pcaOLS.beta)}x + ${fmtCoef(pcaOLS.alpha)}`
                      const bpvEq = `y = ${fmtCoef(bpvOLS.beta)}x + ${fmtCoef(bpvOLS.alpha)}`

                      const ScatterPanel = ({
                        dots, regLine, eq, r2, dotColor, title,
                      }: {
                        dots: { x: number; y: number }[]
                        regLine: { x: number; y: number }[]
                        eq: string; r2: number; dotColor: string; title: string
                      }) => {
                        const mainDots   = dots.slice(0, -1)
                        const latestDot  = dots.slice(-1)
                        return (
                        <div>
                          <div style={{ fontSize: 11, color: '#c6ced8', marginBottom: 4, fontWeight: 500 }}>{title}</div>
                          <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 2, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{eq}</div>
                          <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 6, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>R² = {r2.toFixed(3)}</div>
                          <ResponsiveContainer width="100%" height={180}>
                            <ScatterChart margin={{ top: 4, right: 8, bottom: 24, left: 36 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
                              <XAxis type="number" dataKey="x" domain={['auto', 'auto']}
                                tick={{ fill: '#9aa5b1', fontSize: 9 }}
                                tickFormatter={(v: number) => v.toFixed(2)}
                                label={{ value: fLabels[fi], position: 'insideBottom', offset: -12, fill: '#9aa5b1', fontSize: 9 }} />
                              <YAxis type="number" dataKey="y" domain={['auto', 'auto']}
                                tick={{ fill: '#9aa5b1', fontSize: 9 }}
                                tickFormatter={(v: number) => `${v.toFixed(0)}bp`} />
                              <Scatter data={mainDots} fill={dotColor} opacity={0.55} r={3} />
                              <Scatter data={regLine} fill="none" r={0}
                                line={{ stroke: '#c6ced8', strokeWidth: 1.5, strokeDasharray: '4 3' }} />
                              {latestDot.length > 0 && (
                                <Scatter data={latestDot} fill="#f4f7fa" opacity={1} r={5} />
                              )}
                            </ScatterChart>
                          </ResponsiveContainer>
                        </div>
                        )
                      }

                      return [
                        <ScatterPanel key={`${fk}-pca`} dots={pcaDots} regLine={pcaRegLine} eq={pcaEq} r2={pcaOLS.r2}
                          dotColor={fColors[fi]} title={`PCA-neutral vs ${fLabels[fi]}`} />,
                        <ScatterPanel key={`${fk}-bpv`} dots={bpvDots} regLine={bpvRegLine} eq={bpvEq} r2={bpvOLS.r2}
                          dotColor="#9aa5b1" title={`BPV-neutral vs ${fLabels[fi]}`} />,
                      ]
                    })}
                  </div>
                </div>
              )
            })()}
          </>
        )
      })()}
    </div>
  )
}

// ─── Tab 7: Impact Analysis ───────────────────────────────────────────────────

function ImpactAnalysisTab({ data }: { data: PCAResponse }) {
  const extVars    = data.external_vars ?? []
  const tenors     = data.tenors ?? []
  const eigenvecs  = data.eigenvectors ?? []

  const [selectedTicker, setSelectedTicker] = useState(extVars[0]?.ticker ?? '')
  const [shockSigma,     setShockSigma]     = useState(1.0)
  const [useChanges,     setUseChanges]     = useState(false)

  // Factor score lookup by date
  const factorByDate = useMemo(() => {
    const map = new Map<string, { f1: number; f2: number; f3: number }>()
    for (const pt of data.factor_history ?? []) map.set(pt.date, pt)
    return map
  }, [data.factor_history])

  const selectedVar = extVars.find(v => v.ticker === selectedTicker) ?? null

  // Aligned (x, f1, f2, f3) arrays, optionally first-differenced
  const aligned = useMemo(() => {
    if (!selectedVar) return null
    const xs: number[] = [], f1s: number[] = [], f2s: number[] = [], f3s: number[] = []
    selectedVar.dates.forEach((d, i) => {
      const v = selectedVar.values[i]
      const f = factorByDate.get(d)
      if (f != null && v != null) {
        xs.push(v as number); f1s.push(f.f1); f2s.push(f.f2); f3s.push(f.f3)
      }
    })
    if (useChanges && xs.length > 1) {
      return {
        xs:  xs.slice(1).map((x, i) => x - xs[i]),
        f1s: f1s.slice(1).map((f, i) => f - f1s[i]),
        f2s: f2s.slice(1).map((f, i) => f - f2s[i]),
        f3s: f3s.slice(1).map((f, i) => f - f3s[i]),
        n: xs.length - 1,
      }
    }
    return { xs, f1s, f2s, f3s, n: xs.length }
  }, [selectedVar, factorByDate, useChanges])

  const FACTOR_META = [
    { label: 'PC1', desc: 'Level',     color: F1_COLOR, fk: 'f1s' as const },
    { label: 'PC2', desc: 'Slope',     color: F2_COLOR, fk: 'f2s' as const },
    { label: 'PC3', desc: 'Curvature', color: F3_COLOR, fk: 'f3s' as const },
  ]

  // Std of the aligned variable (for σ-shock conversion)
  const varStd = useMemo(() => {
    if (!aligned || aligned.xs.length < 2) return 1
    const mean = aligned.xs.reduce((s, v) => s + v, 0) / aligned.xs.length
    return Math.sqrt(aligned.xs.reduce((s, v) => s + (v - mean) ** 2, 0) / aligned.xs.length) || 1
  }, [aligned])

  const shock = shockSigma * varStd

  // OLS: factor_j ~ α + β × x
  const regressions = useMemo(() => {
    if (!aligned) return FACTOR_META.map(m => ({ ...m, ols: { beta: 0, alpha: 0, tStat: 0, r2: 0 } }))
    return FACTOR_META.map(m => ({
      ...m,
      ols: simpleOLS(aligned.xs, aligned[m.fk]),
    }))
  }, [aligned]) // eslint-disable-line react-hooks/exhaustive-deps

  // Yield curve impact: Δyield_i = Σ_j β_j·shock · ev_j(i)
  const yieldImpact = useMemo(() => tenors.map(tenor => {
    const pc1 = regressions[0] ? regressions[0].ols.beta * shock * (eigenvecs[0]?.loadings[String(tenor)] ?? 0) * 100 : 0
    const pc2 = regressions[1] ? regressions[1].ols.beta * shock * (eigenvecs[1]?.loadings[String(tenor)] ?? 0) * 100 : 0
    const pc3 = regressions[2] ? regressions[2].ols.beta * shock * (eigenvecs[2]?.loadings[String(tenor)] ?? 0) * 100 : 0
    return { tenor: String(tenor) + 'y', pc1, pc2, pc3, total: pc1 + pc2 + pc3 }
  }), [regressions, shock, tenors, eigenvecs])

  // Current and shocked yield curves
  const currentYields = useMemo(() => {
    const arr = data.yield_history ?? []
    const last = arr[arr.length - 1]
    return last?.yields ?? {}
  }, [data.yield_history])

  const curveData = useMemo(() => tenors.map((tenor, ti) => {
    const cur = (currentYields[String(tenor)] ?? 0) * 100
    const imp = yieldImpact[ti]?.total ?? 0
    return { tenor: String(tenor) + 'y', current: cur, shocked: cur + imp }
  }), [tenors, currentYields, yieldImpact])

  const thS: React.CSSProperties = { padding: '7px 10px', fontSize: 11, color: '#8995a2', fontWeight: 500,
    borderBottom: '1px solid rgba(200,220,240,0.07)', textAlign: 'right' }
  const tdS: React.CSSProperties = { padding: '6px 10px', fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace",
    borderBottom: '1px solid rgba(200,220,240,0.04)', textAlign: 'right' }

  const selStyle: React.CSSProperties = { padding: '5px 10px', borderRadius: 7, fontSize: 12,
    border: '1px solid rgba(200,220,240,0.15)', background: '#0b0f14', color: '#e4eaf1', cursor: 'pointer' }

  if (extVars.length === 0) return (
    <div style={{ color: '#8995a2', fontSize: 13, padding: 24 }}>
      No external variables available. Run PCA with a curve that has external variable data.
    </div>
  )

  return (
    <div>
      {/* ── Controls ── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 14 }}>
          Impact Analysis
        </div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
          Estimates the yield curve impact of a shock to an external variable via OLS regression of each
          PC factor on the variable, then reconstructs the full curve from the implied factor changes.
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#c6ced8' }}>Variable</span>
            <select value={selectedTicker} onChange={e => setSelectedTicker(e.target.value)} style={selStyle}>
              {extVars.map(v => <option key={v.ticker} value={v.ticker}>{v.label} ({v.ticker})</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#c6ced8' }}>Shock magnitude</span>
            <input type="number" value={shockSigma} step={0.5}
              onChange={e => setShockSigma(Number(e.target.value))}
              style={{ ...selStyle, width: 70, fontFamily: "'Geist Mono', ui-monospace, monospace", textAlign: 'right' }} />
            <span style={{ fontSize: 12, color: '#e4eaf1', fontWeight: 600 }}>σ</span>
            <span style={{ fontSize: 11, color: '#8995a2', borderLeft: '1px solid rgba(200,220,240,0.08)', paddingLeft: 10 }}>
              1σ({selectedVar?.label ?? '—'}) = {varStd.toFixed(2)} {useChanges ? 'Δ' : ''}pts
              &ensp;→&ensp;this shock = <span style={{ color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                {shock >= 0 ? '+' : ''}{shock.toFixed(2)} pts
              </span>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { label: 'Levels', val: false },
              { label: 'Changes (Δ)', val: true },
            ].map(({ label, val }) => (
              <button key={label} onClick={() => setUseChanges(val)}
                style={{ padding: '4px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                  border: `1px solid ${useChanges === val ? 'rgba(134,192,222,0.5)' : 'rgba(200,220,240,0.1)'}`,
                  background: useChanges === val ? 'rgba(134,192,222,0.18)' : 'rgba(200,220,240,0.03)',
                  color: useChanges === val ? '#bfe0ef' : '#9aa5b1', fontWeight: useChanges === val ? 600 : 400 }}>
                {label}
              </button>
            ))}
          </div>
          {aligned && <span style={{ fontSize: 11, color: '#8995a2' }}>n = {aligned.n} obs</span>}
        </div>
      </div>

      {/* ── Factor regressions ── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 6 }}>
          Factor Regressions
        </div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 14 }}>
          Regressing each PC factor on <strong style={{ color: '#e4eaf1' }}>{selectedVar?.label}</strong> ({useChanges ? 'week-on-week changes' : 'levels'}).
          A <strong style={{ color: '#e4eaf1' }}>{shockSigma}σ shock</strong> ({shock >= 0 ? '+' : ''}{shock.toFixed(2)} pts) implies
          ΔFactor<sub>k</sub> = β<sub>k</sub> × {shock.toFixed(2)}, which is then projected back onto the yield curve via the eigenvectors.
        </div>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {['Factor', 'Description', 'β (slope)', 'α (intercept)', 't-stat', 'R²', 'Implied ΔFactor'].map(h => (
                <th key={h} style={{ ...thS, textAlign: h === 'Factor' || h === 'Description' ? 'left' : 'right' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {regressions.map((reg, j) => {
              const deltaF = reg.ols.beta * shock
              const sigColor = Math.abs(reg.ols.tStat) > 2 ? CHEAP_COLOR : Math.abs(reg.ols.tStat) > 1.5 ? '#dfbb78' : '#8995a2'
              return (
                <tr key={j}>
                  <td style={{ ...tdS, textAlign: 'left', color: reg.color, fontWeight: 600 }}>{reg.label}</td>
                  <td style={{ ...tdS, textAlign: 'left', color: '#c6ced8' }}>{reg.desc}</td>
                  <td style={{ ...tdS }}>{reg.ols.beta >= 0 ? '+' : ''}{reg.ols.beta.toFixed(4)}</td>
                  <td style={{ ...tdS }}>{reg.ols.alpha >= 0 ? '+' : ''}{reg.ols.alpha.toFixed(4)}</td>
                  <td style={{ ...tdS, color: sigColor, fontWeight: 600 }}>{reg.ols.tStat.toFixed(2)}</td>
                  <td style={{ ...tdS }}>{(reg.ols.r2 * 100).toFixed(1)}%</td>
                  <td style={{ ...tdS, color: deltaF >= 0 ? CHEAP_COLOR : RICH_COLOR, fontWeight: 600 }}>
                    {deltaF >= 0 ? '+' : ''}{deltaF.toFixed(4)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Yield curve impact ── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 6 }}>
          Reconstructed Yield Curve Impact (bp)
        </div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
          Δyield<sub>i</sub> = Σ<sub>j</sub> β<sub>j</sub> · shock · ev<sub>j</sub>(i).
          Stacked bars show PC1/PC2/PC3 contributions.
        </div>

        {/* Stacked bar: per-factor contributions */}
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={yieldImpact} margin={{ top: 8, right: 20, bottom: 8, left: 44 }}
            barSize={28}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
            <XAxis dataKey="tenor" tick={{ fill: '#9aa5b1', fontSize: 11 }} />
            <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }} tickFormatter={v => `${v.toFixed(1)}bp`} />
            <Tooltip
              contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
              labelStyle={{ color: '#c6ced8', fontSize: 12 }}
              formatter={(v: number, name: string) => [`${v >= 0 ? '+' : ''}${v.toFixed(2)}bp`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" />
            <Bar dataKey="pc1" name="PC1 (Level)"     stackId="a" fill={F1_COLOR} opacity={0.85} />
            <Bar dataKey="pc2" name="PC2 (Slope)"     stackId="a" fill={F2_COLOR} opacity={0.85} />
            <Bar dataKey="pc3" name="PC3 (Curvature)" stackId="a" fill={F3_COLOR} opacity={0.85} />
          </BarChart>
        </ResponsiveContainer>

        {/* Total impact summary row */}
        <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
          {yieldImpact.map(pt => (
            <div key={pt.tenor} style={{ textAlign: 'center', background: 'rgba(200,220,240,0.03)',
              border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '8px 12px', minWidth: 64 }}>
              <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 3 }}>{pt.tenor}</div>
              <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace",
                color: pt.total >= 0 ? CHEAP_COLOR : RICH_COLOR }}>
                {pt.total >= 0 ? '+' : ''}{pt.total.toFixed(2)}bp
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Reconstructed yield curve ── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 6 }}>
          Yield Curve: Current vs Shocked
        </div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 14 }}>
          Shocked = current yields + reconstructed impact of {shock >= 0 ? '+' : ''}{shock} unit change in {selectedVar?.label ?? 'variable'}.
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={curveData} margin={{ top: 8, right: 24, bottom: 8, left: 52 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
            <XAxis dataKey="tenor" tick={{ fill: '#9aa5b1', fontSize: 11 }} />
            <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }}
              tickFormatter={v => `${v.toFixed(0)}bp`}
              domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
              labelStyle={{ color: '#c6ced8', fontSize: 12 }}
              formatter={(v: number, name: string) => [`${v.toFixed(1)}bp`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="current" name="Current" stroke="#9aa5b1"
              strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="shocked" name={`Shocked (${shock >= 0 ? '+' : ''}${shock})`}
              stroke={F1_COLOR} strokeWidth={2} strokeDasharray="6 3" dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Tab 8: Factor Residuals ──────────────────────────────────────────────────

function FactorResidualsTab({ data }: { data: PCAResponse }) {
  const tenors    = data.tenors ?? []
  const eigenvecs = data.eigenvectors ?? []
  const nAvail    = Math.min(eigenvecs.length, 3)

  const [nFactors,       setNFactors]       = useState(2)
  const [activeTenors,   setActiveTenors]   = useState<Set<number>>(() => new Set(tenors))

  // date → [f1, f2, f3]
  const factorByDate = useMemo(() => {
    const map = new Map<string, [number, number, number]>()
    for (const pt of data.factor_history ?? []) map.set(pt.date, [pt.f1, pt.f2, pt.f3])
    return map
  }, [data.factor_history])

  // resid_i(t) = [yield_i(t) − Σ_{k<n} f_k(t)·ev_k(i)] × 100  (bp)
  const residHistory = useMemo(() => {
    const evs = eigenvecs.slice(0, nFactors)
    const result: { date: string; resids: Record<string, number> }[] = []
    for (const pt of data.yield_history ?? []) {
      const fs = factorByDate.get(pt.date)
      if (!fs) continue
      const resids: Record<string, number> = {}
      for (const tenor of tenors) {
        const y = pt.yields[String(tenor)]
        if (y == null) continue
        let yhat = 0
        evs.forEach((ev, k) => { yhat += fs[k] * (ev.loadings[String(tenor)] ?? 0) })
        resids[String(tenor)] = parseFloat(((y - yhat) * 100).toFixed(3))
      }
      result.push({ date: pt.date, resids })
    }
    return result
  }, [nFactors, eigenvecs, data.yield_history, factorByDate, tenors])

  const currentResids = residHistory[residHistory.length - 1]?.resids ?? {}

  // Per-tenor: mean, std, z-score over history
  const stats = useMemo(() => {
    const out: Record<string, { mean: number; std: number; z: number }> = {}
    for (const tenor of tenors) {
      const key = String(tenor)
      const vals = residHistory.map(pt => pt.resids[key]).filter((v): v is number => v != null)
      if (vals.length < 2) continue
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const std  = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1))
      const cur  = currentResids[key] ?? mean
      out[key]   = { mean, std, z: std > 0 ? (cur - mean) / std : 0 }
    }
    return out
  }, [residHistory, currentResids, tenors])

  // Chart data: one row per date, one key per tenor
  const chartData = useMemo(() => residHistory.map(pt => {
    const row: Record<string, string | number> = { date: pt.date.slice(0, 7) }
    for (const tenor of tenors) row[String(tenor) + 'y'] = pt.resids[String(tenor)] ?? 0
    return row
  }), [residHistory, tenors])

  const TENOR_COLORS = ['#8b8fd8', '#6aa9cc', '#58ad8e', '#d6ad66', '#d9705e',
                        '#a08bd2', '#c98fb2', '#6fc0cb', '#a8c46e', '#d48853']

  const barData = tenors.map(t => ({
    tenor: tLabel(t, data),
    value: currentResids[String(t)] ?? 0,
    z: stats[String(t)]?.z ?? 0,
  }))

  const thS: React.CSSProperties = { padding: '7px 10px', fontSize: 11, color: '#8995a2',
    fontWeight: 500, borderBottom: '1px solid rgba(200,220,240,0.07)', textAlign: 'right' }
  const tdS: React.CSSProperties = { padding: '6px 10px', fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace",
    borderBottom: '1px solid rgba(200,220,240,0.04)', textAlign: 'right' }

  return (
    <div>
      {/* Controls */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1' }}>Factor Residuals</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#c6ced8' }}>Factors used</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {Array.from({ length: nAvail }, (_, i) => i + 1).map(n => (
                <button key={n} onClick={() => setNFactors(n)}
                  style={{ padding: '4px 14px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${nFactors === n ? 'rgba(134,192,222,0.5)' : 'rgba(200,220,240,0.1)'}`,
                    background: nFactors === n ? 'rgba(134,192,222,0.18)' : 'rgba(200,220,240,0.03)',
                    color: nFactors === n ? '#bfe0ef' : '#9aa5b1', fontWeight: nFactors === n ? 600 : 400 }}>
                  {n === 1 ? 'PC1' : n === 2 ? 'PC1+2' : 'PC1+2+3'}
                </button>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#8995a2' }}>
            {nFactors}-factor model · {residHistory.length} obs
          </div>
          {/* Tenor visibility toggles */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginLeft: 'auto' }}>
            {tenors.map((t, ti) => (
              <button key={t} onClick={() => setActiveTenors(prev => {
                const next = new Set(prev)
                if (next.has(t)) next.delete(t)
                else next.add(t)
                return next
              })}
                style={{ padding: '3px 9px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                  border: `1px solid ${activeTenors.has(t) ? TENOR_COLORS[ti % TENOR_COLORS.length] + '80' : 'rgba(200,220,240,0.1)'}`,
                  background: activeTenors.has(t) ? TENOR_COLORS[ti % TENOR_COLORS.length] + '18' : 'rgba(200,220,240,0.03)',
                  color: activeTenors.has(t) ? TENOR_COLORS[ti % TENOR_COLORS.length] : '#8995a2' }}>
                {t}y
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Current snapshot: bar chart + z-score table */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div className="hub-frame" style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 14 }}>
            Current Residuals (bp)
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={barData} margin={{ top: 20, right: 16, bottom: 8, left: 36 }} barSize={22}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
              <XAxis dataKey="tenor" tick={{ fill: '#9aa5b1', fontSize: 11 }} />
              <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }} tickFormatter={v => `${v}bp`} />
              <Tooltip
                contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                formatter={(v: number) => [`${v >= 0 ? '+' : ''}${v.toFixed(2)}bp`]}
              />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" />
              <Bar dataKey="value" name="Residual (bp)" radius={[3, 3, 0, 0]}>
                {barData.map((d, i) => (
                  <Cell key={i} fill={d.value >= 0 ? CHEAP_COLOR : RICH_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="hub-frame" style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 14 }}>
            Z-Scores vs History
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {['Tenor', 'Residual (bp)', 'Mean (bp)', 'Std (bp)', 'Z-score', 'Signal'].map(h => (
                  <th key={h} style={{ ...thS, textAlign: h === 'Tenor' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tenors.map(t => {
                const key = String(t)
                const s = stats[key]
                const cur = currentResids[key] ?? 0
                const z = s?.z ?? 0
                const zColor = Math.abs(z) > 2 ? (z > 0 ? CHEAP_COLOR : RICH_COLOR)
                             : Math.abs(z) > 1 ? '#dfbb78' : '#c6ced8'
                return (
                  <tr key={t}>
                    <td style={{ ...tdS, textAlign: 'left', color: '#e4eaf1', fontWeight: 600 }}>{t}y</td>
                    <td style={{ ...tdS, color: cur >= 0 ? CHEAP_COLOR : RICH_COLOR }}>
                      {cur >= 0 ? '+' : ''}{cur.toFixed(2)}
                    </td>
                    <td style={{ ...tdS, color: '#c6ced8' }}>{(s?.mean ?? 0).toFixed(2)}</td>
                    <td style={{ ...tdS, color: '#c6ced8' }}>{(s?.std ?? 0).toFixed(2)}</td>
                    <td style={{ ...tdS, color: zColor, fontWeight: 600 }}>
                      {z >= 0 ? '+' : ''}{z.toFixed(2)}σ
                    </td>
                    <td style={{ ...tdS, color: zColor }}>
                      {Math.abs(z) > 2 ? (z > 0 ? '★ Cheap' : '★ Rich')
                       : Math.abs(z) > 1 ? (z > 0 ? '↑ Mild cheap' : '↓ Mild rich')
                       : '— Fair'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* History: multi-line chart */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 6 }}>
          Residual History (bp)
        </div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 14 }}>
          {nFactors}-factor model residuals per tenor over time.
          Positive = cheap (yield above model), negative = rich.
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData} margin={{ top: 8, right: 20, bottom: 8, left: 44 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
            <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }}
              interval={Math.max(1, Math.floor(chartData.length / 10))} />
            <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }} tickFormatter={v => `${v}bp`} />
            <Tooltip
              contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
              labelStyle={{ color: '#c6ced8', fontSize: 11 }}
              formatter={(v: number, name: string) => [`${v >= 0 ? '+' : ''}${v.toFixed(2)}bp`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" />
            {tenors.map((t, ti) => activeTenors.has(t) && (
              <Line key={t} type="monotone" dataKey={String(t) + 'y'} name={tLabel(t, data)}
                stroke={TENOR_COLORS[ti % TENOR_COLORS.length]} strokeWidth={1.5}
                dot={false} connectNulls={false} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Tab: Stability Diagnostics ───────────────────────────────────────────────

function StabilityTab({ data, rollWindowWeeks, setRollWindowWeeks, onRefetch }: {
  data: PCAResponse
  rollWindowWeeks: number | null
  setRollWindowWeeks: (w: number | null) => void
  onRefetch: () => void
}) {
  const tenors   = data.tenors ?? []
  const eigenvecs = data.eigenvectors ?? []
  const stab     = data.stability
  const n        = eigenvecs.length  // number of factors (up to 3)

  // ── Gram matrix G = Eᵀ E (should be identity for orthonormal vectors) ──────
  const gram = useMemo(() => Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      tenors.reduce((s, t) =>
        s + (eigenvecs[i]?.loadings[String(t)] ?? 0) * (eigenvecs[j]?.loadings[String(t)] ?? 0), 0)
    )
  ), [eigenvecs, tenors, n])

  const maxOffDiag = useMemo(() => {
    let m = 0
    gram.forEach((row, i) => row.forEach((v, j) => { if (i !== j) m = Math.max(m, Math.abs(v)) }))
    return m
  }, [gram])

  // ── Rolling stability chart data ────────────────────────────────────────────
  const rollHistory = stab?.history ?? []
  const minSim = useMemo(() => {
    const mins = [1, 1, 1]
    rollHistory.forEach(pt => {
      if (pt.pc1 < mins[0]) mins[0] = pt.pc1
      if (pt.pc2 < mins[1]) mins[1] = pt.pc2
      if ((pt.pc3 ?? 1) < mins[2]) mins[2] = pt.pc3 ?? 1
    })
    return mins
  }, [rollHistory])

  const thS: React.CSSProperties = { padding: '7px 10px', fontSize: 11, color: '#8995a2',
    fontWeight: 500, borderBottom: '1px solid rgba(200,220,240,0.07)', textAlign: 'center' }
  const tdS: React.CSSProperties = { padding: '8px 10px', fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace",
    borderBottom: '1px solid rgba(200,220,240,0.04)', textAlign: 'center' }

  const gramColor = (i: number, j: number, v: number) => {
    if (i === j) {
      const dev = Math.abs(v - 1)
      return dev < 1e-6 ? CHEAP_COLOR : dev < 0.01 ? '#dfbb78' : RICH_COLOR
    }
    const a = Math.abs(v)
    return a < 1e-6 ? CHEAP_COLOR : a < 0.01 ? '#dfbb78' : RICH_COLOR
  }

  const simColor = (v: number) =>
    v > 0.99 ? CHEAP_COLOR : v > 0.95 ? '#dfbb78' : RICH_COLOR

  const FACTOR_COLORS = [F1_COLOR, F2_COLOR, F3_COLOR]
  const FACTOR_LABELS = ['PC1 (Level)', 'PC2 (Slope)', 'PC3 (Curvature)']
  const pcKeys: ('pc1' | 'pc2' | 'pc3')[] = ['pc1', 'pc2', 'pc3']

  const [rollWinDraft, setRollWinDraft] = useState<string>(rollWindowWeeks ? String(rollWindowWeeks) : '')

  return (
    <div>
      {/* ── Rolling window control ── */}
      <div className="hub-frame" style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e4eaf1' }}>Rolling window</span>
        <input
          type="number" min={5} max={260} step={1}
          value={rollWinDraft}
          onChange={e => setRollWinDraft(e.target.value)}
          placeholder={`auto (${stab?.roll_window_weeks ?? '?'}w)`}
          style={{ width: 120, padding: '5px 10px', borderRadius: 7, border: '1px solid rgba(200,220,240,0.15)',
            background: '#0b0f14', color: '#e4eaf1', fontSize: 13, fontFamily: "'Geist Mono', ui-monospace, monospace" }}
        />
        <span style={{ fontSize: 11, color: '#8995a2' }}>weeks</span>
        <button
          onClick={() => {
            const v = parseInt(rollWinDraft, 10)
            setRollWindowWeeks(isNaN(v) || v <= 0 ? null : v)
            onRefetch()
          }}
          style={{ padding: '5px 18px', borderRadius: 7, border: 'none', cursor: 'pointer',
            background: 'rgba(139,143,216,0.8)', color: '#f4f7fa', fontSize: 13, fontWeight: 600 }}>
          Apply
        </button>
        {rollWindowWeeks !== null && (
          <button
            onClick={() => { setRollWinDraft(''); setRollWindowWeeks(null); onRefetch() }}
            style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
              border: '1px solid rgba(200,220,240,0.1)', background: 'rgba(200,220,240,0.04)', color: '#9aa5b1' }}>
            Reset to auto
          </button>
        )}
        <span style={{ fontSize: 11, color: '#8995a2', marginLeft: 4 }}>
          Active: {stab ? `${stab.roll_window_weeks}w` : '—'}
        </span>
      </div>

      {/* ── Summary metrics ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
        {[
          {
            label: 'Condition Number',
            value: stab ? stab.condition_number.toFixed(1) : '—',
            sub: 'λ_max / λ_min of covariance matrix',
            color: stab
              ? stab.condition_number < 100 ? CHEAP_COLOR
              : stab.condition_number < 1000 ? '#dfbb78' : RICH_COLOR
              : '#c6ced8',
          },
          {
            label: 'Max Off-Diagonal |Eᵀ E|',
            value: maxOffDiag.toExponential(2),
            sub: 'Orthogonality error — should be ≈ 0',
            color: maxOffDiag < 1e-6 ? CHEAP_COLOR : maxOffDiag < 0.01 ? '#dfbb78' : RICH_COLOR,
          },
          {
            label: 'Min Rolling Cosine Sim',
            value: stab ? Math.min(...minSim.slice(0, n)).toFixed(4) : '—',
            sub: `Over ${stab?.roll_window_weeks ?? '—'}w rolling window`,
            color: stab
              ? Math.min(...minSim.slice(0, n)) > 0.99 ? CHEAP_COLOR
              : Math.min(...minSim.slice(0, n)) > 0.95 ? '#dfbb78' : RICH_COLOR
              : '#c6ced8',
          },
        ].map(({ label, value, sub, color }) => (
          <div key={label} style={{ ...cardStyle, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 8 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color, marginBottom: 6 }}>{value}</div>
            <div style={{ fontSize: 10, color: '#8995a2' }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* ── Orthogonality: Gram matrix ── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 6 }}>
          Orthogonality Check — Gram Matrix Eᵀ E
        </div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
          Diagonal should be 1.0 (unit norm), off-diagonal should be 0.0 (orthogonal).
          Colour: <span style={{ color: CHEAP_COLOR }}>✓ within 1e-6</span> · <span style={{ color: '#dfbb78' }}>⚠ within 0.01</span> · <span style={{ color: RICH_COLOR }}>✗ larger</span>.
        </div>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: 'left' }}> </th>
              {eigenvecs.map((ev, j) => (
                <th key={j} style={{ ...thS, color: FACTOR_COLORS[j] }}>{ev.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {gram.map((row, i) => (
              <tr key={i}>
                <td style={{ ...tdS, textAlign: 'left', color: FACTOR_COLORS[i], fontWeight: 600 }}>
                  {eigenvecs[i]?.label}
                </td>
                {row.map((v, j) => (
                  <td key={j} style={{ ...tdS, color: gramColor(i, j, v), fontWeight: i === j ? 700 : 400 }}>
                    {i === j ? v.toFixed(8) : v.toExponential(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Rolling stability ── */}
      {rollHistory.length > 0 && (
        <div className="hub-frame" style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 6 }}>
            Temporal Stability — Rolling Cosine Similarity
          </div>
          <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 4 }}>
            At each date, PCA is re-estimated on the preceding {stab?.roll_window_weeks}w window.
            Cosine similarity measures alignment with the full-sample eigenvector.
            Value near 1 = stable; drops indicate the factor direction is rotating.
          </div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
            {pcKeys.slice(0, n).map((pk, k) => (
              <div key={pk} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span style={{ width: 20, height: 2, background: FACTOR_COLORS[k], display: 'inline-block', borderRadius: 1 }} />
                <span style={{ color: FACTOR_COLORS[k] }}>{FACTOR_LABELS[k]}</span>
                <span style={{ color: simColor(minSim[k]), fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                  min={minSim[k].toFixed(4)}
                </span>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={rollHistory} margin={{ top: 8, right: 20, bottom: 8, left: 44 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
              <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }}
                interval={Math.max(1, Math.floor(rollHistory.length / 10))}
                tickFormatter={(d: string) => d.slice(0, 7)} />
              <YAxis domain={[0, 1]} tick={{ fill: '#9aa5b1', fontSize: 10 }}
                tickFormatter={(v: number) => v.toFixed(2)} />
              <Tooltip
                contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                labelStyle={{ color: '#c6ced8', fontSize: 11 }}
                formatter={(v: number, name: string) => [v.toFixed(4), name]}
              />
              <ReferenceLine y={0.99} stroke="rgba(200,220,240,0.15)" strokeDasharray="4 3"
                label={{ value: '0.99', position: 'right', fill: '#8995a2', fontSize: 9 }} />
              <ReferenceLine y={0.95} stroke="rgba(223,187,120,0.25)" strokeDasharray="4 3"
                label={{ value: '0.95', position: 'right', fill: '#8995a2', fontSize: 9 }} />
              {pcKeys.slice(0, n).map((pk, k) => (
                <Line key={pk} type="monotone" dataKey={pk} name={FACTOR_LABELS[k]}
                  stroke={FACTOR_COLORS[k]} strokeWidth={1.5} dot={false} connectNulls={false} />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Rolling eigenvector loadings ── */}
      {rollHistory.length > 0 && (() => {
        const TENOR_COLORS = ['#8b8fd8','#7cc3dc','#5fb592','#d6ad66','#d9705e','#b49fdb','#6fc2a2','#dd9562']
        return (
          <div className="hub-frame" style={cardStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 6 }}>
              Rolling Eigenvector Loadings
            </div>
            <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 20 }}>
              Per-tenor loading of each eigenvector re-estimated over the same {stab?.roll_window_weeks}w rolling window.
              The cosine similarity chart tells you <em>whether</em> a factor changed; this chart tells you <em>which tenors</em> drove it and by how much.
            </div>
            {eigenvecs.map((ev, k) => (
              <div key={k} style={{ marginBottom: k < n - 1 ? 28 : 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: FACTOR_COLORS[k], marginBottom: 8 }}>
                  {ev.label} — per-tenor loading over time
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={rollHistory} margin={{ top: 4, right: 20, bottom: 8, left: 44 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
                    <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }}
                      interval={Math.max(1, Math.floor(rollHistory.length / 10))}
                      tickFormatter={(d: string) => d.slice(0, 7)} />
                    <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }}
                      tickFormatter={(v: number) => v.toFixed(2)} />
                    <Tooltip
                      contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                      labelStyle={{ color: '#c6ced8', fontSize: 11 }}
                      formatter={(v: number, name: string) => [v.toFixed(4), name]}
                    />
                    <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" strokeDasharray="3 2" />
                    <Legend iconType="line" wrapperStyle={{ fontSize: 11, paddingTop: 8, color: '#9aa5b1' }} />
                    {tenors.map((t, ti) => (
                      <Line key={t} type="monotone" dataKey={`pc${k + 1}_t${t}`} name={tLabel(t, data)}
                        stroke={TENOR_COLORS[ti % TENOR_COLORS.length]} strokeWidth={1.2} dot={false} connectNulls={false} />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ))}
          </div>
        )
      })()}

      {/* ── Eigenvector loading profiles ── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 14 }}>
          Eigenvector Loading Profiles
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, 1fr)`, gap: 20 }}>
          {eigenvecs.map((ev, k) => {
            const loadData = tenors.map(t => ({
              tenor: tLabel(t, data),
              loading: parseFloat((ev.loadings[String(t)] ?? 0).toFixed(5)),
            }))
            return (
              <div key={k}>
                <div style={{ fontSize: 12, fontWeight: 600, color: FACTOR_COLORS[k], marginBottom: 8 }}>
                  {ev.label}
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={loadData} margin={{ top: 4, right: 8, bottom: 8, left: 36 }} barSize={16}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
                    <XAxis dataKey="tenor" tick={{ fill: '#9aa5b1', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#9aa5b1', fontSize: 9 }} tickFormatter={(v: number) => v.toFixed(2)} />
                    <Tooltip
                      contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                      formatter={(v: number) => [v.toFixed(5), 'Loading']}
                    />
                    <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" />
                    <Bar dataKey="loading" name="Loading" radius={[2, 2, 0, 0]}>
                      {loadData.map((d, i) => (
                        <Cell key={i} fill={d.loading >= 0 ? FACTOR_COLORS[k] : RICH_COLOR} opacity={0.8} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function FactorCorrelationsTab({ data, extraTickers, onAddTicker, onRemoveTicker }: {
  data: PCAResponse
  extraTickers: { ticker: string; label: string }[]
  onAddTicker: (t: { ticker: string; label: string }) => void
  onRemoveTicker: (ticker: string) => void
}) {
  const extVars = data.external_vars ?? []
  const [rollWin, setRollWin] = useState(26)
  const [tableWin, setTableWin] = useState<{ start: string; end: string } | null>(null)
  const [tableWinDraft, setTableWinDraft] = useState<{ start: string; end: string }>(() => {
    const dates = (data.factor_history ?? []).map(d => d.date)
    return { start: dates[0] ?? '', end: dates[dates.length - 1] ?? '' }
  })
  const [regWin, setRegWin] = useState<{ start: string; end: string } | null>(null)
  const [regWinDraft, setRegWinDraft] = useState<{ start: string; end: string }>(() => {
    const dates = (data.factor_history ?? []).map(d => d.date)
    return { start: dates[0] ?? '', end: dates[dates.length - 1] ?? '' }
  })
  const [activeVars, setActiveVars] = useState<Set<string>>(() => new Set(extVars.map(v => v.ticker)))
  const [tickerInput, setTickerInput] = useState('')
  const [labelInput, setLabelInput] = useState('')

  // date → factor lookup
  const factorByDate = useMemo(() => {
    const map = new Map<string, { f1: number; f2: number; f3: number }>()
    for (const pt of data.factor_history ?? []) map.set(pt.date, { f1: pt.f1, f2: pt.f2, f3: pt.f3 })
    return map
  }, [data.factor_history])

  // Aligned arrays per external variable
  const aligned = useMemo(() => extVars.map(ev => {
    const dates: string[] = [], vals: number[] = [], f1s: number[] = [], f2s: number[] = [], f3s: number[] = []
    ev.dates.forEach((d, i) => {
      const v = ev.values[i]
      const f = factorByDate.get(d)
      if (f != null && v != null) {
        dates.push(d); vals.push(v); f1s.push(f.f1); f2s.push(f.f2); f3s.push(f.f3)
      }
    })
    return { ticker: ev.ticker, label: ev.label, dates, vals, f1s, f2s, f3s }
  }), [extVars, factorByDate])

  // Slice aligned data to the active table window
  const slicedAligned = useMemo(() => aligned.map(a => {
    if (tableWin === null || a.dates.length === 0) return a
    const indices = a.dates.reduce<number[]>((acc, d, i) => {
      if (d >= tableWin.start && d <= tableWin.end) acc.push(i)
      return acc
    }, [])
    return {
      ...a,
      dates: indices.map(i => a.dates[i]),
      vals:  indices.map(i => a.vals[i]),
      f1s:   indices.map(i => a.f1s[i]),
      f2s:   indices.map(i => a.f2s[i]),
      f3s:   indices.map(i => a.f3s[i]),
    }
  }), [aligned, tableWin])

  const fullCorrs = useMemo(() => slicedAligned.map(a => ({
    ticker: a.ticker, label: a.label,
    r: [pearsonCorr(a.vals, a.f1s), pearsonCorr(a.vals, a.f2s), pearsonCorr(a.vals, a.f3s)],
    n: a.vals.length,
  })), [slicedAligned])

  // Slice for regression (independent window)
  const regSliced = useMemo(() => aligned.map(a => {
    if (regWin === null || a.dates.length === 0) return a
    const indices = a.dates.reduce<number[]>((acc, d, i) => {
      if (d >= regWin.start && d <= regWin.end) acc.push(i)
      return acc
    }, [])
    return {
      ...a,
      dates: indices.map(i => a.dates[i]),
      vals:  indices.map(i => a.vals[i]),
      f1s:   indices.map(i => a.f1s[i]),
      f2s:   indices.map(i => a.f2s[i]),
      f3s:   indices.map(i => a.f3s[i]),
    }
  }), [aligned, regWin])

  // OLS per (external var, factor) pair — F_k = α + β·X_i
  const regressionResults = useMemo(() => regSliced.map(a => ({
    ticker: a.ticker, label: a.label,
    ols: [simpleOLS(a.vals, a.f1s), simpleOLS(a.vals, a.f2s), simpleOLS(a.vals, a.f3s)],
    n: a.vals.length,
  })), [regSliced])

  // Rolling correlations — one entry per factor (3), each is chart data array
  const rollingData = useMemo(() => {
    const activeAligned = aligned.filter(a => activeVars.has(a.ticker))
    const getFArr = (a: typeof aligned[0], fi: number) => fi === 0 ? a.f1s : fi === 1 ? a.f2s : a.f3s
    return [0, 1, 2].map(fi => {
      if (activeAligned.length === 0 || activeAligned[0].dates.length === 0) return []
      const refDates = activeAligned[0].dates
      const precomputed: Record<string, (number | null)[]> = {}
      for (const a of activeAligned) precomputed[a.ticker] = rollingCorr(a.vals, getFArr(a, fi), rollWin)
      return refDates.map((date, i) => {
        const pt: Record<string, string | number | null> = { date: date.slice(0, 7) }
        for (const a of activeAligned) {
          const rc = precomputed[a.ticker][i]
          pt[a.ticker] = rc !== null ? parseFloat(rc.toFixed(3)) : null
        }
        return pt
      })
    })
  }, [aligned, activeVars, rollWin])

  const factorColors = [F1_COLOR, F2_COLOR, F3_COLOR]
  const factorLabels = (data.eigenvectors ?? []).slice(0, 3).map(ev => ev.label)

  if (extVars.length === 0) {
    return <div style={{ padding: 60, color: '#8995a2', textAlign: 'center' }}>No external variable data available.</div>
  }

  return (
    <div>
      {/* Controls */}
      <div className="hub-frame" style={cardStyle}>
        {/* Row 1: window + variable toggles */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
          {/* Window */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: '#9aa5b1' }}>Rolling window:</span>
            {ROLL_WINDOWS.map(opt => (
              <button key={opt.weeks} onClick={() => setRollWin(opt.weeks)}
                style={{
                  padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${rollWin === opt.weeks ? 'rgba(134,192,222,0.6)' : 'rgba(200,220,240,0.1)'}`,
                  background: rollWin === opt.weeks ? 'rgba(134,192,222,0.15)' : 'transparent',
                  color: rollWin === opt.weeks ? '#bfe0ef' : '#9aa5b1',
                }}>
                {opt.label}
              </button>
            ))}
          </div>
          {/* Variable toggles */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#9aa5b1' }}>Variables:</span>
            {extVars.map((ev, vi) => {
              const active = activeVars.has(ev.ticker)
              const c = EXT_VAR_COLORS[vi % EXT_VAR_COLORS.length]
              const isCustom = extraTickers.some(e => e.ticker === ev.ticker)
              return (
                <span key={ev.ticker} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  <button
                    onClick={() => setActiveVars(prev => {
                      const next = new Set(prev)
                      if (next.has(ev.ticker)) { if (next.size > 1) next.delete(ev.ticker) }
                      else next.add(ev.ticker)
                      return next
                    })}
                    style={{
                      padding: '3px 8px', borderRadius: isCustom ? '6px 0 0 6px' : 6,
                      fontSize: 12, cursor: 'pointer',
                      border: `1px solid ${active ? c + '88' : 'rgba(200,220,240,0.1)'}`,
                      borderRight: isCustom ? 'none' : undefined,
                      background: active ? c + '22' : 'transparent',
                      color: active ? c : '#9aa5b1',
                    }}>
                    {ev.label}
                  </button>
                  {isCustom && (
                    <button
                      onClick={() => {
                        onRemoveTicker(ev.ticker)
                        setActiveVars(prev => { const n = new Set(prev); n.delete(ev.ticker); return n })
                      }}
                      title="Remove"
                      style={{
                        padding: '3px 6px', borderRadius: '0 6px 6px 0', fontSize: 11,
                        cursor: 'pointer', lineHeight: 1,
                        border: `1px solid ${active ? c + '88' : 'rgba(200,220,240,0.1)'}`,
                        borderLeft: '1px solid rgba(200,220,240,0.08)',
                        background: active ? c + '22' : 'transparent',
                        color: '#9aa5b1',
                      }}>
                      ×
                    </button>
                  )}
                </span>
              )
            })}
          </div>
        </div>

        {/* Row 2: add custom ticker */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid rgba(200,220,240,0.06)', paddingTop: 12 }}>
          <span style={{ fontSize: 12, color: '#9aa5b1', whiteSpace: 'nowrap' }}>Add ticker:</span>
          <input
            value={tickerInput}
            onChange={e => setTickerInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && tickerInput.trim()) {
                const t = tickerInput.trim()
                const l = labelInput.trim() || t
                if (!extVars.some(v => v.ticker === t)) {
                  onAddTicker({ ticker: t, label: l })
                  setActiveVars(prev => new Set([...prev, t]))
                }
                setTickerInput(''); setLabelInput('')
              }
            }}
            placeholder="e.g. GS1 Comdty"
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.15)',
              background: '#0b0f14', color: '#e4eaf1', fontSize: 12, width: 150, fontFamily: "'Geist Mono', ui-monospace, monospace" }}
          />
          <input
            value={labelInput}
            onChange={e => setLabelInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && tickerInput.trim()) {
                const t = tickerInput.trim()
                const l = labelInput.trim() || t
                if (!extVars.some(v => v.ticker === t)) {
                  onAddTicker({ ticker: t, label: l })
                  setActiveVars(prev => new Set([...prev, t]))
                }
                setTickerInput(''); setLabelInput('')
              }
            }}
            placeholder="Label (optional)"
            style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.15)',
              background: '#0b0f14', color: '#e4eaf1', fontSize: 12, width: 130 }}
          />
          <button
            onClick={() => {
              const t = tickerInput.trim()
              const l = labelInput.trim() || t
              if (t && !extVars.some(v => v.ticker === t)) {
                onAddTicker({ ticker: t, label: l })
                setActiveVars(prev => new Set([...prev, t]))
              }
              setTickerInput(''); setLabelInput('')
            }}
            disabled={!tickerInput.trim()}
            style={{
              padding: '4px 14px', borderRadius: 6, fontSize: 12, cursor: tickerInput.trim() ? 'pointer' : 'not-allowed',
              border: '1px solid rgba(139,143,216,0.4)',
              background: tickerInput.trim() ? 'rgba(134,192,222,0.2)' : 'transparent',
              color: tickerInput.trim() ? '#bfe0ef' : '#8995a2',
            }}>
            + Add
          </button>
          <span style={{ fontSize: 11, color: '#77828f' }}>
            Then click <b style={{ color: '#9aa5b1' }}>Run PCA</b> to fetch data
          </span>
        </div>
      </div>

      {/* Full-sample correlation table */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1' }}>
            {tableWin === null ? 'Full-Sample' : 'Custom Window'} Correlations
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {(['full', 'custom'] as const).map(mode => {
              const active = mode === 'full' ? tableWin === null : tableWin !== null
              return (
                <button key={mode}
                  onClick={() => {
                    if (mode === 'full') setTableWin(null)
                    else setTableWin(tableWinDraft)
                  }}
                  style={{
                    padding: '2px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                    border: `1px solid ${active ? 'rgba(134,192,222,0.6)' : 'rgba(200,220,240,0.1)'}`,
                    background: active ? 'rgba(134,192,222,0.15)' : 'transparent',
                    color: active ? '#bfe0ef' : '#9aa5b1',
                    textTransform: 'capitalize',
                  }}>{mode}
                </button>
              )
            })}
            {tableWin !== null && (
              <>
                <input type="date" value={tableWinDraft.start}
                  onChange={e => {
                    const next = { ...tableWinDraft, start: e.target.value }
                    setTableWinDraft(next); setTableWin(next)
                  }}
                  style={{ padding: '2px 6px', borderRadius: 6, fontSize: 11,
                    border: '1px solid rgba(200,220,240,0.15)', background: '#0b0f14',
                    color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }} />
                <span style={{ fontSize: 11, color: '#8995a2' }}>→</span>
                <input type="date" value={tableWinDraft.end}
                  onChange={e => {
                    const next = { ...tableWinDraft, end: e.target.value }
                    setTableWinDraft(next); setTableWin(next)
                  }}
                  style={{ padding: '2px 6px', borderRadius: 6, fontSize: 11,
                    border: '1px solid rgba(200,220,240,0.15)', background: '#0b0f14',
                    color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }} />
              </>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
          Pearson correlation over{tableWin === null ? ' the full estimation window' : ` ${tableWin.start} → ${tableWin.end}`} · {fullCorrs[0]?.n ?? 0} obs
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ padding: '6px 14px', textAlign: 'left', color: '#8995a2', fontWeight: 500,
                borderBottom: '1px solid rgba(200,220,240,0.07)', fontSize: 11 }}>Variable</th>
              {['F1', 'F2', 'F3'].map((fk, fi) => (
                <th key={fk} style={{ padding: '6px 14px', textAlign: 'center',
                  color: factorColors[fi], fontWeight: 600,
                  borderBottom: '1px solid rgba(200,220,240,0.07)', fontSize: 11 }}>
                  {fk} — {factorLabels[fi] ?? fk}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fullCorrs.filter(c => activeVars.has(c.ticker)).map(c => (
              <tr key={c.ticker}>
                <td style={{ padding: '7px 14px', color: '#e4eaf1', fontWeight: 500,
                  borderBottom: '1px solid rgba(200,220,240,0.04)' }}>{c.label}</td>
                {c.r.map((r, fi) => {
                  const abs = Math.abs(r)
                  // Positive → green; negative → red; near zero → transparent
                  const bg = r > 0
                    ? `rgba(95,181,146,${Math.pow(abs, 0.7) * 0.8})`
                    : `rgba(217,112,94,${Math.pow(abs, 0.7) * 0.8})`
                  const textCol = abs > 0.35 ? '#eef2f6' : '#9aa5b1'
                  return (
                    <td key={fi} style={{
                      padding: '7px 14px', textAlign: 'center',
                      borderBottom: '1px solid rgba(200,220,240,0.04)',
                      background: abs < 0.08 ? 'transparent' : bg,
                      fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 12, fontWeight: 600,
                      color: textCol,
                      letterSpacing: '0.02em',
                    }}>
                      {r >= 0 ? '+' : ''}{r.toFixed(3)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {/* Legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, justifyContent: 'center' }}>
          <span style={{ fontSize: 10, color: '#d9705e' }}>−1 negative</span>
          <div style={{ width: 160, height: 10, borderRadius: 5,
            background: 'linear-gradient(to right, rgba(217,112,94,0.8), rgba(217,112,94,0.05), rgba(95,181,146,0.05), rgba(95,181,146,0.8))' }} />
          <span style={{ fontSize: 10, color: '#5fb592' }}>positive +1</span>
        </div>
      </div>

      {/* Linear regression table */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1' }}>
            {regWin === null ? 'Full-Sample' : 'Custom Window'} Linear Regression — F<sub>k</sub> = α + β · X<sub>i</sub>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {(['full', 'custom'] as const).map(mode => {
              const active = mode === 'full' ? regWin === null : regWin !== null
              return (
                <button key={mode} onClick={() => mode === 'full' ? setRegWin(null) : setRegWin(regWinDraft)}
                  style={{
                    padding: '2px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                    border: `1px solid ${active ? 'rgba(134,192,222,0.6)' : 'rgba(200,220,240,0.1)'}`,
                    background: active ? 'rgba(134,192,222,0.15)' : 'transparent',
                    color: active ? '#bfe0ef' : '#9aa5b1', textTransform: 'capitalize',
                  }}>{mode}
                </button>
              )
            })}
            {regWin !== null && (
              <>
                <input type="date" value={regWinDraft.start}
                  onChange={e => { const n = { ...regWinDraft, start: e.target.value }; setRegWinDraft(n); setRegWin(n) }}
                  style={{ padding: '2px 6px', borderRadius: 6, fontSize: 11,
                    border: '1px solid rgba(200,220,240,0.15)', background: '#0b0f14',
                    color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }} />
                <span style={{ fontSize: 11, color: '#8995a2' }}>→</span>
                <input type="date" value={regWinDraft.end}
                  onChange={e => { const n = { ...regWinDraft, end: e.target.value }; setRegWinDraft(n); setRegWin(n) }}
                  style={{ padding: '2px 6px', borderRadius: 6, fontSize: 11,
                    border: '1px solid rgba(200,220,240,0.15)', background: '#0b0f14',
                    color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }} />
              </>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
          OLS slope (β) and t-statistic over{regWin === null ? ' the full estimation window' : ` ${regWin.start} → ${regWin.end}`} · {regressionResults[0]?.n ?? 0} obs
          &ensp;·&ensp;<span style={{ color: '#dfbb78' }}>*</span> |t|&gt;1.96 &ensp;<span style={{ color: '#d6ad66' }}>**</span> |t|&gt;2.58 &ensp;<span style={{ color: '#d9705e' }}>***</span> |t|&gt;3.29
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ padding: '6px 14px', textAlign: 'left', color: '#8995a2', fontWeight: 500,
                borderBottom: '1px solid rgba(200,220,240,0.07)', fontSize: 11 }}>Variable (X)</th>
              {['F1', 'F2', 'F3'].map((fk, fi) => (
                <th key={fk} style={{ padding: '6px 14px', textAlign: 'center',
                  color: factorColors[fi], fontWeight: 600,
                  borderBottom: '1px solid rgba(200,220,240,0.07)', fontSize: 11 }}>
                  {fk} — {factorLabels[fi] ?? fk}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {regressionResults.filter(c => activeVars.has(c.ticker)).map(c => (
              <tr key={c.ticker}>
                <td style={{ padding: '7px 14px', color: '#e4eaf1', fontWeight: 500,
                  borderBottom: '1px solid rgba(200,220,240,0.04)' }}>{c.label}</td>
                {c.ols.map(({ beta, tStat }, fi) => {
                  const sig = Math.abs(tStat) > 3.29 ? '***' : Math.abs(tStat) > 2.58 ? '**' : Math.abs(tStat) > 1.96 ? '*' : ''
                  const sigColor = sig === '***' ? '#d9705e' : sig === '**' ? '#d6ad66' : sig === '*' ? '#dfbb78' : '#8995a2'
                  return (
                    <td key={fi} style={{
                      padding: '7px 14px', textAlign: 'center',
                      borderBottom: '1px solid rgba(200,220,240,0.04)',
                      fontFamily: "'Geist Mono', ui-monospace, monospace",
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: beta >= 0 ? '#e4eaf1' : '#c6ced8' }}>
                        {beta >= 0 ? '+' : ''}{beta.toFixed(4)}
                        {sig && <span style={{ color: sigColor, marginLeft: 3, fontSize: 11 }}>{sig}</span>}
                      </div>
                      <div style={{ fontSize: 10, color: Math.abs(tStat) >= 1.96 ? sigColor : '#8995a2', marginTop: 1 }}>
                        t = {tStat >= 0 ? '+' : ''}{tStat.toFixed(2)}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Scatter plots: each active variable vs each factor */}
      {regSliced.filter(a => activeVars.has(a.ticker) && a.vals.length >= 3).map(a => {
        const regRes = regressionResults.find(r => r.ticker === a.ticker)
        if (!regRes) return null
        const fArrays = [a.f1s, a.f2s, a.f3s]
        const vi = extVars.findIndex(e => e.ticker === a.ticker)
        const varColor = EXT_VAR_COLORS[vi % EXT_VAR_COLORS.length]
        const xMin = Math.min(...a.vals), xMax = Math.max(...a.vals)
        return (
          <div key={a.ticker} style={cardStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>
              {a.label} — scatter vs factors
            </div>
            <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
              {a.vals.length} obs · OLS line · same window as regression table
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
              {[0, 1, 2].map(fi => {
                const { beta, alpha, r2, tStat } = regRes.ols[fi]
                const sig = Math.abs(tStat) > 3.29 ? '***' : Math.abs(tStat) > 2.58 ? '**' : Math.abs(tStat) > 1.96 ? '*' : ''
                const sigColor = sig === '***' ? '#d9705e' : sig === '**' ? '#d6ad66' : '#dfbb78'
                const dots = a.vals.map((v, i) => ({ x: v, y: fArrays[fi][i] }))
                const regLine = [
                  { x: xMin, y: beta * xMin + alpha },
                  { x: xMax, y: beta * xMax + alpha },
                ]
                return (
                  <div key={fi}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: factorColors[fi], marginBottom: 2 }}>
                      F{fi + 1} ({factorLabels[fi] ?? `F${fi + 1}`})
                    </div>
                    <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 6, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                      β = {beta >= 0 ? '+' : ''}{beta.toFixed(4)}
                      {sig && <span style={{ color: sigColor, marginLeft: 3 }}>{sig}</span>}
                      {' '}· R² = {r2.toFixed(3)}
                    </div>
                    <ResponsiveContainer width="100%" height={180}>
                      <ScatterChart margin={{ top: 4, right: 8, bottom: 24, left: 36 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
                        <XAxis type="number" dataKey="x" domain={['auto', 'auto']}
                          tick={{ fill: '#9aa5b1', fontSize: 9 }}
                          tickFormatter={(v: number) => v.toFixed(2)}
                          label={{ value: a.label, position: 'insideBottom', offset: -12, fill: '#9aa5b1', fontSize: 9 }} />
                        <YAxis type="number" dataKey="y" domain={['auto', 'auto']}
                          tick={{ fill: '#9aa5b1', fontSize: 9 }}
                          tickFormatter={(v: number) => v.toFixed(2)} />
                        <Tooltip
                          contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                          labelStyle={{ display: 'none' }}
                          formatter={(v: number, name: string) => [v.toFixed(4), name === 'x' ? a.label : `F${fi + 1}`]}
                        />
                        <Scatter data={dots.slice(0, -1)} fill={varColor} opacity={0.45} r={3} />
                        <Scatter data={regLine} fill="none" r={0}
                          line={{ stroke: '#c6ced8', strokeWidth: 1.5, strokeDasharray: '4 3' }} />
                        {dots.length > 0 && (
                          <Scatter data={dots.slice(-1)} fill="#f4f7fa" opacity={1} r={5} />
                        )}
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* Time-series line plots: each active variable vs each factor (z-scored) */}
      {aligned.filter(a => activeVars.has(a.ticker) && a.vals.length >= 3).map(a => {
        const vi = extVars.findIndex(e => e.ticker === a.ticker)
        const varColor = EXT_VAR_COLORS[vi % EXT_VAR_COLORS.length]

        const zScore = (arr: number[]) => {
          const mean = arr.reduce((s, v) => s + v, 0) / arr.length
          const std = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length) || 1
          return arr.map(v => parseFloat(((v - mean) / std).toFixed(3)))
        }
        const zVals = zScore(a.vals)
        const zF = [zScore(a.f1s), zScore(a.f2s), zScore(a.f3s)]
        const chartData = a.dates.map((d, i) => ({
          date: d.slice(0, 7),
          variable: zVals[i],
          f1: zF[0][i], f2: zF[1][i], f3: zF[2][i],
        }))
        const interval = Math.max(1, Math.floor(chartData.length / 8))

        return (
          <div key={`ts-${a.ticker}`} style={cardStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>
              {a.label} — time series vs factors
            </div>
            <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
              Both series z-scored to a common scale · {a.vals.length} obs ·
              <span style={{ color: varColor }}> ── {a.label}</span>
              {'  '}
              {[0, 1, 2].map(fi => (
                <span key={fi} style={{ color: factorColors[fi], marginRight: 8 }}>
                  {' -- '}F{fi + 1}
                </span>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
              {[0, 1, 2].map(fi => {
                const ols = simpleOLS(zVals, zF[fi])
                const residData = a.dates.map((d, i) => ({
                  date: d.slice(0, 7),
                  residual: parseFloat((zF[fi][i] - (ols.alpha + ols.beta * zVals[i])).toFixed(4)),
                }))
                return (
                  <div key={fi}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: factorColors[fi], marginBottom: 8 }}>
                      F{fi + 1} ({factorLabels[fi] ?? `F${fi + 1}`})
                    </div>
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
                        <XAxis dataKey="date" tick={false} height={0} />
                        <YAxis width={36} tick={{ fill: '#9aa5b1', fontSize: 9 }}
                          tickFormatter={(v: number) => v.toFixed(1)} />
                        <Tooltip
                          contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                          labelStyle={{ color: '#c6ced8', fontSize: 10 }}
                          formatter={(v: number, name: string) => [v.toFixed(3), name === 'variable' ? a.label : `F${fi + 1}`]}
                        />
                        <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" strokeDasharray="3 3" />
                        <Line type="monotone" dataKey="variable" name={a.label}
                          stroke={varColor} strokeWidth={1.5} dot={false} connectNulls={false} />
                        <Line type="monotone" dataKey={`f${fi + 1}`} name={`F${fi + 1}`}
                          stroke={factorColors[fi]} strokeWidth={1.5} dot={false}
                          connectNulls={false} strokeDasharray="4 2" />
                      </LineChart>
                    </ResponsiveContainer>

                    {/* Residual panel */}
                    <div style={{ fontSize: 9, color: '#77828f', marginTop: 2, marginBottom: 2, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                      ε = F{fi + 1} − (α + β·X) &nbsp;·&nbsp; R² = {ols.r2.toFixed(3)}
                    </div>
                    <ResponsiveContainer width="100%" height={140}>
                      <ComposedChart data={residData} margin={{ top: 2, right: 8, bottom: 16, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
                        <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 7 }} interval={interval}
                          tickFormatter={(d: string) => d.slice(0, 7)} />
                        <YAxis width={36} tick={{ fill: '#9aa5b1', fontSize: 8 }}
                          tickFormatter={(v: number) => v.toFixed(1)} />
                        <Tooltip
                          contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                          labelStyle={{ color: '#c6ced8', fontSize: 10 }}
                          formatter={(v: number) => [v.toFixed(4), 'Residual']}
                        />
                        <ReferenceLine y={0} stroke="rgba(200,220,240,0.25)" />
                        <Area type="monotone" dataKey="residual" stroke={factorColors[fi]}
                          fill={factorColors[fi]} fillOpacity={0.15} strokeWidth={1} dot={false} connectNulls={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* Rolling correlation charts — one per factor */}
      {[0, 1, 2].map(fi => {
        const activeList = extVars.filter(ev => activeVars.has(ev.ticker))
        // Trim leading rows where all active series are still null (burn-in period)
        const raw = rollingData[fi]
        const firstValid = raw.findIndex(pt => activeList.some(ev => pt[ev.ticker] !== null))
        const chartData = firstValid > 0 ? raw.slice(firstValid) : raw
        if (chartData.length === 0) return null
        return (
          <div key={fi} style={cardStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, color: factorColors[fi], marginBottom: 4 }}>
              Rolling Correlations with F{fi + 1} ({factorLabels[fi] ?? `F${fi + 1}`})
            </div>
            <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 12 }}>
              {rollWin}-week rolling Pearson correlation
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData} margin={{ top: 8, right: 20, bottom: 20, left: 44 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
                <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }} interval="preserveStartEnd" />
                <YAxis domain={[-1, 1]} tick={{ fill: '#9aa5b1', fontSize: 10 }}
                  tickFormatter={v => v.toFixed(1)} />
                <Tooltip content={<SimpleTooltip />} />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" strokeDasharray="4 4" />
                <ReferenceLine y={0.5}  stroke="rgba(200,220,240,0.07)" strokeDasharray="2 2" />
                <ReferenceLine y={-0.5} stroke="rgba(200,220,240,0.07)" strokeDasharray="2 2" />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8, cursor: 'pointer' }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onClick={(e: any) => {
                    const ticker = String(e.dataKey ?? '')
                    if (!ticker) return
                    setActiveVars(prev => {
                      const next = new Set(prev)
                      if (next.has(ticker)) { if (next.size > 1) next.delete(ticker) }
                      else next.add(ticker)
                      return next
                    })
                  }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: string, entry: any) => (
                    <span style={{ color: activeVars.has(String(entry.dataKey ?? '')) ? '#e4eaf1' : '#2a333d' }}>
                      {value}
                    </span>
                  )}
                />
                {activeList.map((ev) => {
                  const vi = extVars.findIndex(e => e.ticker === ev.ticker)
                  return (
                    <Line key={ev.ticker} type="monotone" dataKey={ev.ticker}
                      name={ev.label} stroke={EXT_VAR_COLORS[vi % EXT_VAR_COLORS.length]}
                      dot={false} strokeWidth={1.5} connectNulls={false} />
                  )
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )
      })}
    </div>
  )
}

function FactorStructureTab({ data }: { data: PCAResponse }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <div className="hub-frame" style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 16 }}>Eigenvalues — Variance Explained</div>
          <EigenvalueChart eigenvalues={data.eigenvalues} />
        </div>
        <div className="hub-frame" style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 16 }}>Eigenvectors (Factor Loadings)</div>
          <EigenvectorChart eigenvectors={data.eigenvectors} tenors={data.tenors} pcaData={data} />
        </div>
      </div>
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>Yield Correlation Matrix</div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
          Pairwise correlations of yield levels across tenors over the lookback window
        </div>
        <CorrelationHeatmap matrix={data.correlation_matrix ?? {}} tenors={data.tenors ?? []} pcaData={data} />
      </div>
      <ClusterAnalysis data={data} />
    </div>
  )
}

// ─── Tab 2: Factor Dynamics ───────────────────────────────────────────────────

function FactorCard({ fk, label, color, history, ouParams }: {
  fk: 'f1' | 'f2' | 'f3'
  label: string
  color: string
  history: { date: string; f1: number; f2: number; f3: number }[]
  ouParams: OUParams
}) {
  const data = (history ?? []).map(d => ({ date: d.date.slice(0, 7), value: d[fk] }))
  const values = data.map(d => d.value)
  const yMin = Math.min(...values)
  const yMax = Math.max(...values)
  const pad = (yMax - yMin) * 0.1 || 5
  const z = ouParams.zscore

  return (
    <div className="hub-frame" style={{ ...cardStyle, flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color }}>
          {fk.toUpperCase()} — {label}
        </div>
        <span style={zscoreBadge(z)}>{fmtZ(z)}</span>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ top: 6, right: 12, bottom: 6, left: 36 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
          <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }} interval="preserveStartEnd" />
          <YAxis domain={[yMin - pad, yMax + pad]} tick={{ fill: '#9aa5b1', fontSize: 10 }}
            tickFormatter={v => v.toFixed(0)} />
          <Tooltip content={<SimpleTooltip />} />
          <ReferenceLine y={ouParams.mu} stroke="rgba(200,220,240,0.25)" strokeDasharray="4 4"
            label={{ value: 'μ', position: 'right', fill: '#9aa5b1', fontSize: 10 }} />
          <Line type="monotone" dataKey="value" name={label} stroke={color} dot={false} strokeWidth={1.5} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function OUForecastChart({ fk, label, color, history, ouParams, forecasts }: {
  fk: 'f1' | 'f2' | 'f3'
  label: string
  color: string
  history: { date: string; f1: number; f2: number; f3: number }[]
  ouParams: OUParams
  forecasts: OUForecastPoint[]
}) {
  const last24 = history.slice(-24)
  const currentValue = ouParams.current

  const chartData = [
    ...last24.map(d => ({
      label: d.date.slice(0, 7),
      hist: d[fk],
      mean: null as number | null,
      upper_1s: null as number | null,
      lower_1s: null as number | null,
      upper_2s: null as number | null,
      lower_2s: null as number | null,
    })),
    ...forecasts.map(pt => ({
      label: `+${pt.week}w`,
      hist: pt.week === 0 ? currentValue : (null as number | null),
      mean: pt.mean,
      upper_1s: pt.upper_1s,
      lower_1s: pt.lower_1s,
      upper_2s: pt.upper_2s,
      lower_2s: pt.lower_2s,
    })),
  ]

  const allVals = chartData.flatMap(d =>
    [d.hist, d.upper_2s, d.lower_2s].filter((v): v is number => v !== null)
  )
  const yMin = Math.min(...allVals)
  const yMax = Math.max(...allVals)
  const pad = (yMax - yMin) * 0.08 || 5

  const expectedProfit = ouParams.mu - ouParams.current

  return (
    <div className="hub-frame" style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color }}>
          OU Forecast — {fk.toUpperCase()} ({label})
        </div>
        <span style={zscoreBadge(ouParams.zscore)}>{fmtZ(ouParams.zscore)}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 20 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#8995a2' }}>Expected profit</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: expectedProfit > 0 ? CHEAP_COLOR : RICH_COLOR, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
              {expectedProfit > 0 ? '+' : ''}{expectedProfit.toFixed(1)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#8995a2' }}>Half-life</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
              {ouParams.half_life_weeks.toFixed(1)}w
            </div>
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 20, bottom: 20, left: 44 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
          <XAxis dataKey="label" tick={{ fill: '#9aa5b1', fontSize: 9 }} interval={Math.floor(chartData.length / 8)} />
          <YAxis domain={[yMin - pad, yMax + pad]} tick={{ fill: '#9aa5b1', fontSize: 10 }}
            tickFormatter={v => v.toFixed(0)} />
          <Tooltip content={<SimpleTooltip />} />
          <ReferenceLine y={ouParams.mu} stroke="rgba(200,220,240,0.25)" strokeDasharray="4 4"
            label={{ value: 'μ', position: 'right', fill: '#9aa5b1', fontSize: 10 }} />
          <Area type="monotone" dataKey="upper_2s" stroke="none"
            fill={color} fillOpacity={0.06} name="±2σ upper" legendType="none" />
          <Area type="monotone" dataKey="lower_2s" stroke="none"
            fill={color} fillOpacity={0.06} name="±2σ lower" legendType="none" />
          <Area type="monotone" dataKey="upper_1s" stroke="none"
            fill={color} fillOpacity={0.1} name="±1σ upper" legendType="none" />
          <Area type="monotone" dataKey="lower_1s" stroke="none"
            fill={color} fillOpacity={0.1} name="±1σ lower" legendType="none" />
          <Line type="monotone" dataKey="hist" name="Historical" stroke={color}
            dot={false} strokeWidth={2} connectNulls={false} />
          <Line type="monotone" dataKey="mean" name="OU Forecast" stroke={color}
            dot={false} strokeWidth={1.5} strokeDasharray="5 3" connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function FactorDynamicsTab({ data }: { data: PCAResponse }) {
  const fKeys: ('f1' | 'f2' | 'f3')[] = ['f1', 'f2', 'f3']
  const labels = (data.eigenvectors ?? []).slice(0, 3).map(ev => ev.label)
  const colors = [F1_COLOR, F2_COLOR, F3_COLOR]
  const [selectedFk, setSelectedFk] = useState<'f1' | 'f2' | 'f3' | null>(null)

  if (!data.ou_params || !data.ou_forecasts || !data.factor_history) {
    return (
      <div style={{ padding: 40, color: '#8995a2', textAlign: 'center' }}>
        OU parameters not available in this response.
      </div>
    )
  }

  // Factor for the OU forecast: user-selected, defaulting to highest |z-score|
  const zScores = fKeys.map(fk => Math.abs(data.ou_params[fk]?.zscore ?? 0))
  const maxZIdx = zScores.indexOf(Math.max(...zScores))
  const highlightFk = selectedFk ?? fKeys[maxZIdx]
  const highlightIdx = fKeys.indexOf(highlightFk)

  const thStyle: React.CSSProperties = {
    padding: '7px 10px', textAlign: 'right', fontSize: 11, color: '#8995a2',
    fontWeight: 500, borderBottom: '1px solid rgba(200,220,240,0.07)',
  }
  const tdStyle: React.CSSProperties = {
    padding: '6px 10px', textAlign: 'right', fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace",
    borderBottom: '1px solid rgba(200,220,240,0.04)',
  }

  return (
    <div>
      {/* 3 factor mini-charts */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 0, flexWrap: 'wrap' }}>
        {fKeys.map((fk, i) => (
          <FactorCard key={fk} fk={fk} label={labels[i] ?? fk.toUpperCase()} color={colors[i]}
            history={data.factor_history} ouParams={data.ou_params[fk]} />
        ))}
      </div>

      {/* OU Parameters Table */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 14 }}>OU Parameters</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                {['Factor', 'Label', 'μ (mean)', 'θ (speed/wk)', 'Half-life', 'Current', 'Z-score'].map(h => (
                  <th key={h} style={{ ...thStyle, ...(h === 'Factor' || h === 'Label' ? { textAlign: 'left' } : {}) }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fKeys.map((fk, i) => {
                const p = data.ou_params[fk]
                return (
                  <tr key={fk}>
                    <td style={{ ...tdStyle, textAlign: 'left', color: colors[i], fontWeight: 600 }}>{fk.toUpperCase()}</td>
                    <td style={{ ...tdStyle, textAlign: 'left', color: '#c6ced8' }}>{labels[i]}</td>
                    <td style={tdStyle}>{p.mu.toFixed(2)}</td>
                    <td style={tdStyle}>{p.theta.toFixed(4)}</td>
                    <td style={tdStyle}>{p.half_life_weeks.toFixed(1)}w</td>
                    <td style={tdStyle}>{p.current.toFixed(2)}</td>
                    <td style={{ ...tdStyle, color: zscoreColor(p.zscore), fontWeight: 600 }}>{fmtZ(p.zscore)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* OU Forecast — factor selectable, defaults to highest |z| */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 12px' }}>
        <span style={{ fontSize: 12, color: '#9aa5b1' }}>Model factor as OU:</span>
        {fKeys.map((fk, i) => {
          const active = fk === highlightFk
          return (
            <button key={fk} onClick={() => setSelectedFk(fk)}
              style={{
                background: active ? `${colors[i]}33` : 'rgba(200,220,240,0.04)',
                border: `1px solid ${active ? colors[i] : 'rgba(200,220,240,0.1)'}`,
                color: active ? colors[i] : '#c6ced8',
                borderRadius: 6, padding: '5px 14px', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', fontFamily: "'Geist Mono', ui-monospace, monospace",
              }}>
              {fk.toUpperCase()} — {labels[i] ?? ''}
            </button>
          )
        })}
        {selectedFk === null && (
          <span style={{ fontSize: 11, color: '#8995a2' }}>(auto: highest |z|)</span>
        )}
      </div>
      <OUForecastChart
        fk={highlightFk}
        label={labels[highlightIdx] ?? highlightFk.toUpperCase()}
        color={colors[highlightIdx]}
        history={data.factor_history}
        ouParams={data.ou_params[highlightFk]}
        forecasts={data.ou_forecasts[highlightFk]}
      />
    </div>
  )
}

// ─── Mean-reversion model helpers ────────────────────────────────────────────

// OLS without added intercept: β = (X'X)^{-1} X'y, X cols already include any constant
function rawOLS(cols: number[][], y: number[]): number[] | null {
  const k = cols[0]?.length ?? 0
  const n = y.length
  if (n < k + 1 || k === 0) return null
  const XtX: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => cols.reduce((s, row) => s + row[i] * row[j], 0))
  )
  const Xty: number[] = Array.from({ length: k }, (_, i) =>
    cols.reduce((s, row, t) => s + row[i] * y[t], 0)
  )
  return gaussianElim(XtX, Xty)
}

// Find root of f(x)=0 nearest to xMean by bisection over a ±4σ grid
function nearestRoot(f: (x: number) => number, xMean: number, xStd: number): number {
  const lo = xMean - 4 * xStd, hi = xMean + 4 * xStd
  const steps = 2000
  const dx = (hi - lo) / steps
  let bestRoot = xMean, bestDist = Infinity
  for (let i = 0; i < steps; i++) {
    const xa = lo + i * dx, xb = xa + dx
    const fa = f(xa), fb = f(xb)
    if (fa * fb <= 0) {
      let l = xa, r = xb
      for (let j = 0; j < 60; j++) {
        const mid = (l + r) / 2
        if (f(mid) * f(l) <= 0) r = mid; else l = mid
      }
      const root = (l + r) / 2
      const dist = Math.abs(root - xMean)
      if (dist < bestDist) { bestDist = dist; bestRoot = root }
    }
  }
  return bestRoot
}

interface MRFit {
  kind: 'ou' | 'poly' | 'invpoly'
  mu: number; halfLife: number; sigma: number; sigmaInf: number
  zscore: number; driftAtCurrent: number
  theta?: number; coefs?: number[]
}

function fitMRModel(series: number[], kind: 'ou' | 'poly' | 'invpoly'): MRFit | null {
  if (series.length < 10) return null
  const n = series.length
  const current = series[n - 1]
  const xMean = series.reduce((s, v) => s + v, 0) / n
  const xStd = Math.sqrt(series.reduce((s, v) => s + (v - xMean) ** 2, 0) / n) || 1
  const dx = series.slice(1).map((v, i) => v - series[i])
  const xi = series.slice(0, n - 1)

  if (kind === 'ou') {
    const { mu, theta, sigma, halfLifeWeeks } = fitOU(series)
    const sigmaInf = theta > 0 ? sigma / Math.sqrt(2 * theta) : sigma
    return { kind: 'ou', mu, halfLife: halfLifeWeeks, sigma, sigmaInf,
      zscore: (current - mu) / (sigmaInf || 1), driftAtCurrent: theta * (mu - current), theta }
  }

  if (kind === 'poly') {
    // dx = a + b*x + c*x^2 + d*x^3  (multiOLS adds intercept → a=alpha, [b,c,d]=weights)
    const design = xi.map(v => [v, v * v, v * v * v])
    const fit = multiOLS(design, dx)
    const [b, c, d] = fit.weights; const a = fit.alpha
    const f = (x: number) => a + b * x + c * x * x + d * x * x * x
    const mu = nearestRoot(f, xMean, xStd)
    const kappa = -(b + 2 * c * mu + 3 * d * mu * mu)
    const halfLife = kappa > 0 ? Math.log(2) / kappa : Infinity
    const sigmaResid = Math.sqrt(dx.reduce((s, v, i) => s + (v - f(xi[i])) ** 2, 0) / dx.length)
    const sigmaInf = kappa > 0 ? sigmaResid / Math.sqrt(2 * kappa) : sigmaResid * 10
    return { kind: 'poly', mu, halfLife, sigma: sigmaResid, sigmaInf,
      zscore: (current - mu) / (sigmaInf || 1), driftAtCurrent: f(current), coefs: [a, b, c, d] }
  }

  // invpoly: dx = a/x + b*x + c*x^2 + d*x^3  (no constant — use rawOLS)
  const pairs = xi.map((v, i) => ({ x: v, dy: dx[i] })).filter(p => Math.abs(p.x) > 1e-8)
  if (pairs.length < 8) return null
  const cols = pairs.map(p => [1 / p.x, p.x, p.x * p.x, p.x * p.x * p.x])
  const yy = pairs.map(p => p.dy)
  const coefs = rawOLS(cols, yy)
  if (!coefs) return null
  const [a, b, c, d] = coefs
  const f = (x: number) => (Math.abs(x) < 1e-8 ? 0 : a / x) + b * x + c * x * x + d * x * x * x
  const mu = nearestRoot(f, xMean, xStd)
  const kappa = -(- a / ((mu || 1e-8) ** 2) + b + 2 * c * mu + 3 * d * mu * mu)
  const halfLife = kappa > 0 ? Math.log(2) / kappa : Infinity
  const sigmaResid = Math.sqrt(yy.reduce((s, v, i) => s + (v - f(pairs[i].x)) ** 2, 0) / yy.length)
  const sigmaInf = kappa > 0 ? sigmaResid / Math.sqrt(2 * kappa) : sigmaResid * 10
  return { kind: 'invpoly', mu, halfLife, sigma: sigmaResid, sigmaInf,
    zscore: (current - mu) / (sigmaInf || 1), driftAtCurrent: f(current), coefs: [a, b, c, d] }
}

// Closed-form OU forecast
function ouForwardPath(
  mu: number, theta: number, sigma: number, x0: number, steps: number
): { week: number; mean: number; u1: number; l1: number; u2: number; l2: number }[] {
  return Array.from({ length: steps }, (_, i) => {
    const w = i + 1
    const mean = mu + (x0 - mu) * Math.exp(-theta * w)
    const sd = Math.sqrt((sigma * sigma / (2 * theta)) * (1 - Math.exp(-2 * theta * w)))
    return { week: w, mean, u1: mean + sd, l1: mean - sd, u2: mean + 2 * sd, l2: mean - 2 * sd }
  })
}

// Euler integration forecast for nonlinear drift
function eulerForwardPath(
  driftFn: (x: number) => number, x0: number, sigma: number, steps: number
): { week: number; mean: number; u1: number; l1: number; u2: number; l2: number }[] {
  const out = []
  let x = x0
  for (let w = 1; w <= steps; w++) {
    x = x + driftFn(x)
    const sd1 = sigma * Math.sqrt(w)
    const sd2 = 2 * sd1
    out.push({ week: w, mean: x, u1: x + sd1, l1: x - sd1, u2: x + sd2, l2: x - sd2 })
  }
  return out
}

// ─── SaveTradeWidget ──────────────────────────────────────────────────────────

function SaveTradeWidget({ curveLabel, factor, direction, magnitude, legs, legParams,
  entryLevel, takeProfit, stopLoss, rr, onSave }: {
  curveLabel: string
  factor: 0 | 1 | 2
  direction: 1 | -1
  magnitude: number
  legs: number[]
  legParams: Record<number, { notional: number; bpv: number; side: 1 | -1 }>
  entryLevel: number
  takeProfit: number
  stopLoss: number
  rr: number
  onSave: (t: SavedTrade) => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [name,      setName]      = useState('')
  const [entryDate, setEntryDate] = useState(today)
  const [saved,     setSaved]     = useState(false)

  const handle = () => {
    const n = name.trim()
    if (!n) return
    onSave({ name: n, curveLabel, factor, direction, magnitude, legs, legParams,
             entryDate, entryLevel, takeProfit, stopLoss, rr })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    setName('')
  }

  const inStyle: React.CSSProperties = {
    fontSize: 11, padding: '4px 8px', borderRadius: 6,
    border: '1px solid rgba(200,220,240,0.12)', background: '#090c10',
    color: '#e4eaf1', fontFamily: "'Geist Mono', ui-monospace, monospace",
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 16,
      paddingTop: 14, borderTop: '1px solid rgba(200,220,240,0.06)', flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 3 }}>Trade name</div>
        <input value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handle()}
          placeholder="e.g. Bund fly flattener"
          style={{ ...inStyle, width: 200 }} autoFocus={false} />
      </div>
      <div>
        <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 3 }}>Entry date</div>
        <input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)}
          style={inStyle} />
      </div>
      <button onClick={handle} disabled={!name.trim()}
        style={{ fontSize: 11, fontWeight: 600, color: '#f4f7fa', marginBottom: 1,
          background: name.trim() ? 'rgba(134,192,222,0.75)' : 'rgba(139,143,216,0.2)',
          border: 'none', borderRadius: 6, padding: '6px 16px',
          cursor: name.trim() ? 'pointer' : 'not-allowed' }}>
        {saved ? '✓ Saved' : 'Save trade'}
      </button>
    </div>
  )
}

// ─── Tab 4: Trade Builder ─────────────────────────────────────────────────────

function TradeBuilderTab({ data, initialTrade, onSaveTrade }: {
  data: PCAResponse
  initialTrade?: SavedTrade | null
  onSaveTrade?: (t: SavedTrade) => void
}) {
  const tenors = data.tenors ?? []
  const N = tenors.length

  // ── Section 1 state ──────────────────────────────────────────────────────────
  const [targetFactor, setTargetFactor] = useState<0 | 1 | 2>(initialTrade?.factor ?? 0)
  const [direction, setDirection] = useState<1 | -1>(initialTrade?.direction ?? 1)
  const [magnitude, setMagnitude] = useState<number>(initialTrade?.magnitude ?? 1.0)

  // ── Section 2 state ──────────────────────────────────────────────────────────
  const [entryLevel,  setEntryLevel]  = useState<string>(initialTrade?.entryLevel  != null ? String(initialTrade.entryLevel)  : '')
  const [takeProfit,  setTakeProfit]  = useState<string>(initialTrade?.takeProfit  != null ? String(initialTrade.takeProfit)  : '')
  const [stopLoss,    setStopLoss]    = useState<string>(initialTrade?.stopLoss    != null ? String(initialTrade.stopLoss)    : '')
  const [selectedLegs, setSelectedLegs] = useState<number[]>(initialTrade?.legs ?? tenors)
  const [legParams, setLegParams] = useState<Record<number, { notional: number; bpv: number; side: 1 | -1 }>>(() => {
    if (initialTrade?.legParams) return initialTrade.legParams
    const init: Record<number, { notional: number; bpv: number; side: 1 | -1 }> = {}
    for (const t of tenors) {
      init[t] = { notional: 100, bpv: data.default_bpvs[String(t)] ?? 500, side: 1 }
    }
    return init
  })
  const [dismissedSuggestion, setDismissedSuggestion] = useState(false)
  const [usedSuggestion, setUsedSuggestion] = useState(false)
  // hedge leg pickers for neutralize
  const [hedgeLeg1, setHedgeLeg1] = useState<number>(tenors[0] ?? 0)
  const [hedgeLeg2, setHedgeLeg2] = useState<number>(tenors[Math.min(1, tenors.length - 1)] ?? 0)

  const pillStyle: React.CSSProperties = {
    background: 'rgba(200,220,240,0.04)',
    border: '1px solid rgba(200,220,240,0.08)',
    borderRadius: 6,
    padding: '8px 16px',
  }
  const inputStyle: React.CSSProperties = {
    background: '#0b0f14',
    border: '1px solid rgba(200,220,240,0.15)',
    borderRadius: 6,
    color: '#e4eaf1',
    padding: '5px 8px',
    fontSize: 12,
    fontFamily: "'Geist Mono', ui-monospace, monospace",
  }

  const FKEYS = ['f1', 'f2', 'f3'] as const
  const fKey = FKEYS[targetFactor]
  const ouP = data.ou_params[fKey]

  // ── Align yield_history + factor_history by date ─────────────────────────────
  const aligned = useMemo(() => {
    const fhMap = new Map<string, { f1: number; f2: number; f3: number }>()
    for (const pt of data.factor_history ?? []) fhMap.set(pt.date, pt)
    const rows: { date: string; yields: Record<string, number>; f1: number; f2: number; f3: number }[] = []
    for (const pt of data.yield_history ?? []) {
      const fh = fhMap.get(pt.date)
      if (!fh) continue
      if (tenors.some(t => pt.yields[String(t)] == null)) continue
      rows.push({ date: pt.date, yields: pt.yields, f1: fh.f1, f2: fh.f2, f3: fh.f3 })
    }
    return rows
  }, [data.factor_history, data.yield_history, tenors])

  // ── Section 1: Macro context — Pearson correlations with external vars ────────
  const macroContext = useMemo(() => {
    if (!data.external_vars?.length || aligned.length < 5) return []
    const fVals = aligned.map(r => r[fKey])
    const fMean = fVals.reduce((s, v) => s + v, 0) / fVals.length
    const fStd  = Math.sqrt(fVals.reduce((s, v) => s + (v - fMean) ** 2, 0) / fVals.length)
    if (fStd === 0) return []

    return (data.external_vars ?? []).map(ev => {
      // align by date
      const evMap = new Map<string, number>()
      ev.dates.forEach((d, i) => { if (ev.values[i] != null) evMap.set(d, ev.values[i] as number) })
      const pairs: [number, number][] = []
      for (const r of aligned) {
        const v = evMap.get(r.date)
        if (v != null) pairs.push([r[fKey], v])
      }
      if (pairs.length < 5) return { label: ev.label, corr: 0, current: null as number | null }
      const n = pairs.length
      const mx = pairs.reduce((s, p) => s + p[0], 0) / n
      const my = pairs.reduce((s, p) => s + p[1], 0) / n
      const num = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0)
      const denom = Math.sqrt(
        pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0) *
        pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0)
      )
      const corr = denom === 0 ? 0 : num / denom
      const lastNonNull = [...ev.values].reverse().find(v => v != null) ?? null
      return { label: ev.label, corr, current: lastNonNull as number | null }
    })
      .sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr))
      .slice(0, 3)
  }, [aligned, fKey, data.external_vars])

  // ── Section 2: Auto-suggest — exhaustive subset search (IS/OOS, max 3 legs) ──
  const suggestion = useMemo(() => {
    if (N === 0 || N > 12 || aligned.length < 10) return null
    const trainN = Math.floor(aligned.length * 0.8)
    const train = aligned.slice(0, trainN)
    const test  = aligned.slice(trainN)
    const targetTrain = train.map(r => r[fKey])
    const targetTest  = test.map(r => r[fKey])

    let bestIS = -Infinity
    let bestResult: { tenorSubset: number[]; isR2: number; oosR2: number } | null = null

    const limit = 1 << N
    for (let mask = 1; mask < limit; mask++) {
      const indices: number[] = []
      for (let i = 0; i < N; i++) if (mask & (1 << i)) indices.push(i)
      if (indices.length > 3) continue
      const X = train.map(r => indices.map(i => r.yields[String(tenors[i])]))
      const { r2, weights, alpha } = multiOLS(X, targetTrain)
      if (r2 <= bestIS) continue
      // compute OOS R²
      let oosR2 = 0
      if (targetTest.length >= 2) {
        const yhat = test.map(r => alpha + indices.reduce((s, idx, j) => s + weights[j] * r.yields[String(tenors[idx])], 0))
        const testMean = targetTest.reduce((s, v) => s + v, 0) / targetTest.length
        const ss_res = targetTest.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0)
        const ss_tot = targetTest.reduce((s, v) => s + (v - testMean) ** 2, 0)
        oosR2 = ss_tot === 0 ? 0 : 1 - ss_res / ss_tot
      }
      bestIS = r2
      bestResult = { tenorSubset: indices.map(i => tenors[i]), isR2: r2, oosR2 }
    }
    return bestResult
  }, [aligned, fKey, N, tenors])

  // ── Section 2: Factor exposures ───────────────────────────────────────────────
  const factorExposures = useMemo(() => {
    return [0, 1, 2].map(k => {
      const ev = data.eigenvectors[k]
      if (!ev) return 0
      return selectedLegs.reduce((sum, t) => {
        const lp = legParams[t]
        if (!lp) return sum
        return sum + lp.side * lp.notional * lp.bpv * (ev.loadings[String(t)] ?? 0)
      }, 0)
    })
  }, [selectedLegs, legParams, data.eigenvectors])

  // ── Section 2: Neutralize — solve 2-equation system for hedge notionals ───────
  const neutralizeHedge = useMemo(() => {
    const nonTarget = [0, 1, 2].filter(k => k !== targetFactor)
    const [k1, k2] = nonTarget
    const ev1 = data.eigenvectors[k1]
    const ev2 = data.eigenvectors[k2]
    if (!ev1 || !ev2) return null
    const bpv1 = legParams[hedgeLeg1]?.bpv ?? (data.default_bpvs[String(hedgeLeg1)] ?? 500)
    const bpv2 = legParams[hedgeLeg2]?.bpv ?? (data.default_bpvs[String(hedgeLeg2)] ?? 500)
    const A = [
      [bpv1 * (ev1.loadings[String(hedgeLeg1)] ?? 0), bpv2 * (ev1.loadings[String(hedgeLeg2)] ?? 0)],
      [bpv1 * (ev2.loadings[String(hedgeLeg1)] ?? 0), bpv2 * (ev2.loadings[String(hedgeLeg2)] ?? 0)],
    ]
    const b = [-factorExposures[k1], -factorExposures[k2]]
    const sol = gaussianElim(A, b)
    if (!sol) return null
    return { leg1: { tenor: hedgeLeg1, notional: sol[0] }, leg2: { tenor: hedgeLeg2, notional: sol[1] } }
  }, [targetFactor, data.eigenvectors, legParams, hedgeLeg1, hedgeLeg2, factorExposures])

  // ── Section 3: Historical P&L simulation ─────────────────────────────────────
  const pnlHistory = useMemo(() => {
    if (selectedLegs.length === 0 || aligned.length < 2) return []
    return aligned.slice(1).map((curr, i) => {
      const prev = aligned[i]
      // total P&L in bp units (yield change in % → bp = *100)
      let totalPnl = 0
      for (const t of selectedLegs) {
        const lp = legParams[t]
        if (!lp) continue
        const dy = ((curr.yields[String(t)] ?? 0) - (prev.yields[String(t)] ?? 0)) * 100
        totalPnl += lp.side * lp.notional * dy
      }
      // factor attributions
      const fFactors: [number, number, number] = [
        curr.f1 - prev.f1, curr.f2 - prev.f2, curr.f3 - prev.f3,
      ]
      const pcAttrib = [0, 1, 2].map(k => {
        const ev = data.eigenvectors[k]
        if (!ev) return 0
        return selectedLegs.reduce((sum, t) => {
          const lp = legParams[t]
          if (!lp) return sum
          return sum + lp.side * lp.notional * lp.bpv * (ev.loadings[String(t)] ?? 0)
        }, 0) * fFactors[k]
      })
      const residualPnl = totalPnl - pcAttrib.reduce((s, v) => s + v, 0)
      return { date: curr.date, totalPnl, pc1: pcAttrib[0], pc2: pcAttrib[1], pc3: pcAttrib[2], residual: residualPnl }
    })
  }, [aligned, selectedLegs, legParams, data.eigenvectors])

  const cumPnlData = useMemo(() => {
    let cumTotal = 0, cumPc1 = 0, cumPc2 = 0, cumPc3 = 0, cumResid = 0
    return pnlHistory.map(row => {
      cumTotal += row.totalPnl
      cumPc1   += row.pc1
      cumPc2   += row.pc2
      cumPc3   += row.pc3
      cumResid += row.residual
      return { date: row.date.slice(0, 7), cumTotal, cumPc1, cumPc2, cumPc3, cumResid }
    })
  }, [pnlHistory])

  const pnlStats = useMemo(() => {
    if (pnlHistory.length < 4) return null
    const vals = pnlHistory.map(r => r.totalPnl)
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length
    const std  = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
    const sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(52)
    const hitRatio = vals.filter(v => v > 0).length / vals.length
    let maxDD = 0, peak = 0, cum = 0
    for (const v of vals) {
      cum += v
      if (cum > peak) peak = cum
      const dd = peak - cum
      if (dd > maxDD) maxDD = dd
    }
    const totalReturn = vals.reduce((s, v) => s + v, 0)
    // attribution averages
    const avgPc1 = pnlHistory.reduce((s, r) => s + r.pc1, 0) / pnlHistory.length
    const avgPc2 = pnlHistory.reduce((s, r) => s + r.pc2, 0) / pnlHistory.length
    const avgPc3 = pnlHistory.reduce((s, r) => s + r.pc3, 0) / pnlHistory.length
    const avgRes = pnlHistory.reduce((s, r) => s + r.residual, 0) / pnlHistory.length
    return { sharpe, hitRatio, maxDD, totalReturn, avgPc1, avgPc2, avgPc3, avgRes }
  }, [pnlHistory])

  // ── Mean Reversion section state + memos ─────────────────────────────────────
  const [mrModel, setMrModel] = useState<'ou' | 'poly' | 'invpoly'>('ou')

  const tradeLevelSeries = useMemo(() => {
    if (selectedLegs.length === 0 || aligned.length === 0) return []
    return aligned.map(row => ({
      date: row.date,
      value: selectedLegs.reduce((sum, t) => {
        const lp = legParams[t]; if (!lp) return sum
        return sum + lp.side * lp.notional * (row.yields[String(t)] ?? 0)
      }, 0),
    }))
  }, [aligned, selectedLegs, legParams])

  const mrFit = useMemo(() =>
    fitMRModel(tradeLevelSeries.map(d => d.value), mrModel),
  [tradeLevelSeries, mrModel])

  const mrChartData = useMemo(() => {
    const hist24 = tradeLevelSeries.slice(-24).map(d => ({
      label: d.date.slice(0, 7),
      hist: d.value, mean: null as number | null,
      u1: null as number | null, l1: null as number | null,
      u2: null as number | null, l2: null as number | null,
    }))
    if (!mrFit || tradeLevelSeries.length === 0) return hist24
    const x0 = tradeLevelSeries[tradeLevelSeries.length - 1].value
    let fwdPts: { week: number; mean: number; u1: number; l1: number; u2: number; l2: number }[]
    if (mrFit.kind === 'ou' && mrFit.theta != null) {
      fwdPts = ouForwardPath(mrFit.mu, mrFit.theta, mrFit.sigma, x0, 52)
    } else if (mrFit.coefs) {
      const [a, b, c, d] = mrFit.coefs
      const fn = mrFit.kind === 'poly'
        ? (x: number) => a + b * x + c * x * x + d * x * x * x
        : (x: number) => (Math.abs(x) < 1e-8 ? 0 : a / x) + b * x + c * x * x + d * x * x * x
      fwdPts = eulerForwardPath(fn, x0, mrFit.sigma, 52)
    } else return hist24
    const fwd = fwdPts.map((pt, i) => ({
      label: `+${pt.week}w`,
      hist: i === 0 ? x0 : null as number | null,
      mean: pt.mean, u1: pt.u1, l1: pt.l1, u2: pt.u2, l2: pt.l2,
    }))
    return [...hist24, ...fwd]
  }, [mrFit, tradeLevelSeries])

  // ── Section 4: Checklist computations ────────────────────────────────────────
  const factorStability = useMemo(() => {
    const hist = data.stability?.history
    if (!hist || hist.length < 2) return null
    // average cosine similarity of consecutive PC vectors (use pc1/pc2/pc3 fields)
    let sum = 0; let cnt = 0
    for (let i = 1; i < hist.length; i++) {
      const prev = hist[i - 1]; const curr = hist[i]
      const pc1p = prev.pc1 as number; const pc2p = prev.pc2 as number; const pc3p = prev.pc3 as number
      const pc1c = curr.pc1 as number; const pc2c = curr.pc2 as number; const pc3c = curr.pc3 as number
      const dot = pc1p * pc1c + pc2p * pc2c + pc3p * pc3c
      const normP = Math.sqrt(pc1p ** 2 + pc2p ** 2 + pc3p ** 2)
      const normC = Math.sqrt(pc1c ** 2 + pc2c ** 2 + pc3c ** 2)
      if (normP > 0 && normC > 0) { sum += Math.abs(dot / (normP * normC)); cnt++ }
    }
    return cnt > 0 ? sum / cnt : null
  }, [data.stability])

  const topMacro = macroContext[0] ?? null

  // Entry / TP / SL derived values — entry auto-computed from trade structure
  const autoEntry = tradeLevelSeries.length > 0
    ? tradeLevelSeries[tradeLevelSeries.length - 1].value : 0
  const autoTP = mrFit ? mrFit.mu : autoEntry
  // SL: 1σ against the trade direction (entry > mu → short trade → SL above entry)
  const autoSL = mrFit
    ? autoEntry + (autoEntry > mrFit.mu ? 1 : -1) * mrFit.sigma
    : autoEntry

  const entryVal = entryLevel !== '' && !isNaN(parseFloat(entryLevel)) ? parseFloat(entryLevel) : autoEntry
  const tpVal    = takeProfit !== '' && !isNaN(parseFloat(takeProfit)) ? parseFloat(takeProfit) : autoTP
  const slVal    = stopLoss   !== '' && !isNaN(parseFloat(stopLoss))   ? parseFloat(stopLoss)   : autoSL
  const tpDist   = Math.abs(tpVal - entryVal)
  const slDist   = Math.abs(slVal - entryVal)
  const rrRatio  = slDist > 1e-8 ? tpDist / slDist : 0

  // overall signal
  const overallSignal = useMemo(() => {
    const z = ouP.zscore
    const signalScore = [
      Math.abs(z) >= 1.5 ? (direction * Math.sign(z) > 0 ? 1 : -1) : 0,
      (direction === 1 ? ouP.current < ouP.mu : ouP.current > ouP.mu) ? 1 : -1,
      topMacro ? (direction * Math.sign(topMacro.corr) > 0 ? 1 : -1) : 0,
    ]
    const total = signalScore.reduce((s, v) => s + v, 0)
    if (total >= 2) return 'Bullish'
    if (total <= -2) return 'Bearish'
    return 'Mixed'
  }, [ouP, direction, topMacro])

  const factorLabels = ['PC1', 'PC2', 'PC3']
  const factorColors = [F1_COLOR, F2_COLOR, F3_COLOR]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Section 1: Factor View ──────────────────────────────────────────── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>Factor View</div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
          Select factor, direction and expected move magnitude
        </div>

        {/* Controls row */}
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 20 }}>
          {/* Factor selector */}
          <div>
            <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 6 }}>Factor</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {([0, 1, 2] as const).map(k => (
                <button key={k} onClick={() => setTargetFactor(k)}
                  style={{
                    padding: '6px 14px', borderRadius: 6, border: `1px solid ${factorColors[k]}`,
                    cursor: 'pointer', fontSize: 12, fontWeight: 600,
                    color: targetFactor === k ? '#f4f7fa' : factorColors[k],
                    background: targetFactor === k ? `${factorColors[k]}2e` : 'transparent',
                  }}>
                  {factorLabels[k]}
                </button>
              ))}
            </div>
          </div>

          {/* Direction toggle */}
          <div>
            <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 6 }}>Direction</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setDirection(1)}
                style={{
                  padding: '6px 14px', borderRadius: 6, border: `1px solid ${CHEAP_COLOR}`,
                  cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  color: direction === 1 ? '#f4f7fa' : CHEAP_COLOR,
                  background: direction === 1 ? 'rgba(95,181,146,0.18)' : 'transparent',
                }}>
                Long ▲
              </button>
              <button onClick={() => setDirection(-1)}
                style={{
                  padding: '6px 14px', borderRadius: 6, border: `1px solid ${RICH_COLOR}`,
                  cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  color: direction === -1 ? '#f4f7fa' : RICH_COLOR,
                  background: direction === -1 ? 'rgba(217,112,94,0.18)' : 'transparent',
                }}>
                Short ▼
              </button>
            </div>
          </div>

          {/* Magnitude */}
          <div>
            <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 6 }}>Expected move (z-score)</div>
            <input type="number" value={magnitude} step={0.5} min={0.1}
              onChange={e => setMagnitude(Number(e.target.value))}
              style={{ ...inputStyle, width: 80 }} />
          </div>
        </div>

        {/* Stat pills */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={pillStyle}>
            <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 3 }}>Current z-score</div>
            <div style={{ fontSize: 15, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: zscoreColor(ouP.zscore) }}>
              {fmtZ(ouP.zscore)}
            </div>
          </div>
          <div style={pillStyle}>
            <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 3 }}>OU half-life</div>
            <div style={{ fontSize: 15, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }}>
              {ouP.half_life_weeks.toFixed(1)}w
            </div>
          </div>
          <div style={pillStyle}>
            <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 3 }}>OU mean</div>
            <div style={{ fontSize: 15, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }}>
              {ouP.mu.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Macro context */}
        {macroContext.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 8 }}>Macro context</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {macroContext.map(mc => (
                <div key={mc.label} style={{ ...pillStyle, display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#c6ced8' }}>{mc.label}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace",
                    color: mc.corr >= 0 ? CHEAP_COLOR : RICH_COLOR }}>
                    {mc.corr >= 0 ? '+' : ''}{mc.corr.toFixed(2)}
                  </span>
                  {mc.current != null && (
                    <span style={{ fontSize: 11, color: '#9aa5b1', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                      {mc.current.toFixed(2)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Section 2: Trade Structure ──────────────────────────────────────── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>Trade Structure</div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
          Define the replicating portfolio. The best IS/OOS structure is pre-computed — override as needed.
        </div>

        {/* Suggestion banner */}
        {suggestion && !dismissedSuggestion && (
          <div style={{
            background: 'rgba(139,143,216,0.08)', border: '1px solid rgba(139,143,216,0.3)',
            borderRadius: 6, padding: '10px 14px', marginBottom: 16,
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 12, color: '#e4eaf1', flex: 1 }}>
              Suggested: {suggestion.tenorSubset.map(t => tLabel(t, data)).join(' · ')}
              {' '}· IS R² {suggestion.isR2.toFixed(3)}
              {' '}· OOS R² {suggestion.oosR2.toFixed(3)}
            </span>
            <button onClick={() => {
              setSelectedLegs(suggestion.tenorSubset)
              setUsedSuggestion(true)
            }}
              style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(139,143,216,0.5)',
                background: 'rgba(139,143,216,0.2)', color: '#e4eaf1', fontSize: 11, cursor: 'pointer' }}>
              Use this
            </button>
            <button onClick={() => setDismissedSuggestion(true)}
              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.1)',
                background: 'transparent', color: '#9aa5b1', fontSize: 11, cursor: 'pointer' }}>
              Dismiss
            </button>
          </div>
        )}
        {usedSuggestion && dismissedSuggestion === false && suggestion && (
          <div style={{ fontSize: 10, color: '#9aa5b1', marginBottom: 8 }}>Using suggested structure</div>
        )}

        {/* Tenor multi-select */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: '#9aa5b1', marginBottom: 8 }}>Select legs</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {tenors.map(t => {
              const active = selectedLegs.includes(t)
              return (
                <button key={t} onClick={() => setSelectedLegs(prev =>
                  active ? prev.filter(x => x !== t) : [...prev, t]
                )}
                  style={{
                    padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.15)',
                    cursor: 'pointer', fontSize: 12, fontWeight: active ? 600 : 400,
                    color: active ? '#e4eaf1' : '#9aa5b1',
                    background: active ? 'rgba(200,220,240,0.08)' : 'transparent',
                  }}>
                  {t}y
                </button>
              )
            })}
          </div>
        </div>

        {/* Per-leg params */}
        {selectedLegs.length > 0 && (
          <div style={{ overflowX: 'auto', marginBottom: 16 }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
              <thead>
                <tr>
                  {['Tenor', 'Side', 'Notional (mn)', 'BPV'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', fontSize: 11, color: '#8995a2',
                      fontWeight: 500, borderBottom: '1px solid rgba(200,220,240,0.07)',
                      textAlign: h === 'Tenor' ? 'left' : 'right' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selectedLegs.map(t => {
                  const lp = legParams[t] ?? { notional: 100, bpv: data.default_bpvs[String(t)] ?? 500, side: 1 as const }
                  return (
                    <tr key={t}>
                      <td style={{ padding: '5px 10px', fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace",
                        borderBottom: '1px solid rgba(200,220,240,0.04)' }}>
                        {t}y
                      </td>
                      <td style={{ padding: '5px 10px', borderBottom: '1px solid rgba(200,220,240,0.04)', textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          {([1, -1] as const).map(s => (
                            <button key={s} onClick={() => setLegParams(prev => ({
                              ...prev, [t]: { ...lp, side: s }
                            }))}
                              style={{
                                padding: '3px 8px', borderRadius: 4, border: `1px solid ${s === 1 ? CHEAP_COLOR : RICH_COLOR}`,
                                cursor: 'pointer', fontSize: 10, fontWeight: lp.side === s ? 600 : 400,
                                color: lp.side === s ? '#f4f7fa' : (s === 1 ? CHEAP_COLOR : RICH_COLOR),
                                background: lp.side === s ? (s === 1 ? 'rgba(95,181,146,0.18)' : 'rgba(217,112,94,0.18)') : 'transparent',
                              }}>
                              {s === 1 ? 'Buy' : 'Sell'}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td style={{ padding: '5px 10px', borderBottom: '1px solid rgba(200,220,240,0.04)', textAlign: 'right' }}>
                        <input type="number" value={lp.notional} step={10} min={1}
                          onChange={e => setLegParams(prev => ({ ...prev, [t]: { ...lp, notional: Number(e.target.value) } }))}
                          style={{ ...inputStyle, width: 70, textAlign: 'right' }} />
                      </td>
                      <td style={{ padding: '5px 10px', borderBottom: '1px solid rgba(200,220,240,0.04)', textAlign: 'right' }}>
                        <input type="number" value={lp.bpv} step={10} min={1}
                          onChange={e => setLegParams(prev => ({ ...prev, [t]: { ...lp, bpv: Number(e.target.value) } }))}
                          style={{ ...inputStyle, width: 70, textAlign: 'right' }} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Factor exposure table */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 8 }}>Factor exposure (DV01 units)</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[0, 1, 2].map(k => (
              <div key={k} style={{ ...pillStyle, minWidth: 100 }}>
                <div style={{ fontSize: 10, color: factorColors[k], marginBottom: 3 }}>{factorLabels[k]}</div>
                <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace",
                  color: factorExposures[k] >= 0 ? CHEAP_COLOR : RICH_COLOR }}>
                  {factorExposures[k] >= 0 ? '+' : ''}{factorExposures[k].toFixed(1)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Neutralize unwanted exposures */}
        <div>
          <div style={{ fontSize: 11, color: '#8995a2', marginBottom: 8 }}>
            Neutralize unwanted factor exposures
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: '#9aa5b1' }}>Hedge tenor 1:</span>
            <select value={hedgeLeg1} onChange={e => setHedgeLeg1(Number(e.target.value))}
              style={{ ...inputStyle, padding: '5px 8px', cursor: 'pointer' }}>
              {tenors.map(t => <option key={t} value={t}>{tLabel(t, data)}</option>)}
            </select>
            <span style={{ fontSize: 11, color: '#9aa5b1' }}>Hedge tenor 2:</span>
            <select value={hedgeLeg2} onChange={e => setHedgeLeg2(Number(e.target.value))}
              style={{ ...inputStyle, padding: '5px 8px', cursor: 'pointer' }}>
              {tenors.map(t => <option key={t} value={t}>{tLabel(t, data)}</option>)}
            </select>
          </div>
          {neutralizeHedge && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {[neutralizeHedge.leg1, neutralizeHedge.leg2].map((leg, idx) => (
                <div key={idx} style={{ ...pillStyle }}>
                  <span style={{ fontSize: 11, color: '#c6ced8' }}>{leg.tenor}y: </span>
                  <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace",
                    color: leg.notional >= 0 ? CHEAP_COLOR : RICH_COLOR }}>
                    {leg.notional >= 0 ? '+' : ''}{leg.notional.toFixed(1)} mn
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Entry / TP / SL / R:R ─────────────────────────────────────────── */}
        <div style={{ borderTop: '1px solid rgba(200,220,240,0.07)', paddingTop: 16, marginTop: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#c6ced8', marginBottom: 12 }}>
            Trade Levels (factor score)
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {/* Entry level — auto from trade structure, overridable */}
            <div>
              <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                Entry level
                <span style={{ fontSize: 9, color: '#77828f' }}>
                  (Σ side×notional×yield = {autoEntry.toFixed(4)})
                </span>
                {entryLevel !== '' && (
                  <button onClick={() => setEntryLevel('')}
                    style={{ fontSize: 9, color: '#8b8fd8', background: 'none', border: 'none',
                      cursor: 'pointer', padding: 0, lineHeight: 1 }}>↺ auto</button>
                )}
              </div>
              <input value={entryLevel} onChange={e => setEntryLevel(e.target.value)}
                placeholder={autoEntry.toFixed(4)}
                style={{ ...inputStyle, width: 110, border: '1px solid rgba(200,220,240,0.15)' }} />
            </div>
            {/* TP */}
            <div>
              <div style={{ fontSize: 10, color: '#5fb592', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                Take profit
                {takeProfit !== '' && (
                  <button onClick={() => setTakeProfit('')}
                    style={{ fontSize: 9, color: '#8b8fd8', background: 'none', border: 'none',
                      cursor: 'pointer', padding: 0, lineHeight: 1 }}>↺ auto</button>
                )}
              </div>
              <input value={takeProfit} onChange={e => setTakeProfit(e.target.value)}
                placeholder={autoTP.toFixed(4)}
                style={{ ...inputStyle, width: 110, border: '1px solid rgba(95,181,146,0.35)' }} />
            </div>
            {/* SL */}
            <div>
              <div style={{ fontSize: 10, color: '#d9705e', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                Stop loss
                {stopLoss !== '' && (
                  <button onClick={() => setStopLoss('')}
                    style={{ fontSize: 9, color: '#8b8fd8', background: 'none', border: 'none',
                      cursor: 'pointer', padding: 0, lineHeight: 1 }}>↺ auto</button>
                )}
              </div>
              <input value={stopLoss} onChange={e => setStopLoss(e.target.value)}
                placeholder={autoSL.toFixed(4)}
                style={{ ...inputStyle, width: 110, border: '1px solid rgba(217,112,94,0.35)' }} />
            </div>
            <div style={{ paddingBottom: 2 }}>
              <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 4 }}>Reward : Risk</div>
              <div style={{ fontSize: 18, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace",
                color: rrRatio >= 1.5 ? CHEAP_COLOR : rrRatio >= 1 ? '#dfbb78' : RICH_COLOR }}>
                {rrRatio.toFixed(2)}
              </div>
              <div style={{ fontSize: 10, color: '#8995a2', marginTop: 2 }}>
                TP {tpDist.toFixed(4)} / SL {slDist.toFixed(4)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Section 3: Historical P&L ───────────────────────────────────────── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 16 }}>
          Historical P&L — Factor Attribution
        </div>

        {cumPnlData.length > 1 ? (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={cumPnlData} margin={{ top: 8, right: 20, bottom: 24, left: 44 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
                <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }}
                  interval={Math.max(1, Math.floor(cumPnlData.length / 8))} />
                <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }}
                  tickFormatter={(v: number) => `${v.toFixed(0)}bp`} />
                <Tooltip
                  contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                  labelStyle={{ color: '#c6ced8', fontSize: 11 }}
                  formatter={(v: number, name: string) => [`${v.toFixed(2)}bp`, name]} />
                <Area type="monotone" dataKey="cumPc1" name="PC1" stroke={F1_COLOR}
                  fill={F1_COLOR} fillOpacity={0.15} strokeWidth={1} stackId="attr" />
                <Area type="monotone" dataKey="cumPc2" name="PC2" stroke={F2_COLOR}
                  fill={F2_COLOR} fillOpacity={0.15} strokeWidth={1} stackId="attr" />
                <Area type="monotone" dataKey="cumPc3" name="PC3" stroke={F3_COLOR}
                  fill={F3_COLOR} fillOpacity={0.15} strokeWidth={1} stackId="attr" />
                <Line type="monotone" dataKey="cumTotal" name="Total P&L" stroke="#e4eaf1"
                  dot={false} strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>

            {/* Attribution pills */}
            {pnlStats && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16, marginBottom: 16 }}>
                {[
                  { label: 'Avg PC1', value: pnlStats.avgPc1, color: F1_COLOR },
                  { label: 'Avg PC2', value: pnlStats.avgPc2, color: F2_COLOR },
                  { label: 'Avg PC3', value: pnlStats.avgPc3, color: F3_COLOR },
                  { label: 'Avg Residual', value: pnlStats.avgRes, color: '#9aa5b1' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ ...pillStyle, minWidth: 90 }}>
                    <div style={{ fontSize: 10, color, marginBottom: 3 }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace",
                      color: value >= 0 ? CHEAP_COLOR : RICH_COLOR }}>
                      {value >= 0 ? '+' : ''}{value.toFixed(2)}bp
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Stats panel */}
            {pnlStats && (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {[
                  { label: 'Sharpe (ann.)', value: pnlStats.sharpe.toFixed(2),
                    color: pnlStats.sharpe > 0.5 ? CHEAP_COLOR : pnlStats.sharpe < 0 ? RICH_COLOR : '#dfbb78' },
                  { label: 'Hit ratio', value: `${(pnlStats.hitRatio * 100).toFixed(0)}%`,
                    color: pnlStats.hitRatio > 0.55 ? CHEAP_COLOR : pnlStats.hitRatio < 0.45 ? RICH_COLOR : '#dfbb78' },
                  { label: 'Max drawdown', value: `${pnlStats.maxDD.toFixed(1)}bp`, color: RICH_COLOR },
                  { label: 'Total return', value: `${pnlStats.totalReturn >= 0 ? '+' : ''}${pnlStats.totalReturn.toFixed(1)}bp`,
                    color: pnlStats.totalReturn >= 0 ? CHEAP_COLOR : RICH_COLOR },
                ].map(({ label, value, color }) => (
                  <div key={label} style={pillStyle}>
                    <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 3 }}>{label}</div>
                    <div style={{ fontSize: 15, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color }}>{value}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: '#8995a2', padding: '20px 0' }}>
            Select legs above to simulate P&L history.
          </div>
        )}
      </div>

      {/* ── Section 3.5: Mean Reversion ─────────────────────────────────────── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>
              Mean Reversion — Trade Level
            </div>
            <div style={{ fontSize: 12, color: '#8995a2' }}>
              {mrModel === 'ou' ? 'Linear OU — closed-form Gaussian transition density'
                : mrModel === 'poly' ? 'Polynomial drift dx=(a+bx+cx²+dx³)dt — Euler forecast'
                : 'Inverse polynomial dx=(a/x+bx+cx²+dx³)dt — Euler forecast'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {([['ou', 'Linear OU'], ['poly', 'Polynomial'], ['invpoly', 'Inv. Polynomial']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setMrModel(k)}
                style={{
                  padding: '4px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                  border: `1px solid ${mrModel === k ? 'rgba(134,192,222,0.5)' : 'rgba(200,220,240,0.1)'}`,
                  background: mrModel === k ? 'rgba(134,192,222,0.18)' : 'rgba(200,220,240,0.03)',
                  color: mrModel === k ? '#bfe0ef' : '#9aa5b1', fontWeight: mrModel === k ? 600 : 400,
                }}>{l}</button>
            ))}
          </div>
        </div>

        {mrChartData.length > 0 && mrFit ? (
          <>
            {/* Stats row */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              {[
                { label: 'Est. μ*', value: mrFit.mu.toFixed(3), color: '#e4eaf1' },
                { label: 'Current',
                  value: tradeLevelSeries.length > 0 ? tradeLevelSeries[tradeLevelSeries.length - 1].value.toFixed(3) : '—',
                  color: '#e4eaf1' },
                { label: 'Z-score', value: fmtZ(mrFit.zscore), color: zscoreColor(mrFit.zscore) },
                { label: 'Half-life',
                  value: isFinite(mrFit.halfLife) ? `${mrFit.halfLife.toFixed(1)}w` : '∞',
                  color: '#e4eaf1' },
                { label: 'σ (resid)', value: mrFit.sigma.toFixed(4), color: '#c6ced8' },
                { label: 'Drift at current',
                  value: (mrFit.driftAtCurrent >= 0 ? '+' : '') + mrFit.driftAtCurrent.toFixed(4),
                  color: (mrFit.driftAtCurrent * direction > 0) ? CHEAP_COLOR : RICH_COLOR },
              ].map(({ label, value, color }) => (
                <div key={label} style={pillStyle}>
                  <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: "'Geist Mono', ui-monospace, monospace", color }}>{value}</div>
                </div>
              ))}
            </div>

            <ResponsiveContainer width="100%" height={230}>
              <ComposedChart data={mrChartData} margin={{ top: 8, right: 20, bottom: 20, left: 44 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
                <XAxis dataKey="label" tick={{ fill: '#9aa5b1', fontSize: 8 }}
                  interval={Math.max(1, Math.floor(mrChartData.length / 10))} />
                <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }} tickFormatter={v => v.toFixed(2)} />
                <Tooltip
                  contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                  labelStyle={{ color: '#c6ced8', fontSize: 10 }}
                  formatter={(v: number, name: string) => [v.toFixed(4), name]} />
                <ReferenceLine y={mrFit.mu} stroke="rgba(200,220,240,0.25)" strokeDasharray="4 4"
                  label={{ value: 'μ*', position: 'right', fill: '#9aa5b1', fontSize: 10 }} />
                {/* ±2σ band */}
                <Line type="monotone" dataKey="u2" name="+2σ" stroke="rgba(139,143,216,0.2)"
                  strokeWidth={1} dot={false} connectNulls strokeDasharray="2 3" legendType="none" />
                <Line type="monotone" dataKey="l2" name="−2σ" stroke="rgba(139,143,216,0.2)"
                  strokeWidth={1} dot={false} connectNulls strokeDasharray="2 3" legendType="none" />
                {/* ±1σ band */}
                <Line type="monotone" dataKey="u1" name="+1σ" stroke="rgba(139,143,216,0.4)"
                  strokeWidth={1} dot={false} connectNulls strokeDasharray="3 2" legendType="none" />
                <Line type="monotone" dataKey="l1" name="−1σ" stroke="rgba(139,143,216,0.4)"
                  strokeWidth={1} dot={false} connectNulls strokeDasharray="3 2" legendType="none" />
                {/* History */}
                <Line type="monotone" dataKey="hist" name="Trade level"
                  stroke={factorColor(targetFactor)} strokeWidth={2} dot={false} connectNulls={false} />
                {/* Forecast mean */}
                <Line type="monotone" dataKey="mean" name="Forecast (mean)"
                  stroke={factorColor(targetFactor)} strokeWidth={1.5} dot={false} connectNulls
                  strokeDasharray="5 3" />
              </ComposedChart>
            </ResponsiveContainer>
          </>
        ) : (
          <div style={{ fontSize: 12, color: '#8995a2', padding: '16px 0' }}>
            Select legs above to compute mean reversion.
          </div>
        )}
      </div>

      {/* ── Section 4: Entry Checklist ──────────────────────────────────────── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>Entry Checklist</div>
        <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 16 }}>
          Synthesized signals across all analytics modules
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 20 }}>
          <thead>
            <tr>
              {['Signal', 'Value', 'Status'].map(h => (
                <th key={h} style={{ padding: '6px 10px', fontSize: 11, color: '#8995a2',
                  fontWeight: 500, borderBottom: '1px solid rgba(200,220,240,0.07)',
                  textAlign: h === 'Status' ? 'center' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const z = ouP.zscore
              const absZ = Math.abs(z)
              const alignsDirection = direction * Math.sign(z) > 0
              const zStatus = absZ >= 1.5 && alignsDirection ? CHEAP_COLOR : absZ >= 1 ? '#dfbb78' : RICH_COLOR

              const ouAligns = direction === 1 ? ouP.current < ouP.mu : ouP.current > ouP.mu
              const ouStatus = ouAligns ? CHEAP_COLOR : RICH_COLOR

              const oosR2Val = suggestion?.oosR2 ?? null
              const oosStatus = oosR2Val == null ? '#9aa5b1' : oosR2Val > 0.95 ? CHEAP_COLOR : oosR2Val > 0.8 ? '#dfbb78' : RICH_COLOR

              const stabVal = factorStability
              const stabStatus = stabVal == null ? '#9aa5b1' : stabVal > 0.95 ? CHEAP_COLOR : stabVal > 0.9 ? '#dfbb78' : RICH_COLOR

              const macroStatus = topMacro == null ? '#9aa5b1'
                : direction * Math.sign(topMacro.corr) > 0 ? CHEAP_COLOR : RICH_COLOR

              const rows = [
                {
                  name: 'Factor z-score',
                  value: `${z >= 0 ? '+' : ''}${z.toFixed(2)}`,
                  status: zStatus,
                },
                {
                  name: 'OU mean-reversion',
                  value: `mean ${ouP.mu.toFixed(2)}, HL ${ouP.half_life_weeks.toFixed(1)}w`,
                  status: ouStatus,
                },
                {
                  name: 'Replication quality (OOS R²)',
                  value: oosR2Val != null ? oosR2Val.toFixed(3) : '—',
                  status: oosStatus,
                },
                {
                  name: 'Factor stability',
                  value: stabVal != null ? stabVal.toFixed(3) : '—',
                  status: stabStatus,
                },
                {
                  name: 'Macro confirmation',
                  value: topMacro != null
                    ? `${topMacro.label} (${topMacro.corr >= 0 ? '+' : ''}${topMacro.corr.toFixed(2)})`
                    : 'No data',
                  status: macroStatus,
                },
              ]

              return rows.map(row => (
                <tr key={row.name}>
                  <td style={{ padding: '7px 10px', fontSize: 12, color: '#c6ced8',
                    borderBottom: '1px solid rgba(200,220,240,0.04)' }}>{row.name}</td>
                  <td style={{ padding: '7px 10px', fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1',
                    borderBottom: '1px solid rgba(200,220,240,0.04)' }}>{row.value}</td>
                  <td style={{ padding: '7px 10px', textAlign: 'center',
                    borderBottom: '1px solid rgba(200,220,240,0.04)' }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%',
                      background: row.status, margin: '0 auto',
                      boxShadow: `0 0 6px ${row.status}` }} />
                  </td>
                </tr>
              ))
            })()}
          </tbody>
        </table>

        {/* Trade Summary */}
        <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)',
          borderRadius: 6, padding: '12px 16px', fontSize: 12, color: '#c6ced8', lineHeight: 1.7 }}>
          <span style={{ color: direction === 1 ? CHEAP_COLOR : RICH_COLOR, fontWeight: 600 }}>
            {direction === 1 ? 'Long' : 'Short'}
          </span>
          {' '}
          <span style={{ color: factorColors[targetFactor], fontWeight: 600 }}>
            {factorLabels[targetFactor]} ({data.eigenvectors[targetFactor]?.label ?? ''})
          </span>
          . Expected move: {direction > 0 ? '+' : '-'}{magnitude}σ.
          Structure: {selectedLegs.length > 0 ? selectedLegs.map(t => tLabel(t, data)).join(' · ') : '(none)'}.
          {' '}Overall signal:{' '}
          <span style={{ fontWeight: 600, color: overallSignal === 'Bullish' ? CHEAP_COLOR : overallSignal === 'Bearish' ? RICH_COLOR : '#dfbb78' }}>
            {overallSignal}
          </span>.
        </div>

        {/* Save trade */}
        {onSaveTrade && (
          <SaveTradeWidget
            curveLabel={data.curve_label}
            factor={targetFactor}
            direction={direction}
            magnitude={magnitude}
            legs={selectedLegs}
            legParams={legParams}
            entryLevel={entryVal}
            takeProfit={tpVal}
            stopLoss={slVal}
            rr={rrRatio}
            onSave={onSaveTrade}
          />
        )}
      </div>
    </div>
  )
}

// ─── Tab: Factor Replication ─────────────────────────────────────────────────

interface SubsetResult {
  indices: number[]
  weights: number[]
  alpha: number
  r2: number
  adjR2: number
  oosR2: number | null
}

function FactorReplicationTab({ data }: { data: PCAResponse }) {
  const tenors    = data.tenors ?? []
  const eigenvecs = data.eigenvectors ?? []
  const nFactors  = eigenvecs.length
  const N         = tenors.length

  const [targetFactor,  setTargetFactor]  = useState(0)
  const [maxSubsetSize, setMaxSubsetSize] = useState(Math.min(3, N))
  const [selectedIdx,   setSelectedIdx]   = useState<number | null>(null)   // rank index
  const [trainEndDate,  setTrainEndDate]  = useState<string>('')             // '' = auto (80%)

  const FACTOR_COLORS = [F1_COLOR, F2_COLOR, F3_COLOR]
  const FACTOR_LABELS = eigenvecs.map(e => e.label)

  // ── Align yield_history with factor_history by date ─────────────────────────
  const aligned = useMemo(() => {
    const fhMap = new Map<string, number[]>()
    for (const pt of data.factor_history ?? []) {
      fhMap.set(pt.date, [pt.f1, pt.f2, pt.f3])
    }
    const rows: { date: string; yields: number[]; factors: number[] }[] = []
    for (const pt of data.yield_history ?? []) {
      const fh = fhMap.get(pt.date)
      if (!fh) continue
      const yields = tenors.map(t => pt.yields[String(t)])
      if (yields.some(v => v == null)) continue
      rows.push({ date: pt.date, yields: yields as number[], factors: fh })
    }
    return rows
  }, [data.factor_history, data.yield_history, tenors])

  // ── Train / test split ───────────────────────────────────────────────────────
  const defaultTrainEnd = useMemo(() => {
    if (aligned.length < 5) return ''
    return aligned[Math.floor(aligned.length * 0.8) - 1].date
  }, [aligned])

  const effectiveTrainEnd = trainEndDate || defaultTrainEnd

  const trainAligned = useMemo(
    () => aligned.filter(r => r.date <= effectiveTrainEnd),
    [aligned, effectiveTrainEnd]
  )
  const testAligned = useMemo(
    () => aligned.filter(r => r.date > effectiveTrainEnd),
    [aligned, effectiveTrainEnd]
  )

  const targetFTrain = useMemo(() => trainAligned.map(r => r.factors[targetFactor]), [trainAligned, targetFactor])
  const YmatTrain    = useMemo(() => trainAligned.map(r => r.yields),                [trainAligned])

  // ── Enumerate all subsets up to maxSubsetSize, rank by in-sample R² ─────────
  const ranked = useMemo<SubsetResult[]>(() => {
    if (targetFTrain.length < 5 || N === 0) return []
    const targetFTest = testAligned.map(r => r.factors[targetFactor])
    const YmatTest    = testAligned.map(r => r.yields)
    const results: SubsetResult[] = []
    const limit = 1 << N
    for (let mask = 1; mask < limit; mask++) {
      const indices: number[] = []
      for (let i = 0; i < N; i++) if (mask & (1 << i)) indices.push(i)
      if (indices.length > maxSubsetSize) continue
      const X = YmatTrain.map(row => indices.map(i => row[i]))
      const { weights, alpha, r2, adjR2 } = multiOLS(X, targetFTrain)
      // OOS R²
      let oosR2: number | null = null
      if (targetFTest.length >= 2) {
        const yhat = YmatTest.map(row =>
          alpha + indices.reduce((s, idx, j) => s + weights[j] * row[idx], 0)
        )
        const meanF  = targetFTest.reduce((s, v) => s + v, 0) / targetFTest.length
        const ssTot  = targetFTest.reduce((s, v) => s + (v - meanF) ** 2, 0)
        const ssRes  = targetFTest.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0)
        oosR2 = ssTot > 0 ? 1 - ssRes / ssTot : null
      }
      results.push({ indices, weights, alpha, r2, adjR2, oosR2 })
    }
    return results.sort((a, b) => b.r2 - a.r2)
  }, [targetFTrain, YmatTrain, testAligned, targetFactor, N, maxSubsetSize])

  const displayResult: SubsetResult | null =
    selectedIdx !== null ? (ranked[selectedIdx] ?? null) : (ranked[0] ?? null)

  // ── Tracking chart: factor vs replicated portfolio (IS z-score params) ───────
  const trackingData = useMemo(() => {
    if (!displayResult || trainAligned.length === 0) return []
    // Compute IS factor values and portfolio values for z-score params
    const isF = trainAligned.map(r => r.factors[targetFactor])
    const isP = trainAligned.map(row =>
      displayResult.alpha + displayResult.indices.reduce((s, idx, j) =>
        s + displayResult.weights[j] * row.yields[idx], 0)
    )
    const meanF = isF.reduce((s, v) => s + v, 0) / isF.length
    const sdF   = Math.sqrt(isF.reduce((s, v) => s + (v - meanF) ** 2, 0) / isF.length) || 1
    const meanP = isP.reduce((s, v) => s + v, 0) / isP.length
    const sdP   = Math.sqrt(isP.reduce((s, v) => s + (v - meanP) ** 2, 0) / isP.length) || 1

    const buildPt = (row: typeof aligned[0], isOOS: boolean) => {
      const portVal = displayResult.alpha + displayResult.indices.reduce((s, idx, j) =>
        s + displayResult.weights[j] * row.yields[idx], 0)
      const zF = (row.factors[targetFactor] - meanF) / sdF
      const zP = (portVal - meanP) / sdP
      return {
        date:      row.date.slice(0, 7),
        factor:    parseFloat(zF.toFixed(4)),
        portfolio: parseFloat(zP.toFixed(4)),
        residual:  parseFloat((zF - zP).toFixed(4)),
        oos:       isOOS,
      }
    }
    return [
      ...trainAligned.map(r => buildPt(r, false)),
      ...testAligned.map(r => buildPt(r, true)),
    ]
  }, [displayResult, trainAligned, testAligned, targetFactor])

  // ── Eigenvector (theoretical optimum) weights ────────────────────────────────
  const evWeights = tenors.map(t => eigenvecs[targetFactor]?.loadings[String(t)] ?? 0)

  // ── OOS RMSE ─────────────────────────────────────────────────────────────────
  const oosStats = useMemo(() => {
    const oosPts = trackingData.filter(d => d.oos)
    if (oosPts.length === 0) return null
    const rmse = Math.sqrt(oosPts.reduce((s, d) => s + d.residual ** 2, 0) / oosPts.length)
    const meanErr = oosPts.reduce((s, d) => s + d.residual, 0) / oosPts.length
    return { rmse, meanErr, n: oosPts.length }
  }, [trackingData])

  // Split date for reference line (first OOS date)
  const splitDateLabel = testAligned.length > 0 ? testAligned[0].date.slice(0, 7) : null

  const r2Color = (r2: number) =>
    r2 > 0.95 ? CHEAP_COLOR : r2 > 0.80 ? '#dfbb78' : RICH_COLOR

  const thS: React.CSSProperties = {
    padding: '6px 12px', fontSize: 11, color: '#8995a2', fontWeight: 500,
    borderBottom: '1px solid rgba(200,220,240,0.07)', textAlign: 'left',
  }
  const tdS: React.CSSProperties = {
    padding: '6px 12px', fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace",
    borderBottom: '1px solid rgba(200,220,240,0.04)',
  }

  const displayTenors = displayResult
    ? displayResult.indices.map((idx, j) => ({ tenor: tenors[idx], weight: displayResult.weights[j] }))
    : []
  const allTenorWeights = tenors.map((t, idx) => ({
    tenor: tLabel(t, data),
    weight: displayResult ? (displayResult.indices.includes(idx)
      ? displayResult.weights[displayResult.indices.indexOf(idx)] : 0) : 0,
    ev: evWeights[idx],
  }))

  const interval = Math.max(1, Math.floor(trackingData.length / 10))

  return (
    <div>
      {/* ── Controls ── */}
      <div className="hub-frame" style={cardStyle}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Target factor */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#9aa5b1' }}>Replicate:</span>
            {Array.from({ length: nFactors }, (_, k) => (
              <button key={k} onClick={() => { setTargetFactor(k); setSelectedIdx(null) }}
                style={{
                  padding: '5px 14px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${targetFactor === k ? FACTOR_COLORS[k] + '80' : 'rgba(200,220,240,0.1)'}`,
                  background: targetFactor === k ? FACTOR_COLORS[k] + '22' : 'rgba(200,220,240,0.03)',
                  color: targetFactor === k ? FACTOR_COLORS[k] : '#9aa5b1',
                  fontWeight: targetFactor === k ? 600 : 400,
                }}>
                PC{k + 1} — {FACTOR_LABELS[k] ?? `F${k + 1}`}
              </button>
            ))}
          </div>
          {/* Max subset size */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#9aa5b1' }}>Max instruments:</span>
            {Array.from({ length: N }, (_, k) => k + 1).map(k => (
              <button key={k} onClick={() => { setMaxSubsetSize(k); setSelectedIdx(null) }}
                style={{
                  padding: '5px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${maxSubsetSize === k ? 'rgba(134,192,222,0.5)' : 'rgba(200,220,240,0.1)'}`,
                  background: maxSubsetSize === k ? 'rgba(134,192,222,0.18)' : 'rgba(200,220,240,0.03)',
                  color: maxSubsetSize === k ? '#bfe0ef' : '#9aa5b1',
                  fontWeight: maxSubsetSize === k ? 600 : 400,
                }}>
                {k}
              </button>
            ))}
          </div>
          {/* Train / test split */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <span style={{ fontSize: 12, color: '#9aa5b1' }}>Train up to:</span>
            <input
              type="date"
              value={trainEndDate || effectiveTrainEnd}
              onChange={e => { setTrainEndDate(e.target.value); setSelectedIdx(null) }}
              style={{
                background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.15)',
                borderRadius: 6, color: '#e4eaf1', fontSize: 12, padding: '4px 8px',
              }}
            />
            {trainEndDate && (
              <button onClick={() => { setTrainEndDate(''); setSelectedIdx(null) }}
                style={{ fontSize: 11, color: '#9aa5b1', background: 'none', border: 'none', cursor: 'pointer' }}>
                reset
              </button>
            )}
            <span style={{ fontSize: 11, color: '#77828f' }}>
              {trainAligned.length} IS · {testAligned.length} OOS
            </span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* ── Left: ranked table ── */}
        <div className="hub-frame" style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>
            Best Replicating Portfolios
          </div>
          <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 14 }}>
            OLS: PC{targetFactor + 1} = α + Σ wᵢ·yᵢ · ranked by R² · click a row to inspect
          </div>
          <div style={{ maxHeight: 480, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#07090c' }}>
                <tr>
                  <th style={{ ...thS, textAlign: 'center', width: 36 }}>#</th>
                  <th style={thS}>Instruments</th>
                  <th style={{ ...thS, textAlign: 'right' }}>IS R²</th>
                  <th style={{ ...thS, textAlign: 'right' }}>OOS R²</th>
                  <th style={{ ...thS, textAlign: 'right' }}>n</th>
                </tr>
              </thead>
              <tbody>
                {ranked.slice(0, 50).map((res, ri) => {
                  const isSelected = (selectedIdx ?? 0) === ri
                  return (
                    <tr key={ri} onClick={() => setSelectedIdx(ri)}
                      style={{
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(134,192,222,0.12)' : 'transparent',
                        borderLeft: isSelected ? `3px solid ${FACTOR_COLORS[targetFactor]}` : '3px solid transparent',
                      }}>
                      <td style={{ ...tdS, textAlign: 'center', color: '#8995a2' }}>{ri + 1}</td>
                      <td style={{ ...tdS, color: '#e4eaf1' }}>
                        {res.indices.map(i => tLabel(tenors[i], data)).join(' · ')}
                      </td>
                      <td style={{ ...tdS, textAlign: 'right', color: r2Color(res.r2), fontWeight: 600 }}>
                        {res.r2.toFixed(4)}
                      </td>
                      <td style={{ ...tdS, textAlign: 'right',
                        color: res.oosR2 != null ? r2Color(res.oosR2) : '#8995a2',
                        fontWeight: res.oosR2 != null ? 600 : 400 }}>
                        {res.oosR2 != null ? res.oosR2.toFixed(4) : '—'}
                      </td>
                      <td style={{ ...tdS, textAlign: 'right', color: '#8995a2' }}>
                        {res.indices.length}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Right: weight charts ── */}
        <div>
          {/* OLS weights vs eigenvector */}
          <div className="hub-frame" style={cardStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>
              Portfolio Weights
            </div>
            <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 14 }}>
              OLS weights (selected) vs eigenvector loadings (theoretical optimum)
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={allTenorWeights} margin={{ top: 4, right: 8, bottom: 8, left: 36 }} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
                <XAxis dataKey="tenor" tick={{ fill: '#9aa5b1', fontSize: 10 }} />
                <YAxis tick={{ fill: '#9aa5b1', fontSize: 9 }} tickFormatter={v => v.toFixed(2)} />
                <Tooltip
                  contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                  formatter={(v: number, name: string) => [v.toFixed(5), name]}
                />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.2)" />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="weight" name="OLS weight" maxBarSize={20}>
                  {allTenorWeights.map((d, i) => (
                    <Cell key={i} fill={d.weight >= 0 ? FACTOR_COLORS[targetFactor] : RICH_COLOR} opacity={0.8} />
                  ))}
                </Bar>
                <Bar dataKey="ev" name="Eigenvector" maxBarSize={20}>
                  {allTenorWeights.map((d, i) => (
                    <Cell key={i} fill={d.ev >= 0 ? '#c6ced8' : '#8995a2'} opacity={0.5} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Summary stats */}
          {displayResult && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
              {[
                { label: 'IS R²',    value: displayResult.r2.toFixed(4),
                  color: r2Color(displayResult.r2) },
                { label: 'OOS R²',   value: displayResult.oosR2 != null ? displayResult.oosR2.toFixed(4) : '—',
                  color: displayResult.oosR2 != null ? r2Color(displayResult.oosR2) : '#8995a2' },
                { label: 'OOS RMSE (z)', value: oosStats ? oosStats.rmse.toFixed(4) : '—',
                  color: oosStats ? (oosStats.rmse < 0.2 ? CHEAP_COLOR : oosStats.rmse < 0.5 ? '#dfbb78' : RICH_COLOR) : '#8995a2' },
                { label: 'Instruments', value: String(displayResult.indices.length), color: '#b9bdea' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ ...cardStyle, textAlign: 'center', marginBottom: 0 }}>
                  <div style={{ fontSize: 10, color: '#8995a2', marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 18, fontWeight: 600, color, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{value}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Tracking chart ── */}
      {trackingData.length > 0 && displayResult && (
        <div className="hub-frame" style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e4eaf1', marginBottom: 4 }}>
            Tracking Quality — {displayResult.indices.map(i => tLabel(tenors[i], data)).join(' · ')}
          </div>
          <div style={{ fontSize: 12, color: '#8995a2', marginBottom: 4 }}>
            Both z-scored (IS params) ·
            <span style={{ color: FACTOR_COLORS[targetFactor], marginLeft: 6 }}>── PC{targetFactor + 1} factor</span>
            <span style={{ color: '#c6ced8', marginLeft: 12 }}>-- OLS portfolio</span>
            {splitDateLabel && (
              <span style={{ color: '#8995a2', marginLeft: 12 }}>· shaded = OOS from {splitDateLabel}</span>
            )}
          </div>

          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={trackingData} margin={{ top: 4, right: 20, bottom: 4, left: 36 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.05)" />
              <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 9 }} interval={interval}
                tickFormatter={(d: string) => d.slice(0, 7)} />
              <YAxis tick={{ fill: '#9aa5b1', fontSize: 10 }} tickFormatter={v => v.toFixed(1)} />
              <Tooltip
                contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                labelStyle={{ color: '#c6ced8', fontSize: 10 }}
                formatter={(v: number, name: string) => [v.toFixed(4), name]}
              />
              {splitDateLabel && (
                <ReferenceArea x1={splitDateLabel}
                  fill="rgba(200,220,240,0.03)" stroke="rgba(200,220,240,0.15)" strokeWidth={1} />
              )}
              {splitDateLabel && (
                <ReferenceLine x={splitDateLabel} stroke="rgba(200,220,240,0.3)" strokeDasharray="4 3"
                  label={{ value: 'OOS', position: 'insideTopRight', fill: '#8995a2', fontSize: 9 }} />
              )}
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.1)" />
              <Line type="monotone" dataKey="factor" name={`PC${targetFactor + 1}`}
                stroke={FACTOR_COLORS[targetFactor]} strokeWidth={1.5} dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="portfolio" name="OLS portfolio"
                stroke="#c6ced8" strokeWidth={1.5} dot={false} connectNulls={false} strokeDasharray="4 2" />
            </ComposedChart>
          </ResponsiveContainer>

          {/* Residuals */}
          <div style={{ fontSize: 10, color: '#77828f', margin: '8px 0 4px', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
            Tracking error (factor − portfolio, z-scored) · IS RMSE: {
              (() => {
                const isPts = trackingData.filter(d => !d.oos)
                if (!isPts.length) return '—'
                return Math.sqrt(isPts.reduce((s, d) => s + d.residual ** 2, 0) / isPts.length).toFixed(4)
              })()
            } · OOS RMSE: {oosStats ? oosStats.rmse.toFixed(4) : '—'}
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <ComposedChart data={trackingData} margin={{ top: 2, right: 20, bottom: 16, left: 36 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(200,220,240,0.04)" />
              <XAxis dataKey="date" tick={{ fill: '#9aa5b1', fontSize: 8 }} interval={interval}
                tickFormatter={(d: string) => d.slice(0, 7)} />
              <YAxis tick={{ fill: '#9aa5b1', fontSize: 9 }} tickFormatter={v => v.toFixed(1)} />
              <Tooltip
                contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6 }}
                formatter={(v: number) => [v.toFixed(4), 'Tracking error']}
              />
              {splitDateLabel && (
                <ReferenceArea x1={splitDateLabel}
                  fill="rgba(200,220,240,0.03)" stroke="none" />
              )}
              {splitDateLabel && (
                <ReferenceLine x={splitDateLabel} stroke="rgba(200,220,240,0.3)" strokeDasharray="4 3" />
              )}
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.25)" />
              <Area type="monotone" dataKey="residual" name="Tracking error"
                stroke={FACTOR_COLORS[targetFactor]} fill={FACTOR_COLORS[targetFactor]}
                fillOpacity={0.15} strokeWidth={1} dot={false} connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>

          {/* OLS weight table */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#c6ced8', marginBottom: 8 }}>OLS Weights</div>
            <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['Tenor', 'OLS weight', 'Eigenvector loading', 'Ratio'].map(h => (
                    <th key={h} style={{ ...thS, textAlign: 'right', paddingRight: 20 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayTenors.map(({ tenor, weight }, j) => {
                  const ev = eigenvecs[targetFactor]?.loadings[String(tenor)] ?? 0
                  return (
                    <tr key={j}>
                      <td style={{ ...tdS, color: '#e4eaf1', fontWeight: 600, paddingRight: 20 }}>{tenor}y</td>
                      <td style={{ ...tdS, color: weight >= 0 ? CHEAP_COLOR : RICH_COLOR, textAlign: 'right', paddingRight: 20 }}>
                        {weight >= 0 ? '+' : ''}{weight.toFixed(5)}
                      </td>
                      <td style={{ ...tdS, color: '#c6ced8', textAlign: 'right', paddingRight: 20 }}>
                        {ev >= 0 ? '+' : ''}{ev.toFixed(5)}
                      </td>
                      <td style={{ ...tdS, color: '#8995a2', textAlign: 'right', paddingRight: 20 }}>
                        {ev !== 0 ? (weight / ev).toFixed(3) : '—'}
                      </td>
                    </tr>
                  )
                })}
                <tr>
                  <td style={{ ...tdS, color: '#8995a2', fontStyle: 'italic' }}>Intercept (α)</td>
                  <td style={{ ...tdS, color: '#8995a2', textAlign: 'right', paddingRight: 20 }} colSpan={3}>
                    {displayResult.alpha >= 0 ? '+' : ''}{displayResult.alpha.toFixed(5)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Step-by-step guide ──────────────────────────────────────────────────────

function StepByStepGuide() {
  const prose: React.CSSProperties = { fontSize: 14, lineHeight: 1.75, color: '#c3ccd6' }
  const h1: React.CSSProperties = { fontSize: 22, fontWeight: 600, color: '#e4eaf1', marginBottom: 24, letterSpacing: '-0.3px' }
  const stepCard: React.CSSProperties = {
    background: 'rgba(200,220,240,0.025)', border: '1px solid rgba(200,220,240,0.07)',
    borderRadius: 6, padding: '20px 24px', marginBottom: 16,
  }
  const stepNum: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, borderRadius: '50%', background: 'rgba(139,143,216,0.25)',
    border: '1px solid rgba(139,143,216,0.4)', color: '#b9bdea',
    fontSize: 12, fontWeight: 600, marginRight: 12, flexShrink: 0,
  }
  const stepTitle: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: '#e4eaf1', display: 'flex', alignItems: 'center', marginBottom: 10 }
  const bullet: React.CSSProperties = { color: '#8b8fd8', marginRight: 8, fontWeight: 600 }
  const note: React.CSSProperties = {
    background: 'rgba(139,143,216,0.08)', border: '1px solid rgba(139,143,216,0.2)',
    borderRadius: 6, padding: '10px 16px', marginTop: 12, fontSize: 13, color: '#c6ced8',
  }
  const math: React.CSSProperties = {
    fontFamily: "'Geist Mono', ui-monospace, monospace", background: 'rgba(200,220,240,0.06)', borderRadius: 4,
    padding: '2px 6px', fontSize: 13, color: '#b9bdea',
  }
  const matrix: React.CSSProperties = {
    fontFamily: "'Geist Mono', ui-monospace, monospace", background: 'rgba(200,220,240,0.04)', borderRadius: 6,
    padding: '12px 20px', margin: '10px 0', fontSize: 13, color: '#cbbde8',
    border: '1px solid rgba(200,220,240,0.06)', display: 'inline-block',
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', ...prose }}>
      <div style={h1}>Constructing Trade Ideas with PCA: A Step-by-Step Guide</div>

      {/* Step 1 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>1</span>Choose Input Data</div>
        <p style={{ margin: '0 0 10px' }}>
          Decide on the relevant input data for the PCA, depending on the goals of the analysis: time horizon,
          type and number of variables, change or level data. Usually, at least one year of data is advisable.
        </p>
        <p style={{ margin: '0 0 10px' }}>
          In the worked example: weekly <strong style={{ color: '#e4eaf1' }}>level</strong> data for 2Y, 5Y, 7Y, and 10Y Bund yields from 4 Jan 2010 to 3 Oct 2011.
          Constant-maturity time series from a fitted curve model are the preferred choice — they avoid roll-down
          effects and distortions from benchmark premia.
        </p>
        <div style={note}>
          <span style={bullet}>▪</span><strong>Heuristic pass:</strong> use a large variable set (e.g. all yields 1–30Y) to find the best instruments.
          Once identified, run a second PCA restricted to those instruments to obtain clean hedge ratios.
        </div>
      </div>

      {/* Step 2 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>2</span>Run the PCA and Check Numerical Stability</div>
        <p style={{ margin: 0 }}>
          Verify that the calculated eigenvectors are genuine eigenvectors and mutually orthogonal.
          The <strong style={{ color: '#e4eaf1' }}>Stability</strong> tab reports the condition number of the covariance matrix — a large
          condition number signals near-singular input data and unreliable decomposition.
        </p>
      </div>

      {/* Step 3 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>3</span>Assess the Factor Structure</div>
        <p style={{ margin: '0 0 10px' }}>
          Display the eigenvalues (<strong style={{ color: '#e4eaf1' }}>Factor Structure</strong> tab) and assess whether factorisation makes sense.
          A strong decrease <span style={math}>|λ₁| ≫ |λ₂| ≫ … ≫ |λₙ|</span> together with high within-data correlation indicates a
          clear factor structure and allows meaningful dimensionality reduction.
        </p>
        <p style={{ margin: 0 }}>
          If correlations are low, every point on the yield curve will have its own factor and
          information reduction becomes impossible. The covariance matrix approaches the identity matrix and PCA loses its power.
        </p>
      </div>

      {/* Step 4 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>4</span>Interpret the Eigenvectors</div>
        <p style={{ margin: 0 }}>
          Display and interpret the eigenvectors (<strong style={{ color: '#e4eaf1' }}>Factor Structure</strong> tab, loading chart).
          For sovereign yield curves the canonical interpretation is: PC1 = <em>Level</em> (all loadings same sign),
          PC2 = <em>Slope</em> (short vs. long), PC3 = <em>Curvature</em> (belly vs. wings).
          Departures from this pattern in your specific curve are economically meaningful.
        </p>
      </div>

      {/* Step 5 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>5</span>Analyse the Factor Time Series</div>
        <p style={{ margin: '0 0 12px' }}>
          Display the factor time series (<strong style={{ color: '#e4eaf1' }}>Factor Dynamics</strong> tab). This is the central output
          of the PCA and is the basis for most subsequent actions:
        </p>
        {[
          ['Statistical qualities', 'Is the factor close to its mean or far away? The OU z-score and half-life give a quick read.'],
          ['Cross-factor correlations', 'Check correlations between factors over sub-periods (Factor Correlations tab). Instability here signals a regime change.'],
          ['OU mean reversion', 'Feed the factor time series into an Ornstein–Uhlenbeck process to assess speed of mean reversion.'],
          ['Factor as regressor', 'Regress a candidate trade position on the factors to confirm it has the desired exposure — in particular, that an RV trade is genuinely non-directional.'],
          ['Factor as regressand', 'Regress the factor on external macro variables. This links the backward-looking statistical analysis to forward-looking expectations about macro events and risks.'],
        ].map(([title, body]) => (
          <div key={title as string} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <span style={bullet}>▪</span>
            <span><strong style={{ color: '#e4eaf1' }}>{title}:</strong> {body}</span>
          </div>
        ))}
      </div>

      {/* Step 6 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>6</span>Select Which Factor to Trade</div>
        <p style={{ margin: '0 0 10px' }}>
          Based on statistical, fundamental/structural, and flow considerations, decide which factor to take a view on.
        </p>
        <div style={note}>
          <strong>Worked example:</strong> Factor 1 has too little speed of mean reversion → no view. Factor 2 is close to its mean → no view.
          Factor 3 is significantly away from its mean with high mean-reversion speed → investigate butterfly trades hedged against factors 1 and 2.
        </div>
        <p style={{ margin: '10px 0 0' }}>
          This decision is the input to the <strong style={{ color: '#e4eaf1' }}>Trade Builder → Factor View</strong> section.
        </p>
      </div>

      {/* Step 7 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>7</span>Select Maturities Using Residual Analysis</div>
        <p style={{ margin: '0 0 10px' }}>
          Display the relevant residual chart (<strong style={{ color: '#e4eaf1' }}>Factor Residuals</strong> tab).
          The residual of each maturity shows how much of its yield move is <em>not</em> explained by the factors
          you are hedging — this is the idiosyncratic component you are taking on.
        </p>
        <div style={note}>
          <strong>Worked example:</strong> For a curvature trade, we compare 7Y vs 10Y residuals. 10Y has ~0.5 bp more negative residual than 7Y, but going
          three years further out on the curve may not be worth it. Decision: <strong style={{ color: '#cbbde8' }}>Sell 2Y, Buy 5Y, Sell 7Y</strong>.
          The <strong style={{ color: '#e4eaf1' }}>Factor Replication</strong> tab automates this selection by exhaustive OLS subset search.
        </div>
      </div>

      {/* Step 8 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>8</span>Calculate Hedge Ratios</div>
        <p style={{ margin: '0 0 12px' }}>
          Achieve factor 1 and factor 2 neutrality via matrix inversion. With BPVs of
          <span style={math}>BPV(2Y)=1.98</span>, <span style={math}>BPV(5Y)=4.86</span>, <span style={math}>BPV(7Y)=6.62</span>{' '}
          and eigenvector entries as sensitivities, form the 2×2 system:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <div style={matrix}>
            {'M = ( BPV₂·e₁²   BPV₇·e₁⁷ )  =  ( 0.84   3.51 )'}<br />
            {'    ( BPV₂·e₂²   BPV₇·e₂⁷ )     ( −1.66  1.91 )'}
          </div>
        </div>
        <p style={{ margin: '10px 0' }}>
          Invert M and multiply by the belly contribution vector{' '}
          <span style={math}>(−n₅·BPV₅·e₁⁵, −n₅·BPV₅·e₂⁵)ᵀ = (−2.69, 0.22)ᵀ</span>:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <div style={matrix}>
            {'M⁻¹ = ( 0.26  −0.47 )      weights = ( −0.80 )'}<br />
            {'      ( 0.22   0.11 )                ( −0.58 )'}
          </div>
        </div>
        <p style={{ margin: '10px 0 0' }}>
          Scaled to 100mn belly: <strong style={{ color: '#cbbde8' }}>Sell 80mn 2Y, Buy 100mn 5Y, Sell 58mn 7Y</strong>.
          This is exactly what the <strong style={{ color: '#e4eaf1' }}>Trade Builder → Trade Structure</strong> "Neutralize" button computes.
        </p>
      </div>

      {/* Step 9 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>9</span>Display the Butterfly Time Series and Validate Factor Exposure</div>
        <p style={{ margin: '0 0 10px' }}>
          Using the hedge ratios, construct the historical time series of the butterfly (<strong style={{ color: '#e4eaf1' }}>Trade Builder → Historical P&L</strong>).
          Then regress that series on the factor time series to confirm:
        </p>
        {[
          'The trade loads predominantly on the target factor (e.g. PC3)',
          'Exposure to the hedged factors (PC1, PC2) is near zero',
          'The residual is small — the butterfly is not a bet on idiosyncratic yield moves',
        ].map(t => (
          <div key={t} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <span style={bullet}>▪</span><span>{t}</span>
          </div>
        ))}
        <div style={note}>
          Edge case: if the sensitivities to PC3 for all selected maturities happen to be zero, the butterfly will be driven by PC4 rather than PC3. The P&L attribution chart will reveal this immediately.
        </div>
      </div>

      {/* Step 10 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>10</span>Run the OU (or Polynomial) Model for Expected Performance</div>
        <p style={{ margin: '0 0 12px' }}>
          Feed the butterfly time series into the mean-reversion model (<strong style={{ color: '#e4eaf1' }}>Trade Builder → Mean Reversion</strong>).
          Calculate:
        </p>
        {[
          ['Expected profit', 'The mean-reversion target minus current level. In the worked example: 32 bp.'],
          ['Expected downside risk', 'Stop loss at the ±2σ level (moves over time as the OU uncertainty band widens). In the example: −42 bp after one week.'],
          ['First passage time', 'The expected time until the trade returns to its estimated mean. In the example: 84 calendar days on average.'],
        ].map(([title, body]) => (
          <div key={title as string} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <span style={bullet}>▪</span>
            <span><strong style={{ color: '#e4eaf1' }}>{title}:</strong> {body}</span>
          </div>
        ))}
      </div>

      {/* Step 11 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>11</span>Select Specific Bonds Using Rich/Cheap Analysis</div>
        <p style={{ margin: 0 }}>
          Use rich/cheap information from a fitted curve model to select the specific bonds to trade.
          This introduces a distinction between the <em>constant-maturity</em> series used for PCA and hedge-ratio calculations,
          and the <em>specific bond</em> series. PCA, eigenvectors, and mean-reversion calculations should remain based on
          the constant-maturity series; but the hedge ratio for execution should use the BPV of the actual bonds traded.
        </p>
      </div>

      {/* Step 12 */}
      <div style={stepCard}>
        <div style={stepTitle}><span style={stepNum}>12</span>Recalculate Hedge Ratios and Assess Carry</div>
        <p style={{ margin: '0 0 10px' }}>
          Since the BPV of the specific bonds may differ from constant-maturity BPVs, repeat the hedge ratio calculation
          with the actual bond BPVs. Then compute the carry over the expected holding horizon.
        </p>
        <div style={note}>
          <span style={bullet}>▪</span> In a PCA framework, carry is naturally expressed in <strong>money terms</strong> (€), not in bp, because PCA
          does away with the assumption of parallel shifts. If bp expression is needed, the reference maturity must be stated explicitly.<br /><br />
          <span style={bullet}>▪</span> <strong>Worked example:</strong> 84-day carry = EUR +70,000 — small relative to the 32 bp mean-reversion profit potential.
          If carry had been significantly negative, calculating carry out to the 90th percentile of the first-passage-time distribution
          would help assess whether the trade remains attractive in adverse scenarios.
        </div>
      </div>
    </div>
  )
}

// ─── Main Page Component ──────────────────────────────────────────────────────

function PCAAnalysis() {
  const navigate = useNavigate()

  const today = new Date()
  const twoYearsAgo = new Date(today)
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2)
  const fmt = toLocalISODate

  const [activeTab, setActiveTab] = useState<TabId>('structure')
  const [curve, setCurve]         = useState<string>('bund')
  const [startDate, setStartDate] = useState<string>(fmt(twoYearsAgo))
  const [endDate, setEndDate]     = useState<string>(fmt(today))
  const [selectedTenors, setSelectedTenors] = useState<number[]>(DEFAULT_TENORS)
  const [useChanges, setUseChanges] = useState<boolean>(false)
  const [rollWindowWeeks, setRollWindowWeeks] = useState<number | null>(null)
  const [extraTickers, setExtraTickers] = useState<{ ticker: string; label: string }[]>([])
  const [data, setData]           = useState<PCAResponse | null>(null)
  const [loading, setLoading]     = useState<boolean>(false)
  const [error, setError]         = useState<string | null>(null)

  // Custom tickers mode
  const [customMode, setCustomMode] = useState<boolean>(false)
  const [showCustomEditor, setShowCustomEditor] = useState<boolean>(false)

  // Saved markets
  const [savedMarkets, setSavedMarkets] = useState<{ name: string; tickers: { ticker: string; label: string }[] }[]>(() => {
    try { return JSON.parse(localStorage.getItem('pca_saved_markets') ?? '[]') } catch { return [] }
  })
  const [saveNameDraft, setSaveNameDraft] = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)

  const persistMarkets = (markets: typeof savedMarkets) => {
    setSavedMarkets(markets)
    localStorage.setItem('pca_saved_markets', JSON.stringify(markets))
  }
  const saveMarket = () => {
    const name = saveNameDraft.trim()
    if (!name || customTickers.filter(t => t.ticker.trim()).length < 2) return
    persistMarkets([...savedMarkets, { name, tickers: customTickers.filter(t => t.ticker.trim() && t.label.trim()) }])
    setSaveNameDraft('')
    setShowSaveInput(false)
  }
  const loadMarket = (idx: number) => {
    const m = savedMarkets[idx]
    if (!m) return
    setCustomTickers(m.tickers)
    setCustomMode(true)
    setShowCustomEditor(false)
  }
  const deleteMarket = (idx: number) => {
    persistMarkets(savedMarkets.filter((_, i) => i !== idx))
  }

  // Saved trades
  const [savedTrades, setSavedTrades] = useState<SavedTrade[]>(() => {
    try { return JSON.parse(localStorage.getItem('pca_saved_trades') ?? '[]') } catch { return [] }
  })
  const [activeTrade, setActiveTrade] = useState<SavedTrade | null>(null)
  const [tradeKey, setTradeKey] = useState(0)

  const persistTrades = (trades: SavedTrade[]) => {
    setSavedTrades(trades)
    localStorage.setItem('pca_saved_trades', JSON.stringify(trades))
  }
  const addSavedTrade = (t: SavedTrade) => persistTrades([...savedTrades, t])
  const deleteSavedTrade = (idx: number) => persistTrades(savedTrades.filter((_, i) => i !== idx))
  const loadTrade = (idx: number) => {
    const t = savedTrades[idx]
    if (!t) return
    setActiveTrade(t)
    setTradeKey(k => k + 1)
    setActiveTab('trade')
  }

  const [customTickers, setCustomTickers] = useState<{ ticker: string; label: string }[]>([
    { ticker: 'GDBR2 Index',  label: '2Y Bund' },
    { ticker: 'GDBR5 Index',  label: '5Y Bund' },
    { ticker: 'GDBR7 Index',  label: '7Y Bund' },
    { ticker: 'GDBR10 Index', label: '10Y Bund' },
  ])

  function addCustomTicker() {
    setCustomTickers(prev => [...prev, { ticker: '', label: '' }])
  }
  function removeCustomTicker(i: number) {
    setCustomTickers(prev => prev.filter((_, j) => j !== i))
  }
  function updateCustomTicker(i: number, field: 'ticker' | 'label', val: string) {
    setCustomTickers(prev => prev.map((t, j) => j === i ? { ...t, [field]: val } : t))
  }

  function toggleTenor(t: number) {
    setSelectedTenors(prev =>
      prev.includes(t)
        ? prev.length > 2 ? prev.filter(x => x !== t) : prev
        : [...prev, t].sort((a, b) => a - b)
    )
  }

  function fetchData() {
    const token = localStorage.getItem('access_token')
    if (!token) { navigate('/login', { replace: true }); return }
    setLoading(true)
    setError(null)
    const validCustom = customTickers.filter(t => t.ticker.trim() && t.label.trim())
    const params: Record<string, string | number | boolean | undefined> = {
      start_date: startDate,
      end_date: endDate,
      n_factors: 3,
      use_changes: useChanges,
      roll_window_weeks: rollWindowWeeks ?? undefined,
      extra_tickers: extraTickers.map(e => `${e.ticker}:${e.label}`).join(','),
    }
    if (customMode && validCustom.length >= 2) {
      params.custom_tickers = validCustom.map(t => `${t.ticker}:${t.label}`).join(',')
    } else {
      params.curve  = curve
      params.tenors = selectedTenors.join(',')
    }
    axios.get('/api/tools/pca-analysis', {
      headers: { Authorization: `Bearer ${token}` },
      params,
    })
      .then(res => { setData(res.data); setError(null) })
      .catch(err => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        } else {
          setError(err.response?.data?.detail ?? err.message ?? 'Unknown error')
        }
      })
      .finally(() => setLoading(false))
  }

  // Auto-fetch on mount with defaults
  useEffect(() => { fetchData() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const tabStyle = (id: TabId): React.CSSProperties => ({
    padding: '6px 18px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer',
    border: '1px solid',
    borderColor: activeTab === id ? 'rgba(134,192,222,0.5)' : 'rgba(200,220,240,0.1)',
    background:  activeTab === id ? 'rgba(134,192,222,0.15)' : 'rgba(200,220,240,0.03)',
    color:       activeTab === id ? '#bfe0ef' : '#9aa5b1',
  })

  const selStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(200,220,240,0.15)',
    background: '#0b0f14', color: '#e4eaf1', fontSize: 13, cursor: 'pointer',
  }

  const SIDEBAR_W = 200

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#e4eaf1', padding: '0 0 80px 0' }}>

      {/* Sticky header */}
      <div style={{ ...headerBar, padding: '12px 28px',
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>

        <PageTitle category="Market Structure & Analysis" categoryId="market-structure" title="PCA Analysis" subtitle="Yield curve" />
        <span style={{ width: 1, alignSelf: 'stretch', background: 'rgba(150,178,205,0.09)', margin: '2px 4px' }} />

        {/* Curve dropdown */}
        {/* Mode toggle: preset curve vs custom tickers */}
        <div style={{ display: 'flex', gap: 3, background: 'rgba(200,220,240,0.04)',
          borderRadius: 6, padding: 3, border: '1px solid rgba(200,220,240,0.08)' }}>
          {([false, true] as [boolean, boolean]).map(isCustom => (
            <button key={String(isCustom)} onClick={() => { setCustomMode(isCustom); setShowCustomEditor(isCustom) }}
              style={{ padding: '4px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: 'none',
                background: customMode === isCustom ? 'rgba(134,192,222,0.16)' : 'transparent',
                color: customMode === isCustom ? '#f4f7fa' : '#9aa5b1',
                fontWeight: customMode === isCustom ? 600 : 400 }}>
              {isCustom ? 'Custom tickers' : 'Preset curve'}
            </button>
          ))}
        </div>

        {customMode ? (
          /* ── Custom ticker editor ───────────────────────────────────────────── */
          showCustomEditor ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'rgba(139,143,216,0.06)',
              border: '1px solid rgba(139,143,216,0.2)', borderRadius: 6, padding: '10px 14px' }}>
              <div style={{ fontSize: 11, color: '#8b8fd8', fontWeight: 600, marginBottom: 2 }}>
                Bloomberg tickers — minimum 2, format: Ticker · Label
              </div>
              {customTickers.map((ct, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input value={ct.ticker} placeholder="e.g. GDBR10 Index"
                    onChange={e => updateCustomTicker(i, 'ticker', e.target.value)}
                    style={{ ...selStyle, width: 160, fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 11 }} />
                  <input value={ct.label} placeholder="Label"
                    onChange={e => updateCustomTicker(i, 'label', e.target.value)}
                    style={{ ...selStyle, width: 100, fontSize: 11 }} />
                  <button onClick={() => removeCustomTicker(i)}
                    style={{ background: 'none', border: 'none', color: '#8995a2', cursor: 'pointer',
                      fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <button onClick={addCustomTicker}
                  style={{ fontSize: 11, color: '#8b8fd8', background: 'none',
                    border: '1px dashed rgba(139,143,216,0.4)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>
                  + Add ticker
                </button>
                <button
                  onClick={() => { setShowCustomEditor(false); fetchData() }}
                  disabled={customTickers.filter(t => t.ticker.trim() && t.label.trim()).length < 2}
                  style={{ fontSize: 11, fontWeight: 600, color: '#f4f7fa',
                    background: customTickers.filter(t => t.ticker.trim() && t.label.trim()).length >= 2
                      ? '#8b8fd8' : 'rgba(139,143,216,0.3)',
                    border: 'none', borderRadius: 6, padding: '4px 14px', cursor:
                      customTickers.filter(t => t.ticker.trim() && t.label.trim()).length >= 2 ? 'pointer' : 'not-allowed' }}>
                  Run PCA
                </button>
              </div>
            </div>
          ) : (
            /* collapsed: show summary pill + edit button */
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: '#c6ced8' }}>
                {customTickers.filter(t => t.ticker.trim() && t.label.trim()).map(t => t.label).join(' · ')}
              </span>
              <button onClick={() => setShowCustomEditor(true)}
                style={{ fontSize: 11, color: '#8b8fd8', background: 'none',
                  border: '1px solid rgba(139,143,216,0.4)', borderRadius: 6, padding: '2px 10px', cursor: 'pointer' }}>
                Edit
              </button>
            </div>
          )
        ) : (
          /* ── Preset curve controls ──────────────────────────────────────────── */
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#8995a2' }}>Curve</span>
              <select value={curve} onChange={e => setCurve(e.target.value)} style={selStyle}>
                {CURVES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#8995a2' }}>Tenors</span>
              {ALL_TENORS.map(t => (
                <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer',
                  fontSize: 12, color: selectedTenors.includes(t) ? '#e4eaf1' : '#8995a2' }}>
                  <input type="checkbox" checked={selectedTenors.includes(t)}
                    onChange={() => toggleTenor(t)}
                    style={{ accentColor: '#8b8fd8', cursor: 'pointer' }} />
                  {t}y
                </label>
              ))}
            </div>
          </>
        )}

        {/* Estimation window */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#8995a2' }}>From</span>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            max={endDate}
            style={{ ...selStyle, fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 12 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#8995a2' }}>To</span>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
            min={startDate}
            style={{ ...selStyle, fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 12 }} />
        </div>

        {/* Levels / Changes toggle */}
        <div style={{ display: 'flex', gap: 4, background: 'rgba(200,220,240,0.04)',
          borderRadius: 6, padding: 3, border: '1px solid rgba(200,220,240,0.08)' }}>
          {([false, true] as const).map(val => (
            <button key={String(val)} onClick={() => setUseChanges(val)}
              style={{ padding: '4px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: 'none',
                background: useChanges === val ? 'rgba(134,192,222,0.16)' : 'transparent',
                color: useChanges === val ? '#f4f7fa' : '#9aa5b1',
                fontWeight: useChanges === val ? 600 : 400 }}>
              {val ? 'Changes' : 'Levels'}
            </button>
          ))}
        </div>

        {/* Run button */}
        <button onClick={fetchData} disabled={loading}
          style={{ padding: '7px 20px', borderRadius: 6, border: 'none', cursor: loading ? 'wait' : 'pointer',
            background: loading ? 'rgba(200,220,240,0.05)' : 'rgba(139,143,216,0.85)',
            color: loading ? '#8995a2' : '#f4f7fa', fontSize: 13, fontWeight: 600 }}>
          {loading ? 'Running…' : 'Run PCA'}
        </button>

        {/* Meta info */}
        {data && !loading && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#8995a2', fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
              {data.start_date} → {data.end_date}
            </span>
            <span style={{ fontSize: 11, color: '#8995a2' }}>{data.n_obs} obs</span>
            <span style={{
              fontSize: 11, padding: '2px 10px', borderRadius: 6,
              background: data.data_source === 'bloomberg' ? 'rgba(88,173,142,0.15)' : 'rgba(214,173,102,0.15)',
              color:      data.data_source === 'bloomberg' ? '#6fc2a2' : '#dfbb78',
              border: `1px solid ${data.data_source === 'bloomberg' ? 'rgba(88,173,142,0.3)' : 'rgba(214,173,102,0.3)'}`,
            }}>
              {data.data_source === 'bloomberg' ? 'Live' : 'Simulated'}
            </span>
            <span style={{
              fontSize: 11, padding: '2px 10px', borderRadius: 6,
              background: (data.input_mode ?? 'levels') === 'changes' ? 'rgba(134,192,222,0.15)' : 'rgba(200,220,240,0.05)',
              color:      (data.input_mode ?? 'levels') === 'changes' ? '#bfe0ef' : '#9aa5b1',
              border: `1px solid ${(data.input_mode ?? 'levels') === 'changes' ? 'rgba(134,192,222,0.3)' : 'rgba(200,220,240,0.1)'}`,
            }}>
              {(data.input_mode ?? 'levels') === 'changes' ? 'Δ Changes' : 'Levels'}
            </span>
          </div>
        )}
      </div>

      {/* Body: sidebar + main content */}
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>

        {/* ── Saved Markets sidebar ── */}
        <div style={{
          width: SIDEBAR_W, flexShrink: 0, position: 'sticky', top: 57,
          height: 'calc(100vh - 57px)', overflowY: 'auto',
          borderRight: '1px solid rgba(200,220,240,0.1)',
          background: '#090c10',
          padding: '16px 12px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#9aa5b1', letterSpacing: '0.1em',
            textTransform: 'uppercase', marginBottom: 8 }}>
            Saved Markets
          </div>

          {savedMarkets.length === 0 && (
            <div style={{ fontSize: 11, color: '#8995a2', fontStyle: 'italic', lineHeight: 1.5 }}>
              No markets saved yet.
            </div>
          )}

          {savedMarkets.map((m, idx) => (
            <div key={idx} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              borderRadius: 6, padding: '5px 8px',
              background: 'rgba(200,220,240,0.03)',
              border: '1px solid rgba(200,220,240,0.06)',
              cursor: 'pointer',
            }}
              onClick={() => loadMarket(idx)}
            >
              <span style={{ flex: 1, fontSize: 12, color: '#c3ccd6', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.name}
              </span>
              <button
                onClick={e => { e.stopPropagation(); deleteMarket(idx) }}
                style={{ background: 'none', border: 'none', color: '#8995a2', cursor: 'pointer',
                  fontSize: 13, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                title="Delete"
              >×</button>
            </div>
          ))}

          {/* Save current */}
          <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid rgba(200,220,240,0.06)' }}>
            {customMode && !showCustomEditor && customTickers.filter(t => t.ticker.trim() && t.label.trim()).length >= 2 ? (
              showSaveInput ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    value={saveNameDraft}
                    onChange={e => setSaveNameDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveMarket(); if (e.key === 'Escape') setShowSaveInput(false) }}
                    placeholder="Market name…"
                    autoFocus
                    style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(139,143,216,0.4)',
                      background: '#0b0f14', color: '#e4eaf1', width: '100%', boxSizing: 'border-box' }}
                  />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={saveMarket}
                      style={{ flex: 1, fontSize: 11, fontWeight: 600, color: '#f4f7fa', background: 'rgba(139,143,216,0.7)',
                        border: 'none', borderRadius: 6, padding: '4px 0', cursor: 'pointer' }}>
                      Save
                    </button>
                    <button onClick={() => setShowSaveInput(false)}
                      style={{ fontSize: 11, color: '#8995a2', background: 'none',
                        border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowSaveInput(true)}
                  style={{ width: '100%', fontSize: 11, color: '#8b8fd8', background: 'none',
                    border: '1px dashed rgba(139,143,216,0.4)', borderRadius: 6, padding: '5px 0', cursor: 'pointer' }}>
                  + Save current
                </button>
              )
            ) : (
              <div style={{ fontSize: 10, color: '#77828f', textAlign: 'center', lineHeight: 1.4 }}>
                Load a custom market first to save it
              </div>
            )}
          </div>

          {/* ── Saved Trades ── */}
          {savedTrades.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(200,220,240,0.06)' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#9aa5b1', letterSpacing: '0.1em',
                textTransform: 'uppercase', marginBottom: 8 }}>
                Saved Trades
              </div>
              {savedTrades.map((t, idx) => (
                <div key={idx} style={{
                  marginBottom: 6, borderRadius: 7, padding: '7px 9px',
                  background: 'rgba(200,220,240,0.03)',
                  border: '1px solid rgba(200,220,240,0.07)',
                  cursor: 'pointer',
                }}
                  onClick={() => loadTrade(idx)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ flex: 1, fontSize: 12, color: '#c3ccd6', overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                      {t.name}
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); deleteSavedTrade(idx) }}
                      style={{ background: 'none', border: 'none', color: '#8995a2', cursor: 'pointer',
                        fontSize: 13, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                      title="Delete"
                    >×</button>
                  </div>
                  {/* Trade details */}
                  <div style={{ fontSize: 10, color: '#8995a2', marginTop: 5, lineHeight: 1.8, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
                    <div style={{ color: '#9aa5b1' }}>
                      F{t.factor + 1} · {t.direction > 0 ? 'Long' : 'Short'} {t.magnitude}σ
                      {t.entryDate ? ` · ${t.entryDate}` : ''}
                    </div>
                    {t.entryLevel != null && (
                      <div>
                        Entry <span style={{ color: '#c6ced8' }}>{t.entryLevel.toFixed(4)}</span>
                      </div>
                    )}
                    {t.takeProfit != null && t.stopLoss != null && (
                      <div>
                        TP <span style={{ color: '#5fb592' }}>{t.takeProfit.toFixed(4)}</span>
                        {' · '}SL <span style={{ color: '#d9705e' }}>{t.stopLoss.toFixed(4)}</span>
                      </div>
                    )}
                    {t.rr != null && (
                      <div>R:R <span style={{ color: t.rr >= 1.5 ? '#5fb592' : t.rr >= 1 ? '#dfbb78' : '#d9705e',
                        fontWeight: 600 }}>{t.rr.toFixed(2)}</span></div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Main content */}
        <div style={{ flex: 1, minWidth: 0, padding: '28px 28px 0' }}>

        {loading && (
          <div style={{ textAlign: 'center', padding: 80, color: '#8995a2', fontSize: 16 }}>
            Running PCA…
          </div>
        )}

        {error && !loading && (
          <div style={{ color: '#e2826f', padding: 20, background: 'rgba(217,112,94,0.08)',
            border: '1px solid rgba(217,112,94,0.2)', borderRadius: 6, marginBottom: 20 }}>
            Error: {error}
          </div>
        )}

        {data && !loading && (
          <>
            {/* Tab switcher */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
              {([
                ['structure', 'Factor Structure'],
                ['dynamics', 'Factor Dynamics'],
                ['correlations', 'Factor Correlations'],
                ['stability', 'Stability'],
                ['fresiduals', 'Factor Residuals'],
                ['hedge', 'Hedge Ratios'],
                ['impact', 'Impact Analysis'],
                ['freplication', 'Factor Replication'],
                ['trade', 'Trade Builder'],
                ['guide', 'Step-by-step Example'],
              ] as [TabId, string][]).map(([id, label]) => (
                <button key={id} style={tabStyle(id)} onClick={() => setActiveTab(id)}>
                  {label}
                </button>
              ))}

              {/* Curve label */}
              <div style={{ marginLeft: 'auto', fontSize: 13, color: '#8995a2', alignSelf: 'center' }}>
                {data.curve_label} · {(data.tenors ?? []).map(t => tLabel(t, data)).join(', ')}
              </div>
            </div>

            {activeTab === 'structure'    && <FactorStructureTab data={data} />}
            {activeTab === 'dynamics'     && <FactorDynamicsTab data={data} />}
            {activeTab === 'trade'        && <TradeBuilderTab key={tradeKey} data={data} initialTrade={activeTrade} onSaveTrade={addSavedTrade} />}
            {activeTab === 'hedge'        && <HedgeRatiosTab data={data} />}
            {activeTab === 'impact'       && <ImpactAnalysisTab data={data} />}
            {activeTab === 'freplication' && <FactorReplicationTab data={data} />}
            {activeTab === 'fresiduals'   && <FactorResidualsTab data={data} />}
            {activeTab === 'stability'    && <StabilityTab data={data} rollWindowWeeks={rollWindowWeeks} setRollWindowWeeks={setRollWindowWeeks} onRefetch={fetchData} />}
            {activeTab === 'guide'        && <StepByStepGuide />}
            {activeTab === 'correlations' && (
              <FactorCorrelationsTab
                data={data}
                extraTickers={extraTickers}
                onAddTicker={t => setExtraTickers(prev =>
                  prev.some(e => e.ticker === t.ticker) ? prev : [...prev, t]
                )}
                onRemoveTicker={ticker => setExtraTickers(prev => prev.filter(e => e.ticker !== ticker))}
              />
            )}
          </>
        )}
        </div>
      </div>
    </div>
  )
}

// Wrap with error boundary so render crashes show a readable message instead of blank page
const _PCAAnalysis = PCAAnalysis
export default function PCAAnalysisPage() {
  return <PCAErrorBoundary><_PCAAnalysis /></PCAErrorBoundary>
}
