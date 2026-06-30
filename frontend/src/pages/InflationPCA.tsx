import { useMemo, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface BondSpec {
  label: string       // e.g. "BTPei 32"
  maturity: number    // calendar year
  bbgTicker: string   // for future Bloomberg integration
}

interface FlyResult {
  name: string        // e.g. "28s32s38s"
  leftIdx: number
  bellyIdx: number
  rightIdx: number
  wLeft: number       // PCA-neutral left wing weight
  wRight: number      // PCA-neutral right wing weight
  spreads: number[]   // fly spread level time series (bps)
  current: number     // latest spread (bps)
  avg3m: number       // 63-day rolling mean (bps)
  std3m: number       // 63-day rolling std (bps)
  zscore: number      // (current − avg3m) / std3m
  signal: 'Very Cheap' | 'Cheap' | 'Neutral' | 'Rich' | 'Very Rich'
  netDV01: number     // (wL×dur_L − dur_belly + wR×dur_R) × $100 — $/bp per $1MM belly notional
}

type YieldType = 'real' | 'breakeven' | 'iota'

// ─── API response types ───────────────────────────────────────────────────────

interface ApiYieldBlock {
  levels:       number[][]   // [T, N] in %
  loadings:     number[][]   // [nPCs, N]
  var_explained: number[]    // [nPCs]
  flies: {
    name: string; left_idx: number; belly_idx: number; right_idx: number
    w_left: number; w_right: number; spreads: number[]
    current: number; avg3m: number; std3m: number; zscore: number
    signal: string; net_dv01: number
  }[]
}

interface ApiResponse {
  curve:       string
  bonds:       BondSpec[]
  dates:       string[]
  data_source: 'bloomberg' | 'simulation'
  real:        ApiYieldBlock
  breakeven:   ApiYieldBlock
  iota:        ApiYieldBlock
}

const YIELD_TYPES: { id: YieldType; label: string; description: string }[] = [
  { id: 'real',      label: 'Real Yield',  description: 'Real yield of the inflation-linked bond'          },
  { id: 'breakeven', label: 'Breakeven',   description: 'Nominal yield − real yield (implied inflation)'   },
  { id: 'iota',      label: 'IOTA',        description: 'ILB asset swap spread vs real rate swap'          },
]

// ─── Curve config ─────────────────────────────────────────────────────────────

const CURVES: Record<string, {
  label: string; color: string
  bonds: BondSpec[]
  baseYields:           number[]  // real yields (%)
  baseYieldsBreakeven:  number[]  // breakeven inflation (%)
  baseYieldsIOTA:       number[]  // ILB asset swap spread vs real rate swap (%)
  vol: number
}> = {
  btpei: {
    label: 'BTPei', color: '#6366f1',
    bonds: [
      { label: 'BTPei 28', maturity: 2028, bbgTicker: 'ITIL28 Index' },
      { label: 'BTPei 30', maturity: 2030, bbgTicker: 'ITIL30 Index' },
      { label: 'BTPei 32', maturity: 2032, bbgTicker: 'ITIL32 Index' },
      { label: 'BTPei 35', maturity: 2035, bbgTicker: 'ITIL35 Index' },
      { label: 'BTPei 38', maturity: 2038, bbgTicker: 'ITIL38 Index' },
      { label: 'BTPei 41', maturity: 2041, bbgTicker: 'ITIL41 Index' },
      { label: 'BTPei 51', maturity: 2051, bbgTicker: 'ITIL51 Index' },
    ],
    baseYields:           [0.80, 1.00, 1.20, 1.40, 1.52, 1.62, 1.82],
    baseYieldsBreakeven:  [2.10, 2.15, 2.20, 2.25, 2.28, 2.30, 2.35],
    baseYieldsIOTA:       [-0.05, 0.02, 0.08, 0.12, 0.15, 0.17, 0.20],
    vol: 1.0,
  },
  oatei: {
    label: 'OATei', color: '#38bdf8',
    bonds: [
      { label: 'OATei 27', maturity: 2027, bbgTicker: 'FROB27I Index' },
      { label: 'OATei 29', maturity: 2029, bbgTicker: 'FROB29I Index' },
      { label: 'OATei 32', maturity: 2032, bbgTicker: 'FROB32I Index' },
      { label: 'OATei 36', maturity: 2036, bbgTicker: 'FROB36I Index' },
      { label: 'OATei 40', maturity: 2040, bbgTicker: 'FROB40I Index' },
      { label: 'OATei 47', maturity: 2047, bbgTicker: 'FROB47I Index' },
    ],
    baseYields:           [0.55, 0.75, 0.90, 1.05, 1.15, 1.30],
    baseYieldsBreakeven:  [1.95, 2.05, 2.12, 2.18, 2.22, 2.28],
    baseYieldsIOTA:       [-0.15, -0.10, -0.08, -0.05, -0.03, 0.00],
    vol: 0.85,
  },
  dbrei: {
    label: 'DBRei', color: '#f59e0b',
    bonds: [
      { label: 'DBRei 26', maturity: 2026, bbgTicker: 'DBIBL26 Index' },
      { label: 'DBRei 30', maturity: 2030, bbgTicker: 'DBIBL30 Index' },
      { label: 'DBRei 33', maturity: 2033, bbgTicker: 'DBIBL33 Index' },
      { label: 'DBRei 40', maturity: 2040, bbgTicker: 'DBIBL40 Index' },
      { label: 'DBRei 46', maturity: 2046, bbgTicker: 'DBIBL46 Index' },
    ],
    baseYields:           [0.25, 0.42, 0.58, 0.72, 0.85],
    baseYieldsBreakeven:  [1.85, 1.95, 2.02, 2.08, 2.15],
    baseYieldsIOTA:       [-0.25, -0.20, -0.15, -0.12, -0.08],
    vol: 0.80,
  },
  uki: {
    label: 'UKi', color: '#22c55e',
    bonds: [
      { label: 'UKi 27', maturity: 2027, bbgTicker: 'UKTIIL27 Index' },
      { label: 'UKi 30', maturity: 2030, bbgTicker: 'UKTIIL30 Index' },
      { label: 'UKi 32', maturity: 2032, bbgTicker: 'UKTIIL32 Index' },
      { label: 'UKi 35', maturity: 2035, bbgTicker: 'UKTIIL35 Index' },
      { label: 'UKi 40', maturity: 2040, bbgTicker: 'UKTIIL40 Index' },
      { label: 'UKi 47', maturity: 2047, bbgTicker: 'UKTIIL47 Index' },
      { label: 'UKi 55', maturity: 2055, bbgTicker: 'UKTIIL55 Index' },
    ],
    baseYields:           [-0.20, 0.05, 0.20, 0.38, 0.60, 0.85, 1.05],
    baseYieldsBreakeven:  [3.20, 3.35, 3.45, 3.55, 3.62, 3.68, 3.75],
    baseYieldsIOTA:       [-0.40, -0.35, -0.30, -0.25, -0.20, -0.15, -0.10],
    vol: 0.90,
  },
}

const CURVE_ORDER = ['btpei', 'oatei', 'dbrei', 'uki']
const N_DAYS = 252   // 1 year of daily data

// ─── RNG ──────────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function strSeed(s: string): number {
  let h = 0
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

// ─── Business date generation ─────────────────────────────────────────────────

function generateBdates(n: number): string[] {
  const dates: string[] = []
  const d = new Date()
  while (dates.length < n) {
    d.setDate(d.getDate() - 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) dates.unshift(d.toISOString().slice(0, 10))
  }
  return dates
}

// ─── Synthetic real yield levels (T × N) ─────────────────────────────────────
// Three latent factors: level, slope, curvature — mean-reverting daily walks.
// Bonds loaded on these factors by maturity position; small idiosyncratic noise.

// Vol and slope scaling differ by yield type:
//   real:      full rate vol, standard slope
//   breakeven: ~75% vol (inflation less volatile than real rates), flatter slope
//   iota:      ~40% vol (asset swap spread mean-reverts tightly), near-flat slope
const YIELD_TYPE_VOL:   Record<YieldType, number> = { real: 1.00, breakeven: 0.75, iota: 0.40 }
const YIELD_TYPE_SLOPE: Record<YieldType, number> = { real: 1.00, breakeven: 0.50, iota: 0.25 }

function generateYieldLevels(curveId: string, yieldType: YieldType): number[][] {
  const cfg   = CURVES[curveId]
  const N     = cfg.bonds.length
  const vMul  = YIELD_TYPE_VOL[yieldType]
  const sMul  = YIELD_TYPE_SLOPE[yieldType]
  const base  = yieldType === 'breakeven' ? cfg.baseYieldsBreakeven
               : yieldType === 'iota'     ? cfg.baseYieldsIOTA
               : cfg.baseYields
  const rng   = mulberry32(strSeed(curveId + '_' + yieldType + '_lvl'))

  const lv: number[] = [0], sl: number[] = [0], cu: number[] = [0]
  for (let t = 1; t < N_DAYS; t++) {
    lv.push(lv[t-1] * 0.998 + (rng() - 0.5) * 0.055 * cfg.vol * vMul)
    sl.push(sl[t-1] * 0.996 + (rng() - 0.5) * 0.035 * cfg.vol * vMul)
    cu.push(cu[t-1] * 0.993 + (rng() - 0.5) * 0.022 * cfg.vol * vMul)
  }

  return Array.from({ length: N_DAYS }, (_, t) =>
    Array.from({ length: N }, (_, j) => {
      const x = j / (N - 1)
      return (
        base[j]
        + lv[t] * 1.0
        + sl[t] * (-1.0 + 2.0 * x) * sMul
        + cu[t] * (-Math.sin(Math.PI * x))
        + (rng() - 0.5) * 0.012 * cfg.vol * vMul
      )
    })
  )
}

// ─── Jacobi PCA on yield CHANGES ─────────────────────────────────────────────
// Using changes (not levels) gives stationary, more stable loadings.
// Returns loadings (N-vectors per PC) and variance explained.

function runPCA(levels: number[][], nPCs = 3) {
  // First-difference into changes matrix (T-1 × N)
  const T = levels.length - 1
  const N = levels[0].length
  const dY: number[][] = Array.from({ length: T }, (_, t) =>
    Array.from({ length: N }, (_, j) => levels[t+1][j] - levels[t][j])
  )

  // Centre columns (changes are near-zero mean; centering is technically correct)
  const means = Array.from({ length: N }, (_, j) => dY.reduce((s, r) => s + r[j], 0) / T)
  const X = dY.map(row => row.map((v, j) => v - means[j]))

  // Covariance matrix (N × N)
  const C: number[][] = Array.from({ length: N }, () => new Array(N).fill(0))
  for (let i = 0; i < N; i++)
    for (let j = i; j < N; j++) {
      let s = 0
      for (let t = 0; t < T; t++) s += X[t][i] * X[t][j]
      C[i][j] = C[j][i] = s / (T - 1)
    }

  // Jacobi eigen-decomposition
  const A = C.map(r => [...r])
  const V = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => +(i === j))
  )

  for (let iter = 0; iter < 300; iter++) {
    let maxV = 0, p = 0, q = 1
    for (let i = 0; i < N; i++)
      for (let j = i + 1; j < N; j++)
        if (Math.abs(A[i][j]) > maxV) { maxV = Math.abs(A[i][j]); p = i; q = j }
    if (maxV < 1e-12) break

    const tau = (A[q][q] - A[p][p]) / (2 * A[p][q])
    const t2  = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau))
    const c   = 1 / Math.sqrt(1 + t2 * t2)
    const s2  = t2 * c
    const Ac  = A.map(r => [...r])

    for (let i = 0; i < N; i++) {
      A[p][i] = A[i][p] = c * Ac[i][p] - s2 * Ac[i][q]
      A[q][i] = A[i][q] = s2 * Ac[i][p] + c * Ac[i][q]
      const vp = V[i][p], vq = V[i][q]
      V[i][p] = c * vp - s2 * vq
      V[i][q] = s2 * vp + c * vq
    }
    A[p][p] = c*c*Ac[p][p] - 2*s2*c*Ac[p][q] + s2*s2*Ac[q][q]
    A[q][q] = s2*s2*Ac[p][p] + 2*s2*c*Ac[p][q] + c*c*Ac[q][q]
    A[p][q] = A[q][p] = 0
  }

  const eigs = Array.from({ length: N }, (_, i) => ({ val: A[i][i], idx: i }))
    .sort((a, b) => b.val - a.val)
  const totalVar = eigs.reduce((s, e) => s + Math.max(0, e.val), 0)
  const varExplained = eigs.map(e => Math.max(0, e.val) / totalVar * 100)

  // Sign convention:
  //   PC1 (level): mean loading positive → all bonds rally together
  //   PC2 (slope): long-end loading positive → bear-steepener positive
  //   PC3 (curvature): no canonical sign; leave as-is
  const loadings = eigs.slice(0, nPCs).map(({ idx }, pcIdx) => {
    const v = Array.from({ length: N }, (_, i) => V[i][idx])
    let flip = 1
    if (pcIdx === 0) flip = v.reduce((s, x) => s + x, 0) < 0 ? -1 : 1
    if (pcIdx === 1) flip = v[N - 1] < 0 ? -1 : 1
    return v.map(x => x * flip)
  })

  return { loadings, varExplained: varExplained.slice(0, nPCs) }
}

