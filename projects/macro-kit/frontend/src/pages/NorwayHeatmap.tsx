import React, { useCallback, useRef, useState } from 'react'
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts'

interface Indicator {
  name: string; asOfLastMtg: string; latest: string; change: string
  lastUpd: string; units: string; mean: number; std: number; zscores: number[]
}
interface Group { name: string; indicators: Indicator[] }

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 24,
}

function generateMonths(): string[] {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const out: string[] = []
  let y = 2023, m = 5
  for (let i = 0; i < 25; i++) { out.push(`${names[m]} '${String(y).slice(2)}`); if (++m > 11) { m = 0; y++ } }
  return out
}
const MONTH_COLS = generateMonths()
const N_MONTHS = MONTH_COLS.length

function generateZscores(seed: number, groupBias: number, amplitude: number, phase: number, freq: number, noiseSeed: number): number[] {
  const zs: number[] = []
  for (let t = 0; t < N_MONTHS; t++) {
    const trend = groupBias * (1 - t / (N_MONTHS * 1.5))
    const wave1 = amplitude * Math.sin(freq * t + phase)
    const wave2 = (amplitude * 0.5) * Math.cos(freq * 1.7 * t + phase * 0.8)
    const noise = 0.35 * Math.sin(noiseSeed * 13.7 + t * 2.3 + seed * 7.1) + 0.20 * Math.cos(noiseSeed * 5.3 + t * 4.1 + seed * 3.9)
    zs.push(Math.max(-3, Math.min(3, trend + wave1 + wave2 + noise)))
  }
  return zs
}

