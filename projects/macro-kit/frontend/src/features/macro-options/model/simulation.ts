// ─── Simulated market ─────────────────────────────────────────────────────────
//
// Stand-in for Bloomberg when it is unavailable: deterministic levels drifting with the
// snapshot time, ECB-meeting scenarios before each expiry (a discrete mixture) plus a
// Bachelier diffusion with a quadratic smile, and a simulated open-interest history.
// `simMarket` packages it as a Market, the same interface the live data come in.

import { MONTHS, MONTH_CODES, isBusinessDay, lastTradingDay, nthWeekday, serialExpiry } from './calendar'
import { bachelierCall } from './distribution'
import { STEP_BP, fixingWindow, solveLinear, windowShare } from './outcomes'
import { N_QUARTERLIES, packOf } from './types'
import type { Chain, Contract, Market, Meeting, OISeries, OptionExpiry, PathMeeting } from './types'

interface SimContract extends Contract {
  baseF: number      // reference futures price (100 − rate)
  sigma: number      // reference Bachelier normal vol, price units / yr
  skew: number       // dσ/dK relative (negative → heavier low-price / high-rate tail)
  curv: number       // smile curvature
  seed: number
  slot: number       // position 0–11 (serials sit on the first two)
}

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

// One quarterly contract as it stands at `snap`: forward level from the calendar
// anchors, vol / smile from its time to expiry. `slot` (0–11) sets pack & colour.
function makeContract(y: number, m: number, snap: Date, slot: number): SimContract {
  const tau  = (lastTradingDay(y, m).getTime() - snap.getTime()) / (365 * 864e5)
  const tauX = VOL_TS.map(v => v[0])
  const id   = `ER${MONTH_CODES[m - 1]}${y % 10}`
  return {
    id, label: id, year: y, month: m, slot, ...packOf(slot),
    baseF: interp(y * 12 + m, F_ANCHORS.map(([ay, am]) => ay * 12 + am), F_ANCHORS.map(a => a[2]), true),
    sigma: interp(tau, tauX, VOL_TS.map(v => v[1])),
    skew:  interp(tau, tauX, VOL_TS.map(v => v[2])),
    curv:  interp(tau, tauX, VOL_TS.map(v => v[3])),
    seed:  (y * 12 + m) % 97 + 1,
  }
}

// The 12 quarterly contracts live at the snapshot: front = first quarterly whose
// last trading day is after the snapshot. Packs and colours are positional.
function contractsAt(snap: Date): SimContract[] {
  let y = snap.getUTCFullYear()
  let m = Math.ceil((snap.getUTCMonth() + 1) / 3) * 3
  if (lastTradingDay(y, m) <= snap) { m += 3; if (m > 12) { m -= 12; y += 1 } }

  const out: SimContract[] = []
  for (let i = 0; i < N_QUARTERLIES; i++) {
    out.push(makeContract(y, m, snap, i))
    m += 3
    if (m > 12) { m -= 12; y += 1 }
  }
  return out
}

// Option expiries after the snapshot, as ICE lists them: the contract's own (standard) month,
// and on the first two quarterlies the two serial months before it
function optionExpiries(c: SimContract, snap: Date): OptionExpiry[] {
  const months: [number, number][] = (c.slot < 2 ? [-2, -1, 0] : [0]).map(back => {
    const m = c.month + back
    return m >= 1 ? [c.year, m] : [c.year - 1, m + 12]
  })
  return months.flatMap(([y, m]) => {
    const own = y === c.year && m === c.month
    const d = own ? lastTradingDay(y, m) : serialExpiry(y, m)
    if (d <= snap) return []
    return [{
      id: `${y}-${String(m).padStart(2, '0')}`,
      label: `${d.getUTCDate()} ${MONTHS[m - 1]} ${String(y).slice(2)}`,   // last trading day, e.g. "13 Nov 26"
      code: `ER${MONTH_CODES[m - 1]}${y % 10}`,
      kind: own ? 'standard' as const : 'serial' as const,
      date: d,
    }]
  })
}

// ─── Simulated market ─────────────────────────────────────────────────────────

// Smooth deterministic noise in time: sum of sinusoids, distinct per seed
function wiggle(hours: number, seed: number): number {
  const periods = [9, 37, 190, 820]
  const amps    = [0.10, 0.20, 0.35, 0.35]
  return periods.reduce((acc, p, k) =>
    acc + amps[k] * Math.sin(hours / p + seed * (k + 1) * 1.7 + k), 0)
}

function marketAt(c: SimContract, snap: Date): { F: number; sigma: number } {
  const hours = snap.getTime() / 3.6e6
  const common = wiggle(hours, 0)          // curve-wide level move
  const own    = wiggle(hours, c.seed)
  const F      = c.baseF + 0.16 * common + 0.04 * own
  const sigma  = c.sigma * (1 + 0.12 * wiggle(hours, c.seed + 11))
  return { F, sigma }
}

const LISTED_STRIKE = 0.0625      // ICE listed strike interval: the simulated quotes sit on it
const OPT_TICK = 0.0025

