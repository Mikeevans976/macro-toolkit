import { useEffect, useMemo, useRef, useState } from 'react'
import PageTitle, { headerBar } from '../components/PageTitle'
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Brush,
  BarChart,
  Bar,
  Cell,
} from 'recharts'

// ─── Methodology ──────────────────────────────────────────────────────────────
//
// Risk-neutral distribution of the underlying futures price at option expiry,
// extracted from a chain of call prices on an evenly spaced strike grid
// (Breeden–Litzenberger), with the grid spacing h chosen by the user:
//
//   PDF(K)  ≈ [C(K−h) − 2·C(K) + C(K+h)] / h²        (butterfly / h²)
//   CDF(K)  ≈ 1 + [C(K+h) − C(K−h)] / (2h)           (call spread / h)
//
// ICE Euribor options are premium-margined (futures-style), so no discounting.
// A wider h smooths noise in quoted prices but blurs the shape; a narrower h
// resolves more detail but amplifies price errors (watch for negative density).
//
// The option chain is SIMULATED: ECB-meeting scenarios before expiry (a discrete
// mixture) plus a Bachelier diffusion with a quadratic smile, levels drifting
// deterministically with the snapshot time. `simulateChain` is the only
// function to replace when a live / historical option-price feed is wired in.

// ─── Types ────────────────────────────────────────────────────────────────────

interface Contract {
  id: string
  label: string
  year: number
  month: number      // 1–12, contract month
  baseF: number      // reference futures price (100 − rate)
  sigma: number      // reference Bachelier normal vol, price units / yr
  skew: number       // dσ/dK relative (negative → heavier low-price / high-rate tail)
  curv: number       // smile curvature
  seed: number
  pack: PackId
  color: string
}

interface OptionExpiry {
  id: string         // "2026-11"
  label: string      // "16 Nov 26" — expiry date
  code: string       // "ERX6" — ICE option month code
  kind: 'serial' | 'quarterly' | 'standard'
  date: Date         // expiry, London wall-clock stored as UTC
}

interface DistPoint {
  strike: number
  rate: number
  pdf: number
  cdf: number
}

interface DistResult {
  F: number
  atmVol: number     // annualised normal vol at the money, price units
  T: number          // years
  h: number
  points: DistPoint[]
  stats: DistStats
}

interface DistStats {
  mass: number
  mean: number
  std: number
  skew: number
  q05: number
  q25: number
  q50: number
  q75: number
  q95: number
  negDensity: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BG     = '#07090c'
const CARD   = 'rgba(200,220,240,0.04)'
const BORDER = 'rgba(200,220,240,0.08)'
const MONO   = "'Geist Mono', ui-monospace, monospace"
const FG1 = '#e4eaf1', FG2 = '#c6ced8', FG3 = '#9aa5b1', FG4 = '#77828f'

// Quarterly packs: whites = contracts 1–4, reds = 5–8, greens = 9–12.
// Colour follows the pack (hue) and position within it (light → dark), fixed per contract.
type PackId = 'whites' | 'reds' | 'greens'
const PACKS: { id: PackId; label: string; shades: string[] }[] = [
  { id: 'whites', label: 'Whites', shades: ['#eef2f6', '#cdd5de', '#aab4bf', '#87929e'] },
  { id: 'reds',   label: 'Reds',   shades: ['#f3bfb4', '#e8a091', '#dd8270', '#c8695a'] },
  { id: 'greens', label: 'Greens', shades: ['#b5e3cf', '#8fd1b6', '#6fc2a2', '#4fa784'] },
]

// Forward-curve anchors keyed by contract month, so a contract keeps its level as it rolls
// from greens → reds → whites. Linear in between, linearly extrapolated beyond.
const F_ANCHORS: [number, number, number][] = [   // [year, month, base futures price]
  [2026, 12, 97.900], [2027, 3, 97.850], [2027, 6, 97.780], [2027, 9, 97.700],
  [2027, 12, 97.620], [2028, 3, 97.560], [2028, 6, 97.510], [2028, 9, 97.470],
  [2028, 12, 97.430], [2029, 3, 97.400], [2029, 6, 97.370], [2029, 9, 97.350],
]

// Vol / smile term structure keyed by the contract's time to expiry (years)
const VOL_TS: [number, number, number, number][] = [  // [τ, sigma, skew, curv]
  [0.18, 0.22, -0.55, 0.90], [0.43, 0.30, -0.50, 0.80], [0.68, 0.36, -0.45, 0.70], [0.93, 0.41, -0.42, 0.60],
  [1.18, 0.45, -0.40, 0.60], [1.43, 0.48, -0.38, 0.58], [1.68, 0.51, -0.36, 0.56], [1.93, 0.53, -0.35, 0.55],
  [2.18, 0.55, -0.34, 0.54], [2.43, 0.57, -0.32, 0.52], [2.68, 0.58, -0.31, 0.51], [2.93, 0.59, -0.30, 0.50],
]

function interp(x: number, xs: number[], ys: number[], extrapolate = false): number {
  const n = xs.length
  if (x <= xs[0] || x >= xs[n - 1]) {
    const [i, j] = x <= xs[0] ? [0, 1] : [n - 2, n - 1]
    if (!extrapolate) return ys[x <= xs[0] ? 0 : n - 1]
    return ys[i] + (ys[j] - ys[i]) * (x - xs[i]) / (xs[j] - xs[i])
  }
  const k = xs.findIndex(v => v >= x)
  return ys[k - 1] + (ys[k] - ys[k - 1]) * (x - xs[k - 1]) / (xs[k] - xs[k - 1])
}

const N_QUARTERLIES = 12   // whites + reds + greens

// One quarterly contract as it stands at `snap`: forward level from the calendar
// anchors, vol / smile from its time to expiry. `slot` (0–11) sets pack & colour.
function makeContract(y: number, m: number, snap: Date, slot: number): Contract {
  const tau  = (lastTradingDay(y, m).getTime() - snap.getTime()) / (365 * 864e5)
  const tauX = VOL_TS.map(v => v[0])
  const pack = PACKS[Math.min(2, Math.floor(slot / 4))]
  const id   = `ER${MONTH_CODES[m - 1]}${y % 10}`
  return {
    id, label: id, year: y, month: m,
    baseF: interp(y * 12 + m, F_ANCHORS.map(([ay, am]) => ay * 12 + am), F_ANCHORS.map(a => a[2]), true),
    sigma: interp(tau, tauX, VOL_TS.map(v => v[1])),
    skew:  interp(tau, tauX, VOL_TS.map(v => v[2])),
    curv:  interp(tau, tauX, VOL_TS.map(v => v[3])),
    seed:  (y * 12 + m) % 97 + 1,
    pack:  pack.id,
    color: pack.shades[slot % 4],
  }
}

// The 12 quarterly contracts live at the snapshot: front = first quarterly whose
// last trading day is after the snapshot. Packs and colours are positional.
function contractsAt(snap: Date): Contract[] {
  let y = snap.getUTCFullYear()
  let m = Math.ceil((snap.getUTCMonth() + 1) / 3) * 3
  if (lastTradingDay(y, m) <= snap) { m += 3; if (m > 12) { m -= 12; y += 1 } }

  const out: Contract[] = []
  for (let i = 0; i < N_QUARTERLIES; i++) {
    out.push(makeContract(y, m, snap, i))
    m += 3
    if (m > 12) { m -= 12; y += 1 }
  }
  return out
}

// Strike grid spacing (price units). 0.0625 is the listed ICE Euribor strike interval.
const WIDTHS: { h: number; label: string }[] = [
  { h: 0.0125, label: '1.25 bp' },
  { h: 0.025,  label: '2.5 bp' },
  { h: 0.0625, label: '6.25 bp' },
  { h: 0.125,  label: '12.5 bp' },
  { h: 0.25,   label: '25 bp' },
]

// Futures month codes, Jan → Dec
const MONTH_CODES = 'FGHJKMNQUVXZ'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SESSION_OPEN_H  = 1    // ICE Euribor futures & options, London time
const SESSION_CLOSE_H = 21
const EXPIRY_HOUR     = 10   // options cease trading 10:00 London on LTD

// ─── Calendar (London wall-clock, stored as UTC Date) ─────────────────────────

function londonNow(): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(p => [p.type, p.value]),
  )
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute))
}

// ─── Holiday calendars ────────────────────────────────────────────────────────
// A business day must be open in London (ICE Futures Europe) AND a TARGET day
// (Euribor fixing published). Special one-off UK holidays are not modelled.

// Easter Sunday (anonymous Gregorian algorithm), as [month 1–12, day]
function easterSunday(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  return [month, ((h + l - 7 * m + 114) % 31) + 1]
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

function nthWeekday(y: number, m: number, dow: number, n: number): number {     // n-th (1-based) or last (n = -1)
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
    return 1 + ((dow - first + 7) % 7) + 7 * (n - 1)
  }
  const lastDay = new Date(Date.UTC(y, m, 0))
  return lastDay.getUTCDate() - ((lastDay.getUTCDay() - dow + 7) % 7)
}

const _holidayCache = new Map<number, Set<string>>()