// Norges Bank last meeting: 27 Mar 2025 (cut to 4.25% — first cut from 4.50%)
const GROUPS_META: {
  name: string; bias: number
  indicators: {
    name: string; asOfLastMtg: string; latest: string; change: string
    lastUpd: string; units: string; mean: number; std: number
    amp: number; phase: number; freq: number; noiseSeed: number
  }[]
}[] = [
  {
    name: 'Real Activity', bias: -0.1,
    indicators: [
      { name: 'Mainland GDP (q/q SA)',            asOfLastMtg: '+0.5%', latest: '+0.6%', change: '+0.1',  lastUpd: '29 May 2025', units: '% q/q SA',  mean: 0.6,    std: 0.5,   amp: 0.9, phase: 0.5, freq: 0.28, noiseSeed: 501 },
      { name: 'GDP Total (q/q SA)',               asOfLastMtg: '+0.4%', latest: '+0.5%', change: '+0.1',  lastUpd: '29 May 2025', units: '% q/q SA',  mean: 0.5,    std: 0.6,   amp: 0.8, phase: 0.3, freq: 0.26, noiseSeed: 502 },
      { name: 'Industrial Production (m/m)',      asOfLastMtg: '-0.4%', latest: '-0.6%', change: '-0.2',  lastUpd: '14 May 2025', units: '% m/m SA',  mean: -0.6,   std: 1.8,   amp: 1.1, phase: 0.8, freq: 0.46, noiseSeed: 503 },
      { name: 'Manufacturing Production (m/m)',   asOfLastMtg: '+0.3%', latest: '-0.5%', change: '-0.8',  lastUpd: '14 May 2025', units: '% m/m SA',  mean: -0.5,   std: 1.5,   amp: 1.0, phase: 1.0, freq: 0.44, noiseSeed: 504 },
      { name: 'Retail Sales (m/m)',               asOfLastMtg: '+0.4%', latest: '+0.2%', change: '-0.2',  lastUpd: '21 May 2025', units: '% m/m SA',  mean: 0.2,    std: 0.9,   amp: 1.0, phase: 1.2, freq: 0.42, noiseSeed: 505 },
      { name: 'Trade Balance (NOKbn)',            asOfLastMtg: '68.2',  latest: '62.5',  change: '-5.7',  lastUpd: '08 May 2025', units: 'NOKbn SA',  mean: 62.5,   std: 15.0,  amp: 0.9, phase: 0.7, freq: 0.30, noiseSeed: 506 },
      { name: 'Petroleum Investment (NOKbn)',     asOfLastMtg: '88.5',  latest: '91.2',  change: '+2.7',  lastUpd: '12 May 2025', units: 'NOKbn SA',  mean: 91.2,   std: 8.0,   amp: 0.7, phase: 1.5, freq: 0.22, noiseSeed: 507 },
    ],
  },
  {
    name: 'Business Activity', bias: -0.1,
    indicators: [
      { name: 'PMI Manufacturing (Norges Bank)', asOfLastMtg: '51.2', latest: '50.8',  change: '-0.4',  lastUpd: '02 May 2025', units: 'Index SA',  mean: 50.8,   std: 3.5,   amp: 1.1, phase: 0.4, freq: 0.44, noiseSeed: 508 },
      { name: 'Norges Bank Reg. Network — Prod.',asOfLastMtg: '1.5',  latest: '1.2',   change: '-0.3',  lastUpd: '11 Mar 2025', units: 'Index',     mean: 1.2,    std: 0.8,   amp: 1.0, phase: 0.5, freq: 0.28, noiseSeed: 509 },
      { name: 'Reg. Network — Expected Output',  asOfLastMtg: '1.8',  latest: '1.4',   change: '-0.4',  lastUpd: '11 Mar 2025', units: 'Index',     mean: 1.4,    std: 0.7,   amp: 1.0, phase: 0.6, freq: 0.28, noiseSeed: 510 },
      { name: 'Reg. Network — Capacity Util.',   asOfLastMtg: '3.5',  latest: '3.2',   change: '-0.3',  lastUpd: '11 Mar 2025', units: 'Index',     mean: 3.2,    std: 0.5,   amp: 0.8, phase: 0.3, freq: 0.26, noiseSeed: 511 },
      { name: 'Business Confidence (SSB)',        asOfLastMtg: '2.8',  latest: '2.5',   change: '-0.3',  lastUpd: '22 Apr 2025', units: 'Index',     mean: 2.5,    std: 1.0,   amp: 0.9, phase: 0.8, freq: 0.36, noiseSeed: 512 },
      { name: 'Consumer Confidence (Kantar)',     asOfLastMtg: '-7',   latest: '-9',    change: '-2',    lastUpd: '22 Apr 2025', units: 'Balance',   mean: -9.0,   std: 5.0,   amp: 1.0, phase: 1.0, freq: 0.38, noiseSeed: 513 },
      { name: 'Export Orders (Mfg Survey)',       asOfLastMtg: '2.0',  latest: '1.6',   change: '-0.4',  lastUpd: '14 May 2025', units: 'Index',     mean: 1.6,    std: 0.8,   amp: 1.1, phase: 1.3, freq: 0.40, noiseSeed: 514 },
    ],
  },
  {
    name: 'Housing Market', bias: -0.3,
    indicators: [
      { name: 'House Prices — Eiendom Norge (m/m)',asOfLastMtg: '+0.8%',latest: '+0.5%', change: '-0.3',  lastUpd: '05 May 2025', units: '% m/m SA',  mean: 0.5,    std: 1.0,   amp: 1.0, phase: 0.4, freq: 0.36, noiseSeed: 515 },
      { name: 'House Prices — National (y/y)',    asOfLastMtg: '+1.2%',latest: '+1.5%', change: '+0.3',  lastUpd: '05 May 2025', units: '% y/y',     mean: 1.5,    std: 3.0,   amp: 1.1, phase: 0.6, freq: 0.28, noiseSeed: 516 },
      { name: 'Oslo House Prices (m/m)',          asOfLastMtg: '+1.0%',latest: '+0.6%', change: '-0.4',  lastUpd: '05 May 2025', units: '% m/m SA',  mean: 0.6,    std: 1.2,   amp: 1.1, phase: 0.5, freq: 0.38, noiseSeed: 517 },
      { name: 'Housing Starts (k SAAR)',          asOfLastMtg: '20.8', latest: '19.2',  change: '-1.6',  lastUpd: '15 May 2025', units: 'k SAAR',    mean: 19.2,   std: 4.0,   amp: 1.0, phase: 0.7, freq: 0.34, noiseSeed: 518 },
      { name: 'Building Permits (m/m)',           asOfLastMtg: '-2.5%',latest: '-4.2%', change: '-1.7',  lastUpd: '08 May 2025', units: '% m/m SA',  mean: -4.2,   std: 7.0,   amp: 1.2, phase: 1.0, freq: 0.42, noiseSeed: 519 },
      { name: 'Household Mortgage Credit (y/y)', asOfLastMtg: '+2.8%',latest: '+3.0%', change: '+0.2',  lastUpd: '30 Apr 2025', units: '% y/y',     mean: 3.0,    std: 0.8,   amp: 0.7, phase: 1.2, freq: 0.26, noiseSeed: 520 },
      { name: 'Credit to Households (y/y)',      asOfLastMtg: '+3.2%',latest: '+3.4%', change: '+0.2',  lastUpd: '30 Apr 2025', units: '% y/y',     mean: 3.4,    std: 0.6,   amp: 0.7, phase: 1.4, freq: 0.24, noiseSeed: 521 },
    ],
  },
  {
    name: 'Labour Market', bias: -0.1,
    indicators: [
      { name: 'Unemployment Rate — NAV (reg.)',   asOfLastMtg: '2.0%',  latest: '2.1%',  change: '+0.1',  lastUpd: '15 May 2025', units: '% SA',      mean: 2.1,    std: 0.15,  amp: 0.5, phase: 1.5, freq: 0.20, noiseSeed: 522 },
      { name: 'Unemployment Rate — LFS',          asOfLastMtg: '4.0%',  latest: '4.2%',  change: '+0.2',  lastUpd: '15 May 2025', units: '% SA',      mean: 4.2,    std: 0.3,   amp: 0.6, phase: 1.4, freq: 0.22, noiseSeed: 523 },
      { name: 'Employment Change (k)',            asOfLastMtg: '+4k',   latest: '-2k',   change: '-6',    lastUpd: '15 May 2025', units: 'k SA',      mean: -2.0,   std: 12.0,  amp: 1.0, phase: 0.6, freq: 0.40, noiseSeed: 524 },
      { name: 'Full-time Employment (k)',         asOfLastMtg: '+3k',   latest: '-1k',   change: '-4',    lastUpd: '15 May 2025', units: '% q/q SA',  mean: -1.0,   std: 10.0,  amp: 0.9, phase: 0.7, freq: 0.38, noiseSeed: 525 },
      { name: 'Hours Worked (m/m)',               asOfLastMtg: '+0.1%', latest: '-0.2%', change: '-0.3',  lastUpd: '15 May 2025', units: '% m/m SA',  mean: -0.2,   std: 0.8,   amp: 0.8, phase: 1.0, freq: 0.40, noiseSeed: 526 },
      { name: 'Job Vacancies — NAV (k)',          asOfLastMtg: '62',    latest: '58',    change: '-4',    lastUpd: '22 May 2025', units: 'k SA',      mean: 58.0,   std: 8.0,   amp: 0.9, phase: 1.1, freq: 0.32, noiseSeed: 527 },
      { name: 'New Claims — NAV (k/month)',      asOfLastMtg: '4.8',   latest: '5.2',   change: '+0.4',  lastUpd: '30 Apr 2025', units: 'k SA',      mean: 5.2,    std: 0.8,   amp: 0.7, phase: 0.9, freq: 0.28, noiseSeed: 528 },
    ],
  },
  {
    name: 'Wages', bias: 0.2,
    indicators: [
      { name: 'Annual Wage Growth — TBU est.',   asOfLastMtg: '4.8%',  latest: '4.5%',  change: '-0.3',  lastUpd: '30 Apr 2025', units: '% y/y',     mean: 4.5,    std: 0.5,   amp: 0.6, phase: 0.3, freq: 0.20, noiseSeed: 529 },
      { name: 'Avg Monthly Earnings (y/y)',      asOfLastMtg: '5.0%',  latest: '4.8%',  change: '-0.2',  lastUpd: '29 May 2025', units: '% y/y',     mean: 4.8,    std: 0.5,   amp: 0.7, phase: 0.5, freq: 0.22, noiseSeed: 530 },
      { name: 'Total Wage Sum (y/y)',            asOfLastMtg: '4.6%',  latest: '4.4%',  change: '-0.2',  lastUpd: '30 Apr 2025', units: '% y/y',     mean: 4.4,    std: 0.6,   amp: 0.7, phase: 0.7, freq: 0.22, noiseSeed: 531 },
      { name: 'Unit Labour Costs (q/q)',         asOfLastMtg: '1.1%',  latest: '0.9%',  change: '-0.2',  lastUpd: '29 May 2025', units: '% q/q SA',  mean: 0.9,    std: 0.6,   amp: 0.7, phase: 0.9, freq: 0.24, noiseSeed: 532 },
      { name: 'Real Wage Growth (y/y)',          asOfLastMtg: '1.4%',  latest: '1.2%',  change: '-0.2',  lastUpd: '29 May 2025', units: '% y/y',     mean: 1.2,    std: 0.6,   amp: 0.7, phase: 1.1, freq: 0.26, noiseSeed: 533 },
    ],
  },
  {
    name: 'Inflation', bias: 0.2,
    indicators: [
      { name: 'CPI (y/y)',                       asOfLastMtg: '2.8%',  latest: '3.2%',  change: '+0.4',  lastUpd: '10 May 2025', units: '% y/y',     mean: 3.2,    std: 0.6,   amp: 0.9, phase: 0.0, freq: 0.28, noiseSeed: 534 },
      { name: 'CPI-ATE (y/y) — Norges Bank Core',asOfLastMtg: '3.2%', latest: '3.4%',  change: '+0.2',  lastUpd: '10 May 2025', units: '% y/y',     mean: 3.4,    std: 0.5,   amp: 0.8, phase: 0.2, freq: 0.26, noiseSeed: 535 },
      { name: 'CPI ex Energy (y/y)',             asOfLastMtg: '3.0%',  latest: '3.3%',  change: '+0.3',  lastUpd: '10 May 2025', units: '% y/y',     mean: 3.3,    std: 0.5,   amp: 0.8, phase: 0.4, freq: 0.25, noiseSeed: 536 },
      { name: 'Services CPI (y/y)',              asOfLastMtg: '4.2%',  latest: '4.5%',  change: '+0.3',  lastUpd: '10 May 2025', units: '% y/y',     mean: 4.5,    std: 0.6,   amp: 0.8, phase: 0.3, freq: 0.24, noiseSeed: 537 },
      { name: 'PPI (y/y)',                       asOfLastMtg: '0.8%',  latest: '1.2%',  change: '+0.4',  lastUpd: '08 May 2025', units: '% y/y',     mean: 1.2,    std: 3.0,   amp: 1.3, phase: 0.6, freq: 0.36, noiseSeed: 538 },
      { name: 'Import Prices (y/y)',             asOfLastMtg: '-0.5%', latest: '-0.2%', change: '+0.3',  lastUpd: '10 May 2025', units: '% y/y',     mean: -0.2,   std: 3.0,   amp: 1.3, phase: 0.8, freq: 0.40, noiseSeed: 539 },
      { name: 'Infl. Expectations 2y (Kantar)',  asOfLastMtg: '2.9%',  latest: '3.0%',  change: '+0.1',  lastUpd: '11 Mar 2025', units: '%',         mean: 3.0,    std: 0.4,   amp: 0.6, phase: 0.5, freq: 0.22, noiseSeed: 540 },
    ],
  },
  {
    name: 'Financial Conditions', bias: 0.0,
    indicators: [
      { name: 'Norges Bank Policy Rate',         asOfLastMtg: '4.25%', latest: '4.25%', change: '—',     lastUpd: '27 Mar 2025', units: '%',         mean: 4.25,   std: 0.12,  amp: 0.3, phase: 0.2, freq: 0.12, noiseSeed: 541 },
      { name: 'NOWA Overnight',                  asOfLastMtg: '4.22%', latest: '4.22%', change: '—',     lastUpd: '30 May 2025', units: '%',         mean: 4.22,   std: 0.12,  amp: 0.3, phase: 0.3, freq: 0.12, noiseSeed: 542 },
      { name: '2y NGB Yield',                    asOfLastMtg: '3.80%', latest: '3.80%', change: '—',     lastUpd: '30 May 2025', units: '%',         mean: 3.80,   std: 0.25,  amp: 0.8, phase: 0.4, freq: 0.28, noiseSeed: 543 },
      { name: '5y NGB Yield',                    asOfLastMtg: '3.35%', latest: '3.38%', change: '+0.03', lastUpd: '30 May 2025', units: '%',         mean: 3.38,   std: 0.30,  amp: 1.0, phase: 0.5, freq: 0.32, noiseSeed: 544 },
      { name: '10y NGB Yield',                   asOfLastMtg: '3.42%', latest: '3.45%', change: '+0.03', lastUpd: '30 May 2025', units: '%',         mean: 3.45,   std: 0.28,  amp: 1.0, phase: 0.6, freq: 0.34, noiseSeed: 545 },
      { name: '20y NGB Yield',                   asOfLastMtg: '3.42%', latest: '3.48%', change: '+0.06', lastUpd: '30 May 2025', units: '%',         mean: 3.48,   std: 0.26,  amp: 1.0, phase: 0.7, freq: 0.35, noiseSeed: 546 },
      { name: '30y NGB Yield',                   asOfLastMtg: '3.40%', latest: '3.48%', change: '+0.08', lastUpd: '30 May 2025', units: '%',         mean: 3.48,   std: 0.25,  amp: 1.0, phase: 0.8, freq: 0.36, noiseSeed: 547 },
      { name: '2s10s NGB Curve',                 asOfLastMtg: '-38',   latest: '-35',   change: '+3',    lastUpd: '30 May 2025', units: 'bps',       mean: -35.0,  std: 30.0,  amp: 1.1, phase: 1.2, freq: 0.38, noiseSeed: 548 },
      { name: '5s30s NGB Curve',                 asOfLastMtg: '5',     latest: '10',    change: '+5',    lastUpd: '30 May 2025', units: 'bps',       mean: 10.0,   std: 18.0,  amp: 1.0, phase: 1.4, freq: 0.36, noiseSeed: 549 },
      { name: '10y NGB Real Yield (NGB-i)',      asOfLastMtg: '1.18%', latest: '1.22%', change: '+0.04', lastUpd: '30 May 2025', units: '%',         mean: 1.22,   std: 0.20,  amp: 0.8, phase: 0.5, freq: 0.30, noiseSeed: 550 },
      { name: 'EUR/NOK',                         asOfLastMtg: '11.98', latest: '11.92', change: '-0.06', lastUpd: '30 May 2025', units: 'FX Rate',   mean: 11.92,  std: 0.40,  amp: 1.0, phase: 1.0, freq: 0.40, noiseSeed: 551 },
      { name: 'OBX Index',                       asOfLastMtg: '1,412', latest: '1,445', change: '+33',   lastUpd: '30 May 2025', units: 'Index',     mean: 1445.0, std: 80.0,  amp: 1.0, phase: 0.9, freq: 0.42, noiseSeed: 552 },
    ],
  },
]

