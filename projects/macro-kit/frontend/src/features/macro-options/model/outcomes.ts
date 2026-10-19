import { isBusinessDay, nthWeekday } from './calendar'
import { normCdf, normPdf } from './distribution'
import type { Chain, Contract, OptionExpiry, PathMeeting } from './types'

export const STEP_BP = 25

// Small dense linear solve (Gaussian elimination with partial pivoting)
export function solveLinear(A: number[][], b: number[]): number[] {
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

// Accrual window of the 3m Euribor fixing that settles the future
export function fixingWindow(c: Contract): [Date, Date] {
  const s = new Date(Date.UTC(c.year, c.month - 1, nthWeekday(c.year, c.month, 3, 3)))
  const e = new Date(s); e.setUTCMonth(e.getUTCMonth() + 3)
  while (!isBusinessDay(e)) e.setUTCDate(e.getUTCDate() + 1)
  return [s, e]
}

// Share of the fixing window that a meeting's decision affects (1 if effective before it starts)
export function windowShare(effective: Date, [s, e]: [Date, Date]): number {
  if (effective <= s) return 1
  if (effective >= e) return 0
  return (e.getTime() - effective.getTime()) / (e.getTime() - s.getTime())
}


// ─── Options-implied ECB outcomes (Hikes & cuts tab) ─────────────────────────
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

export const OPT_TICK = 0.0025    // ICE Euribor option tick, price points
const QUOTE_ERR = 0.00125         // assumed half-spread per quote, price points
export const DELTA_MAX_BP = 12, DELTA_PRIOR_SD_BP = 5
const NOISE_MIN_BP = 0.5, NOISE_MAX_BP = 15
const RIDGE = 0.1                 // mild pull of weights towards uniform

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

export interface OutcomeQuote { strike: number; type: 'C' | 'P'; market: number; model: number }

export interface OutcomeFit {
  expiry: OptionExpiry
  F: number; T: number
  realised: PathMeeting[]
  pending: PathMeeting[]
  moves: number[]                 // cumulative outcome grid, bp
  probs: number[]
  mus: number[]                   // component means, rate %
  noiseBp: number
  deltaBp: number
  fwdAdjBp: number
  rmseTicks: number
  expectedBp: number              // options-implied E[cumulative move]
  oisBp: number                   // OIS expectation for the same meetings, window-weighted
  quotes: OutcomeQuote[]
  flags: string[]
}

// `path` holds the OIS expected move of every meeting after the snapshot
export function fitOutcomes(c: Contract, chain: Chain, expiry: OptionExpiry, path: PathMeeting[], dfr: number,
                            offsetBp: number, coarse = false): OutcomeFit | null {
  const { F, T, atmVol } = chain
  // Listed OTM premia within ±4σ of the forward (puts below F, calls at or above)
  const half = Math.max(0.25, 4 * atmVol * Math.sqrt(T))
  const quotes = chain.quotes.filter(q => Math.abs(q.strike - F) <= half + 1e-9 && q.market >= OPT_TICK / 4)
  if (quotes.length < 4) return null

  const win = fixingWindow(c)
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