// ─── PCA-neutral butterfly computation ────────────────────────────────────────
//
// For wings i (left), j (belly), k (right), solve the 2×2 system:
//
//   [pc1[i]  pc1[k]] [wL]   [pc1[j]]
//   [pc2[i]  pc2[k]] [wR] = [pc2[j]]
//
// belly fixed at −1 (short belly). Fly spread = wL·y_i − y_j + wR·y_k (in bps).
// Cheap/rich: z-score of current spread vs 63-day rolling window.
//
// Note: full DV01-weighted version to be wired in when Bloomberg yields are live
// (replace pc_k[i] with DV01_i × pc_k[i] throughout).

function classifySignal(z: number): FlyResult['signal'] {
  if (z >  2) return 'Very Rich'
  if (z >  1) return 'Rich'
  if (z < -2) return 'Very Cheap'
  if (z < -1) return 'Cheap'
  return 'Neutral'
}

// Approximate modified duration for an IL bond (years to maturity × 0.92 for low-coupon bonds)
const REF_YEAR = 2026
function approxDuration(maturity: number): number {
  return Math.max(0.5, maturity - REF_YEAR) * 0.92
}

function computeFlies(
  levels: number[][],
  loadings: number[][],
  bonds: BondSpec[]
): FlyResult[] {
  const N   = bonds.length
  const T   = levels.length
  const pc1 = loadings[0]
  const pc2 = loadings[1]
  const MIN_DET = 1e-6
  const results: FlyResult[] = []

  for (let i = 0; i < N - 2; i++) {
    for (let j = i + 1; j < N - 1; j++) {
      for (let k = j + 1; k < N; k++) {
        // 2×2 solve via Cramer's rule
        const det  = pc1[i] * pc2[k] - pc1[k] * pc2[i]
        if (Math.abs(det) < MIN_DET) continue   // ill-conditioned, skip

        const wL = (pc1[j] * pc2[k] - pc1[k] * pc2[j]) / det
        const wR = (pc1[i] * pc2[j] - pc2[i] * pc1[j]) / det

        // Spread in bps (levels in %)
        const spreads = levels.map(row =>
          (wL * row[i] - row[j] + wR * row[k]) * 100
        )

        const current  = spreads[T - 1]
        const window63 = spreads.slice(Math.max(0, T - 63))
        const avg3m    = window63.reduce((s, v) => s + v, 0) / window63.length
        const std3m    = Math.sqrt(
          window63.reduce((s, v) => s + (v - avg3m) ** 2, 0) / window63.length
        ) || 0.01

        const zscore = (current - avg3m) / std3m

        const mi = bonds[i].maturity % 100
        const mj = bonds[j].maturity % 100
        const mk = bonds[k].maturity % 100

        // DV01 per $1MM ≈ duration × $100 (par bond approximation)
        const netDV01 = (
            wL * approxDuration(bonds[i].maturity)
          -      approxDuration(bonds[j].maturity)
          + wR * approxDuration(bonds[k].maturity)
        ) * 100

        results.push({
          name: `${mi}s${mj}s${mk}s`,
          leftIdx: i, bellyIdx: j, rightIdx: k,
          wLeft: wL, wRight: wR,
          spreads, current, avg3m, std3m, zscore,
          signal: classifySignal(zscore),
          netDV01,
        })
      }
    }
  }

  // Sort by |z-score| descending so most actionable flies appear first
  return results.sort((a, b) => Math.abs(b.zscore) - Math.abs(a.zscore))
}