const GROUPS: Group[] = GROUPS_META.map((g, gi) => ({
  name: g.name,
  indicators: g.indicators.map((ind, ii) => ({
    name: ind.name, asOfLastMtg: ind.asOfLastMtg, latest: ind.latest, change: ind.change,
    lastUpd: ind.lastUpd, units: ind.units, mean: ind.mean, std: ind.std,
    zscores: generateZscores(gi * 10 + ii, g.bias, ind.amp, ind.phase, ind.freq, ind.noiseSeed),
  })),
}))

// ─── NGB Yields ───────────────────────────────────────────────────────────────
// 5 tenors (2y/5y/10y/20y/30y), Jun '23 – Jun '25
// Norges Bank hiked to 4.50% Dec '23; held through 2024; cut to 4.25% Mar '25

export const YIELD_TENORS = ['2y', '5y', '10y', '20y', '30y'] as const
export type Tenor = typeof YIELD_TENORS[number]

export const SYNTHETIC_YIELDS: Record<Tenor, number[]> = {
  //          Jun'23 Jul'23 Aug'23 Sep'23 Oct'23 Nov'23 Dec'23 Jan'24 Feb'24 Mar'24 Apr'24 May'24 Jun'24 Jul'24 Aug'24 Sep'24 Oct'24 Nov'24 Dec'24 Jan'25 Feb'25 Mar'25 Apr'25 May'25 Jun'25
  '2y':  [4.05, 4.20, 4.32, 4.40, 4.42, 4.35, 4.38, 4.30, 4.28, 4.25, 4.22, 4.20, 4.18, 4.12, 4.05, 3.98, 3.95, 3.92, 3.90, 3.88, 3.85, 3.80, 3.78, 3.80, 3.80],
  '5y':  [3.78, 3.92, 4.02, 4.10, 4.12, 3.98, 3.88, 3.82, 3.78, 3.75, 3.72, 3.68, 3.58, 3.48, 3.38, 3.28, 3.25, 3.18, 3.12, 3.22, 3.28, 3.32, 3.35, 3.38, 3.38],
  '10y': [3.55, 3.70, 3.80, 3.92, 4.02, 3.82, 3.65, 3.60, 3.58, 3.55, 3.62, 3.58, 3.48, 3.38, 3.28, 3.20, 3.25, 3.18, 3.12, 3.28, 3.35, 3.38, 3.42, 3.45, 3.45],
  '20y': [3.45, 3.60, 3.70, 3.82, 3.92, 3.72, 3.55, 3.50, 3.48, 3.45, 3.52, 3.48, 3.40, 3.32, 3.22, 3.15, 3.20, 3.12, 3.08, 3.25, 3.32, 3.38, 3.42, 3.48, 3.48],
  '30y': [3.42, 3.57, 3.67, 3.80, 3.90, 3.70, 3.52, 3.48, 3.45, 3.42, 3.50, 3.45, 3.38, 3.30, 3.20, 3.12, 3.18, 3.10, 3.05, 3.22, 3.30, 3.35, 3.40, 3.45, 3.48],
}

// ─── Yield PCA (Jacobi) ───────────────────────────────────────────────────────

function jacobiEigen(mat: number[][]): { values: number[]; vectors: number[][] } {
  const n = mat.length, a = mat.map(r => [...r])
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let iter = 0; iter < 500; iter++) {
    let maxVal = 0, p = 0, q = 1
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) if (Math.abs(a[i][j]) > maxVal) { maxVal = Math.abs(a[i][j]); p = i; q = j }
    if (maxVal < 1e-12) break
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(1 + theta * theta))
    const c = 1 / Math.sqrt(1 + t * t), s = t * c
    const app = a[p][p], aqq = a[q][q], apq = a[p][q]
    a[p][p] = app - t * apq; a[q][q] = aqq + t * apq; a[p][q] = 0; a[q][p] = 0
    for (let i = 0; i < n; i++) { if (i !== p && i !== q) { const aip = a[i][p], aiq = a[i][q]; a[i][p] = a[p][i] = c * aip - s * aiq; a[i][q] = a[q][i] = s * aip + c * aiq } }
    for (let i = 0; i < n; i++) { const vip = v[i][p], viq = v[i][q]; v[i][p] = c * vip - s * viq; v[i][q] = s * vip + c * viq }
  }
  const pairs = Array.from({ length: n }, (_, k) => ({ val: a[k][k], vec: Array.from({ length: n }, (_, r) => v[r][k]) })).sort((x, y) => y.val - x.val)
  return { values: pairs.map(p => p.val), vectors: pairs.map(p => p.vec) }
}
export interface YieldPCAResult { scores: number[][]; loadings: number[][]; explainedVar: number[]; means: number[] }
function computeYieldPCA(): YieldPCAResult {
  const N = N_MONTHS, M = YIELD_TENORS.length
  const data: number[][] = Array.from({ length: N }, (_, t) => YIELD_TENORS.map(tenor => SYNTHETIC_YIELDS[tenor][t]))
  const means = Array.from({ length: M }, (_, j) => data.reduce((s, row) => s + row[j], 0) / N)
  const centered = data.map(row => row.map((v, j) => v - means[j]))
  const cov: number[][] = Array.from({ length: M }, (_, i) => Array.from({ length: M }, (_, j) => centered.reduce((s, row) => s + row[i] * row[j], 0) / (N - 1)))
  const { values, vectors } = jacobiEigen(cov)
  const totalVar = values.reduce((s, v) => s + Math.abs(v), 0)
  const rawLoadings = vectors.slice(0, 3)
  const pivots = [rawLoadings[0][2], rawLoadings[1][4], rawLoadings[2][1]]
  const loadings = rawLoadings.map((l, k) => { const sign = pivots[k] < 0 ? -1 : 1; return l.map(v => v * sign) })
  const scores = centered.map(row => loadings.map(loading => loading.reduce((s, l, j) => s + l * row[j], 0)))
  return { scores, loadings, explainedVar: values.slice(0, 3).map(v => v / totalVar), means }
}
export const YIELD_PCA: YieldPCAResult = computeYieldPCA()