function holidays(y: number): Set<string> {
  const hit = _holidayCache.get(y)
  if (hit) return hit
  const out = new Set<string>()
  const [em, ed] = easterSunday(y)
  const easter = Date.UTC(y, em - 1, ed)
  const offset = (days: number) => new Date(easter + days * 864e5)
  const add = (dt: Date) => out.add(dt.toISOString().slice(0, 10))

  // TARGET: New Year, Good Friday, Easter Monday, 1 May, 25 & 26 Dec
  out.add(ymd(y, 1, 1)); add(offset(-2)); add(offset(1)); out.add(ymd(y, 5, 1)); out.add(ymd(y, 12, 25)); out.add(ymd(y, 12, 26))

  // England & Wales bank holidays (weekend dates roll to the next free weekday)
  const dowOf = (m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const ny = dowOf(1, 1)
  out.add(ymd(y, 1, ny === 6 ? 3 : ny === 0 ? 2 : 1))
  out.add(ymd(y, 5, nthWeekday(y, 5, 1, 1)))        // early May
  out.add(ymd(y, 5, nthWeekday(y, 5, 1, -1)))       // spring
  out.add(ymd(y, 8, nthWeekday(y, 8, 1, -1)))       // summer
  const xmas = dowOf(12, 25)
  if (xmas === 6) { out.add(ymd(y, 12, 27)); out.add(ymd(y, 12, 28)) }        // Sat → Mon/Tue
  else if (xmas === 0) { out.add(ymd(y, 12, 27)) }                             // Sun → Tue (Boxing on Mon)
  else if (xmas === 5) { out.add(ymd(y, 12, 28)) }                             // Boxing Sat → Mon

  _holidayCache.set(y, out)
  return out
}

function isBusinessDay(d: Date): boolean {
  const dow = d.getUTCDay()
  return dow !== 0 && dow !== 6 && !holidays(d.getUTCFullYear()).has(d.toISOString().slice(0, 10))
}

// Last trading day: two business days before the third Wednesday of the month
// (normally the Monday; earlier when a holiday intervenes, e.g. Easter Monday)
function lastTradingDay(year: number, month: number): Date {
  const d = new Date(Date.UTC(year, month - 1, nthWeekday(year, month, 3, 3), EXPIRY_HOUR, 0))
  let back = 0
  while (back < 2) {
    d.setUTCDate(d.getUTCDate() - 1)
    if (isBusinessDay(d)) back++
  }
  return d
}

// Snap to the last moment the market was open (weekends, holidays, outside session hours)
function snapToSession(d: Date): Date {
  const s = new Date(d)
  for (let i = 0; i < 12; i++) {
    const hr = s.getUTCHours() + s.getUTCMinutes() / 60
    if (!isBusinessDay(s) || hr < SESSION_OPEN_H) {
      s.setUTCDate(s.getUTCDate() - 1)
      s.setUTCHours(SESSION_CLOSE_H, 0, 0, 0)
    } else if (hr > SESSION_CLOSE_H) {
      s.setUTCHours(SESSION_CLOSE_H, 0, 0, 0)
    } else break
  }
  return s
}

function contractExpiry(c: Contract): Date {
  return lastTradingDay(c.year, c.month)
}

// Monthly option expiries after the snapshot, up to the contract's own expiry (max 12)
function optionExpiries(c: Contract, snap: Date): OptionExpiry[] {
  const out: OptionExpiry[] = []
  const end = contractExpiry(c)
  let y = snap.getUTCFullYear(), m = snap.getUTCMonth() + 1
  for (let i = 0; i < 15 && out.length < 12; i++) {
    const d = lastTradingDay(y, m)
    if (d > end) break
    if (d > snap) {
      const isOwn = y === c.year && m === c.month
      out.push({
        id: `${y}-${String(m).padStart(2, '0')}`,
        label: `${d.getUTCDate()} ${MONTHS[m - 1]} ${String(y).slice(2)}`,   // last trading day, e.g. "19 Oct 26"
        code: `ER${MONTH_CODES[m - 1]}${y % 10}`,
        kind: isOwn ? 'standard' : m % 3 === 0 ? 'quarterly' : 'serial',
        date: d,
      })
    }
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

const fmtSnap = (d: Date) =>
  `${d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })} ` +
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} London`

const toDateInput = (d: Date) => d.toISOString().slice(0, 10)
const toTimeInput = (d: Date) => d.toISOString().slice(11, 16)

// ─── Simulated market ─────────────────────────────────────────────────────────

// Smooth deterministic noise in time: sum of sinusoids, distinct per seed
function wiggle(hours: number, seed: number): number {
  const periods = [9, 37, 190, 820]
  const amps    = [0.10, 0.20, 0.35, 0.35]
  return periods.reduce((acc, p, k) =>
    acc + amps[k] * Math.sin(hours / p + seed * (k + 1) * 1.7 + k), 0)
}

function marketAt(c: Contract, snap: Date): { F: number; sigma: number } {
  const hours = snap.getTime() / 3.6e6
  const common = wiggle(hours, 0)          // curve-wide level move
  const own    = wiggle(hours, c.seed)
  const F      = c.baseF + 0.16 * common + 0.04 * own
  const sigma  = c.sigma * (1 + 0.12 * wiggle(hours, c.seed + 11))
  return { F, sigma }
}

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.39894228 * Math.exp(-0.5 * x * x)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
}

function bachelierCall(F: number, K: number, T: number, vol: number): number {
  if (T <= 0 || vol <= 0) return Math.max(F - K, 0)
  const w = vol * Math.sqrt(T)
  const d = (F - K) / w
  return (F - K) * normCdf(d) + w * Math.exp(-0.5 * d * d) / Math.sqrt(2 * Math.PI)
}

// Call prices on the strike grid — the single seam for real data
function simulateChain(c: Contract, snap: Date, expiry: Date, strikes: number[]) {
  const { F, sigma } = marketAt(c, snap)
  const T = Math.max((expiry.getTime() - snap.getTime()) / (365 * 864e5), 1 / (365 * 24))
  // ECB meetings decided before expiry make the terminal rate a mixture of discrete outcomes;
  // the remaining uncertainty is a Bachelier diffusion with the contract's smile.
  const scen = simScenarios(c, snap, expiry)
  const EJ   = scen.reduce((a, s) => a + s.p * s.j, 0)
  const varJ = scen.reduce((a, s) => a + s.p * (s.j - EJ) ** 2, 0) / 1e4            // price units²
  const sRes = Math.sqrt(Math.max(sigma * sigma * T - varJ, (0.55 * sigma) ** 2 * T) / T)
  const smile = (K: number, Fj: number) => {
    const x = (K - Fj) / (sRes * Math.sqrt(T))       // moneyness in std devs
    return Math.max(0.02, sRes * (1 + c.skew * 0.1 * x + c.curv * 0.02 * x * x))
  }
  // Scenario forwards keep the mixture mean at F: a higher rate outcome is a lower price
  const comps = scen.map(sc => ({ p: sc.p, Fj: F - (sc.j - EJ) / 100 }))
  return {
    F, atmVol: sigma, T,
    calls: strikes.map(K => comps.reduce((a, { p, Fj }) => a + p * bachelierCall(Fj, K, T, smile(K, Fj)), 0)),
  }
}

// ─── Breeden–Litzenberger ─────────────────────────────────────────────────────

function quantile(points: DistPoint[], p: number): number {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    if (a.cdf <= p && b.cdf >= p) {
      const w = b.cdf > a.cdf ? (p - a.cdf) / (b.cdf - a.cdf) : 0
      return a.strike + w * (b.strike - a.strike)
    }
  }
  return p < 0.5 ? points[0].strike : points[points.length - 1].strike
}

function extractDistribution(c: Contract, snap: Date, expiry: Date, h: number): DistResult {
  const { F: F0, sigma: s0 } = marketAt(c, snap)
  const T0   = Math.max((expiry.getTime() - snap.getTime()) / (365 * 864e5), 1 / (365 * 24))
  const half = Math.max(0.25, 6 * s0 * Math.sqrt(T0))           // ±6σ covers the tails
  const lo   = Math.floor((F0 - half) / h) * h
  const n    = Math.ceil((2 * half) / h) + 2
  const strikes = Array.from({ length: n + 1 }, (_, i) => +(lo + i * h).toFixed(6))

  const { F, atmVol, T, calls } = simulateChain(c, snap, expiry, strikes)

  const points: DistPoint[] = []
  for (let i = 1; i < strikes.length - 1; i++) {
    const K = strikes[i]
    points.push({
      strike: K,
      rate: 100 - K,
      pdf: (calls[i - 1] - 2 * calls[i] + calls[i + 1]) / (h * h),
      cdf: Math.min(1, Math.max(0, 1 + (calls[i + 1] - calls[i - 1]) / (2 * h))),
    })
  }

  const mass = points.reduce((a, p) => a + p.pdf, 0) * h
  const mean = points.reduce((a, p) => a + p.strike * p.pdf, 0) * h / mass
  const m2   = points.reduce((a, p) => a + (p.strike - mean) ** 2 * p.pdf, 0) * h / mass
  const m3   = points.reduce((a, p) => a + (p.strike - mean) ** 3 * p.pdf, 0) * h / mass
  const std  = Math.sqrt(m2)

  return {
    F, atmVol, T, h, points,
    stats: {
      mass, mean, std,
      skew: std > 0 ? m3 / std ** 3 : 0,
      q05: quantile(points, 0.05), q25: quantile(points, 0.25), q50: quantile(points, 0.50),
      q75: quantile(points, 0.75), q95: quantile(points, 0.95),
      negDensity: points.filter(p => p.pdf < -1e-9).length,
    },
  }
}

// Express a point on the requested axis: futures price, or implied rate (100 − price)
type AxisMode = 'price' | 'rate'

function toAxis(points: DistPoint[], mode: AxisMode) {
  if (mode === 'price') return points.map(p => ({ x: p.strike, pdf: p.pdf, cdf: p.cdf, strike: p.strike, rate: p.rate }))
  // In rate space the density is unchanged; P(rate ≤ r) = 1 − P(price < 100 − r)
  return [...points].reverse().map(p => ({ x: p.rate, pdf: p.pdf, cdf: 1 - p.cdf, strike: p.strike, rate: p.rate }))
}

// ─── Shared UI bits ───────────────────────────────────────────────────────────

const card: React.CSSProperties = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 6 }

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: FG3, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', minWidth: 86 }}>
      {children}
    </span>
  )
}

function Chip({ active, onClick, children, color, title }: {
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

const inputStyle: React.CSSProperties = {
  background: 'rgba(106,169,204,0.08)', border: '1px solid rgba(106,169,204,0.2)', borderRadius: 6,
  padding: '4px 10px', color: '#a9d2e8', fontSize: 12, fontFamily: MONO, outline: 'none', colorScheme: 'dark',
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: '10px 14px', minWidth: 0 }}>
      <div style={{ color: FG4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ color: FG1, fontSize: 15, fontFamily: MONO, whiteSpace: 'nowrap' }}>{value}</div>
      {sub && <div style={{ color: FG4, fontSize: 10, fontFamily: MONO, marginTop: 2, whiteSpace: 'nowrap' }}>{sub}</div>}
    </div>
  )
}

// Round-number ticks spanning [lo, hi]
function niceTicks(lo: number, hi: number, target = 6): number[] {
  if (!(hi > lo)) return [lo]
  const raw  = (hi - lo) / target
  const mag  = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6))
  return out
}

// Density axis: round ticks from 0 with the top tick at or above the peak
function pdfAxis(peak: number): { domain: [number, number]; ticks: number[] } {
  const target = (peak > 0 ? peak : 1) * 1.04
  const t = niceTicks(0, target, 4)
  const step = t.length > 1 ? t[1] - t[0] : target
  const top = +(Math.ceil(target / step) * step).toFixed(6)
  return { domain: [0, top], ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(6)) }
}

const peakOf = (rows: Record<string, number>[], suffix: string) =>
  rows.reduce((m, r) => Math.max(m, ...Object.entries(r).filter(([k]) => k.endsWith(suffix)).map(([, v]) => v)), 0)

const axisProps = {
  stroke: 'rgba(150,178,205,0.14)',
  tick: { fill: FG3, fontSize: 10, fontFamily: MONO },
  tickLine: false,
}

// ─── Snapshot / width controls (shared by both tabs) ──────────────────────────

function SnapshotControls({ snapDate, snapTime, onDate, onTime, onNow, h, onWidth, effective, requested, showWidth = true }: {
  showWidth?: boolean
  snapDate: string; snapTime: string
  onDate: (v: string) => void; onTime: (v: string) => void; onNow: () => void
  h: number; onWidth: (h: number) => void
  effective: Date; requested: Date
}) {
  const snapped = effective.getTime() !== requested.getTime()
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Label>Snapshot</Label>
        <input type="date" value={snapDate} max={toDateInput(londonNow())} onChange={e => e.target.value && onDate(e.target.value)} style={inputStyle} />
        <input type="time" value={snapTime} step={300} onChange={e => e.target.value && onTime(e.target.value)} style={inputStyle} />
        <span style={{ color: FG4, fontSize: 11 }}>London</span>
        <button onClick={onNow} style={{ ...inputStyle, background: 'rgba(200,220,240,0.05)', border: `1px solid ${BORDER}`, color: FG2, cursor: 'pointer', fontFamily: 'inherit' }}>
          Now
        </button>
        {snapped && (
          <span style={{ color: '#dfbb78', fontSize: 11 }}>
            Market closed — using last trade time {fmtSnap(effective)}
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
        <span style={{ color: FG4, fontSize: 11 }}>spacing h between strikes in the butterfly / call-spread estimators</span>
      </div>}
    </>
  )
}

// ─── Tab 1 — PDF & CDF ────────────────────────────────────────────────────────

function DistTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, padding: '8px 12px', fontSize: 11, fontFamily: MONO }}>
      <div style={{ color: FG1, marginBottom: 4 }}>K {d.strike.toFixed(4)} · {d.rate.toFixed(3)}%</div>
      <div style={{ color: FG3 }}>PDF <span style={{ color: FG1 }}>{d.pdf.toFixed(3)}</span></div>
      <div style={{ color: FG3 }}>CDF <span style={{ color: FG1 }}>{(d.cdf * 100).toFixed(1)}%</span></div>
    </div>
  )
}

function DistributionTab({ contracts, contract, setContract, expiryId, setExpiryId, snap, h, axis, setAxis, controls }: {
  contracts: Contract[]
  contract: Contract; setContract: (c: Contract) => void
  expiryId: string | null; setExpiryId: (id: string) => void
  snap: Date; h: number
  axis: AxisMode; setAxis: (a: AxisMode) => void
  controls: React.ReactNode
}) {
  const expiries = useMemo(() => optionExpiries(contract, snap), [contract, snap])
  const expiry   = expiries.find(e => e.id === expiryId) ?? expiries[0] ?? null
  const dist     = useMemo(() => expiry ? extractDistribution(contract, snap, expiry.date, h) : null, [contract, snap, expiry, h])
  const data     = useMemo(() => dist ? toAxis(dist.points, axis) : [], [dist, axis])

  const atmX   = dist ? (axis === 'price' ? dist.F : 100 - dist.F) : 0
  const xTicks = useMemo(() => data.length ? niceTicks(data[0].x, data[data.length - 1].x) : [], [data])
  const fmtX   = (v: number) => v.toFixed(axis === 'price' ? 3 : 2)
  const xLabel = axis === 'price' ? 'Futures price at expiry' : 'Implied 3m Euribor at expiry (%)'
  const s      = dist?.stats
  const pX     = (q: number) => axis === 'price' ? q : 100 - q          // price quantile → axis units

  // Rate-space quantiles: the p-quantile of the rate is 100 − the (1−p)-quantile of the price
  const rq = s ? { q05: 100 - s.q95, q25: 100 - s.q75, q50: 100 - s.q50, q75: 100 - s.q25, q95: 100 - s.q05 } : null

  return (
    <>
      <div style={{ ...card, padding: '16px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Underlying</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {PACKS.map(pk => (
            <div key={pk.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ color: pk.shades[2], fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', width: 46 }}>{pk.label}</span>
              {contracts.filter(c => c.pack === pk.id).map(c => {
                const { F } = marketAt(c, snap)
                return (
                  <Chip key={c.id} active={c.id === contract.id} onClick={() => setContract(c)}>
                    {c.label}<span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11, fontFamily: MONO }}>{F.toFixed(3)}</span>
                  </Chip>
                )
              })}
            </div>
          ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Expiry</Label></span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
          {expiries.length === 0 && <span style={{ color: FG3, fontSize: 12 }}>No live option expiries for {contract.label} at this snapshot</span>}
          {expiries.map(e => (
            <Chip key={e.id} active={e.id === expiry?.id} onClick={() => setExpiryId(e.id)}
              title={`${e.code} · ${e.kind} · expires ${e.date.toISOString().slice(0, 10)} 10:00 London`}>
              <span style={{ fontFamily: MONO }}>{e.code}</span>
              <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{e.label}</span>
              <span style={{ marginLeft: 5, opacity: 0.5, fontSize: 10 }}>{e.kind === 'serial' ? 'S' : e.kind === 'quarterly' ? 'Q' : '●'}</span>
            </Chip>
          ))}
        </div>
        </div>
        {controls}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Label>Axis</Label>
          <Chip active={axis === 'price'} onClick={() => setAxis('price')}>Futures price</Chip>
          <Chip active={axis === 'rate'} onClick={() => setAxis('rate')}>Implied rate</Chip>
        </div>
      </div>

      {dist && s && expiry ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, marginBottom: 16 }}>
            {/* PDF */}
            <div style={{ ...card, padding: '16px 16px 8px' }}>
              <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Probability density</div>
              <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                {expiry.code} ({expiry.label}) options on {contract.label} · butterfly / h²
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={data} margin={{ top: 10, right: 16, left: 4, bottom: 24 }}>
                  <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                  <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps}
                    label={{ value: xLabel, position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                  <YAxis {...pdfAxis(Math.max(...data.map(d => d.pdf)))} tickFormatter={(v: number) => (+v.toFixed(2)).toString()} width={40} {...axisProps} />
                  <Tooltip content={<DistTooltip />} cursor={{ stroke: 'rgba(200,220,240,0.25)' }} />
                  <ReferenceLine y={0} stroke="rgba(150,178,205,0.2)" />
                  <ReferenceLine x={atmX} stroke="rgba(200,220,240,0.45)" strokeDasharray="5 3"
                    label={{ value: `F ${fmtX(atmX)}`, position: 'insideTopRight', fill: FG2, fontSize: 10 }} />
                  <Area type="monotone" dataKey="pdf" stroke={contract.color} fill={contract.color} fillOpacity={0.18}
                    strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* CDF */}
            <div style={{ ...card, padding: '16px 16px 8px' }}>
              <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Cumulative distribution</div>
              <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                {axis === 'price' ? 'P(price ≤ x)' : 'P(rate ≤ x)'} · 1 + call spread / h
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={data} margin={{ top: 10, right: 16, left: 4, bottom: 24 }}>
                  <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                  <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps}
                    label={{ value: xLabel, position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                  <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} width={40} {...axisProps} />
                  <Tooltip content={<DistTooltip />} cursor={{ stroke: 'rgba(200,220,240,0.25)' }} />
                  {[0.05, 0.5, 0.95].map(p => (
                    <ReferenceLine key={p} y={p} stroke="rgba(150,178,205,0.16)" strokeDasharray="2 4" />
                  ))}
                  <ReferenceLine x={atmX} stroke="rgba(200,220,240,0.45)" strokeDasharray="5 3"
                    label={{ value: `F ${fmtX(atmX)}`, position: 'insideTopLeft', fill: FG2, fontSize: 10 }} />
                  <Line type="monotone" dataKey="cdf" stroke={contract.color} strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Summary */}
          <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
            <Stat label="Futures" value={dist.F.toFixed(3)} sub={`${(100 - dist.F).toFixed(3)}%`} />
            <Stat label="Time to expiry" value={`${(dist.T * 365).toFixed(1)} d`} sub={`${dist.T.toFixed(3)} y`} />
            <Stat label="ATM normal vol" value={`${(dist.atmVol * 100).toFixed(0)} bp`} sub="annualised" />
            <Stat label="Mean" value={fmtX(pX(s.mean))} sub={`vs F ${((s.mean - dist.F) * 100).toFixed(1)} bp`} />
            <Stat label="Std dev" value={`${(s.std * 100).toFixed(1)} bp`} />
            <Stat label="Skew" value={(axis === 'price' ? s.skew : -s.skew).toFixed(2)} sub={axis === 'price' ? 'price space' : 'rate space'} />
            <Stat label="Median" value={fmtX(axis === 'price' ? s.q50 : rq!.q50)} />
            <Stat label="25–75%" value={axis === 'price' ? `${fmtX(s.q25)}–${fmtX(s.q75)}` : `${fmtX(rq!.q25)}–${fmtX(rq!.q75)}`} />
            <Stat label="5–95%" value={axis === 'price' ? `${fmtX(s.q05)}–${fmtX(s.q95)}` : `${fmtX(rq!.q05)}–${fmtX(rq!.q95)}`} />
            <Stat label="Mass captured" value={`${(s.mass * 100).toFixed(1)}%`}
              sub={s.negDensity ? `${s.negDensity} neg. density pts` : 'no neg. density'} />
          </div>
          <p style={{ color: FG4, fontSize: 10, marginTop: 10 }}>
            Snapshot {fmtSnap(snap)} · {expiry.code} expiry {expiry.date.toISOString().slice(0, 10)} 10:00 London ·
            {' '}{dist.points.length} strikes at h = {h.toFixed(4)}. Risk-neutral (no risk-premium adjustment).
            Options premium-margined, so undiscounted. Simulated option chain.
          </p>
        </>
      ) : (
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>
          No option expiries available for {contract.label} at this snapshot.
        </div>
      )}
    </>
  )
}

// ─── Tab 2 — Cross-time comparisons ───────────────────────────────────────────

interface CrossTimeState {
  contractId: string | null
  expiryId: string | null
  dates: string[] | null        // comparison snapshots "YYYY-MM-DDTHH:MM" (London); null → defaults
}

const MAX_DATES = 6             // including the reference snapshot
const PRESETS: { key: string; label: string; shift: (d: Date) => void }[] = [
  { key: '1D', label: '−1D', shift: d => d.setUTCDate(d.getUTCDate() - 1) },
  { key: '1W', label: '−1W', shift: d => d.setUTCDate(d.getUTCDate() - 7) },
  { key: '1M', label: '−1M', shift: d => d.setUTCMonth(d.getUTCMonth() - 1) },
  { key: '3M', label: '−3M', shift: d => d.setUTCMonth(d.getUTCMonth() - 3) },
  { key: '6M', label: '−6M', shift: d => d.setUTCMonth(d.getUTCMonth() - 6) },
]

const toKey = (d: Date) => d.toISOString().slice(0, 16)
const fromKey = (k: string) => new Date(`${k}:00Z`)

function presetKey(ref: Date, key: string): string {
  const d = new Date(ref)
  PRESETS.find(p => p.key === key)!.shift(d)
  return toKey(d)
}

// Single-hue (glacier) ramp: oldest faint → reference brightest
function timeRamp(n: number): string[] {
  const a = [0x3f, 0x5b, 0x6e], b = [0xa9, 0xd8, 0xef]
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 1 : i / (n - 1)
    return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * t).toString(16).padStart(2, '0')).join('')
  })
}

const fmtShort = (d: Date) =>
  `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' })} ` +
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

function CrossTimeTab({ contracts, snap, h, axis, setAxis, controls, state, setState }: {
  contracts: Contract[]; snap: Date; h: number
  axis: AxisMode; setAxis: (a: AxisMode) => void
  controls: React.ReactNode
  state: CrossTimeState; setState: (f: (s: CrossTimeState) => CrossTimeState) => void
}) {
  const [draftDate, setDraftDate] = useState('')
  const [draftTime, setDraftTime] = useState(toTimeInput(snap))

  const contract = contracts.find(c => c.id === state.contractId) ?? contracts[1]
  const expiries = useMemo(() => optionExpiries(contract, snap), [contract, snap])
  const expiry   = expiries.find(e => e.id === state.expiryId) ?? expiries[Math.min(2, expiries.length - 1)] ?? null

  const compKeys = state.dates ?? ['1W', '1M', '3M'].map(k => presetKey(snap, k))

  // Resolve: snap each to a trading moment, keep those before the option expiry, dedupe, sort
  const snapshots = useMemo(() => {
    const now = londonNow()
    const seen = new Map<number, { at: Date; key: string | null }>()
    seen.set(snap.getTime(), { at: snap, key: null })
    compKeys.forEach(k => {
      const raw = fromKey(k)
      if (isNaN(raw.getTime())) return
      const at = snapToSession(raw > now ? now : raw)
      if (expiry && at >= expiry.date) return
      if (!seen.has(at.getTime())) seen.set(at.getTime(), { at, key: k })
    })
    return [...seen.values()].sort((a, b) => a.at.getTime() - b.at.getTime()).slice(-MAX_DATES)
  }, [compKeys.join(','), snap, expiry])

  const colors = timeRamp(snapshots.length)

  const series = useMemo(() => {
    if (!expiry) return []
    return snapshots.map(({ at, key }, i) => {
      const c = makeContract(contract.year, contract.month, at, 0)
      return {
        id: String(at.getTime()), key, at, isRef: key === null,
        name: key === null ? `${fmtShort(at)} (ref)` : fmtShort(at),
        color: colors[i],
        dist: extractDistribution(c, at, expiry.date, h),
      }
    })
  }, [snapshots, contract, expiry, h])

  const merged = useMemo(() => {
    const rows = new Map<number, Record<string, number>>()
    series.forEach(s => toAxis(s.dist.points, axis).forEach(p => {
      const x = +p.x.toFixed(6)
      const row = rows.get(x) ?? { x }
      row[`${s.id}_pdf`] = p.pdf
      row[`${s.id}_cdf`] = p.cdf
      rows.set(x, row)
    }))
    return [...rows.values()].sort((a, b) => a.x - b.x)
  }, [series, axis])

  const fmtX   = (v: number) => v.toFixed(axis === 'price' ? 3 : 2)
  const xTicks = merged.length ? niceTicks(merged[0].x, merged[merged.length - 1].x) : []
  const ref    = series.find(s => s.isRef)

  const setDates = (f: (keys: string[]) => string[]) => setState(s => ({ ...s, dates: f(compKeys) }))
  const addKey = (k: string) => setDates(keys => keys.includes(k) || keys.length >= MAX_DATES - 1 ? keys : [...keys, k])
  const full   = compKeys.length >= MAX_DATES - 1

  // Stats in axis units: price quantile p ↔ rate quantile 1−p
  const median = (st: DistStats) => axis === 'price' ? st.q50 : 100 - st.q50
  const band   = (st: DistStats) => axis === 'price' ? [st.q05, st.q95] : [100 - st.q95, 100 - st.q05]
  const fwd    = (F: number) => axis === 'price' ? F : 100 - F
  const dBp    = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}`

  const chart = (kind: 'pdf' | 'cdf') => (
    <div style={{ ...card, padding: '16px 16px 8px' }}>
      <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>
        {kind === 'pdf' ? 'Probability density' : 'Cumulative distribution'}
      </div>
      <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
        {expiry?.code} options on {contract.label} · {series.length} snapshots
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={merged} margin={{ top: 10, right: 16, left: 4, bottom: 24 }}>
          <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
          <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps}
            label={{ value: axis === 'price' ? 'Futures price at expiry' : 'Implied rate at expiry (%)', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
          <YAxis width={40} {...axisProps}
            {...(kind === 'cdf'
              ? { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1], tickFormatter: (v: number) => `${(v * 100).toFixed(0)}%` }
              : { ...pdfAxis(peakOf(merged, '_pdf')), tickFormatter: (v: number) => (+v.toFixed(2)).toString() })} />
          <Tooltip
            contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
            labelFormatter={(v: number) => fmtX(Number(v))}
            formatter={(v: number, name: string) => [kind === 'cdf' ? `${(v * 100).toFixed(1)}%` : v.toFixed(3), name]}
          />
          {ref && (
            <ReferenceLine x={fwd(ref.dist.F)} stroke="rgba(200,220,240,0.35)" strokeDasharray="5 3"
              label={{ value: `F ref ${fmtX(fwd(ref.dist.F))}`, position: kind === 'pdf' ? 'insideTopRight' : 'insideTopLeft', fill: FG3, fontSize: 10 }} />
          )}
          {series.map(s => (
            <Line key={s.id} type="monotone" dataKey={`${s.id}_${kind}`} name={s.name} stroke={s.color}
              strokeWidth={s.isRef ? 2.5 : 1.6} dot={false} connectNulls isAnimationActive={false} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )

  return (
    <>
      <div style={{ ...card, padding: '16px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Underlying</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {PACKS.map(pk => (
              <div key={pk.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: pk.shades[2], fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', width: 46 }}>{pk.label}</span>
                {contracts.filter(c => c.pack === pk.id).map(c => (
                  <Chip key={c.id} active={c.id === contract.id}
                    onClick={() => setState(s => ({ ...s, contractId: c.id, expiryId: null }))}>{c.label}</Chip>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Expiry</Label></span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
            {expiries.map(e => (
              <Chip key={e.id} active={e.id === expiry?.id} onClick={() => setState(s => ({ ...s, expiryId: e.id }))}
                title={`${e.code} · ${e.kind} · expires ${e.date.toISOString().slice(0, 10)} 10:00 London`}>
                <span style={{ fontFamily: MONO }}>{e.code}</span>
                <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{e.label}</span>
              </Chip>
            ))}
          </div>
        </div>
        {controls}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Compare to</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {series.map(s => (
                <span key={s.id} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 10px', borderRadius: 6,
                  border: `1px solid ${BORDER}`, background: 'rgba(200,220,240,0.03)', fontSize: 12, fontFamily: MONO, color: FG2,
                }}>
                  <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke={s.color} strokeWidth={s.isRef ? 3 : 2} /></svg>
                  {s.name}
                  {s.isRef
                    ? <span style={{ color: FG4, fontSize: 10, padding: '0 4px', fontFamily: 'inherit' }} title="Set by the snapshot control above">fixed</span>
                    : <button onClick={() => setDates(keys => keys.filter(k => k !== s.key))} title="Remove"
                        style={{ background: 'none', border: 'none', color: FG3, cursor: 'pointer', fontSize: 13, padding: '0 4px' }}>×</button>}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {PRESETS.map(p => (
                <Chip key={p.key} active={false} onClick={() => addKey(presetKey(snap, p.key))}
                  title={full ? `Up to ${MAX_DATES} snapshots` : `Add the snapshot ${p.label.slice(1)} before the reference`}>
                  {p.label}
                </Chip>
              ))}
              <span style={{ width: 8 }} />
              <input type="date" value={draftDate} max={toDateInput(snap)} onChange={e => setDraftDate(e.target.value)} style={inputStyle} />
              <input type="time" value={draftTime} step={300} onChange={e => e.target.value && setDraftTime(e.target.value)} style={inputStyle} />
              <button disabled={!draftDate || full} onClick={() => { addKey(`${draftDate}T${draftTime}`); setDraftDate('') }}
                style={{ ...inputStyle, background: 'rgba(200,220,240,0.05)', border: `1px solid ${BORDER}`, color: FG2,
                  cursor: draftDate && !full ? 'pointer' : 'default', opacity: draftDate && !full ? 1 : 0.5, fontFamily: 'inherit' }}>
                Add date
              </button>
              {full && <span style={{ color: FG4, fontSize: 11 }}>Max {MAX_DATES} snapshots — remove one to add another</span>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Label>Axis</Label>
          <Chip active={axis === 'price'} onClick={() => setAxis('price')}>Futures price</Chip>
          <Chip active={axis === 'rate'} onClick={() => setAxis('rate')}>Implied rate</Chip>
        </div>
      </div>

      {!expiry || series.length === 0 ? (
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>
          No option expiries for {contract.label} at the reference snapshot.
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, marginBottom: 16 }}>
            {chart('pdf')}
            {chart('cdf')}
          </div>
          <div style={{ ...card, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: FG3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {['Snapshot', 'Futures', 'Days', 'ATM vol', 'Std dev', 'Skew', 'Median', '5–95%', 'Median Δ since', 'Std Δ since'].map((c, i) => (
                    <th key={c} style={{ padding: '10px 14px', textAlign: i === 0 ? 'left' : 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {series.map(({ id, name, color, isRef, dist }) => {
                  const st = dist.stats
                  const [lo, hi] = band(st)
                  const dMed = ref ? median(ref.dist.stats) - median(st) : 0
                  const dStd = ref ? ref.dist.stats.std - st.std : 0
                  const td: React.CSSProperties = { padding: '8px 14px', textAlign: 'right', color: FG2, whiteSpace: 'nowrap' }
                  return (
                    <tr key={id} style={{ borderTop: `1px solid ${BORDER}`, fontFamily: MONO }}>
                      <td style={{ ...td, textAlign: 'left', color: FG1 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth={isRef ? 3 : 2} /></svg>{name}
                        </span>
                      </td>
                      <td style={td}>{fmtX(fwd(dist.F))}</td>
                      <td style={td}>{(dist.T * 365).toFixed(0)}</td>
                      <td style={td}>{(dist.atmVol * 100).toFixed(0)} bp</td>
                      <td style={td}>{(st.std * 100).toFixed(1)} bp</td>
                      <td style={td}>{(axis === 'price' ? st.skew : -st.skew).toFixed(2)}</td>
                      <td style={td}>{fmtX(median(st))}</td>
                      <td style={td}>{fmtX(lo)}–{fmtX(hi)}</td>
                      <td style={{ ...td, color: isRef ? FG4 : FG2 }}>{isRef ? '—' : `${dBp(dMed)} bp`}</td>
                      <td style={{ ...td, color: isRef ? FG4 : FG2 }}>{isRef ? '—' : `${dBp(dStd)} bp`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ color: FG4, fontSize: 10, marginTop: 10 }}>
            Each snapshot re-extracts the same {expiry.code} options on {contract.label} with that day's forward, vol and time to expiry.
            Snapshots outside trading hours snap to the previous close. “Δ since” = reference minus that snapshot, i.e. how far it has moved since then, in {axis === 'price' ? 'price' : 'rate'} terms. Simulated option chain.
          </p>
        </>
      )}
    </>
  )
}

// ─── Tab 3 — Cross-section ────────────────────────────────────────────────────
//
// One snapshot, many (underlying, expiry) pairs: a base PDF (shaded) against
// overlays that can differ in expiry, underlying, or both — plus each overlay's
// difference from the base. "Centred" puts every distribution on its own
// forward (bp from F) so shapes can be compared across underlyings.

interface SeriesRef { contractId: string; expiryId: string }

interface CrossSectionState {
  base: SeriesRef | null           // null → 2nd contract, its standard expiry
  overlays: SeriesRef[] | null     // null → the two expiries before the base, same underlying
  centred: boolean
  measure: 'pdf' | 'cdf'
}

const MAX_OVERLAYS = 4
// Fixed categorical order for overlays (base is the glacier fill)
const OVERLAY_COLORS = ['#d6ad66', '#6fc2a2', '#b79fdb', '#dd8a7d']

const seriesName = (c: Contract, e: OptionExpiry) => (e.code === c.id ? c.id : `${e.code} on ${c.id}`)

function defaultExpiry(exps: OptionExpiry[]): OptionExpiry | undefined {
  return exps.find(e => e.kind === 'standard') ?? exps[exps.length - 1]
}

type AxisPoint = { x: number; pdf: number; cdf: number }

// Points on the chosen axis; centred → bp from the series' own forward.
// CDF is P(price ≤ x) on the price axis and P(rate ≤ x) on the rate axis.
function axisPoints(dist: DistResult, axis: AxisMode, centred: boolean): AxisPoint[] {
  const pts = dist.points.map(p => {
    const x = centred
      ? (axis === 'price' ? (p.strike - dist.F) * 100 : (dist.F - p.strike) * 100)
      : (axis === 'price' ? p.strike : p.rate)
    return { x, pdf: p.pdf, cdf: axis === 'price' ? p.cdf : 1 - p.cdf }
  })
  return pts.sort((a, b) => a.x - b.x)
}

// Linear interpolation; outside a series' grid the PDF is 0 and the CDF is 0 / 1
function interpAt(pts: AxisPoint[], x: number, field: 'pdf' | 'cdf'): number {
  if (!pts.length) return 0
  if (x < pts[0].x) return 0
  if (x > pts[pts.length - 1].x) return field === 'cdf' ? 1 : 0
  const k = pts.findIndex(p => p.x >= x)
  if (k <= 0) return pts[0][field]
  const a = pts[k - 1], b = pts[k]
  return a[field] + (b[field] - a[field]) * (x - a.x) / (b.x - a.x)
}

function CrossSectionTab({ contracts, snap, h, axis, setAxis, controls, state, setState }: {
  contracts: Contract[]; snap: Date; h: number
  axis: AxisMode; setAxis: (a: AxisMode) => void
  controls: React.ReactNode
  state: CrossSectionState; setState: (f: (s: CrossSectionState) => CrossSectionState) => void
}) {
  const expOf = useMemo(() => {
    const m = new Map<string, OptionExpiry[]>()
    contracts.forEach(c => m.set(c.id, optionExpiries(c, snap)))
    return m
  }, [contracts, snap])

  // Resolve a reference to live (contract, expiry), or null if it has rolled off
  const resolve = (r: SeriesRef | null) => {
    if (!r) return null
    const c = contracts.find(x => x.id === r.contractId)
    const e = c && expOf.get(c.id)!.find(x => x.id === r.expiryId)
    return c && e ? { c, e } : null
  }

  const base = resolve(state.base) ?? (() => {
    const c = contracts[1], e = defaultExpiry(expOf.get(c.id)!)
    return e ? { c, e } : null
  })()

  const overlays = (() => {
    if (!base) return []
    const refs = state.overlays ?? (() => {
      const exps = expOf.get(base.c.id)!
      const i = exps.indexOf(base.e)
      return exps.slice(Math.max(0, i - 2), i).map(e => ({ contractId: base.c.id, expiryId: e.id }))
    })()
    return refs.map(resolve)
      .filter((x): x is { c: Contract; e: OptionExpiry } => !!x && !(x.c.id === base.c.id && x.e.id === base.e.id))
      .slice(0, MAX_OVERLAYS)
  })()
  const overlayRefs = overlays.map(o => ({ contractId: o.c.id, expiryId: o.e.id }))
  const setOverlays = (refs: SeriesRef[]) => setState(s => ({ ...s, overlays: refs }))
  const setBase = (r: SeriesRef) => setState(s => ({ ...s, base: r, overlays: s.overlays ?? overlayRefs }))

  // "Add" picker: underlying + expiry
  const [pickC, setPickC] = useState<string>('')
  const [pickE, setPickE] = useState<string>('')
  const addC = contracts.find(c => c.id === pickC) ?? base?.c ?? contracts[0]
  const addExps = (expOf.get(addC.id) ?? []).filter(e =>
    !(addC.id === base?.c.id && e.id === base?.e.id) && !overlayRefs.some(r => r.contractId === addC.id && r.expiryId === e.id))
  const addE = addExps.find(e => e.id === pickE) ?? defaultExpiry(addExps)
  const full = overlays.length >= MAX_OVERLAYS

  const baseDist = useMemo(() => base ? extractDistribution(base.c, snap, base.e.date, h) : null,
    [base?.c.id, base?.e.id, snap, h])
  const series = useMemo(() => overlays.map((o, i) => ({
    key: `o${i}`, c: o.c, e: o.e, name: seriesName(o.c, o.e),
    color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
    dist: extractDistribution(o.c, snap, o.e.date, h),
  })), [overlays.map(o => `${o.c.id}:${o.e.id}`).join(','), snap, h])

  // Common grid: strike spacing (level) or h in bp (centred)
  const centred = state.centred
  const measure = state.measure
  const isCdf   = measure === 'cdf'
  const merged = useMemo(() => {
    if (!baseDist) return []
    const all = [{ key: 'base', pts: axisPoints(baseDist, axis, centred) },
      ...series.map(s => ({ key: s.key, pts: axisPoints(s.dist, axis, centred) }))]
    const step = centred ? h * 100 : h
    const lo = Math.min(...all.map(a => a.pts[0].x)), hi = Math.max(...all.map(a => a.pts[a.pts.length - 1].x))
    const rows: Record<string, number>[] = []
    for (let x = Math.ceil(lo / step - 1e-9) * step; x <= hi + 1e-9; x += step) {
      const row: Record<string, number> = { x: +x.toFixed(6) }
      all.forEach(a => { row[a.key] = interpAt(a.pts, x, measure) })
      series.forEach(s => { row[`${s.key}_diff`] = row[s.key] - row.base })
      rows.push(row)
    }
    return rows
  }, [baseDist, series, axis, centred, measure, h])

  // Strike-range zoom shared by both charts (indices into `merged`)
  const [range, setRange] = useState<[number, number] | null>(null)
  const lo = range && range[1] < merged.length ? range[0] : 0
  const hi = range && range[1] < merged.length ? range[1] : merged.length - 1
  const view = merged.slice(lo, hi + 1)

  const fmtX   = (v: number) => centred ? `${v > 0 ? '+' : ''}${v.toFixed(0)}` : v.toFixed(axis === 'price' ? 3 : 2)
  const xTicks = view.length ? niceTicks(view[0].x, view[view.length - 1].x) : []
  const fwdX   = (F: number) => centred ? 0 : axis === 'price' ? F : 100 - F
  const xLabel = centred
    ? `Distance from each forward (bp, ${axis === 'price' ? 'price' : 'rate'} terms)`
    : axis === 'price' ? 'Strike (futures price at expiry)' : 'Implied rate at expiry (%)'

  const pdfPeak  = Math.max(0, ...view.map(r => Math.max(r.base ?? 0, ...series.map(s => r[s.key] ?? 0))))
  const diffMax  = Math.max(1e-9, ...view.flatMap(r => series.map(s => Math.abs(r[`${s.key}_diff`] ?? 0))))
  const diffAxis = pdfAxis(diffMax)
  const fmtVal   = (v: number) => isCdf ? `${(v * 100).toFixed(1)}%` : v.toFixed(3)
  const fmtDiff  = (v: number) => isCdf ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}pp` : `${v > 0 ? '+' : ''}${v.toFixed(3)}`
  const cdfLabel = axis === 'price' ? 'P(price ≤ x)' : 'P(rate ≤ x)'
  const diffTicks = [...diffAxis.ticks.slice(1).map(t => -t).reverse(), ...diffAxis.ticks]

  const median = (st: DistStats) => axis === 'price' ? st.q50 : 100 - st.q50
  const band   = (st: DistStats) => axis === 'price' ? [st.q05, st.q95] : [100 - st.q95, 100 - st.q05]
  const fmtLvl = (v: number) => v.toFixed(axis === 'price' ? 3 : 2)

  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer', fontFamily: MONO }
  const resetZoom = () => setRange(null)

  return (
    <>
      <div style={{ ...card, padding: '16px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Base */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Base</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {PACKS.map(pk => (
              <div key={pk.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: pk.shades[2], fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', width: 46 }}>{pk.label}</span>
                {contracts.filter(c => c.pack === pk.id).map(c => (
                  <Chip key={c.id} active={c.id === base?.c.id}
                    onClick={() => {
                      const e = defaultExpiry(expOf.get(c.id)!)
                      if (e) { setBase({ contractId: c.id, expiryId: e.id }); resetZoom() }
                    }}>{c.label}</Chip>
                ))}
              </div>
            ))}
            {base && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                <span style={{ color: FG3, fontSize: 11, width: 46 }}>expiry</span>
                <select value={base.e.id} style={selectStyle}
                  onChange={ev => setBase({ contractId: base.c.id, expiryId: ev.target.value })}>
                  {expOf.get(base.c.id)!.map(e => <option key={e.id} value={e.id}>{e.code} · {e.label}{e.kind === 'standard' ? ' · standard' : ''}</option>)}
                </select>
                <span style={{ color: FG4, fontSize: 11 }}>shaded</span>
              </div>
            )}
          </div>
        </div>

        {/* Overlays */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Overlays</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minHeight: 28 }}>
              {series.length === 0 && <span style={{ color: FG4, fontSize: 12 }}>None — add an expiry or another underlying below</span>}
              {series.map((s, i) => (
                <span key={s.key} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 10px', borderRadius: 6,
                  border: `1px solid ${BORDER}`, background: 'rgba(200,220,240,0.03)', fontSize: 12, color: FG2,
                }}>
                  <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={s.color} strokeWidth="2" /><circle cx="9" cy="4" r="3" fill={s.color} /></svg>
                  <span style={{ fontFamily: MONO }}>{s.name}</span>
                  <span style={{ color: FG3, fontSize: 11 }}>{s.e.label}</span>
                  <button onClick={() => setOverlays(overlayRefs.filter((_, j) => j !== i))} title="Remove"
                    style={{ background: 'none', border: 'none', color: FG3, cursor: 'pointer', fontSize: 13, padding: '0 4px' }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={addC.id} onChange={ev => { setPickC(ev.target.value); setPickE('') }} style={selectStyle} disabled={full}>
                {PACKS.map(pk => (
                  <optgroup key={pk.id} label={pk.label}>
                    {contracts.filter(c => c.pack === pk.id).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </optgroup>
                ))}
              </select>
              <select value={addE?.id ?? ''} onChange={ev => setPickE(ev.target.value)} style={selectStyle} disabled={full || !addExps.length}>
                {addExps.map(e => <option key={e.id} value={e.id}>{e.code} · {e.label}{e.kind === 'standard' ? ' · standard' : ''}</option>)}
              </select>
              <button
                disabled={full || !addE}
                onClick={() => addE && setOverlays([...overlayRefs, { contractId: addC.id, expiryId: addE.id }])}
                title={full ? `Up to ${MAX_OVERLAYS} overlays` : 'Add this underlying / expiry'}
                style={{ ...inputStyle, cursor: !full && addE ? 'pointer' : 'default', opacity: !full && addE ? 1 : 0.5, fontFamily: 'inherit' }}>
                + Add
              </button>
              {series.length > 0 && (
                <button onClick={() => setOverlays([])} title="Remove all overlays"
                  style={{ ...inputStyle, background: 'rgba(217,112,94,0.08)', border: '1px solid rgba(217,112,94,0.25)', color: '#e2826f', cursor: 'pointer', fontFamily: 'inherit' }}>
                  Clear
                </button>
              )}
              {full && <span style={{ color: FG4, fontSize: 11 }}>Max {MAX_OVERLAYS} overlays</span>}
            </div>
          </div>
        </div>
        {controls}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Label>Axis</Label>
          <Chip active={axis === 'price'} onClick={() => { setAxis('price'); resetZoom() }}>Futures price</Chip>
          <Chip active={axis === 'rate'} onClick={() => { setAxis('rate'); resetZoom() }}>Implied rate</Chip>
          <span style={{ width: 12 }} />
          <Chip active={!centred} onClick={() => { setState(s => ({ ...s, centred: false })); resetZoom() }}>Level</Chip>
          <Chip active={centred} onClick={() => { setState(s => ({ ...s, centred: true })); resetZoom() }}
            title="Plot each distribution against its distance from its own forward, to compare shapes across underlyings">
            Centred on forward
          </Chip>
          <span style={{ width: 12 }} />
          <Chip active={!isCdf} onClick={() => setState(s => ({ ...s, measure: 'pdf' }))}>PDF</Chip>
          <Chip active={isCdf} onClick={() => setState(s => ({ ...s, measure: 'cdf' }))}>CDF</Chip>
        </div>
      </div>

      {!base || !baseDist ? (
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>
          No option expiries for the base underlying at this snapshot.
        </div>
      ) : (
        <>
          <div style={{ ...card, padding: '16px 16px 8px', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Cross-section {isCdf ? `CDF · ${cdfLabel}` : 'PDF'}</div>
              <div style={{ color: FG3, fontSize: 11 }}>
                base {seriesName(base.c, base.e)} ({base.e.label}) shaded · overlays dotted
                {centred ? ' · centred on each forward' : ''}
              </div>
              {range && (
                <button onClick={resetZoom} style={{ marginLeft: 'auto', ...inputStyle, background: 'rgba(200,220,240,0.05)', border: `1px solid ${BORDER}`, color: FG2, cursor: 'pointer', fontFamily: 'inherit' }}>
                  Reset range
                </button>
              )}
            </div>
            {/* Legend */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '10px 0 4px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: FG2, fontSize: 12 }}>
                <svg width="22" height="10"><rect x="0" y="2" width="22" height="8" rx="2" fill="#86c0de" fillOpacity="0.3" /><line x1="0" y1="2" x2="22" y2="2" stroke="#86c0de" strokeWidth="2" /></svg>
                <span style={{ fontFamily: MONO }}>{seriesName(base.c, base.e)}</span> base
              </span>
              {series.map(s => (
                <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, color: FG2, fontSize: 12 }}>
                  <svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke={s.color} strokeWidth="2" /><circle cx="11" cy="5" r="3" fill={s.color} /></svg>
                  <span style={{ fontFamily: MONO }}>{s.name}</span>
                </span>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={view} margin={{ top: 18, right: 16, left: 4, bottom: 8 }}>
                <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps} allowDataOverflow />
                <YAxis width={40} {...axisProps}
                  {...(isCdf
                    ? { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1], tickFormatter: (v: number) => `${(v * 100).toFixed(0)}%` }
                    : { ...pdfAxis(pdfPeak), tickFormatter: (v: number) => (+v.toFixed(2)).toString() })} />
                <Tooltip
                  contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                  labelFormatter={(v: number) => centred ? `${fmtX(Number(v))} bp from F` : fmtX(Number(v))}
                  formatter={(v: number, name: string) => [fmtVal(v), name]}
                />
                {isCdf && [0.05, 0.5, 0.95].map(p => (
                  <ReferenceLine key={p} y={p} stroke="rgba(150,178,205,0.16)" strokeDasharray="2 4" />
                ))}
                <ReferenceLine x={fwdX(baseDist.F)} stroke="#e2826f" strokeOpacity={0.7} strokeDasharray="4 3"
                  label={{ value: centred ? 'Forward' : `ATM ${fmtLvl(fwdX(baseDist.F))}`, position: 'top', fill: '#e2826f', fontSize: 10 }} />
                {!centred && series.filter(s => s.c.id !== base.c.id).map(s => (
                  <ReferenceLine key={`f${s.key}`} x={fwdX(s.dist.F)} stroke={s.color} strokeOpacity={0.6} strokeDasharray="2 3" />
                ))}
                <Area type="monotone" dataKey="base" name={`${seriesName(base.c, base.e)} (base)`} stroke="#86c0de" fill="#86c0de"
                  fillOpacity={0.22} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                {series.map(s => (
                  <Line key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2}
                    dot={{ r: 2.5, fill: s.color, stroke: s.color }} activeDot={{ r: 4 }} isAnimationActive={false} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>

            {/* Range slider (drives both charts) */}
            <div style={{ padding: '4px 20px 4px 48px' }}>
              <ResponsiveContainer width="100%" height={34}>
                <ComposedChart data={merged} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <XAxis dataKey="x" hide />
                  <Area type="monotone" dataKey="base" stroke="none" fill="#86c0de" fillOpacity={0.12} isAnimationActive={false} />
                  <Brush dataKey="x" height={30} stroke="rgba(134,192,222,0.5)" fill="rgba(200,220,240,0.03)"
                    travellerWidth={8} startIndex={lo} endIndex={hi} tickFormatter={(v: number) => fmtX(Number(v))}
                    onChange={(r: { startIndex?: number; endIndex?: number }) => {
                      if (r.startIndex === undefined || r.endIndex === undefined) return
                      setRange(r.startIndex === 0 && r.endIndex === merged.length - 1 ? null : [r.startIndex, r.endIndex])
                    }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Difference vs base */}
            <div style={{ color: FG2, fontSize: 12, fontWeight: 600, margin: '14px 0 2px' }}>
              Difference vs base <span style={{ color: FG4, fontWeight: 400 }}>· overlay − {seriesName(base.c, base.e)}, {isCdf ? 'cumulative probability (pp)' : 'density'}</span>
            </div>
            {series.length === 0 ? (
              <div style={{ color: FG4, fontSize: 12, padding: '24px 0', textAlign: 'center' }}>Add an overlay to compare against the base.</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={view} margin={{ top: 8, right: 16, left: 4, bottom: 24 }}>
                  <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                  <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicks} tickFormatter={fmtX} {...axisProps} allowDataOverflow
                    label={{ value: xLabel, position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                  <YAxis domain={[-diffAxis.domain[1], diffAxis.domain[1]]} ticks={diffTicks}
                    tickFormatter={(v: number) => isCdf ? `${+(v * 100).toFixed(1)}` : (+v.toFixed(2)).toString()} width={40} {...axisProps} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                    labelFormatter={(v: number) => centred ? `${fmtX(Number(v))} bp from F` : fmtX(Number(v))}
                    formatter={(v: number, name: string) => [fmtDiff(v), name]}
                  />
                  <ReferenceLine y={0} stroke="rgba(200,220,240,0.35)" />
                  <ReferenceLine x={fwdX(baseDist.F)} stroke="#e2826f" strokeOpacity={0.5} strokeDasharray="4 3" />
                  {series.map(s => (
                    <Line key={s.key} type="linear" dataKey={`${s.key}_diff`} name={`${s.name} − base`} stroke={s.color}
                      strokeWidth={2} dot={{ r: 2.5, fill: s.color, stroke: s.color }} activeDot={{ r: 4 }} isAnimationActive={false} />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Summary */}
          <div style={{ ...card, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: FG3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {['Series', 'Futures', 'Expires', 'Days', 'Std dev', 'Std vs base', 'Skew', 'Median', '5–95%', isCdf ? 'Largest Δ prob.' : 'Largest Δ density'].map((c, i) => (
                    <th key={c} style={{ padding: '10px 14px', textAlign: i === 0 ? 'left' : 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[{ key: 'base', name: seriesName(base.c, base.e), e: base.e, color: '#86c0de', dist: baseDist, isBase: true },
                  ...series.map(s => ({ ...s, isBase: false }))].map(({ key, name, e, color, dist, isBase }) => {
                  const st = dist.stats
                  const [b5, b95] = band(st)
                  let peak = { x: 0, v: 0 }
                  if (!isBase) merged.forEach(r => { const v = r[`${key}_diff`] ?? 0; if (Math.abs(v) > Math.abs(peak.v)) peak = { x: r.x, v } })
                  const td: React.CSSProperties = { padding: '8px 14px', textAlign: 'right', color: FG2, whiteSpace: 'nowrap' }
                  return (
                    <tr key={key} style={{ borderTop: `1px solid ${BORDER}`, fontFamily: MONO }}>
                      <td style={{ ...td, textAlign: 'left', color: FG1 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {isBase
                            ? <svg width="18" height="10"><rect x="0" y="2" width="18" height="8" rx="2" fill={color} fillOpacity="0.35" /></svg>
                            : <svg width="18" height="10"><line x1="0" y1="5" x2="18" y2="5" stroke={color} strokeWidth="2" /><circle cx="9" cy="5" r="3" fill={color} /></svg>}
                          {name}{isBase && <span style={{ color: FG4, fontSize: 10 }}>base</span>}
                        </span>
                      </td>
                      <td style={td}>{fmtLvl(axis === 'price' ? dist.F : 100 - dist.F)}</td>
                      <td style={td}>{e.label}</td>
                      <td style={td}>{(dist.T * 365).toFixed(0)}</td>
                      <td style={td}>{(st.std * 100).toFixed(1)} bp</td>
                      <td style={{ ...td, color: isBase ? FG4 : FG2 }}>{isBase ? '—' : `${((st.std - baseDist.stats.std) * 100) > 0 ? '+' : ''}${((st.std - baseDist.stats.std) * 100).toFixed(1)} bp`}</td>
                      <td style={td}>{(axis === 'price' ? st.skew : -st.skew).toFixed(2)}</td>
                      <td style={td}>{fmtLvl(median(st))}</td>
                      <td style={td}>{fmtLvl(b5)}–{fmtLvl(b95)}</td>
                      <td style={{ ...td, color: isBase ? FG4 : FG2 }}>
                        {isBase ? '—' : `${isCdf ? fmtDiff(peak.v) : `${peak.v > 0 ? '+' : ''}${peak.v.toFixed(2)}`} @ ${fmtX(peak.x)}${centred ? ' bp' : ''}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ color: FG4, fontSize: 10, marginTop: 10 }}>
            All series at the same snapshot and strike width (h = {h.toFixed(4)}), interpolated onto a common grid for the difference panel.
            Same-underlying overlays show how the distribution builds with time to expiry; other underlyings sit around their own
            forwards (dotted lines) — use “Centred on forward” to compare shapes. Simulated option chain.
          </p>
        </>
      )}
    </>
  )
}

// ─── ECB calendar & futures-implied path (drives the simulated market) ───────
//
// Each ER future prices expected 3m Euribor over [IMM date, +3m]; less a basis,
// that is the expected average DFR over the window. The DFR steps at ECB
// meetings, so the smoothest step path matching every window gives meeting-level
// expectations — used here only to simulate OIS and the option chain.

// ECB monetary-policy meetings (decision day). 2026 per the published calendar;
// later years use the Thursday nearest the 2026 day-of-month, flagged as estimates.
const ECB_MEETINGS_2026: [number, number][] = [[2, 5], [3, 19], [4, 30], [6, 11], [7, 23], [9, 10], [10, 29], [12, 17]]
const ECB_CONFIRMED_THROUGH = 2026
const STEP_BP = 25

interface Meeting { decision: Date; effective: Date; estimated: boolean }

function ecbMeetings(fromYear: number, toYear: number): Meeting[] {
  const out: Meeting[] = []
  for (let y = fromYear; y <= toYear; y++) {
    ECB_MEETINGS_2026.forEach(([m, d]) => {
      let decision: Date
      if (y === 2026) decision = new Date(Date.UTC(y, m - 1, d, 13, 15))
      else {
        // Thursday nearest the same day-of-month as in 2026
        const ref = new Date(Date.UTC(y, m - 1, d, 13, 15))
        const shift = ((4 - ref.getUTCDay() + 10) % 7) - 3            // −3 … +3 days
        decision = new Date(ref.getTime() + shift * 864e5)
      }
      const effective = new Date(decision)
      effective.setUTCDate(effective.getUTCDate() + 6)          // following Wednesday (start of next MRO)
      effective.setUTCHours(0, 0, 0, 0)
      out.push({ decision, effective, estimated: y > ECB_CONFIRMED_THROUGH })
    })
  }
  return out
}

// Small dense linear solve (Gaussian elimination with partial pivoting)
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]
    const piv = M[c][c] || 1e-12
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]
    x[r] = s / (M[r][r] || 1e-12)
  }
  return x
}

interface ContractWindow {
  c: Contract; F: number; euribor: number; target: number   // target = expected avg DFR over window (%)
  start: Date; end: Date; fitted: number
}

interface MeetingResult extends Meeting {
  rate: number          // expected DFR after the meeting (%)
  change: number        // bp at this meeting
  cumulative: number    // bp vs today
}


function futuresImpliedPath(contracts: Contract[], snap: Date, dfr: number, basisBp: number) {
  const windows: ContractWindow[] = contracts.map(c => {
    const start = new Date(Date.UTC(c.year, c.month - 1, nthWeekday(c.year, c.month, 3, 3)))
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 3)
    const { F } = marketAt(c, snap)
    const euribor = 100 - F
    return { c, F, euribor, target: euribor - basisBp / 100, start, end, fitted: 0 }
  })
  const horizon = windows[windows.length - 1].end
  const meetings = ecbMeetings(snap.getUTCFullYear(), horizon.getUTCFullYear())
    .filter(m => m.decision > snap && m.effective < horizon)
  const N = meetings.length

  // Window average = Σ_k w_jk·x_k (+ w_j0·dfr): day-share of each regime inside the window
  const bounds = [snap.getTime(), ...meetings.map(m => m.effective.getTime()), Infinity]
  const weights = windows.map(w => {
    const a = w.start.getTime(), b = w.end.getTime(), len = b - a
    return bounds.slice(0, -1).map((lo, k) => Math.max(0, Math.min(b, bounds[k + 1]) - Math.max(a, lo)) / len)
  })

  // min  W·Σ_j (A_j x − t_j)²  +  λ·Σ_k (x_k − x_{k−1})²,  x_0 = dfr fixed
  const W = 1e4, LAM = 1
  const AtA = Array.from({ length: N }, () => new Array(N).fill(0))
  const rhs = new Array(N).fill(0)
  windows.forEach((w, j) => {
    const row = weights[j].slice(1)
    const t = w.target - weights[j][0] * dfr
    for (let i = 0; i < N; i++) {
      rhs[i] += W * row[i] * t
      for (let k = 0; k < N; k++) AtA[i][k] += W * row[i] * row[k]
    }
  })
  for (let k = 0; k < N; k++) {
    AtA[k][k] += LAM * (k === N - 1 ? 1 : 2)
    if (k > 0) AtA[k][k - 1] -= LAM
    if (k < N - 1) AtA[k][k + 1] -= LAM
  }
  rhs[0] += LAM * dfr
  const x = N ? solveLinear(AtA, rhs) : []

  windows.forEach((w, j) => { w.fitted = weights[j][0] * dfr + x.reduce((s, v, k) => s + weights[j][k + 1] * v, 0) })

  const results: MeetingResult[] = meetings.map((m, k) => {
    const prev = k === 0 ? dfr : x[k - 1]
    const change = (x[k] - prev) * 100
    return { ...m, rate: x[k], change, cumulative: (x[k] - dfr) * 100 }
  })
  return { windows, meetings: results, horizon }
}

// ─── Simulated ECB scenario layer (feeds the simulated option chain) ─────────
//
// Stand-in for OIS (WIRP-style) meeting expectations: the futures-implied step
// path, with each meeting given two-sided −25 / hold / +25 probabilities whose
// mean equals that expected move. Options expiring after a meeting then see a
// genuine mixture of scenarios, which is what the Hikes & cuts tab recovers.

const SIM_DFR = 2.00          // "true" deposit rate in the simulation, %
const SIM_OFFSET_BP = 8       // "true" (ESTR − DFR) + (Euribor − ESTR) basis, bp

interface SimMeeting extends Meeting { expBp: number; pUp: number; pDn: number }

const _simPathCache = new Map<number, SimMeeting[]>()

function simMeetingPath(snap: Date): SimMeeting[] {
  const hit = _simPathCache.get(snap.getTime())
  if (hit) return hit
  const { meetings } = futuresImpliedPath(contractsAt(snap), snap, SIM_DFR, SIM_OFFSET_BP)
  const out = meetings.map((m, k) => {
    const d = m.change
    const u = Math.min(0.3, 0.03 + 0.012 * k)                 // two-sided uncertainty grows with distance
    let pUp = Math.max(0, d) / STEP_BP + u / 2
    let pDn = Math.max(0, -d) / STEP_BP + u / 2
    const tot = pUp + pDn
    if (tot > 1) { pUp /= tot; pDn /= tot }
    return { ...m, expBp: d, pUp, pDn }
  })
  if (_simPathCache.size > 64) _simPathCache.clear()
  _simPathCache.set(snap.getTime(), out)
  return out
}

// Accrual window of the 3m Euribor fixing that settles the future
function fixingWindow(c: Contract): [Date, Date] {
  const s = new Date(Date.UTC(c.year, c.month - 1, nthWeekday(c.year, c.month, 3, 3)))
  const e = new Date(s); e.setUTCMonth(e.getUTCMonth() + 3)
  while (!isBusinessDay(e)) e.setUTCDate(e.getUTCDate() + 1)
  return [s, e]
}

// Share of the fixing window that a meeting's decision affects (1 if effective before it starts)
function windowShare(effective: Date, [s, e]: [Date, Date]): number {
  if (effective <= s) return 1
  if (effective >= e) return 0
  return (e.getTime() - effective.getTime()) / (e.getTime() - s.getTime())
}

// Discrete distribution of the cumulative move (bp, window-weighted) from meetings decided before expiry
function simScenarios(c: Contract, snap: Date, expiry: Date): { j: number; p: number }[] {
  const win = fixingWindow(c)
  let dist = new Map<number, number>([[0, 1]])
  simMeetingPath(snap).filter(m => m.decision < expiry).forEach(m => {
    const om = windowShare(m.effective, win)
    const next = new Map<number, number>()
    dist.forEach((p, j) => {
      ([[-STEP_BP, m.pDn], [0, 1 - m.pUp - m.pDn], [STEP_BP, m.pUp]] as [number, number][]).forEach(([x, q]) => {
        if (q <= 0) return
        const k = Math.round((j + om * x) * 2) / 2
        next.set(k, (next.get(k) ?? 0) + p * q)
      })
    })
    dist = next
  })
  return [...dist.entries()].map(([j, p]) => ({ j, p })).filter(s => s.p > 1e-6)
}

// ─── Tab 4 — Hikes & cuts (options-implied ECB outcomes) ─────────────────────
//
// Port of the ecb_probs.py mixture method. At option expiry the futures rate
// R = 100 − F is a mixture of normals, one per cumulative DFR outcome c_j from
// meetings decided before expiry:
//
//   R ~ Σ_j w_j · N(μ_j, s²),   μ_j = DFR + c_j + offset + δ + Σ_pending ω_m · E[Δ_m]
//
// offset is a prior for (ESTR − DFR) + (Euribor − ESTR); δ a fitted, penalised
// correction; pending meetings enter only through their expected move (OIS),
// weighted by their share ω of the fixing window. Futures options are premium
// margined: a futures call at K is a rate put at 100 − K, undiscounted. For each
// (s, δ) on a grid the weights solve a non-negative least-squares problem on OTM
// premia, with Σw = 1 and the mixture mean pinned to the futures rate.

const OPT_TICK = 0.0025           // ICE Euribor option tick, price points
const LISTED_STRIKE = 0.0625      // ICE listed strike interval — the fit uses listed strikes only
const QUOTE_ERR = 0.00125         // assumed half-spread per quote, price points
const DELTA_MAX_BP = 12, DELTA_PRIOR_SD_BP = 5
const NOISE_MIN_BP = 0.5, NOISE_MAX_BP = 15
const RIDGE = 0.1                 // mild pull of weights towards uniform

function normPdf(x: number): number { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI) }

// Undiscounted futures-option premium for one normal rate component
function componentPrice(rateStrike: number, mu: number, s: number, futuresCall: boolean): number {
  const x = rateStrike - mu
  const z = x / s
  const ratePut = x * normCdf(z) + s * normPdf(z)        // E[(K_r − R)+] = futures call
  return futuresCall ? ratePut : ratePut - x               // rate call = futures put
}

// Lawson–Hanson NNLS on the normal equations (G = AᵀA, g = Aᵀb)
function nnlsGram(G: number[][], g: number[]): number[] {
  const n = g.length
  const x = new Array(n).fill(0)
  const P = new Set<number>()
  const grad = (v: number[]) => g.map((gi, i) => gi - G[i].reduce((s, Gij, j) => s + Gij * v[j], 0))
  const solveP = () => {
    const idx = [...P]
    const sol = solveLinear(idx.map(i => idx.map(j => G[i][j])), idx.map(i => g[i]))
    const z = new Array(n).fill(0)
    idx.forEach((i, k) => { z[i] = sol[k] })
    return z
  }
  for (let iter = 0; iter < 4 * n; iter++) {
    const w = grad(x)
    let j = -1, best = 1e-10
    for (let i = 0; i < n; i++) if (!P.has(i) && w[i] > best) { best = w[i]; j = i }
    if (j < 0) break
    P.add(j)
    for (let inner = 0; inner < 4 * n; inner++) {
      const z = solveP()
      if ([...P].every(i => z[i] > 0)) { for (let i = 0; i < n; i++) x[i] = z[i]; break }
      let alpha = 1
      P.forEach(i => { if (z[i] <= 0) alpha = Math.min(alpha, x[i] / (x[i] - z[i])) })
      for (let i = 0; i < n; i++) x[i] += alpha * (z[i] - x[i])
      P.forEach(i => { if (x[i] <= 1e-12) P.delete(i) })
    }
  }
  return x
}

interface OutcomeQuote { strike: number; type: 'C' | 'P'; market: number; model: number }

interface OutcomeFit {
  expiry: OptionExpiry
  F: number; T: number
  realised: SimMeeting[]
  pending: SimMeeting[]
  moves: number[]                 // cumulative outcome grid, bp
  probs: number[]
  mus: number[]                   // component means, rate %
  noiseBp: number
  deltaBp: number
  fwdAdjBp: number
  rmseTicks: number
  expectedBp: number              // options-implied E[cumulative move]
  oisBp: number                   // OIS (simulated) expectation for the same meetings, window-weighted
  quotes: OutcomeQuote[]
  flags: string[]
}

function fitOutcomes(c: Contract, snap: Date, expiry: OptionExpiry, dfr: number,
                     offsetBp: number, coarse = false): OutcomeFit | null {
  const { F: F0, sigma } = marketAt(c, snap)
  const T0 = Math.max((expiry.date.getTime() - snap.getTime()) / (365 * 864e5), 1 / (365 * 24))
  const half = Math.max(0.25, 4 * sigma * Math.sqrt(T0))
  const h = LISTED_STRIKE
  const lo = Math.floor((F0 - half) / h) * h
  const strikes = Array.from({ length: Math.ceil(2 * half / h) + 1 }, (_, i) => +(lo + i * h).toFixed(6))
  const { F, T, calls } = simulateChain(c, snap, expiry.date, strikes)

  // OTM quotes only: calls at/above F, puts (via parity) below
  const quotes = strikes.map((K, i) => K >= F
    ? { strike: K, type: 'C' as const, market: calls[i] }
    : { strike: K, type: 'P' as const, market: calls[i] - (F - K) })
    .filter(q => q.market >= OPT_TICK / 4)
  if (quotes.length < 4) return null

  const win = fixingWindow(c)
  const path = simMeetingPath(snap)
  const realised = path.filter(m => m.decision < expiry.date)
  const pending = path.filter(m => m.decision >= expiry.date)
  const flags: string[] = []
  if (!realised.length) return {
    expiry, F, T, realised, pending, moves: [], probs: [], mus: [], noiseBp: 0, deltaBp: 0, fwdAdjBp: 0,
    rmseTicks: 0, expectedBp: 0, oisBp: 0, quotes: [], flags: ['No ECB meeting is decided before this expiry, so outcome probabilities are not identified — pick a later expiry.'],
  }
  const lastEff = realised[realised.length - 1].effective
  if (lastEff > win[0]) flags.push('The last resolved meeting takes effect after the fixing window starts, so its move is only partly in the fixing.')

  const fwdAdjBp = pending.reduce((s, m) => s + m.expBp * windowShare(m.effective, win), 0)
  const oisBp = realised.reduce((s, m) => s + m.expBp * windowShare(m.effective, win), 0)

  const k = Math.max(1, Math.min(realised.length, 3))
  const span = STEP_BP * (k + (k === 1 ? 1 : 0))
  const moves: number[] = []
  for (let v = -span; v <= span; v += STEP_BP) moves.push(v)
  const n = moves.length
  const RF = 100 - F
  const base = moves.map(cj => dfr + (cj + offsetBp + fwdAdjBp) / 100)

  const evalAt = (sBp: number, dBp: number) => {
    const s = sBp / 100
    const mus = base.map(b => b + dBp / 100)
    // Rows: quotes / err, then Σw = 1 and mean = R_F (heavily weighted), then ridge towards 1/n
    const rows: number[][] = [], rhs: number[] = []
    quotes.forEach(q => {
      rows.push(mus.map(mu => componentPrice(100 - q.strike, mu, s, q.type === 'C') / QUOTE_ERR))
      rhs.push(q.market / QUOTE_ERR)
    })
    const EQ = 1e3
    rows.push(new Array(n).fill(EQ)); rhs.push(EQ)
    rows.push(mus.map(mu => EQ * mu * 100)); rhs.push(EQ * RF * 100)
    const r = Math.sqrt(RIDGE)
    for (let j = 0; j < n; j++) { const row = new Array(n).fill(0); row[j] = r; rows.push(row); rhs.push(r / n) }

    const G = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => rows.reduce((acc, row) => acc + row[i] * row[j], 0)))
    const g = Array.from({ length: n }, (_, i) => rows.reduce((acc, row, t) => acc + row[i] * rhs[t], 0))
    const w = nnlsGram(G, g)
    const resid = rows.reduce((acc, row, t) => acc + (row.reduce((a, v, j) => a + v * w[j], 0) - rhs[t]) ** 2, 0)
    return { w, mus, obj: resid + (dBp / DELTA_PRIOR_SD_BP) ** 2 }
  }

  // Grid search over (noise, δ), then a finer pass around the best point
  const sStep = coarse ? 1 : 0.5, dStep = coarse ? 1 : 0.5
  let best = { sBp: 3, dBp: 0, ...evalAt(3, 0) }
  for (let sBp = NOISE_MIN_BP; sBp <= NOISE_MAX_BP + 1e-9; sBp += sStep)
    for (let dBp = -DELTA_MAX_BP; dBp <= DELTA_MAX_BP + 1e-9; dBp += dStep) {
      const r = evalAt(sBp, dBp)
      if (r.obj < best.obj) best = { sBp, dBp, ...r }
    }
  if (!coarse) {
    const s0 = best.sBp, d0 = best.dBp
    for (let sBp = Math.max(NOISE_MIN_BP, s0 - 0.5); sBp <= Math.min(NOISE_MAX_BP, s0 + 0.5) + 1e-9; sBp += 0.1)
      for (let dBp = Math.max(-DELTA_MAX_BP, d0 - 0.5); dBp <= Math.min(DELTA_MAX_BP, d0 + 0.5) + 1e-9; dBp += 0.1) {
        const r = evalAt(sBp, dBp)
        if (r.obj < best.obj) best = { sBp, dBp, ...r }
      }
  }

  const tot = best.w.reduce((a, b) => a + b, 0) || 1
  const probs = best.w.map(v => Math.max(0, v) / tot)
  const s = best.sBp / 100
  const modelQuotes = quotes.map(q => ({
    ...q, model: best.mus.reduce((acc, mu, j) => acc + probs[j] * componentPrice(100 - q.strike, mu, s, q.type === 'C'), 0),
  }))
  const rmseTicks = Math.sqrt(modelQuotes.reduce((a, q) => a + ((q.model - q.market) / OPT_TICK) ** 2, 0) / modelQuotes.length)

  if (best.sBp >= NOISE_MAX_BP - 0.05) flags.push(`Noise hit its ${NOISE_MAX_BP} bp cap: the market density is wider than discrete outcomes explain, so probabilities lean on the priors.`)
  if (Math.abs(best.dBp) >= DELTA_MAX_BP - 0.05) flags.push(`Basis correction δ hit its ±${DELTA_MAX_BP} bp bound — check the offset prior.`)
  else if (Math.abs(best.dBp) > 2 * DELTA_PRIOR_SD_BP) flags.push(`Basis correction δ is large (${best.dBp.toFixed(1)} bp): part of a priced move may be absorbed into the basis.`)

  return {
    expiry, F, T, realised, pending, moves, probs, mus: best.mus,
    noiseBp: best.sBp, deltaBp: best.dBp, fwdAdjBp, rmseTicks,
    expectedBp: probs.reduce((a, p, j) => a + p * moves[j], 0), oisBp,
    quotes: modelQuotes, flags,
  }
}

// Diverging: cuts cool, hold neutral, hikes warm (deeper = larger move)
function moveColor(bp: number): string {
  if (bp <= -50) return '#5b93b3'
  if (bp < 0) return '#86c0de'
  if (bp === 0) return 'rgba(150,178,205,0.45)'
  if (bp < 50) return '#dd8a7d'
  return '#c8695a'
}

const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' })
const sbp = (v: number, dp = 1) => `${v > 0.05 ? '+' : v < -0.05 ? '−' : ''}${Math.abs(v).toFixed(dp)}`
const moveLabel = (bp: number) => bp === 0 ? 'Hold' : `${bp > 0 ? '+' : '−'}${Math.abs(bp)}`

function OutcomeBar({ moves, probs, width = 200 }: { moves: number[]; probs: number[]; width?: number }) {
  return (
    <div style={{ display: 'flex', height: 10, width, borderRadius: 2, overflow: 'hidden', background: 'rgba(150,178,205,0.06)' }}>
      {moves.map((m, j) => probs[j] > 0.002 && (
        <div key={m} title={`${moveLabel(m)}: ${(probs[j] * 100).toFixed(0)}%`} style={{ width: `${probs[j] * 100}%`, background: moveColor(m) }} />
      ))}
    </div>
  )
}

interface HikesState { contractId: string | null; expiryId: string | null }

function HikesCutsTab({ contracts, snap, h, controls, dfr, setDfr, offset, setOffset, state, setState }: {
  contracts: Contract[]; snap: Date; h: number; controls: React.ReactNode
  dfr: number; setDfr: (v: number) => void
  offset: number; setOffset: (v: number) => void
  state: HikesState; setState: (f: (s: HikesState) => HikesState) => void
}) {
  const contract = contracts.find(c => c.id === state.contractId) ?? contracts[0]
  const expiries = useMemo(() => optionExpiries(contract, snap), [contract, snap])
  // Default: the contract's own (standard) expiry, else the last listed
  const expiry = expiries.find(e => e.id === state.expiryId)
    ?? expiries.find(e => e.kind === 'standard') ?? expiries[expiries.length - 1] ?? null

  const fit = useMemo(() => expiry ? fitOutcomes(contract, snap, expiry, dfr, offset) : null,
    [contract, snap, expiry, dfr, offset])

  // Term structure across this contract's expiries (coarser grid for speed)
  const term = useMemo(() => expiries.map(e => fitOutcomes(contract, snap, e, dfr, offset, true))
    .filter((f): f is OutcomeFit => !!f && f.moves.length > 0), [contract, snap, expiries, dfr, offset])

  // Market density (Breeden–Litzenberger, rate axis) vs fitted mixture
  const density = useMemo(() => {
    if (!fit || !fit.moves.length || !expiry) return []
    const dist = extractDistribution(contract, snap, expiry.date, h)
    const s = fit.noiseBp / 100
    const market = new Map(dist.points.map(p => [+p.rate.toFixed(6), p.pdf]))
    const lo = Math.min(...dist.points.map(p => p.rate)), hi = Math.max(...dist.points.map(p => p.rate))
    const rows: { x: number; market?: number; mixture: number }[] = []
    const sub = Math.max(1, Math.round(h / 0.0125))           // fine grid that still lands on every strike
    for (let i = 0; lo + i * h / sub <= hi + 1e-9; i++) {
      const xr = +(lo + i * h / sub).toFixed(6)
      rows.push({ x: xr, market: market.get(xr), mixture: fit.mus.reduce((a, mu, j) => a + fit.probs[j] * normPdf((xr - mu) / s) / s, 0) })
    }
    return rows
  }, [fit, contract, snap, expiry, h])

  const numInput = (value: number, onChange: (v: number) => void, step: number) => (
    <input type="number" value={value} step={step} onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v) }}
      style={{ ...inputStyle, width: 72 }} />
  )

  const ok = fit && fit.moves.length > 0
  const pCut  = ok ? fit.probs.reduce((a, p, j) => a + (fit.moves[j] < 0 ? p : 0), 0) : 0
  const pHold = ok ? fit.probs.reduce((a, p, j) => a + (fit.moves[j] === 0 ? p : 0), 0) : 0
  const pHike = ok ? fit.probs.reduce((a, p, j) => a + (fit.moves[j] > 0 ? p : 0), 0) : 0
  const densPeak = Math.max(0, ...density.map(r => Math.max(r.market ?? 0, r.mixture)))
  const xTicksD = density.length ? niceTicks(density[0].x, density[density.length - 1].x) : []
  const quoteTicks = ok ? niceTicks(fit.quotes[0].strike, fit.quotes[fit.quotes.length - 1].strike) : []

  return (
    <>
      <div style={{ ...card, padding: '16px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Underlying</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {PACKS.map(pk => (
              <div key={pk.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: pk.shades[2], fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', width: 46 }}>{pk.label}</span>
                {contracts.filter(c => c.pack === pk.id).map(c => (
                  <Chip key={c.id} active={c.id === contract.id}
                    onClick={() => setState(() => ({ contractId: c.id, expiryId: null }))}>{c.label}</Chip>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Expiry</Label></span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
            {expiries.map(e => (
              <Chip key={e.id} active={e.id === expiry?.id} onClick={() => setState(s => ({ ...s, expiryId: e.id }))}
                title={`${e.code} · ${e.kind} · expires ${e.date.toISOString().slice(0, 10)} 10:00 London`}>
                <span style={{ fontFamily: MONO }}>{e.code}</span>
                <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{e.label}</span>
              </Chip>
            ))}
          </div>
        </div>
        {controls}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Label>Assumptions</Label>
          <span style={{ color: FG3, fontSize: 12 }}>Current DFR</span>
          {numInput(dfr, setDfr, 0.25)}<span style={{ color: FG4, fontSize: 11 }}>%</span>
          <span style={{ width: 12 }} />
          <span style={{ color: FG3, fontSize: 12 }}>Basis offset prior</span>
          {numInput(offset, setOffset, 1)}<span style={{ color: FG4, fontSize: 11 }}>bp</span>
          <span style={{ color: FG4, fontSize: 11 }}>(ESTR − DFR) + (3m Euribor − ESTR); the fit corrects it by δ within ±{DELTA_MAX_BP} bp</span>
        </div>
      </div>

      {!expiry || !fit ? (
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>Not enough option quotes for this expiry.</div>
      ) : (
        <>
          {fit.flags.length > 0 && (
            <div style={{ ...card, padding: '10px 16px', marginBottom: 16, borderColor: 'rgba(214,173,102,0.35)', background: 'rgba(214,173,102,0.06)' }}>
              {fit.flags.map(f => <div key={f} style={{ color: '#dfbb78', fontSize: 12, lineHeight: 1.6 }}>{f}</div>)}
            </div>
          )}

          {ok && (
            <>
              {/* Headline */}
              <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 16 }}>
                <Stat label={`${expiry.code} options on ${contract.label}`} value={expiry.label}
                  sub={`${fit.realised.length} meeting${fit.realised.length > 1 ? 's' : ''} resolved`} />
                <Stat label="P(cut)" value={`${(pCut * 100).toFixed(0)}%`} sub="any cumulative cut" />
                <Stat label="P(hold)" value={`${(pHold * 100).toFixed(0)}%`} sub="no net change" />
                <Stat label="P(hike)" value={`${(pHike * 100).toFixed(0)}%`} sub="any cumulative hike" />
                <Stat label="Options-implied E[Δ]" value={`${sbp(fit.expectedBp)} bp`} sub={`OIS (sim.) ${sbp(fit.oisBp)} bp`} />
                <Stat label="Fit" value={`${fit.rmseTicks.toFixed(2)} ticks`} sub={`noise ${fit.noiseBp.toFixed(1)} bp · δ ${sbp(fit.deltaBp)} bp`} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, marginBottom: 16 }}>
                {/* Outcome probabilities */}
                <div style={{ ...card, padding: '16px 16px 8px' }}>
                  <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Probability by cumulative DFR change</div>
                  <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                    Meetings resolved before {fmtDay(expiry.date)}: {fit.realised.map(m => fmtDay(m.decision)).join(', ')}
                  </div>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={fit.moves.map((m, j) => ({ label: moveLabel(m), m, p: fit.probs[j] }))}
                      margin={{ top: 22, right: 16, left: 4, bottom: 8 }} barCategoryGap="22%">
                      <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="label" {...axisProps} />
                      <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} width={40} {...axisProps} />
                      <Tooltip cursor={{ fill: 'rgba(200,220,240,0.04)' }}
                        contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                        formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, 'Probability']}
                        labelFormatter={(l: string) => `${l === 'Hold' ? 'Hold' : `${l} bp`} → DFR ${(dfr + (fit.moves[fit.moves.findIndex(m => moveLabel(m) === l)] ?? 0) / 100).toFixed(2)}%`} />
                      <Bar dataKey="p" isAnimationActive={false} radius={[3, 3, 0, 0]}
                        label={{ position: 'top', fill: FG2, fontSize: 11, fontFamily: MONO, formatter: (v: number) => v >= 0.005 ? `${(v * 100).toFixed(0)}%` : '' }}>
                        {fit.moves.map(m => <Cell key={m} fill={moveColor(m)} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Density: market vs mixture */}
                <div style={{ ...card, padding: '16px 16px 8px' }}>
                  <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Implied rate density at expiry</div>
                  <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                    Shaded = market (Breeden–Litzenberger) · line = fitted outcome mixture · dotted = scenario centres
                  </div>
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={density} margin={{ top: 22, right: 16, left: 4, bottom: 20 }}>
                      <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                      <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} ticks={xTicksD} tickFormatter={(v: number) => v.toFixed(2)} {...axisProps}
                        label={{ value: 'Implied 3m Euribor at expiry (%)', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                      <YAxis {...pdfAxis(densPeak)} tickFormatter={(v: number) => (+v.toFixed(1)).toString()} width={40} {...axisProps} />
                      <Tooltip
                        contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                        labelFormatter={(v: number) => `${Number(v).toFixed(3)}%`}
                        formatter={(v: number, name: string) => [v.toFixed(2), name]} />
                      {fit.mus.map((mu, j) => fit.probs[j] > 0.01 && (
                        <ReferenceLine key={j} x={mu} stroke="rgba(150,178,205,0.35)" strokeDasharray="2 3"
                          label={{ value: moveLabel(fit.moves[j]), position: 'top', fill: FG3, fontSize: 10 }} />
                      ))}
                      <ReferenceLine x={100 - fit.F} stroke="#e2826f" strokeOpacity={0.6} strokeDasharray="4 3" />
                      <Area type="monotone" dataKey="market" name="Market" stroke="#86c0de" fill="#86c0de" fillOpacity={0.2}
                        strokeWidth={1.2} dot={false} connectNulls isAnimationActive={false} />
                      <Line type="monotone" dataKey="mixture" name="Mixture fit" stroke="#d6ad66" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Term structure across expiries */}
              <div style={{ ...card, overflowX: 'auto', marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '12px 14px 4px', flexWrap: 'wrap' }}>
                  <span style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Outcomes by option expiry · {contract.label}</span>
                  {[-50, -25, 0, 25, 50].map(m => (
                    <span key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: FG3, fontSize: 11 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: moveColor(m) }} />{moveLabel(m)}{Math.abs(m) === 50 ? ' or more' : ''}
                    </span>
                  ))}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: FG3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {['Expiry', 'Expires', 'Meetings resolved', 'P(cut)', 'P(hold)', 'P(hike)', 'E[Δ] options', 'E[Δ] OIS', 'Noise', 'Distribution'].map((c, i) => (
                        <th key={c} style={{ padding: '8px 14px', textAlign: i < 3 || i === 9 ? 'left' : 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {term.map(t => {
                      const td: React.CSSProperties = { padding: '7px 14px', textAlign: 'right', color: FG2, whiteSpace: 'nowrap' }
                      const sum = (pred: (m: number) => boolean) => t.probs.reduce((a, p, j) => a + (pred(t.moves[j]) ? p : 0), 0)
                      const sel = t.expiry.id === expiry.id
                      return (
                        <tr key={t.expiry.id} onClick={() => setState(s => ({ ...s, expiryId: t.expiry.id }))}
                          style={{ borderTop: `1px solid ${BORDER}`, fontFamily: MONO, cursor: 'pointer', background: sel ? 'rgba(106,169,204,0.07)' : 'transparent' }}>
                          <td style={{ ...td, textAlign: 'left', color: FG1 }}>{t.expiry.code}</td>
                          <td style={{ ...td, textAlign: 'left', color: FG3 }}>{t.expiry.label}</td>
                          <td style={{ ...td, textAlign: 'left', color: FG3 }}>{t.realised.length}</td>
                          <td style={td}>{(sum(m => m < 0) * 100).toFixed(0)}%</td>
                          <td style={td}>{(sum(m => m === 0) * 100).toFixed(0)}%</td>
                          <td style={td}>{(sum(m => m > 0) * 100).toFixed(0)}%</td>
                          <td style={td}>{sbp(t.expectedBp)} bp</td>
                          <td style={{ ...td, color: FG3 }}>{sbp(t.oisBp)} bp</td>
                          <td style={{ ...td, color: t.flags.some(f => f.startsWith('Noise')) ? '#dfbb78' : FG3 }}>{t.noiseBp.toFixed(1)} bp</td>
                          <td style={{ ...td, textAlign: 'left' }}><OutcomeBar moves={t.moves} probs={t.probs} /></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Fit quality */}
              <div style={{ ...card, padding: '16px 16px 8px' }}>
                <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Fit to OTM premia</div>
                <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>
                  Dots = market (puts below F, calls above) · line = mixture model · RMSE {fit.rmseTicks.toFixed(2)} ticks over {fit.quotes.length} quotes
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={fit.quotes.map(q => ({ ...q, mktT: q.market / OPT_TICK, mdlT: q.model / OPT_TICK }))}
                    margin={{ top: 10, right: 16, left: 4, bottom: 20 }}>
                    <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
                    <XAxis type="number" dataKey="strike" domain={['dataMin', 'dataMax']} ticks={quoteTicks} tickFormatter={(v: number) => v.toFixed(3)} {...axisProps}
                      label={{ value: 'Futures strike', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
                    <YAxis tickFormatter={(v: number) => v.toFixed(0)} width={40} {...axisProps}
                      label={{ value: 'ticks', angle: -90, position: 'insideLeft', offset: 14, fill: FG3, fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }}
                      labelFormatter={(v: number) => `K ${Number(v).toFixed(4)}`}
                      formatter={(v: number, name: string) => [`${v.toFixed(2)} ticks`, name]} />
                    <ReferenceLine x={fit.F} stroke="#e2826f" strokeOpacity={0.6} strokeDasharray="4 3" />
                    <Line type="monotone" dataKey="mdlT" name="Model" stroke="#d6ad66" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="mktT" name="Market" stroke="none" dot={{ r: 3, fill: '#86c0de', stroke: '#86c0de' }} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          <p style={{ color: FG4, fontSize: 10, marginTop: 10, lineHeight: 1.5 }}>
            Method: the rate at option expiry is a mixture of normals, one per cumulative DFR outcome from meetings decided before expiry,
            μ = DFR + outcome + offset + δ + window-weighted OIS expectations of later meetings. Weights (the probabilities), noise and δ are
            fitted to OTM premia (non-negative least squares, Σw = 1, mixture mean = futures rate; δ penalised with a {DELTA_PRIOR_SD_BP} bp prior).
            Probabilities are risk-neutral. When the market density is smooth rather than lumpy, outcome weights are weakly identified and lean on
            the priors — see any warnings above. OIS meeting expectations and the option chain are simulated; ECB dates after {ECB_CONFIRMED_THROUGH} are estimated.
          </p>
        </>
      )}
    </>
  )
}

// ─── Tab 5 — Open interest ────────────────────────────────────────────────────
//
// End-of-day open interest by strike for one option series (underlying × expiry).
// ICE publishes OI the following morning, so the latest available day is the last
// business day *before* the snapshot date. The history is SIMULATED: each day new
// positions open near that day's forward (calls above, puts below, round strikes
// favoured), a small share closes, occasional block trades land on a single strike,
// and most positions are closed or rolled in the final days before expiry.
// `simOpenInterest` is the seam for a real OI feed (e.g. Bloomberg OPEN_INT by day).

interface OISeries {
  dates: Date[]            // business days, ascending
  strikes: number[]        // ascending
  calls: number[][]        // [day][strike], lots
  puts: number[][]
  F: number[]              // futures settlement per day
}

const OI_STRIKE = 0.0625   // listed strike interval

// Deterministic pseudo-random in [0, 1) from integers (mulberry32-style hash)
function hash01(...xs: number[]): number {
  let h = 0x9e3779b9
  xs.forEach(x => { h = Math.imul(h ^ (x | 0), 0x85ebca6b); h ^= h >>> 13 })
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const _oiCache = new Map<string, OISeries>()

function simOpenInterest(c: Contract, expiry: OptionExpiry, through: Date): OISeries {
  const key = `${c.id}|${expiry.id}|${through.toISOString().slice(0, 10)}`
  const hit = _oiCache.get(key)
  if (hit) return hit

  // Listing: ~12 months before expiry for quarterlies, ~4 months for serials
  const listed = new Date(expiry.date)
  listed.setUTCMonth(listed.getUTCMonth() - (expiry.kind === 'serial' ? 4 : 12))
  const end = new Date(Math.min(through.getTime(), expiry.date.getTime()))
  const dates: Date[] = []
  for (const d = new Date(Date.UTC(listed.getUTCFullYear(), listed.getUTCMonth(), listed.getUTCDate(), 21)); d <= end; d.setUTCDate(d.getUTCDate() + 1))
    if (isBusinessDay(d)) dates.push(new Date(d))
  const F = dates.map(d => marketAt(c, d).F)

  const lo = Math.floor((Math.min(...F) - 0.75) / OI_STRIKE) * OI_STRIKE
  const hi = Math.ceil((Math.max(...F) + 0.75) / OI_STRIKE) * OI_STRIKE
  const strikes: number[] = []
  for (let k = lo; k <= hi + 1e-9; k += OI_STRIKE) strikes.push(+k.toFixed(4))

  const seed = c.seed * 131 + expiry.date.getUTCMonth() * 7 + expiry.date.getUTCFullYear()
  const roundness = (K: number) => (Math.abs(K / 0.25 - Math.round(K / 0.25)) < 1e-6 ? 1.5
    : Math.abs(K / 0.125 - Math.round(K / 0.125)) < 1e-6 ? 1.2 : 1.0)

  const calls: number[][] = [], puts: number[][] = []
  let pc = strikes.map(() => 0), pp = strikes.map(() => 0)
  const n = dates.length
  dates.forEach((d, t) => {
    const daysLeft = (expiry.date.getTime() - d.getTime()) / 864e5
    const age = t / Math.max(1, n)
    // Activity ramps up as expiry nears, then positions are closed / rolled in the last week
    // Day-to-day activity varies a lot; a few days see net unwinds rather than new positions
    const activity = 0.15 + 1.7 * hash01(seed + 6, t) ** 2
    const unwind = hash01(seed + 7, t) < 0.05 ? 0.03 + 0.05 * hash01(seed + 8, t) : 0
    const flow = 9000 * activity * (0.35 + 1.3 * Math.min(1, 120 / Math.max(daysLeft, 5))) * (unwind ? 0.2 : 1)
    const decay = (daysLeft < 7 ? 0.18 : 0.004 + 0.002 * age) + unwind
    const width = 0.10 + 0.12 * Math.min(1, daysLeft / 250)
    const nc: number[] = [], np: number[] = []
    strikes.forEach((K, i) => {
      const r = hash01(seed, t, i)
      const callIn = flow * 0.45 * Math.exp(-0.5 * ((K - (F[t] + 0.09)) / width) ** 2) * roundness(K) * (0.4 + 1.2 * r)
      const putIn  = flow * 0.55 * Math.exp(-0.5 * ((K - (F[t] - 0.11)) / (width * 1.15)) ** 2) * roundness(K) * (0.4 + 1.2 * hash01(seed + 1, t, i))
      nc.push(pc[i] * (1 - decay) + callIn / strikes.length * 3)
      np.push(pp[i] * (1 - decay) + putIn / strikes.length * 3)
    })
    // Block trades: ~1 in 25 days, 4–20k lots on one (usually round) OTM strike
    if (daysLeft > 7 && hash01(seed + 2, t) < 0.04) {
      const put = hash01(seed + 3, t) < 0.55
      const dist = 0.0625 * (1 + Math.floor(hash01(seed + 4, t) * 6))
      const target = Math.round((F[t] + (put ? -dist : dist)) / 0.125) * 0.125
      const i = strikes.findIndex(K => Math.abs(K - target) < 1e-6)
      if (i >= 0) (put ? np : nc)[i] += 4000 + 16000 * hash01(seed + 5, t)
    }
    pc = nc; pp = np
    calls.push(nc.map(Math.round)); puts.push(np.map(Math.round))
  })

  const out = { dates, strikes, calls, puts, F }
  if (_oiCache.size > 48) _oiCache.clear()
  _oiCache.set(key, out)
  return out
}

// Strike at which option holders' total payout would be smallest
function maxPain(strikes: number[], calls: number[], puts: number[]): number {
  let best = strikes[0], bestPay = Infinity
  strikes.forEach(S => {
    const pay = strikes.reduce((a, K, i) => a + calls[i] * Math.max(S - K, 0) + puts[i] * Math.max(K - S, 0), 0)
    if (pay < bestPay) { bestPay = pay; best = S }
  })
  return best
}

type OIMeasure = 'total' | 'calls' | 'puts' | 'net'
type OILookback = '1M' | '3M' | '6M' | 'All'
type OICompare = '1D' | '1W' | '1M' | 'start'

interface OIState {
  contractId: string | null
  expiryId: string | null
  lookback: OILookback
  measure: OIMeasure
  compare: OICompare
  dayIdx: number | null      // index into the series; null → latest
}

const OI_CALL = '#86c0de', OI_PUT = '#dd8a7d'
const fmtLots = (v: number) => Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}m` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`
const fmtSigned = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtLots(Math.abs(v))}`
const fmtDayShort = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' })

function lerpHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16))
  return '#' + pa.map((v, k) => Math.round(v + (pb[k] - v) * t).toString(16).padStart(2, '0')).join('')
}

// Measured width of an element (for the hand-drawn heatmap)
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(es => setW(es[0].contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function OIHeatmap({ series, start, measure, dayIdx, onDay }: {
  series: OISeries; start: number; measure: OIMeasure; dayIdx: number; onDay: (i: number) => void
}) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<{ t: number; i: number; x: number; y: number } | null>(null)

  // Only strikes that ever carry meaningful OI in the window, highest strike on top
  const value = (t: number, i: number) => {
    const c = series.calls[t][i], p = series.puts[t][i]
    return measure === 'calls' ? c : measure === 'puts' ? p : measure === 'net' ? p - c : c + p
  }
  const days = Array.from({ length: series.dates.length - start }, (_, k) => start + k)
  const peak = Math.max(1, ...days.flatMap(t => series.strikes.map((_, i) => series.calls[t][i] + series.puts[t][i])))
  const rows = series.strikes.map((_, i) => i).filter(i => days.some(t => series.calls[t][i] + series.puts[t][i] > peak * 0.01)).reverse()
  const vmax = Math.max(1, ...days.flatMap(t => rows.map(i => Math.abs(value(t, i)))))

  const ML = 58, MR = 10, MT = 6, MB = 26
  const H = Math.min(560, Math.max(260, rows.length * 13)) + MT + MB
  const cw = Math.max(0.5, (width - ML - MR) / days.length), ch = (H - MT - MB) / Math.max(1, rows.length)
  const x0 = (k: number) => ML + k * cw
  const yOfStrike = (K: number) => {
    const top = series.strikes[rows[0]], bot = series.strikes[rows[rows.length - 1]]
    return MT + ((top - K) / (top - bot || 1)) * (H - MT - MB - ch) + ch / 2
  }

  // Sequential ramp from the card surface; gamma < 1 keeps small positions visible without washing out
  const color = (v: number) => {
    const t = Math.pow(Math.min(1, Math.abs(v) / vmax), 0.65)
    if (measure === 'net') return lerpHex('#0f141a', v >= 0 ? OI_PUT : OI_CALL, t)
    return lerpHex('#0f141a', measure === 'puts' ? OI_PUT : measure === 'calls' ? OI_CALL : '#a9d8ef', t)
  }

  const labelEvery = Math.max(1, Math.ceil(rows.length / 18))
  const monthTicks = days.map((t, k) => ({ t, k })).filter(({ t }, j) => j === 0 || series.dates[t].getUTCMonth() !== series.dates[t - 1]?.getUTCMonth())
  const fPath = days.map((t, k) => `${k === 0 ? 'M' : 'L'}${(x0(k) + cw / 2).toFixed(1)},${yOfStrike(series.F[t]).toFixed(1)}`).join(' ')
  const selK = dayIdx - start

  const cellAt = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    const k = Math.floor((mx - ML) / cw), ri = Math.floor((my - MT) / ch)
    return k < 0 || k >= days.length || ri < 0 || ri >= rows.length ? null : { t: days[k], i: rows[ri], x: mx, y: my }
  }
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => setHover(cellAt(e))

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <svg width={width} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        onClick={e => { const c = cellAt(e); if (c) onDay(c.t) }} style={{ display: 'block', cursor: 'crosshair' }}>
        {rows.map((i, ri) => days.map((t, k) => {
          const v = value(t, i)
          if (measure !== 'net' && v <= 0) return null
          return <rect key={`${i}-${t}`} x={x0(k)} y={MT + ri * ch} width={cw + 0.5} height={ch + 0.5} fill={color(v)} shapeRendering="crispEdges" />
        }))}
        {/* Futures price through time */}
        <path d={fPath} fill="none" stroke="#f4f7fa" strokeOpacity={0.75} strokeWidth={1.4} strokeDasharray="4 3" />
        {/* Selected day */}
        {selK >= 0 && <rect x={x0(selK)} y={MT} width={Math.max(cw, 1.5)} height={H - MT - MB} fill="none" stroke="#f4f7fa" strokeWidth={1} />}
        {/* Strike labels */}
        {rows.map((i, ri) => ri % labelEvery === 0 && (
          <text key={i} x={ML - 6} y={MT + ri * ch + ch / 2} textAnchor="end" dominantBaseline="middle" fill={FG3} fontSize={10} fontFamily={MONO}>
            {series.strikes[i].toFixed(3)}
          </text>
        ))}
        {/* Month ticks */}
        {monthTicks.map(({ t, k }) => (
          <g key={t}>
            <line x1={x0(k)} x2={x0(k)} y1={H - MB} y2={H - MB + 4} stroke="rgba(150,178,205,0.3)" />
            <text x={x0(k) + 2} y={H - MB + 15} fill={FG3} fontSize={10} fontFamily={MONO}>
              {series.dates[t].toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })}
            </text>
          </g>
        ))}
      </svg>
      {hover && (
        <div style={{
          position: 'absolute', left: Math.min(hover.x + 14, width - 200), top: Math.max(0, hover.y - 70), pointerEvents: 'none',
          background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, padding: '8px 12px',
          fontSize: 11, fontFamily: MONO, color: FG2, whiteSpace: 'nowrap',
        }}>
          <div style={{ color: FG1, marginBottom: 3 }}>{fmtDayShort(series.dates[hover.t])} · K {series.strikes[hover.i].toFixed(4)}</div>
          <div>Calls <span style={{ color: OI_CALL }}>{fmtLots(series.calls[hover.t][hover.i])}</span>
            {'  '}Puts <span style={{ color: OI_PUT }}>{fmtLots(series.puts[hover.t][hover.i])}</span></div>
          <div style={{ color: FG3 }}>Futures {series.F[hover.t].toFixed(3)} · click to inspect day</div>
        </div>
      )}
    </div>
  )
}

function OpenInterestTab({ contracts, snap, controls, state, setState }: {
  contracts: Contract[]; snap: Date; controls: React.ReactNode
  state: OIState; setState: (f: (s: OIState) => OIState) => void
}) {
  const contract = contracts.find(c => c.id === state.contractId) ?? contracts[1]
  const expiries = useMemo(() => optionExpiries(contract, snap), [contract, snap])
  const expiry = expiries.find(e => e.id === state.expiryId)
    ?? expiries.find(e => e.kind === 'standard') ?? expiries[expiries.length - 1] ?? null

  // Latest published OI: the business day before the snapshot's date
  const through = useMemo(() => {
    const d = new Date(Date.UTC(snap.getUTCFullYear(), snap.getUTCMonth(), snap.getUTCDate(), 21))
    do d.setUTCDate(d.getUTCDate() - 1); while (!isBusinessDay(d))
    return d
  }, [snap])

  const series = useMemo(() => expiry ? simOpenInterest(contract, expiry, through) : null, [contract, expiry, through])
  if (!expiry || !series || series.dates.length < 2) {
    return (
      <>
        <div style={{ ...card, padding: '16px 20px', marginBottom: 16 }}>{controls}</div>
        <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>No open-interest history for this series yet.</div>
      </>
    )
  }

  const n = series.dates.length
  const lbDays = { '1M': 21, '3M': 63, '6M': 126, All: Infinity }[state.lookback]
  const start = Math.max(0, n - Math.min(n, lbDays))
  const day = state.dayIdx !== null && state.dayIdx >= start && state.dayIdx < n ? state.dayIdx : n - 1
  const cmpIdx = Math.max(0, state.compare === '1D' ? day - 1 : state.compare === '1W' ? day - 5 : state.compare === '1M' ? day - 21 : start)

  const sum = (row: number[]) => row.reduce((a, b) => a + b, 0)
  const totC = sum(series.calls[day]), totP = sum(series.puts[day])
  const tot = totC + totP
  const totAt = (t: number) => sum(series.calls[t]) + sum(series.puts[t])
  const d1 = day > 0 ? tot - totAt(day - 1) : 0
  const d5 = day >= 5 ? tot - totAt(day - 5) : 0
  const pain = maxPain(series.strikes, series.calls[day], series.puts[day])

  // Strikes worth showing in the profile: ≥ 0.5% of the day's largest strike OI (or that changed materially)
  const peakDay = Math.max(1, ...series.strikes.map((_, i) => series.calls[day][i] + series.puts[day][i]))
  const profile = series.strikes.map((K, i) => ({
    K, calls: series.calls[day][i], puts: -series.puts[day][i],
    dCalls: series.calls[day][i] - series.calls[cmpIdx][i], dPuts: series.puts[day][i] - series.puts[cmpIdx][i],
  })).filter(r => r.calls - r.puts > peakDay * 0.005 || Math.abs(r.dCalls) + Math.abs(r.dPuts) > peakDay * 0.01)

  const history = Array.from({ length: n - start }, (_, k) => {
    const t = start + k
    const c = sum(series.calls[t]), p = sum(series.puts[t])
    return { t: series.dates[t].getTime(), calls: c, puts: p, pcr: c > 0 ? p / c : 0 }
  })

  const top = series.strikes.flatMap((K, i) => [
    { K, type: 'Call' as const, oi: series.calls[day][i], d1: day > 0 ? series.calls[day][i] - series.calls[day - 1][i] : 0, d5: day >= 5 ? series.calls[day][i] - series.calls[day - 5][i] : 0 },
    { K, type: 'Put' as const, oi: series.puts[day][i], d1: day > 0 ? series.puts[day][i] - series.puts[day - 1][i] : 0, d5: day >= 5 ? series.puts[day][i] - series.puts[day - 5][i] : 0 },
  ]).sort((a, b) => b.oi - a.oi).slice(0, 10)

  const set = (patch: Partial<OIState>) => setState(s => ({ ...s, ...patch }))
  const xTicksStrike = profile.length ? niceTicks(profile[0].K, profile[profile.length - 1].K) : []
  const timeTicks = (() => {
    const out: number[] = []
    history.forEach((h, k) => { if (k > 0 && new Date(h.t).getUTCMonth() !== new Date(history[k - 1].t).getUTCMonth()) out.push(h.t) })
    const step = Math.ceil(out.length / 8)
    return out.filter((_, i) => i % step === 0)
  })()
  const tip = { background: 'rgba(11,15,20,0.96)', border: '1px solid rgba(150,178,205,0.17)', borderRadius: 6, fontSize: 11, fontFamily: MONO }
  const cmpLabel = { '1D': '1 day', '1W': '1 week', '1M': '1 month', start: 'start of range' }[state.compare]

  return (
    <>
      <div style={{ ...card, padding: '16px 20px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Underlying</Label></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {PACKS.map(pk => (
              <div key={pk.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: pk.shades[2], fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', width: 46 }}>{pk.label}</span>
                {contracts.filter(c => c.pack === pk.id).map(c => (
                  <Chip key={c.id} active={c.id === contract.id} onClick={() => set({ contractId: c.id, expiryId: null, dayIdx: null })}>{c.label}</Chip>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ paddingTop: 5, display: 'flex' }}><Label>Expiry</Label></span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
            {expiries.map(e => (
              <Chip key={e.id} active={e.id === expiry.id} onClick={() => set({ expiryId: e.id, dayIdx: null })}
                title={`${e.code} · ${e.kind} · expires ${e.date.toISOString().slice(0, 10)} 10:00 London`}>
                <span style={{ fontFamily: MONO }}>{e.code}</span>
                <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{e.label}</span>
              </Chip>
            ))}
          </div>
        </div>
        {controls}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Label>View</Label>
          {(['1M', '3M', '6M', 'All'] as OILookback[]).map(l => (
            <Chip key={l} active={state.lookback === l} onClick={() => set({ lookback: l })}>{l === 'All' ? 'Since listing' : l}</Chip>
          ))}
          <span style={{ width: 12 }} />
          {([['total', 'Total'], ['calls', 'Calls'], ['puts', 'Puts'], ['net', 'Puts − calls']] as [OIMeasure, string][]).map(([m, l]) => (
            <Chip key={m} active={state.measure === m} onClick={() => set({ measure: m })}>{l}</Chip>
          ))}
        </div>
      </div>

      {/* Headline */}
      <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 16 }}>
        <Stat label={`${expiry.code} on ${contract.label}`} value={fmtDayShort(series.dates[day])}
          sub={day === n - 1 ? 'latest close (published T+1)' : 'selected day'} />
        <Stat label="Total OI" value={`${fmtLots(tot)} lots`} />
        <Stat label="Calls / puts" value={`${fmtLots(totC)} / ${fmtLots(totP)}`} />
        <Stat label="Put / call ratio" value={totC > 0 ? (totP / totC).toFixed(2) : '—'} />
        <Stat label="Δ 1 day" value={fmtSigned(d1)} sub={tot - d1 > 0 ? `${((d1 / (tot - d1)) * 100).toFixed(1)}%` : undefined} />
        <Stat label="Δ 1 week" value={fmtSigned(d5)} sub={tot - d5 > 0 ? `${((d5 / (tot - d5)) * 100).toFixed(1)}%` : undefined} />
        <Stat label="Max pain" value={pain.toFixed(3)} sub={`futures ${series.F[day].toFixed(3)}`} />
      </div>

      {/* Heatmap */}
      <div style={{ ...card, padding: '16px 16px 10px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Open interest by strike and day</span>
          <span style={{ color: FG3, fontSize: 11 }}>
            {state.measure === 'net' ? 'Warm = more puts, cool = more calls' : `${state.measure === 'total' ? 'Calls + puts' : state.measure === 'calls' ? 'Calls' : 'Puts'}, brighter = larger`}
            {' '}· dashed = futures price · click a column to inspect that day
          </span>
        </div>
        <OIHeatmap series={series} start={start} measure={state.measure} dayIdx={day} onDay={i => set({ dayIdx: i })} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, marginBottom: 16 }}>
        {/* Profile for the selected day */}
        <div style={{ ...card, padding: '16px 16px 8px' }}>
          <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Strike profile · {fmtDayShort(series.dates[day])}</div>
          <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>Calls up, puts down · dashed = futures · dotted = max pain</div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={profile} margin={{ top: 10, right: 16, left: 4, bottom: 20 }} stackOffset="sign" barCategoryGap={1}>
              <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
              <XAxis type="number" dataKey="K" domain={['dataMin - 0.03', 'dataMax + 0.03']} ticks={xTicksStrike} tickFormatter={(v: number) => v.toFixed(3)} {...axisProps}
                label={{ value: 'Strike', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
              <YAxis tickFormatter={(v: number) => fmtLots(Math.abs(v))} width={48} {...axisProps} />
              <Tooltip cursor={{ fill: 'rgba(200,220,240,0.04)' }} contentStyle={tip}
                labelFormatter={(v: number) => `K ${Number(v).toFixed(4)}`}
                formatter={(v: number, name: string) => [`${fmtLots(Math.abs(v))} lots`, name]} />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.3)" />
              <ReferenceLine x={series.F[day]} stroke="#f4f7fa" strokeOpacity={0.6} strokeDasharray="4 3" />
              <ReferenceLine x={pain} stroke="#d6ad66" strokeOpacity={0.7} strokeDasharray="1 3" />
              <Bar dataKey="calls" name="Calls" stackId="oi" fill={OI_CALL} isAnimationActive={false} barSize={6} />
              <Bar dataKey="puts" name="Puts" stackId="oi" fill={OI_PUT} isAnimationActive={false} barSize={6} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Change by strike */}
        <div style={{ ...card, padding: '16px 16px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Change by strike</span>
            <span style={{ color: FG3, fontSize: 11 }}>vs {cmpLabel} earlier ({fmtDayShort(series.dates[cmpIdx])})</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {(['1D', '1W', '1M', 'start'] as OICompare[]).map(k => (
                <Chip key={k} active={state.compare === k} onClick={() => set({ compare: k })}>{k === 'start' ? 'Range' : k}</Chip>
              ))}
            </span>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={profile} margin={{ top: 10, right: 16, left: 4, bottom: 20 }} barCategoryGap={1}>
              <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
              <XAxis type="number" dataKey="K" domain={['dataMin - 0.03', 'dataMax + 0.03']} ticks={xTicksStrike} tickFormatter={(v: number) => v.toFixed(3)} {...axisProps}
                label={{ value: 'Strike', position: 'insideBottom', offset: -12, fill: FG3, fontSize: 11 }} />
              <YAxis tickFormatter={(v: number) => fmtSigned(v)} width={52} {...axisProps} />
              <Tooltip cursor={{ fill: 'rgba(200,220,240,0.04)' }} contentStyle={tip}
                labelFormatter={(v: number) => `K ${Number(v).toFixed(4)}`}
                formatter={(v: number, name: string) => [`${fmtSigned(v)} lots`, name]} />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.3)" />
              <ReferenceLine x={series.F[day]} stroke="#f4f7fa" strokeOpacity={0.6} strokeDasharray="4 3" />
              <Bar dataKey="dCalls" name="Δ calls" fill={OI_CALL} isAnimationActive={false} barSize={4} />
              <Bar dataKey="dPuts" name="Δ puts" fill={OI_PUT} isAnimationActive={false} barSize={4} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 16, marginBottom: 16 }}>
        {/* Total OI over time */}
        <div style={{ ...card, padding: '16px 16px 8px' }}>
          <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Total open interest</div>
          <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>Calls and puts stacked · lots</div>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={history} margin={{ top: 10, right: 16, left: 4, bottom: 8 }}>
              <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
              <XAxis type="number" dataKey="t" domain={['dataMin', 'dataMax']} ticks={timeTicks} {...axisProps}
                tickFormatter={(t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })} />
              <YAxis tickFormatter={(v: number) => fmtLots(v)} width={48} {...axisProps} />
              <Tooltip contentStyle={tip} labelFormatter={(t: number) => fmtDayShort(new Date(t))}
                formatter={(v: number, name: string) => [`${fmtLots(v)} lots`, name]} />
              <ReferenceLine x={series.dates[day].getTime()} stroke="#f4f7fa" strokeOpacity={0.5} />
              <Area type="monotone" dataKey="calls" name="Calls" stackId="1" stroke={OI_CALL} fill={OI_CALL} fillOpacity={0.35} isAnimationActive={false} />
              <Area type="monotone" dataKey="puts" name="Puts" stackId="1" stroke={OI_PUT} fill={OI_PUT} fillOpacity={0.35} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Put / call ratio */}
        <div style={{ ...card, padding: '16px 16px 8px' }}>
          <div style={{ color: FG1, fontSize: 14, fontWeight: 600 }}>Put / call ratio</div>
          <div style={{ color: FG3, fontSize: 11, marginBottom: 8 }}>Put OI ÷ call OI · above 1 = more downside-price (higher-rate) protection</div>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={history} margin={{ top: 10, right: 16, left: 4, bottom: 8 }}>
              <CartesianGrid stroke="rgba(150,178,205,0.07)" strokeDasharray="2 4" vertical={false} />
              <XAxis type="number" dataKey="t" domain={['dataMin', 'dataMax']} ticks={timeTicks} {...axisProps}
                tickFormatter={(t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })} />
              <YAxis domain={['auto', 'auto']} tickFormatter={(v: number) => v.toFixed(2)} width={44} {...axisProps} />
              <Tooltip contentStyle={tip} labelFormatter={(t: number) => fmtDayShort(new Date(t))}
                formatter={(v: number) => [v.toFixed(2), 'Put / call']} />
              <ReferenceLine y={1} stroke="rgba(200,220,240,0.3)" strokeDasharray="4 3" />
              <ReferenceLine x={series.dates[day].getTime()} stroke="#f4f7fa" strokeOpacity={0.5} />
              <Line type="monotone" dataKey="pcr" stroke="#d6ad66" strokeWidth={1.8} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top strikes */}
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={{ color: FG1, fontSize: 14, fontWeight: 600, padding: '12px 14px 4px' }}>Largest open interest · {fmtDayShort(series.dates[day])}</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: FG3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {['Strike', 'Type', 'Rate', 'Open interest', 'Share of total', 'Δ 1 day', 'Δ 1 week', 'vs futures'].map((c, i) => (
                <th key={c} style={{ padding: '8px 14px', textAlign: i < 2 ? 'left' : 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {top.map(r => {
              const td: React.CSSProperties = { padding: '7px 14px', textAlign: 'right', color: FG2, whiteSpace: 'nowrap' }
              return (
                <tr key={`${r.K}-${r.type}`} style={{ borderTop: `1px solid ${BORDER}`, fontFamily: MONO }}>
                  <td style={{ ...td, textAlign: 'left', color: FG1 }}>{r.K.toFixed(4)}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: r.type === 'Call' ? OI_CALL : OI_PUT }} />{r.type}
                    </span>
                  </td>
                  <td style={{ ...td, color: FG3 }}>{(100 - r.K).toFixed(3)}%</td>
                  <td style={td}>{fmtLots(r.oi)}</td>
                  <td style={td}>{((r.oi / tot) * 100).toFixed(1)}%</td>
                  <td style={td}>{fmtSigned(r.d1)}</td>
                  <td style={td}>{fmtSigned(r.d5)}</td>
                  <td style={{ ...td, color: FG3 }}>{`${((r.K - series.F[day]) * 100) > 0 ? '+' : ''}${((r.K - series.F[day]) * 100).toFixed(1)} bp`}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p style={{ color: FG4, fontSize: 10, marginTop: 10, lineHeight: 1.5 }}>
        End-of-day open interest in lots, by listed strike (0.0625). ICE publishes OI the next morning, so the latest day is the last business
        day before the snapshot date. Max pain = the settlement strike at which option holders' total intrinsic payout would be smallest.
        Puts on the future gain when rates rise. Simulated open interest.
      </p>
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

type TabId = 'dist' | 'cross' | 'section' | 'rates' | 'oi'
const TABS: { id: TabId; label: string }[] = [
  { id: 'dist',    label: 'PDF & CDF' },
  { id: 'cross',   label: 'Cross-time comparisons' },
  { id: 'section', label: 'Cross-section' },
  { id: 'rates',   label: 'Hikes & cuts' },
  { id: 'oi',      label: 'Open interest' },
]

export default function MacroOptionsMonitor() {
  const initial = londonNow()
  const [tab, setTab]           = useState<TabId>('dist')
  const [snapDate, setSnapDate] = useState(toDateInput(initial))
  const [snapTime, setSnapTime] = useState(toTimeInput(initial))
  const [h, setH]               = useState(0.0625)
  const [axis, setAxis]         = useState<AxisMode>('price')
  const [contractId, setContractId] = useState<string | null>(null)   // null → 2nd contract
  const [crossTime, setCrossTime] = useState<CrossTimeState>({ contractId: null, expiryId: null, dates: null })
  const [dfr, setDfr]           = useState(2.00)   // ECB deposit facility rate, %
  const [offsetBp, setOffsetBp] = useState(10)     // prior for (ESTR − DFR) + (Euribor − ESTR), bp
  const [hikes, setHikes]       = useState<HikesState>({ contractId: null, expiryId: null })
  const [oi, setOi]             = useState<OIState>({ contractId: null, expiryId: null, lookback: 'All', measure: 'total', compare: '1W', dayIdx: null })
  const [crossSection, setCrossSection] = useState<CrossSectionState>({ base: null, overlays: null, centred: false, measure: 'pdf' })
  const [expiryId, setExpiryId] = useState<string | null>(null)

  const requested = useMemo(() => {
    const d = new Date(`${snapDate}T${snapTime}:00Z`)
    const now = londonNow()
    return isNaN(d.getTime()) ? now : d > now ? now : d
  }, [snapDate, snapTime])
  const snap = useMemo(() => snapToSession(requested), [requested])
  const contracts = useMemo(() => contractsAt(snap), [snap])
  // A selected contract that has expired by the snapshot falls back to the 2nd contract
  const contract  = contracts.find(c => c.id === contractId) ?? contracts[1]

  const controls = (
    <SnapshotControls
      snapDate={snapDate} snapTime={snapTime}
      onDate={setSnapDate} onTime={setSnapTime}
      onNow={() => { const n = londonNow(); setSnapDate(toDateInput(n)); setSnapTime(toTimeInput(n)) }}
      h={h} onWidth={setH} effective={snap} requested={requested}
    />
  )
  const controlsNoWidth = (
    <SnapshotControls
      snapDate={snapDate} snapTime={snapTime}
      onDate={setSnapDate} onTime={setSnapTime}
      onNow={() => { const n = londonNow(); setSnapDate(toDateInput(n)); setSnapTime(toTimeInput(n)) }}
      h={h} onWidth={setH} effective={snap} requested={requested} showWidth={false}
    />
  )

  return (
    <div style={{ minHeight: '100vh', background: BG, color: FG1, fontFamily: "'Geist', system-ui, sans-serif" }}>
      <div style={{ ...headerBar, padding: '12px 32px', display: 'flex', alignItems: 'center', gap: 16 }}>
        <PageTitle category="Futures / Swaps / Vol" categoryId="futures-swaps-vol" title="Macro Options Monitor"
          subtitle={<>ER Euribor options · risk-neutral PDF / CDF · {fmtSnap(snap)}</>} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding: '6px 16px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer',
                border: `1px solid ${tab === t.id ? 'rgba(106,169,204,0.5)' : 'rgba(200,220,240,0.1)'}`,
                background: tab === t.id ? 'rgba(106,169,204,0.15)' : 'rgba(200,220,240,0.03)',
                color: tab === t.id ? '#a9d2e8' : FG3,
              }}>{t.label}</button>
            ))}
          </div>
          <span style={{ background: 'rgba(221,149,98,0.12)', border: '1px solid rgba(221,149,98,0.3)', borderRadius: 6, padding: '3px 10px', fontSize: 11, color: '#dd9562' }}>
            SIMULATED DATA
          </span>
        </div>
      </div>

      <div style={{ padding: '24px 32px', maxWidth: 1440 }}>
        {tab === 'dist' ? (
          <DistributionTab
            contracts={contracts} contract={contract} setContract={c => { setContractId(c.id); setExpiryId(null) }}
            expiryId={expiryId} setExpiryId={setExpiryId}
            snap={snap} h={h} axis={axis} setAxis={setAxis} controls={controls}
          />
        ) : (
          tab === 'cross' ? (
            <CrossTimeTab contracts={contracts} snap={snap} h={h} axis={axis} setAxis={setAxis} controls={controls}
              state={crossTime} setState={setCrossTime} />
          ) : tab === 'oi' ? (
            <OpenInterestTab contracts={contracts} snap={snap} controls={controlsNoWidth} state={oi} setState={setOi} />
          ) : tab === 'rates' ? (
            <HikesCutsTab contracts={contracts} snap={snap} h={h} controls={controls}
              dfr={dfr} setDfr={setDfr} offset={offsetBp} setOffset={setOffsetBp} state={hikes} setState={setHikes} />
          ) : (
            <CrossSectionTab contracts={contracts} snap={snap} h={h} axis={axis} setAxis={setAxis} controls={controls}
              state={crossSection} setState={setCrossSection} />
          )
        )}
      </div>
    </div>
  )
}