// ─── Styling ──────────────────────────────────────────────────────────────────

const BG = '#080d1a'
const MUTED = '#475569'
const RED = '#ef4444'
const PC_COLORS = ['#6366f1', '#f59e0b', '#a78bfa']
const PC_NAMES  = ['Level', 'Slope', 'Curvature']

const signalColor: Record<string, string> = {
  'Very Rich':  '#ef4444',
  'Rich':       '#fca5a5',
  'Neutral':    '#94a3b8',
  'Cheap':      '#86efac',
  'Very Cheap': '#22c55e',
}

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: '16px 20px',
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function SimpleTooltip({ active, payload, label }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#94a3b8', marginBottom: 4 }}>{label}</div>
      {payload.filter(p => p.value != null).map((p, i) => (
        <div key={i} style={{ color: p.color || '#f1f5f9' }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toFixed(2) : p.value}
        </div>
      ))}
    </div>
  )
}

// ─── Cached dates (stable across renders) ────────────────────────────────────
const BDATES = generateBdates(N_DAYS)

// ─── Main component ───────────────────────────────────────────────────────────

export default function InflationPCA() {
  const navigate   = useNavigate()
  const [curveId, setCurveId]         = useState('btpei')
  const [yieldType, setYieldType]     = useState<YieldType>('real')
  const [selectedFly, setSelectedFly] = useState<string | null>(null)
  const [showAll, setShowAll]         = useState(false)
  const [nameFilter, setNameFilter]   = useState('')

  const cfg = CURVES[curveId]

  const [apiData, setApiData]       = useState<ApiResponse | null>(null)
  const [apiLoading, setApiLoading] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('access_token')
    if (!token) return
    setApiLoading(true)
    setApiData(null)
    fetch(`/api/tools/inflation-pca/${curveId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then((d: ApiResponse | null) => { setApiData(d); setApiLoading(false) })
      .catch(() => setApiLoading(false))
  }, [curveId])

  const { levels, loadings, varExplained, flies } = useMemo(() => {
    const block = apiData?.[yieldType]
    if (block) {
      const flies: FlyResult[] = block.flies.map(f => ({
        name:      f.name,
        leftIdx:   f.left_idx,
        bellyIdx:  f.belly_idx,
        rightIdx:  f.right_idx,
        wLeft:     f.w_left,
        wRight:    f.w_right,
        spreads:   f.spreads,
        current:   f.current,
        avg3m:     f.avg3m,
        std3m:     f.std3m,
        zscore:    f.zscore,
        signal:    f.signal as FlyResult['signal'],
        netDV01:   f.net_dv01,
      }))
      return { levels: block.levels, loadings: block.loadings, varExplained: block.var_explained, flies }
    }
    const levels      = generateYieldLevels(curveId, yieldType)
    const { loadings, varExplained } = runPCA(levels)
    const flies       = computeFlies(levels, loadings, cfg.bonds)
    return { levels, loadings, varExplained, flies }
  }, [curveId, yieldType, apiData])   // eslint-disable-line react-hooks/exhaustive-deps

  const activeFly = flies.find(f => f.name === selectedFly) ?? flies[0] ?? null

  // Table display logic
  const { displayRows, richCount } = useMemo(() => {
    const q = nameFilter.trim().toLowerCase()
    const pool = q ? flies.filter(f => f.name.includes(q)) : flies

    if (showAll || q) {
      const rows = pool.slice().sort((a, b) => b.zscore - a.zscore)
      return { displayRows: rows, richCount: rows.length }  // no divider in flat mode
    }

    const rich  = pool.filter(f => f.zscore > 0).sort((a, b) => b.zscore - a.zscore).slice(0, 20)
    const cheap = pool.filter(f => f.zscore < 0).sort((a, b) => a.zscore - b.zscore).slice(0, 20)
    return { displayRows: [...rich, ...cheap], richCount: rich.length }
  }, [flies, showAll, nameFilter])

  // Dynamic length — API may return a different T than N_DAYS
  const T_actual = levels.length
  const dates = apiData?.dates ?? BDATES.slice(BDATES.length - T_actual)
  const bonds = apiData?.bonds ?? cfg.bonds

  // PC loadings bar chart data
  const loadingsData = bonds.map((b, j) => ({
    bond: String(b.maturity % 100),
    PC1:  +loadings[0][j].toFixed(4),
    PC2:  +loadings[1][j].toFixed(4),
    PC3:  +loadings[2][j].toFixed(4),
  }))

  // Current real yield curve snapshot
  const curveData = bonds.map((b, j) => ({
    bond:    String(b.maturity % 100),
    current: +(levels[T_actual - 1][j] * 100).toFixed(1),   // in bps for display
    threeM:  +(levels[Math.max(0, T_actual - 63)][j] * 100).toFixed(1),
  }))

  // Selected fly spread — subsampled every 5 days
  const flyChartData = activeFly
    ? dates
        .map((date, i) => ({ date, i, spread: +activeFly.spreads[i].toFixed(2) }))
        .filter(({ i }) => i % 5 === 0 || i === T_actual - 1)
        .map(({ date, spread }) => ({ date: date.slice(5), spread }))
    : []

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#f1f5f9', fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button onClick={() => navigate('/')}
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, padding: '6px 14px', color: '#94a3b8', fontSize: 13, cursor: 'pointer' }}>
          ← Back
        </button>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>Inflation PCA</div>
          <div style={{ color: MUTED, fontSize: 11, marginTop: 1 }}>
            Inflation Markets · PCA on 1y daily yield changes ·{' '}
            {apiLoading
              ? <span style={{ color: '#64748b' }}>loading…</span>
              : apiData
                ? <span style={{ color: apiData.data_source === 'bloomberg' ? '#22c55e' : '#f59e0b' }}>
                    {apiData.data_source === 'bloomberg' ? 'Live (Bloomberg)' : 'Simulated data'}
                  </span>
                : <span style={{ color: '#64748b' }}>Simulated data</span>
            }
          </div>
        </div>
      </div>

      {/* Curve tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, zIndex: 10, background: BG }}>
        {CURVE_ORDER.map(id => (
          <button key={id} onClick={() => { setCurveId(id); setYieldType('real'); setSelectedFly(null); setShowAll(false); setNameFilter('') }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 16px', fontSize: 13, fontWeight: 500, color: curveId === id ? CURVES[id].color : '#64748b', borderBottom: curveId === id ? `2px solid ${CURVES[id].color}` : '2px solid transparent', marginBottom: -1, transition: 'color 0.15s' }}>
            {CURVES[id].label}
          </button>
        ))}
      </div>


      {/* Yield type toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {YIELD_TYPES.map(yt => (
          <button key={yt.id} onClick={() => { setYieldType(yt.id); setSelectedFly(null) }}
            title={yt.description}
            style={{ background: yieldType === yt.id ? `${cfg.color}22` : 'rgba(255,255,255,0.04)', border: `1px solid ${yieldType === yt.id ? cfg.color + '66' : 'rgba(255,255,255,0.08)'}`, borderRadius: 8, padding: '7px 20px', color: yieldType === yt.id ? cfg.color : '#64748b', fontSize: 13, fontWeight: yieldType === yt.id ? 700 : 400, cursor: 'pointer', transition: 'all 0.15s' }}>
            {yt.label}
          </button>
        ))}
        <span style={{ alignSelf: 'center', fontSize: 11, color: '#334155', marginLeft: 4 }}>
          {YIELD_TYPES.find(yt => yt.id === yieldType)?.description}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ── A. Variance explained cards ─────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {varExplained.map((v, i) => (
            <div key={i} style={cardStyle}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                PC{i+1} — {PC_NAMES[i]}
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: PC_COLORS[i] }}>{v.toFixed(1)}%</div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>variance explained (Δyields)</div>
              <div style={{ marginTop: 8, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                <div style={{ height: '100%', width: `${Math.min(v, 100)}%`, background: PC_COLORS[i], borderRadius: 2 }} />
              </div>
            </div>
          ))}
        </div>

        {/* ── B. Current curve + PC loadings side by side ──────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16 }}>

          {/* Current real yield curve */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {cfg.label} Real Yield Curve
            </div>
            <ResponsiveContainer width="100%" height={170}>
              <LineChart data={curveData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="bond" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} width={40}
                  tickFormatter={(v: number) => v.toFixed(0) + 'bp'} />
                <Tooltip content={<SimpleTooltip />} />
                <Line type="monotone" dataKey="current" stroke={cfg.color} strokeWidth={2} dot={{ r: 3, fill: cfg.color }} name="Current" />
                <Line type="monotone" dataKey="threeM"  stroke={cfg.color} strokeWidth={1.2} strokeDasharray="5 3" dot={false} name="3m ago" strokeOpacity={0.45} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* PC Loadings — 3 sub-panels */}
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 14, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              PC Loadings (from Δyield PCA)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              {loadings.map((_, pcIdx) => (
                <div key={pcIdx}>
                  <div style={{ fontSize: 11, color: PC_COLORS[pcIdx], marginBottom: 6, fontWeight: 600 }}>
                    PC{pcIdx+1} {PC_NAMES[pcIdx]} ({varExplained[pcIdx].toFixed(1)}%)
                  </div>
                  <ResponsiveContainer width="100%" height={130}>
                    <BarChart data={loadingsData} margin={{ top: 4, right: 2, bottom: 4, left: 0 }}>
                      <XAxis dataKey="bond" tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} width={28}
                        tickFormatter={(v: number) => v.toFixed(2)} />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" />
                      <Tooltip content={<SimpleTooltip />} />
                      <Bar dataKey={`PC${pcIdx+1}`} name={`PC${pcIdx+1}`}>
                        {loadingsData.map((entry, i) => (
                          <Cell key={i}
                            fill={(entry[`PC${pcIdx+1}` as keyof typeof entry] as number) >= 0 ? PC_COLORS[pcIdx] : RED}
                            fillOpacity={0.8} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── C. PCA-neutral butterfly table ───────────────────────────────── */}
        <div style={cardStyle}>

          {/* Header + filter bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>
              PCA-Neutral Butterflies
            </div>
            <div style={{ fontSize: 11, color: '#334155', flexShrink: 0 }}>
              {flies.length} flies
              {!showAll && !nameFilter && ` · showing top 20 rich + top 20 cheap`}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Fly name search */}
              <input
                value={nameFilter}
                onChange={e => setNameFilter(e.target.value)}
                placeholder="search fly, e.g. 32s35s"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '5px 10px', color: '#f1f5f9', fontSize: 12, width: 170, outline: 'none' }}
              />
              {/* Show all toggle */}
              <button
                onClick={() => setShowAll(v => !v)}
                style={{ background: showAll ? cfg.color : 'rgba(255,255,255,0.06)', border: `1px solid ${showAll ? cfg.color : 'rgba(255,255,255,0.12)'}`, borderRadius: 6, padding: '5px 12px', color: showAll ? '#fff' : '#94a3b8', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {showAll ? 'Top 20 only' : 'Show all'}
              </button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  {['Fly', 'Weights (L / −1 / R)', 'Spread (bp)', '3m Avg (bp)', 'Std (bp)', 'Z-score', 'Net DV01 ($/bp)', 'Signal'].map(h => (
                    <th key={h} style={{ textAlign: h === 'Fly' ? 'left' : 'right', padding: '6px 10px', color: MUTED, fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((fly, rowIdx) => {
                  const isActive = fly.name === activeFly?.name
                  const scol     = signalColor[fly.signal]
                  // Insert a divider between rich and cheap sections (default mode only)
                  const showDivider = !showAll && !nameFilter.trim() && rowIdx === richCount && richCount > 0
                  return (
                    <>
                      {showDivider && (
                        <tr key="divider">
                          <td colSpan={8} style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.02)', borderTop: '1px solid rgba(255,255,255,0.08)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                            <span style={{ fontSize: 10, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
                              ▼ Cheap
                            </span>
                          </td>
                        </tr>
                      )}
                      {rowIdx === 0 && !showAll && !nameFilter.trim() && richCount > 0 && (
                        <tr key="rich-label">
                          <td colSpan={8} style={{ padding: '6px 10px', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                            <span style={{ fontSize: 10, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
                              ▼ Rich
                            </span>
                          </td>
                        </tr>
                      )}
                      <tr key={fly.name} onClick={() => setSelectedFly(fly.name)}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: isActive ? 'rgba(255,255,255,0.04)' : 'transparent', cursor: 'pointer' }}>
                        <td style={{ padding: '7px 10px', color: isActive ? cfg.color : '#94a3b8', fontWeight: isActive ? 700 : 400, fontVariantNumeric: 'tabular-nums' }}>
                          {fly.name}
                        </td>
                        <td style={{ textAlign: 'right', padding: '7px 10px', color: '#64748b', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                          {fly.wLeft.toFixed(3)} / −1 / {fly.wRight.toFixed(3)}
                        </td>
                        <td style={{ textAlign: 'right', padding: '7px 10px', color: '#f1f5f9', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                          {fly.current.toFixed(1)}
                        </td>
                        <td style={{ textAlign: 'right', padding: '7px 10px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                          {fly.avg3m.toFixed(1)}
                        </td>
                        <td style={{ textAlign: 'right', padding: '7px 10px', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                          {fly.std3m.toFixed(1)}
                        </td>
                        <td style={{ textAlign: 'right', padding: '7px 10px', color: scol, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                          {fly.zscore >= 0 ? '+' : ''}{fly.zscore.toFixed(2)}σ
                        </td>
                        <td style={{ textAlign: 'right', padding: '7px 10px', color: Math.abs(fly.netDV01) < 50 ? '#22c55e' : '#f59e0b', fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
                          {fly.netDV01 >= 0 ? '+$' : '−$'}{Math.abs(fly.netDV01).toFixed(0)}
                        </td>
                        <td style={{ textAlign: 'right', padding: '7px 10px' }}>
                          <span style={{ background: `${scol}1a`, color: scol, borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                            {fly.signal}
                          </span>
                        </td>
                      </tr>
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: '#334155', marginTop: 10 }}>
            Weights are yield-space (not DV01-weighted). Net DV01 = (wL×dur_L − dur_belly + wR×dur_R) × $100 per $1MM belly notional. Approx duration = (maturity − 2026) × 0.92. Collapses to zero when DV01-weighted.
          </div>
        </div>

        {/* ── D. Selected fly detail ───────────────────────────────────────── */}
        {activeFly && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: cfg.color }}>{activeFly.name}</div>
              <div style={{ fontSize: 12, color: signalColor[activeFly.signal], fontWeight: 600 }}>
                {activeFly.current.toFixed(1)} bp &nbsp;·&nbsp;
                {activeFly.signal} &nbsp;·&nbsp;
                {activeFly.zscore >= 0 ? '+' : ''}{activeFly.zscore.toFixed(2)}σ vs 3m avg ({activeFly.avg3m.toFixed(1)} bp)
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 12 }}>
              {cfg.bonds[activeFly.leftIdx].label} ×{activeFly.wLeft.toFixed(3)}
              &ensp;/&ensp;{cfg.bonds[activeFly.bellyIdx].label} ×(−1)
              &ensp;/&ensp;{cfg.bonds[activeFly.rightIdx].label} ×{activeFly.wRight.toFixed(3)}
            </div>
            <ResponsiveContainer width="100%" height={420}>
              <LineChart data={flyChartData} margin={{ top: 8, right: 80, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false}
                  interval={Math.floor(flyChartData.length / 6)} />
                <YAxis tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} width={40}
                  tickFormatter={(v: number) => v.toFixed(1)} />
                {/* ±2σ */}
                <ReferenceLine y={activeFly.avg3m + 2 * activeFly.std3m} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5}
                  label={{ value: '+2σ', position: 'right', style: { fontSize: 9, fill: '#ef4444' } }} />
                <ReferenceLine y={activeFly.avg3m - 2 * activeFly.std3m} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.5}
                  label={{ value: '−2σ', position: 'right', style: { fontSize: 9, fill: '#22c55e' } }} />
                {/* ±1σ */}
                <ReferenceLine y={activeFly.avg3m + 1 * activeFly.std3m} stroke="#fca5a5" strokeDasharray="3 3" strokeOpacity={0.4}
                  label={{ value: '+1σ', position: 'right', style: { fontSize: 9, fill: '#fca5a5' } }} />
                <ReferenceLine y={activeFly.avg3m - 1 * activeFly.std3m} stroke="#86efac" strokeDasharray="3 3" strokeOpacity={0.4}
                  label={{ value: '−1σ', position: 'right', style: { fontSize: 9, fill: '#86efac' } }} />
                {/* 3m avg */}
                <ReferenceLine y={activeFly.avg3m} stroke="#f59e0b" strokeDasharray="4 3" strokeOpacity={0.8}
                  label={{ value: `avg ${activeFly.avg3m.toFixed(1)}bp`, position: 'right', style: { fontSize: 9, fill: '#f59e0b' } }} />
                <Tooltip content={<SimpleTooltip />} />
                <Line type="monotone" dataKey="spread" stroke={cfg.color} strokeWidth={1.5} dot={false} name="Spread (bp)" />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 10, color: '#334155', marginTop: 8 }}>
              Spread = {activeFly.wLeft.toFixed(3)} × {cfg.bonds[activeFly.leftIdx].label}
              {' '}− 1 × {cfg.bonds[activeFly.bellyIdx].label}
              {' '}+ {activeFly.wRight.toFixed(3)} × {cfg.bonds[activeFly.rightIdx].label}
              {' '}· in basis points
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