// ─── Color helpers + Legend + HeatmapTable ────────────────────────────────────

function formatCellValue(value: number, units: string): string {
  if (units === 'FX Rate') return value.toFixed(2)
  if (units === 'bps') return value.toFixed(0)
  if (Math.abs(value) >= 1000) return value.toFixed(0)
  return value.toFixed(1)
}
function zscoreToColors(z: number): { bg: string; fg: string } {
  if (z >= 2.0)  return { bg: '#7F1D1D', fg: '#ffffff' }
  if (z >= 1.0)  return { bg: '#DC2626', fg: '#ffffff' }
  if (z >= 0.5)  return { bg: '#FCA5A5', fg: '#0f172a' }
  if (z > -0.5)  return { bg: '#F1F5F9', fg: '#0f172a' }
  if (z > -1.0)  return { bg: '#93C5FD', fg: '#0f172a' }
  if (z > -2.0)  return { bg: '#2563EB', fg: '#ffffff' }
  return           { bg: '#1E3A5F', fg: '#ffffff' }
}
function Legend() {
  const steps = [{ bg: '#7F1D1D', fg: '#ffffff', label: '≥ +2σ' }, { bg: '#DC2626', fg: '#ffffff', label: '+1σ' }, { bg: '#FCA5A5', fg: '#0f172a', label: '+0.5σ' }, { bg: '#F1F5F9', fg: '#0f172a', label: '0' }, { bg: '#93C5FD', fg: '#0f172a', label: '−0.5σ' }, { bg: '#2563EB', fg: '#ffffff', label: '−1σ' }, { bg: '#1E3A5F', fg: '#ffffff', label: '≤ −2σ' }]
  return (<div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><span style={{ color: '#475569', fontSize: 11, marginRight: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Z-score scale</span>{steps.map(s => (<div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 36, height: 20, background: s.bg, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ color: s.fg, fontSize: 9, fontFamily: 'monospace', fontWeight: 600 }}>{s.label}</span></div></div>))}</div>)
}

const CELL_W = 52, CELL_H = 28, INDICATOR_W_DEFAULT = 210
const RIGHT_COL_W = 76, UNITS_COL_W = 88, stickyBg = '#080d1a'