// The simulated chain of one expiry: a pricer on any strike, and listed OTM quotes from it
function simChain(c: SimContract, snap: Date, expiry: Date): Chain {
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
  const call = (K: number) => comps.reduce((a, { p, Fj }) => a + p * bachelierCall(Fj, K, T, smile(K, Fj)), 0)
  const half = Math.max(0.25, 4 * sigma * Math.sqrt(T))
  const lo = Math.floor((F - half) / LISTED_STRIKE) * LISTED_STRIKE
  let quotes: Chain['quotes'] | null = null
  return {
    F, atmVol: sigma, T, call, flags: [],
    get quotes() {
      // OTM quotes only: calls at/above F, puts (via parity) below
      quotes ??= Array.from({ length: Math.ceil(2 * half / LISTED_STRIKE) + 1 }, (_, i) => +(lo + i * LISTED_STRIKE).toFixed(6))
        .map(K => K >= F
          ? { strike: K, type: 'C' as const, market: call(K) }
          : { strike: K, type: 'P' as const, market: call(K) - (F - K) })
        .filter(q => q.market >= OPT_TICK / 4)
      return quotes
    },
  }
}

// ─── ECB calendar & futures-implied path (drives the simulated market) ───────
//
// Each ER future prices expected 3m Euribor over [IMM date, +3m]; less a basis,
// that is the expected average DFR over the window. The DFR steps at ECB
// meetings, so the smoothest step path matching every window gives meeting-level
// expectations — used here only to simulate OIS and the option chain.

// ECB monetary-policy meetings (decision day), 2026–27 per the published calendar (as in
// swaps_rv.py); later years use the Thursday nearest the 2027 day-of-month, flagged as estimates.
const ECB_MEETINGS: Record<number, [number, number][]> = {
  2026: [[2, 5], [3, 19], [4, 30], [6, 11], [7, 23], [9, 10], [10, 29], [12, 17]],
  2027: [[2, 4], [3, 18], [4, 29], [6, 10], [7, 22], [9, 9], [10, 28], [12, 16]],
}
export const ECB_CONFIRMED_THROUGH = 2027

function ecbMeetings(fromYear: number, toYear: number): Meeting[] {
  const out: Meeting[] = []
  for (let y = fromYear; y <= toYear; y++) {
    (ECB_MEETINGS[y] ?? ECB_MEETINGS[ECB_CONFIRMED_THROUGH]).forEach(([m, d]) => {
      let decision: Date
      if (ECB_MEETINGS[y]) decision = new Date(Date.UTC(y, m - 1, d, 13, 15))
      else {
        // Thursday nearest the same day-of-month as in the last confirmed year
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

interface ContractWindow {
  c: SimContract; F: number; euribor: number; target: number   // target = expected avg DFR over window (%)
  start: Date; end: Date; fitted: number
}

interface MeetingResult extends Meeting {
  rate: number          // expected DFR after the meeting (%)
  change: number        // bp at this meeting
  cumulative: number    // bp vs today
}


function futuresImpliedPath(contracts: SimContract[], snap: Date, dfr: number, basisBp: number) {
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

interface SimMeeting extends PathMeeting { pUp: number; pDn: number }

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

// Discrete distribution of the cumulative move (bp, window-weighted) from meetings decided before expiry
function simScenarios(c: SimContract, snap: Date, expiry: Date): { j: number; p: number }[] {
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

// ─── Simulated open interest ──────────────────────────────────────────────────
//
// End-of-day open interest by strike for one option series (underlying × expiry):
// each day new
// positions open near that day's forward (calls above, puts below, round strikes
// favoured), a small share closes, occasional block trades land on a single strike,
// and most positions are closed or rolled in the final days before expiry.

const OI_STRIKE = 0.0625   // listed strike interval

// Deterministic pseudo-random in [0, 1) from integers (mulberry32-style hash)
function hash01(...xs: number[]): number {
  let h = 0x9e3779b9
  xs.forEach(x => { h = Math.imul(h ^ (x | 0), 0x85ebca6b); h ^= h >>> 13 })
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const _oiCache = new Map<string, OISeries>()

function simOpenInterest(c: SimContract, expiry: OptionExpiry, through: Date): OISeries {
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


// ─── The simulated market at a snapshot ──────────────────────────────────────

export function simMarket(snap: Date, note: string | null = null): Market {
  const contracts = contractsAt(snap)
  const byId = new Map(contracts.map(c => [c.id, c]))
  const sim = (c: Contract) => byId.get(c.id) ?? makeContract(c.year, c.month, snap, 0)
  const chains = new Map<string, Chain>()
  return {
    source: 'simulation', snap, contracts, note,
    expiries: c => optionExpiries(sim(c), snap),
    F: c => marketAt(sim(c), snap).F,
    chain: (c, e) => {
      const key = `${c.id}|${e.id}`
      let ch = chains.get(key)
      if (!ch) { ch = simChain(sim(c), snap, e.date); chains.set(key, ch) }
      return ch
    },
    path: simMeetingPath(snap),
    dfr: null,
    simOpenInterest: (c, e, through) => simOpenInterest(sim(c), e, through),
  }
}