function HeatmapTable() {
  const [indicatorW, setIndicatorW] = useState(INDICATOR_W_DEFAULT)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); dragRef.current = { startX: e.clientX, startW: indicatorW }
    function onMouseMove(ev: MouseEvent) { if (!dragRef.current) return; setIndicatorW(Math.max(120, dragRef.current.startW + ev.clientX - dragRef.current.startX)) }
    function onMouseUp() { dragRef.current = null; window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp) }
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp)
  }, [indicatorW])
  const cellStyle = (z: number): React.CSSProperties => { const { bg, fg } = zscoreToColors(z); return { width: CELL_W, minWidth: CELL_W, maxWidth: CELL_W, height: CELL_H, textAlign: 'center', fontFamily: 'monospace', fontSize: 10, fontWeight: 500, color: fg, background: bg, padding: 0, border: '1px solid rgba(8,13,26,0.5)', userSelect: 'none' } }
  const hdrCell: React.CSSProperties = { width: CELL_W, minWidth: CELL_W, maxWidth: CELL_W, textAlign: 'center', color: '#64748b', fontSize: 10, fontFamily: 'monospace', padding: '5px 2px', fontWeight: 600, whiteSpace: 'nowrap', background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, zIndex: 2 }
  const indHdr: React.CSSProperties = { width: indicatorW, minWidth: indicatorW, maxWidth: indicatorW, textAlign: 'left', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '5px 12px', fontWeight: 600, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, left: 0, zIndex: 4, overflow: 'visible' }
  const rHdr = (ro: number): React.CSSProperties => ({ width: RIGHT_COL_W, minWidth: RIGHT_COL_W, maxWidth: RIGHT_COL_W, textAlign: 'center', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '5px 4px', fontWeight: 600, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, right: ro, zIndex: 4, whiteSpace: 'nowrap' })
  const indCell: React.CSSProperties = { width: indicatorW, minWidth: indicatorW, maxWidth: indicatorW, color: '#cbd5e1', fontSize: 11, padding: '0 12px', height: CELL_H, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: 0, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.04)', borderRight: '1px solid rgba(255,255,255,0.07)', zIndex: 1 }
  const grpRow: React.CSSProperties = { background: 'rgba(255,255,255,0.025)', color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, padding: '4px 12px', height: 22, position: 'sticky', left: 0, zIndex: 1 }
  const rCell: React.CSSProperties = { width: RIGHT_COL_W, minWidth: RIGHT_COL_W, maxWidth: RIGHT_COL_W, textAlign: 'center', fontSize: 10, fontFamily: 'monospace', padding: 0, height: CELL_H, borderBottom: '1px solid rgba(255,255,255,0.04)', borderLeft: '1px solid rgba(255,255,255,0.06)', background: stickyBg }
  const uHdr = (ro: number): React.CSSProperties => ({ width: UNITS_COL_W, minWidth: UNITS_COL_W, maxWidth: UNITS_COL_W, textAlign: 'center', color: '#64748b', fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '0.05em', padding: '5px 4px', fontWeight: 600, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky' as const, top: 0, right: ro, zIndex: 4, whiteSpace: 'nowrap' as const })
  const R_CHANGE = 0, R_LATEST = RIGHT_COL_W, R_AS_OF_MTG = RIGHT_COL_W * 2, R_UNITS = RIGHT_COL_W * 3, R_LASTUPD = RIGHT_COL_W * 3 + UNITS_COL_W
  return (
    <div style={{ overflowX: 'auto', overflowY: 'visible' }}>
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: indicatorW + CELL_W * N_MONTHS + RIGHT_COL_W * 4 + UNITS_COL_W }}>
        <colgroup><col style={{ width: indicatorW }} />{MONTH_COLS.map((_, i) => <col key={i} style={{ width: CELL_W }} />)}<col style={{ width: RIGHT_COL_W }} /><col style={{ width: UNITS_COL_W }} /><col style={{ width: RIGHT_COL_W }} /><col style={{ width: RIGHT_COL_W }} /><col style={{ width: RIGHT_COL_W }} /></colgroup>
        <thead>
          <tr>
            <th style={indHdr}>Indicator<div onMouseDown={onResizeMouseDown} style={{ position: 'absolute', top: 0, right: 0, width: 6, height: '100%', cursor: 'col-resize', userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ width: 2, height: 14, borderRadius: 1, background: 'rgba(255,255,255,0.18)' }} /></div></th>
            {MONTH_COLS.map((m, i) => <th key={i} style={hdrCell}>{m}</th>)}
            <th style={{ ...rHdr(R_LASTUPD), borderLeft: '1px solid rgba(255,255,255,0.07)' }}>Last Upd</th>
            <th style={{ ...uHdr(R_UNITS), borderLeft: '1px solid rgba(255,255,255,0.04)' }}>Units</th>
            <th style={{ ...rHdr(R_AS_OF_MTG), borderLeft: '1px solid rgba(255,255,255,0.04)' }}>As of MTG</th>
            <th style={{ ...rHdr(R_LATEST), borderLeft: '1px solid rgba(255,255,255,0.04)' }}>Latest</th>
            <th style={{ ...rHdr(R_CHANGE), borderLeft: '1px solid rgba(255,255,255,0.04)' }}>Change</th>
          </tr>
        </thead>
        <tbody>
          {GROUPS.map(group => (
            <React.Fragment key={group.name}>
              <tr style={{ background: 'rgba(255,255,255,0.025)' }}><td colSpan={N_MONTHS + 6} style={grpRow}>{group.name}</td></tr>
              {group.indicators.map(ind => (
                <tr key={ind.name} onMouseEnter={e => { e.currentTarget.querySelectorAll('td').forEach(td => { if ((td as HTMLElement).dataset.heatcell !== '1') (td as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }) }} onMouseLeave={e => { e.currentTarget.querySelectorAll('td').forEach(td => { if ((td as HTMLElement).dataset.heatcell !== '1') (td as HTMLElement).style.background = stickyBg }) }}>
                  <td style={indCell}>{ind.name}</td>
                  {ind.zscores.map((z, ci) => (<td key={ci} style={cellStyle(z)} data-heatcell="1">{formatCellValue(ind.mean + z * ind.std, ind.units)}</td>))}
                  <td style={{ ...rCell, position: 'sticky', right: R_LASTUPD, zIndex: 2, color: '#64748b', fontSize: 9 }}>{ind.lastUpd}</td>
                  <td style={{ width: UNITS_COL_W, minWidth: UNITS_COL_W, maxWidth: UNITS_COL_W, textAlign: 'center', fontSize: 9, fontFamily: 'monospace', padding: 0, height: CELL_H, borderBottom: '1px solid rgba(255,255,255,0.04)', borderLeft: '1px solid rgba(255,255,255,0.06)', background: stickyBg, position: 'sticky', right: R_UNITS, zIndex: 2, color: '#475569', whiteSpace: 'nowrap' }}>{ind.units}</td>
                  <td style={{ ...rCell, position: 'sticky', right: R_AS_OF_MTG, zIndex: 2, color: '#94a3b8' }}>{ind.asOfLastMtg}</td>
                  <td style={{ ...rCell, position: 'sticky', right: R_LATEST, zIndex: 2, color: '#e2e8f0', fontWeight: 600 }}>{ind.latest}</td>
                  <td style={{ ...rCell, position: 'sticky', right: R_CHANGE, zIndex: 2, fontWeight: 600, color: ind.change === '—' ? '#334155' : ind.change.startsWith('+') ? '#34d399' : '#f87171' }}>{ind.change}</td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── DFM + OLS + PC Charts ────────────────────────────────────────────────────

const DFM_FACTORS: { key: string; label: string; color: string; groupIndices: number[] }[] = [
  { key: 'broadMacro', label: 'Broad Macro', color: '#94a3b8', groupIndices: [0, 1, 3, 4, 5] },
  { key: 'growth',     label: 'Growth',      color: '#34d399', groupIndices: [0, 1, 2] },
  { key: 'inflation',  label: 'Inflation',   color: '#f87171', groupIndices: [5] },
  { key: 'employment', label: 'Employment',  color: '#60a5fa', groupIndices: [3] },
  { key: 'wages',      label: 'Wages',       color: '#a78bfa', groupIndices: [4] },
]
function computeFactor(groupIndices: number[]): number[] {
  const all: number[][] = []
  groupIndices.forEach(gi => GROUPS[gi].indicators.forEach(ind => all.push(ind.zscores)))
  return Array.from({ length: N_MONTHS }, (_, t) => { const vals = all.map(zs => zs[t]); return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100) / 100 })
}
const FACTOR_SERIES: Record<string, number[]> = Object.fromEntries(DFM_FACTORS.map(f => [f.key, computeFactor(f.groupIndices)]))
const DFM_CHART_DATA = MONTH_COLS.map((month, t) => { const obj: Record<string, string | number> = { month }; DFM_FACTORS.forEach(f => { obj[f.key] = FACTOR_SERIES[f.key][t] }); return obj })
interface FactorStats { current: number; d1m: number; d3m: number; d12m: number; zscore: number }
const FACTOR_STATS: Record<string, FactorStats> = Object.fromEntries(DFM_FACTORS.map(f => {
  const s = FACTOR_SERIES[f.key], current = s[N_MONTHS - 1], mean = s.reduce((a, b) => a + b, 0) / s.length
  const std = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length)
  return [f.key, { current, d1m: current - s[N_MONTHS - 2], d3m: current - s[N_MONTHS - 4], d12m: current - s[N_MONTHS - 13], zscore: std > 0 ? (current - mean) / std : 0 }]
}))
function DFMSection() {
  const fmt = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2)
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Macro Factors — DFM Synthesis</h2>
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>5 factors extracted via Dynamic Factor Model &middot; weekly monitoring of Norwegian macro fundamentals</p>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={DFM_CHART_DATA} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={3} />
              <YAxis domain={[-2.5, 2.5]} tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickCount={6} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(value: number, name: string) => { const f = DFM_FACTORS.find(f => f.key === name); return [value.toFixed(2) + 'σ', f?.label ?? name] }} />
              {DFM_FACTORS.map(f => <Line key={f.key} type="monotone" dataKey={f.key} stroke={f.color} strokeWidth={1.8} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />)}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 8 }}>{DFM_FACTORS.map(f => (<div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 24, height: 2, borderRadius: 1, background: f.color }} /><span style={{ color: '#94a3b8', fontSize: 11 }}>{f.label}</span></div>))}</div>
        </div>
        <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Factor summary</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead><tr>{['Factor','Level (σ)','Δ1m','Δ3m','Δ12m','Z'].map((h, i) => <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 6px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
              <tbody>{DFM_FACTORS.map(f => { const st = FACTOR_STATS[f.key]; const lc = st.current > 0.3 ? '#f87171' : st.current < -0.3 ? '#60a5fa' : '#94a3b8'; const dc = (d: number) => d > 0.05 ? '#f87171' : d < -0.05 ? '#60a5fa' : '#475569'; const zc = st.zscore > 0.5 ? '#f87171' : st.zscore < -0.5 ? '#60a5fa' : '#94a3b8'; return (<tr key={f.key}><td style={{ padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, flexShrink: 0 }} /><span style={{ color: '#cbd5e1', fontSize: 11, whiteSpace: 'nowrap' }}>{f.label}</span></div></td><td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: lc, fontWeight: 700 }}>{fmt(st.current)}</td><td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: dc(st.d1m) }}>{fmt(st.d1m)}</td><td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: dc(st.d3m) }}>{fmt(st.d3m)}</td><td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: dc(st.d12m) }}>{fmt(st.d12m)}</td><td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: zc, fontWeight: 600 }}>{fmt(st.zscore)}</td></tr>) })}</tbody>
            </table>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '12px 14px' }}>
            <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Methodology</p>
            {['Broad Macro: avg z-score across activity, inflation, labour & wage series','Growth: Business Activity, Real Activity & Housing blocks','Inflation: Inflation block (~7 indicators incl. CPI/CPI-ATE/Services)','Employment: Labour Market block (~7 indicators)','Wages: Wages block (~5 indicators incl. TBU wage estimate)'].map((note, i) => (<div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5 }}><span style={{ color: DFM_FACTORS[i].color, fontSize: 10, flexShrink: 0, marginTop: 1 }}>●</span><span style={{ color: '#475569', fontSize: 10, lineHeight: 1.45 }}>{note}</span></div>))}
          </div>
        </div>
      </div>
    </div>
  )
}

function matTranspose(A: number[][]): number[][] { return A[0].map((_, j) => A.map(r => r[j])) }
function matMul(A: number[][], B: number[][]): number[][] { return Array.from({ length: A.length }, (_, i) => Array.from({ length: B[0].length }, (_, j) => Array.from({ length: B.length }, (_, k) => A[i][k] * B[k][j]).reduce((a, b) => a + b, 0))) }
function matVecMul(A: number[][], v: number[]): number[] { return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0)) }
function matInv(A: number[][]): number[][] {
  const n = A.length, aug = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col++) { let mx = col; for (let r = col + 1; r < n; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[mx][col])) mx = r; [aug[col], aug[mx]] = [aug[mx], aug[col]]; const pv = aug[col][col]; for (let j = 0; j < 2 * n; j++) aug[col][j] /= pv; for (let r = 0; r < n; r++) { if (r === col) continue; const f = aug[r][col]; for (let j = 0; j < 2 * n; j++) aug[r][j] -= f * aug[col][j] } }
  return aug.map(row => row.slice(n))
}
interface OLSResult { coefficients: number[]; tStats: number[]; rSquared: number; adjRSquared: number; fitted: number[]; residuals: number[] }
function ols(y: number[], X: number[][]): OLSResult {
  const N = y.length, K = X[0].length, Xt = matTranspose(X), XtX = matMul(Xt, X), Xty = matVecMul(Xt, y), beta = matVecMul(matInv(XtX), Xty)
  const fitted = X.map(row => row.reduce((s, x, j) => s + x * beta[j], 0)), residuals = y.map((yi, i) => yi - fitted[i])
  const yMean = y.reduce((s, v) => s + v, 0) / N, TSS = y.reduce((s, v) => s + (v - yMean) ** 2, 0), RSS = residuals.reduce((s, r) => s + r ** 2, 0)
  const sigma2 = RSS / (N - K), XtXinv = matInv(XtX)
  return { coefficients: beta, tStats: beta.map((b, j) => b / Math.sqrt(sigma2 * XtXinv[j][j])), rSquared: 1 - RSS / TSS, adjRSquared: 1 - (RSS / (N - K)) / (TSS / (N - 1)), fitted, residuals }
}
const REG_FACTORS: { key: string; label: string; color: string }[] = [{ key: 'broadMacro', label: 'Broad Macro', color: '#94a3b8' }, { key: 'growth', label: 'Growth', color: '#34d399' }, { key: 'inflation', label: 'Inflation', color: '#f87171' }, { key: 'employment', label: 'Employment', color: '#60a5fa' }]
const REG_X: number[][] = Array.from({ length: N_MONTHS }, (_, t) => REG_FACTORS.map(f => FACTOR_SERIES[f.key][t]))
const PC1_REG: OLSResult = ols(YIELD_PCA.scores.map(s => s[0]), REG_X)
const PC2_REG: OLSResult = ols(YIELD_PCA.scores.map(s => s[1]), REG_X)
const PC_META = [{ key: 'pc1', label: 'PC1 — Level', color: '#f59e0b' }, { key: 'pc2', label: 'PC2 — Slope', color: '#34d399' }, { key: 'pc3', label: 'PC3 — Curvature', color: '#a78bfa' }]
const PC_CHART_DATA = MONTH_COLS.map((month, t) => ({ month, pc1: Math.round(YIELD_PCA.scores[t][0] * 1000) / 1000, pc2: Math.round(YIELD_PCA.scores[t][1] * 1000) / 1000, pc3: Math.round(YIELD_PCA.scores[t][2] * 1000) / 1000 }))

function YieldPCChart() {
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div><h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>NGB Yield Curve — Principal Components</h2><p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>PCA on 2/5/10/20/30y NGB yields &middot; synthetic data</p></div>
        <div style={{ display: 'flex', gap: 8 }}>{PC_META.map((pc, k) => (<div key={pc.key} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '4px 10px' }}><div style={{ width: 8, height: 8, borderRadius: '50%', background: pc.color }} /><span style={{ color: '#94a3b8', fontSize: 11 }}>{pc.label}</span><span style={{ color: pc.color, fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>{(YIELD_PCA.explainedVar[k] * 100).toFixed(1)}%</span></div>))}</div>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={PC_CHART_DATA} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={3} />
          <YAxis tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(2)} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number, n: string) => { const pc = PC_META.find(p => p.key === n); return [v.toFixed(3), pc?.label ?? n] }} />
          {PC_META.map(pc => <Line key={pc.key} type="monotone" dataKey={pc.key} stroke={pc.color} strokeWidth={1.8} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />)}
        </LineChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 20 }}>
        <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Factor loadings (eigenvectors)</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead><tr><th style={{ textAlign: 'left', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 8px 6px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', width: 120 }}>Factor</th>{YIELD_TENORS.map(t => <th key={t} style={{ textAlign: 'right', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 6px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>{t}</th>)}</tr></thead>
          <tbody>{PC_META.map((pc, k) => (<tr key={pc.key}><td style={{ padding: '5px 8px 5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 10, height: 10, borderRadius: '50%', background: pc.color, flexShrink: 0 }} /><span style={{ color: '#cbd5e1', fontSize: 11 }}>{pc.label}</span></div></td>{YIELD_PCA.loadings[k].map((l, j) => (<td key={j} style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', fontSize: 10, color: l > 0.05 ? '#34d399' : l < -0.05 ? '#f87171' : '#475569' }}>{l >= 0 ? '+' : ''}{l.toFixed(3)}</td>))}</tr>))}</tbody>
        </table>
      </div>
    </div>
  )
}

const REG_CHART_DATA = MONTH_COLS.map((month, t) => ({ month, pc1Actual: Math.round(YIELD_PCA.scores[t][0] * 1000) / 1000, pc1Fitted: Math.round(PC1_REG.fitted[t] * 1000) / 1000, pc2Actual: Math.round(YIELD_PCA.scores[t][1] * 1000) / 1000, pc2Fitted: Math.round(PC2_REG.fitted[t] * 1000) / 1000 }))
function tStatColor(t: number): string { const a = Math.abs(t); return a >= 2.58 ? '#34d399' : a >= 1.96 ? '#fbbf24' : a >= 1.65 ? '#94a3b8' : '#475569' }
function RegressionTable({ reg, pcLabel }: { reg: OLSResult; pcLabel: string }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}><span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 600 }}>{pcLabel}</span><span style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6, padding: '2px 8px', fontFamily: 'monospace', fontSize: 11, color: '#f1f5f9' }}>R² = {reg.rSquared.toFixed(3)}</span><span style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6, padding: '2px 8px', fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>adj. R² = {reg.adjRSquared.toFixed(3)}</span></div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead><tr>{['Factor','Coeff.','t-stat','Sig.'].map(h => <th key={h} style={{ textAlign: h === 'Factor' ? 'left' : 'right', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 8px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
        <tbody>{REG_FACTORS.map((f, k) => { const b = reg.coefficients[k], t = reg.tStats[k]; return (<tr key={f.key}><td style={{ padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, flexShrink: 0 }} /><span style={{ color: '#cbd5e1', fontSize: 11 }}>{f.label}</span></div></td><td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: b >= 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>{b >= 0 ? '+' : ''}{b.toFixed(4)}</td><td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: tStatColor(t) }}>{t >= 0 ? '+' : ''}{t.toFixed(2)}</td><td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', color: tStatColor(t), fontWeight: 600 }}>{Math.abs(t) >= 2.58 ? '***' : Math.abs(t) >= 1.96 ? '**' : Math.abs(t) >= 1.65 ? '*' : '—'}</td></tr>) })}</tbody>
      </table>
    </div>
  )
}
function PCRegressionSection() {
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 20 }}><h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Rates–Macro Linkage — PC Regressions</h2><p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>OLS: PC1 &amp; PC2 of NGB curve regressed on macro factors &middot; *** p&lt;1% &nbsp;** p&lt;5% &nbsp;* p&lt;10%</p></div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
        {[{ label: 'PC1 — Level', actualKey: 'pc1Actual', fittedKey: 'pc1Fitted', color: '#f59e0b' }, { label: 'PC2 — Slope', actualKey: 'pc2Actual', fittedKey: 'pc2Fitted', color: '#34d399' }].map(({ label, actualKey, fittedKey, color }) => (
          <div key={label} style={{ flex: '1 1 400px', minWidth: 0 }}>
            <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>{label}</p>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={REG_CHART_DATA} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
                <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(2)} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.10)" strokeDasharray="4 4" />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number, n: string) => [v.toFixed(3), n.includes('Actual') ? 'Actual' : 'Fitted']} />
                <Line type="monotone" dataKey={actualKey} stroke={color} strokeWidth={1.8} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                <Line type="monotone" dataKey={fittedKey} stroke="rgba(255,255,255,0.45)" strokeWidth={1.2} strokeDasharray="5 3" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 16, marginTop: 6 }}><div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 2, background: color, borderRadius: 1 }} /><span style={{ color: '#475569', fontSize: 10 }}>Actual</span></div><div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 0, borderTop: '2px dashed rgba(255,255,255,0.45)' }} /><span style={{ color: '#475569', fontSize: 10 }}>Fitted</span></div></div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}><RegressionTable reg={PC1_REG} pcLabel="PC1 — Level" /></div>
        <div style={{ width: '1px', background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
        <div style={{ flex: '1 1 280px', minWidth: 0 }}><RegressionTable reg={PC2_REG} pcLabel="PC2 — Slope" /></div>
      </div>
    </div>
  )
}

// ── FAIR VALUE ────────────────────────────────────────────────────────────────
const NGB_10Y_IDX = 2
const NGB_10Y_RAW = SYNTHETIC_YIELDS['10y']
const NGB_10Y_MEAN = NGB_10Y_RAW.reduce((a: number, b: number) => a + b, 0) / NGB_10Y_RAW.length
const NGB_10Y_STD = Math.sqrt(NGB_10Y_RAW.reduce((s: number, v: number) => s + (v - NGB_10Y_MEAN) ** 2, 0) / NGB_10Y_RAW.length)
const PC1_LOAD_10Y = YIELD_PCA.loadings[NGB_10Y_IDX][0]
const PC2_LOAD_10Y = YIELD_PCA.loadings[NGB_10Y_IDX][1]
const NGB_10Y_FAIR_VALUE = YIELD_PCA.scores.map((_sc, t) => {
  const zFitted = PC1_LOAD_10Y * PC1_REG.fitted[t] + PC2_LOAD_10Y * PC2_REG.fitted[t]
  return Math.round((zFitted * NGB_10Y_STD + NGB_10Y_MEAN) * 1000) / 1000
})
const NGB_10Y_PCA_FITTED = YIELD_PCA.scores.map((sc, _t) => {
  const zFitted = PC1_LOAD_10Y * sc[0] + PC2_LOAD_10Y * sc[1]
  return Math.round((zFitted * NGB_10Y_STD + NGB_10Y_MEAN) * 1000) / 1000
})
const NGB_10Y_RICHCHEAP = NGB_10Y_RAW.map((v: number, t: number) => Math.round((v - NGB_10Y_FAIR_VALUE[t]) * 100) / 100)

function NorwayFairValueSection() {
  const fvData = MONTH_COLS.map((month, t) => ({ month, actual: NGB_10Y_RAW[t], pcaFitted: NGB_10Y_PCA_FITTED[t], macroFair: NGB_10Y_FAIR_VALUE[t], richCheap: NGB_10Y_RICHCHEAP[t] }))
  const last = fvData[fvData.length - 1]
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>NGB 10y Fair Value</h2>
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>PCA reconstruction + macro OLS fair value &middot; rich/cheap = actual − macro fair</p>
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 28 }}>
        <div style={{ flex: '1 1 420px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>Yield vs Fair Value</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={fvData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
              <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(2)} domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number, n: string) => [v.toFixed(3) + '%', n === 'actual' ? 'NGB 10y Actual' : n === 'pcaFitted' ? 'PCA Fitted' : 'Macro Fair Value']} />
              <Line type="monotone" dataKey="actual" stroke="#f59e0b" strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="pcaFitted" stroke="#34d399" strokeWidth={1.4} strokeDasharray="4 2" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="macroFair" stroke="#818cf8" strokeWidth={1.4} strokeDasharray="6 3" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 6, flexWrap: 'wrap' }}>
            {[{ color: '#f59e0b', label: 'NGB 10y Actual', dash: false }, { color: '#34d399', label: 'PCA Fitted', dash: true }, { color: '#818cf8', label: 'Macro Fair Value', dash: true }].map(({ color, label, dash }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>{dash ? <div style={{ width: 18, height: 0, borderTop: `2px dashed ${color}` }} /> : <div style={{ width: 18, height: 2, background: color, borderRadius: 1 }} />}<span style={{ color: '#475569', fontSize: 10 }}>{label}</span></div>
            ))}
          </div>
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>Rich / Cheap (bps vs macro fair)</p>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={fvData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <defs>
                <linearGradient id="gradCheapNO" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#34d399" stopOpacity={0.3} /><stop offset="95%" stopColor="#34d399" stopOpacity={0.02} /></linearGradient>
                <linearGradient id="gradRichNO" x1="0" y1="1" x2="0" y2="0"><stop offset="5%" stopColor="#f87171" stopOpacity={0.3} /><stop offset="95%" stopColor="#f87171" stopOpacity={0.02} /></linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
              <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => (v * 100).toFixed(0) + 'bp'} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" strokeDasharray="4 4" />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number) => [(v * 100).toFixed(1) + 'bp', 'Rich/Cheap']} />
              <Area type="monotone" dataKey="richCheap" stroke={last.richCheap >= 0 ? '#34d399' : '#f87171'} strokeWidth={1.8} fill={last.richCheap >= 0 ? 'url(#gradCheapNO)' : 'url(#gradRichNO)'} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: last.richCheap >= 0 ? '#34d399' : '#f87171' }}>{last.richCheap >= 0 ? '+' : ''}{(last.richCheap * 100).toFixed(1)}bp</span>
            <span style={{ color: '#475569', fontSize: 11, marginLeft: 6 }}>{last.richCheap >= 0 ? 'cheap vs fair' : 'rich vs fair'} (latest)</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {[{ label: 'NGB 10y Actual', value: (last.actual * 100).toFixed(0) + 'bp', color: '#f59e0b' }, { label: 'PCA Fitted', value: (last.pcaFitted * 100).toFixed(0) + 'bp', color: '#34d399' }, { label: 'Macro Fair Value', value: (last.macroFair * 100).toFixed(0) + 'bp', color: '#818cf8' }, { label: 'Rich/Cheap', value: (last.richCheap >= 0 ? '+' : '') + (last.richCheap * 100).toFixed(1) + 'bp', color: last.richCheap >= 0 ? '#34d399' : '#f87171' }].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '10px 16px', minWidth: 120 }}>
            <div style={{ color: '#475569', fontSize: 10, marginBottom: 4 }}>{label}</div>
            <div style={{ color, fontSize: 15, fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── CURVE DYNAMICS ────────────────────────────────────────────────────────────
const BDAYS_PER_MONTH = 21
const N_DAILY = MONTH_COLS.length * BDAYS_PER_MONTH
function _genDailyYield(monthly: number[]): number[] {
  const out: number[] = []
  for (let m = 0; m < monthly.length; m++) {
    const next = monthly[Math.min(m + 1, monthly.length - 1)]
    for (let d = 0; d < BDAYS_PER_MONTH; d++) {
      const frac = d / BDAYS_PER_MONTH
      const noise = (Math.sin((m * BDAYS_PER_MONTH + d) * 0.37) * 0.012 + Math.cos((m * BDAYS_PER_MONTH + d) * 0.19) * 0.008)
      out.push(monthly[m] + (next - monthly[m]) * frac + noise)
    }
  }
  return out
}
const DAILY_2Y = _genDailyYield(SYNTHETIC_YIELDS['2y'])
const DAILY_10Y = _genDailyYield(SYNTHETIC_YIELDS['10y'])
const ROLL_DAYS = 63
const CURVE_ROLL_DATA: { month: string; bullSteep: number; bearFlat: number; neutral: number }[] = []
for (let i = ROLL_DAYS; i < N_DAILY; i += BDAYS_PER_MONTH) {
  const monthIdx = Math.floor(i / BDAYS_PER_MONTH)
  if (monthIdx >= MONTH_COLS.length) break
  let bs = 0, bf = 0, ne = 0
  for (let j = i - ROLL_DAYS; j < i - 1; j++) {
    const d10 = DAILY_10Y[j + 1] - DAILY_10Y[j]
    const slope = (DAILY_10Y[j + 1] - DAILY_2Y[j + 1]) - (DAILY_10Y[j] - DAILY_2Y[j])
    if (d10 < -0.0005 && slope > 0.0001) bs++
    else if (d10 > 0.0005 && slope < -0.0001) bf++
    else ne++
  }
  const tot = bs + bf + ne || 1
  CURVE_ROLL_DATA.push({ month: MONTH_COLS[monthIdx], bullSteep: Math.round((bs / tot) * 100), bearFlat: Math.round((bf / tot) * 100), neutral: Math.round((ne / tot) * 100) })
}
function CurveDynamicsSection() {
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>2s10s NGB Directionality</h2>
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>63-day rolling regime attribution &middot; bull-steep / bear-flat / neutral</p>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={CURVE_ROLL_DATA} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
          <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => v + '%'} domain={[0, 100]} />
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number, n: string) => [v + '%', n === 'bullSteep' ? 'Bull Steep' : n === 'bearFlat' ? 'Bear Flat' : 'Neutral']} />
          <Area type="monotone" dataKey="bullSteep" stackId="1" stroke="#34d399" fill="rgba(52,211,153,0.25)" strokeWidth={1} />
          <Area type="monotone" dataKey="neutral" stackId="1" stroke="#475569" fill="rgba(71,85,105,0.20)" strokeWidth={1} />
          <Area type="monotone" dataKey="bearFlat" stackId="1" stroke="#f87171" fill="rgba(248,113,113,0.25)" strokeWidth={1} />
        </AreaChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 20, marginTop: 10, flexWrap: 'wrap' }}>
        {[{ color: '#34d399', label: 'Bull Steep', key: 'bullSteep' }, { color: '#475569', label: 'Neutral', key: 'neutral' }, { color: '#f87171', label: 'Bear Flat', key: 'bearFlat' }].map(({ color, label, key }) => {
          const lastRow = CURVE_ROLL_DATA[CURVE_ROLL_DATA.length - 1]
          const val = lastRow[key as keyof typeof lastRow] as number
          return (<div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} /><span style={{ color: '#475569', fontSize: 10 }}>{label}</span><span style={{ color: '#94a3b8', fontSize: 10, fontFamily: 'monospace', marginLeft: 2 }}>{val}%</span></div>)
        })}
      </div>
    </div>
  )
}

// ── BREAKEVEN DYNAMICS ────────────────────────────────────────────────────────
const BE_ANCHOR = 0.022
function _genBE(seed: number): number[] {
  return MONTH_COLS.map((_, t) => {
    const base = BE_ANCHOR + Math.sin(t * 0.28 + seed) * 0.0045 + Math.cos(t * 0.14 + seed * 1.3) * 0.003
    return Math.round(base * 10000) / 10000
  })
}
const BE_1Y = _genBE(1.1)
const BE_5Y = _genBE(2.3)
const BE_10Y = _genBE(3.7)
const REAL_10Y_RAW = NGB_10Y_RAW.map((y, t) => Math.round((y - BE_10Y[t]) * 10000) / 10000)
const BE_DATA = MONTH_COLS.map((month, t) => ({ month, nominal10y: NGB_10Y_RAW[t], real10y: REAL_10Y_RAW[t], be10y: BE_10Y[t], be5y: BE_5Y[t], be1y: BE_1Y[t] }))
function beRegime(nom: number, real: number, be: number): { label: string; color: string } {
  if (nom > 0.035 && real > 0.015) return { label: 'Bear Real', color: '#f87171' }
  if (nom > 0.035 && be > BE_ANCHOR + 0.003) return { label: 'Bear Breakeven', color: '#fb923c' }
  if (nom < 0.030 && real < 0.010) return { label: 'Bull Real', color: '#34d399' }
  if (nom < 0.030 && be < BE_ANCHOR - 0.003) return { label: 'Bull Breakeven', color: '#60a5fa' }
  return { label: 'Neutral', color: '#94a3b8' }
}
function BEDynamicsSection() {
  const last = BE_DATA[BE_DATA.length - 1]
  const regime = beRegime(last.nominal10y, last.real10y, last.be10y)
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Norway 10y nominal NGB vs real yield (NGB-i)</h2>
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>Nominal / real / breakeven decomposition &middot; regime: <span style={{ color: regime.color, fontWeight: 600 }}>{regime.label}</span></p>
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: '2 1 400px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>Nominal / Real / Breakeven</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={BE_DATA} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
              <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => (v * 100).toFixed(2) + '%'} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number, n: string) => [(v * 100).toFixed(2) + '%', n === 'nominal10y' ? 'Nominal 10y' : n === 'real10y' ? 'Real 10y (NGB-i)' : n === 'be10y' ? '10y BE' : n === 'be5y' ? '5y BE' : '1y BE']} />
              <Line type="monotone" dataKey="nominal10y" stroke="#f59e0b" strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="real10y" stroke="#34d399" strokeWidth={1.6} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="be10y" stroke="#818cf8" strokeWidth={1.4} strokeDasharray="5 3" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="be5y" stroke="#60a5fa" strokeWidth={1.2} strokeDasharray="3 2" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="be1y" stroke="#94a3b8" strokeWidth={1} strokeDasharray="2 2" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
            {[{ color: '#f59e0b', label: 'Nominal 10y' }, { color: '#34d399', label: 'Real 10y' }, { color: '#818cf8', label: '10y BE', dash: true }, { color: '#60a5fa', label: '5y BE', dash: true }, { color: '#94a3b8', label: '1y BE', dash: true }].map(({ color, label, dash }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>{dash ? <div style={{ width: 16, height: 0, borderTop: `2px dashed ${color}` }} /> : <div style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />}<span style={{ color: '#475569', fontSize: 10 }}>{label}</span></div>
            ))}
          </div>
        </div>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 12px', fontWeight: 600 }}>Latest</p>
          {[{ label: 'Nominal 10y', value: (last.nominal10y * 100).toFixed(2) + '%', color: '#f59e0b' }, { label: 'Real 10y', value: (last.real10y * 100).toFixed(2) + '%', color: '#34d399' }, { label: '10y BE', value: (last.be10y * 100).toFixed(2) + '%', color: '#818cf8' }, { label: '5y BE', value: (last.be5y * 100).toFixed(2) + '%', color: '#60a5fa' }, { label: '1y BE', value: (last.be1y * 100).toFixed(2) + '%', color: '#94a3b8' }, { label: 'Regime', value: regime.label, color: regime.color }].map(({ label, value, color }) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <span style={{ color: '#64748b', fontSize: 11 }}>{label}</span>
              <span style={{ color, fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────
function fmtTimestamp(): string {
  const d = new Date()
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

const NAV_SECTIONS = [
  { id: 'heatmap', label: 'Macro Heatmap' },
  { id: 'dfm', label: 'DFM Factors' },
  { id: 'pca', label: 'Yield PCA' },
  { id: 'pc-reg', label: 'PC Regressions' },
  { id: 'fair-value', label: 'Fair Value' },
  { id: 'curve', label: 'Curve Dynamics' },
  { id: 'breakeven', label: 'Breakevens' },
]

export default function NorwayHeatmap() {
  const [activeSection, setActiveSection] = React.useState('heatmap')
  const scrollTo = (id: string) => {
    setActiveSection(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <div style={{ minHeight: '100vh', background: '#080d1a', color: '#f1f5f9', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '18px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <a href="/" style={{ color: '#475569', fontSize: 12, textDecoration: 'none' }}>← Dashboard</a>
          </div>
          <h1 style={{ color: '#f1f5f9', fontSize: 22, fontWeight: 700, margin: 0 }}>Norway — Macro Heatmap</h1>
          <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>Norges Bank framework · NGB yields · NGB-i linkers · NOWA rate</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: '#34d399', fontSize: 12, fontFamily: 'monospace', fontWeight: 600 }}>Norges Bank Rate: 4.25%</div>
          <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>Last mtg: 27 Mar 2025 · First cut (−25bp)</div>
          <div style={{ color: '#475569', fontSize: 10, marginTop: 4 }}>Updated: {fmtTimestamp()}</div>
        </div>
      </div>
      {/* Sticky nav */}
      <div style={{ position: 'sticky', top: 0, zIndex: 50, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '0 32px', display: 'flex', gap: 0, overflowX: 'auto' }}>
        {NAV_SECTIONS.map(({ id, label }) => (
          <button key={id} onClick={() => scrollTo(id)} style={{ padding: '12px 18px', fontSize: 12, fontWeight: 600, color: activeSection === id ? '#f1f5f9' : '#475569', background: 'none', border: 'none', borderBottom: activeSection === id ? '2px solid #f59e0b' : '2px solid transparent', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 0.15s' }}>{label}</button>
        ))}
      </div>
      {/* Sections */}
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 32 }}>
        <div id="dfm"><DFMSection /></div>
        <div id="pca"><YieldPCChart /></div>
        <div id="pc-reg"><PCRegressionSection /></div>
        <div id="fair-value"><NorwayFairValueSection /></div>
        <div id="curve"><CurveDynamicsSection /></div>
        <div id="breakeven"><BEDynamicsSection /></div>
        <div style={cardStyle}><Legend /></div>
        <div id="heatmap"><HeatmapTable /></div>
      </div>
    </div>
  )
}
