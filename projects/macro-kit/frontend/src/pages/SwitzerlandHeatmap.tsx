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

// SNB last meeting: 20 Mar 2025 (cut to 0.25% from 0.50% — 4th consecutive cut)
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
      { name: 'GDP (q/q SA)',                       asOfLastMtg: '+0.4%', latest: '+0.3%', change: '-0.1',  lastUpd: '29 May 2025', units: '% q/q SA',  mean: 0.3,   std: 0.5,  amp: 0.9, phase: 0.5, freq: 0.28, noiseSeed: 601 },
      { name: 'GDP (y/y)',                          asOfLastMtg: '+1.6%', latest: '+1.4%', change: '-0.2',  lastUpd: '29 May 2025', units: '% y/y',     mean: 1.4,   std: 0.8,  amp: 0.8, phase: 0.3, freq: 0.26, noiseSeed: 602 },
      { name: 'Industrial Production (q/q)',        asOfLastMtg: '+0.2%', latest: '-0.5%', change: '-0.7',  lastUpd: '14 May 2025', units: '% q/q SA',  mean: -0.5,  std: 1.8,  amp: 1.1, phase: 0.8, freq: 0.46, noiseSeed: 603 },
      { name: 'Retail Sales Volume (m/m)',          asOfLastMtg: '+0.5%', latest: '+0.2%', change: '-0.3',  lastUpd: '21 May 2025', units: '% m/m SA',  mean: 0.2,   std: 0.9,  amp: 1.0, phase: 1.2, freq: 0.42, noiseSeed: 604 },
      { name: 'Trade Balance (CHFbn)',              asOfLastMtg: '4.5',   latest: '3.8',   change: '-0.7',  lastUpd: '08 May 2025', units: 'CHFbn SA',  mean: 3.8,   std: 2.0,  amp: 0.9, phase: 0.7, freq: 0.30, noiseSeed: 605 },
      { name: 'Exports (y/y)',                      asOfLastMtg: '+2.2%', latest: '+1.5%', change: '-0.7',  lastUpd: '08 May 2025', units: '% y/y',     mean: 1.5,   std: 4.0,  amp: 1.0, phase: 1.0, freq: 0.34, noiseSeed: 606 },
      { name: 'Construction Activity (y/y)',        asOfLastMtg: '-0.8%', latest: '-1.2%', change: '-0.4',  lastUpd: '15 May 2025', units: '% y/y',     mean: -1.2,  std: 3.0,  amp: 1.0, phase: 1.4, freq: 0.38, noiseSeed: 607 },
    ],
  },
  {
    name: 'Business Activity', bias: -0.1,
    indicators: [
      { name: 'PMI Manufacturing (procure.ch)',     asOfLastMtg: '47.8', latest: '47.3',  change: '-0.5',  lastUpd: '02 May 2025', units: 'Index SA',  mean: 47.3,  std: 4.0,  amp: 1.1, phase: 0.4, freq: 0.44, noiseSeed: 608 },
      { name: 'KOF Economic Barometer',            asOfLastMtg: '101.2',latest: '102.5', change: '+1.3',  lastUpd: '30 Apr 2025', units: 'Index',     mean: 102.5, std: 8.0,  amp: 1.0, phase: 0.5, freq: 0.28, noiseSeed: 609 },
      { name: 'ZEW Economic Expectations (CH)',     asOfLastMtg: '8.5',  latest: '15.2',  change: '+6.7',  lastUpd: '20 May 2025', units: 'Balance',   mean: 15.2,  std: 20.0, amp: 1.2, phase: 0.6, freq: 0.40, noiseSeed: 610 },
      { name: 'Consumer Confidence (SECO)',         asOfLastMtg: '-36',  latest: '-33',   change: '+3',    lastUpd: '22 Apr 2025', units: 'Balance',   mean: -33.0, std: 10.0, amp: 1.0, phase: 0.8, freq: 0.36, noiseSeed: 611 },
      { name: 'SNB Business Situation (survey)',    asOfLastMtg: '-6.5', latest: '-4.8',  change: '+1.7',  lastUpd: '20 Mar 2025', units: 'Balance',   mean: -4.8,  std: 5.0,  amp: 0.9, phase: 1.0, freq: 0.30, noiseSeed: 612 },
      { name: 'Export Orders (KOF)',               asOfLastMtg: '41.5', latest: '43.2',  change: '+1.7',  lastUpd: '30 Apr 2025', units: 'Index SA',  mean: 43.2,  std: 6.0,  amp: 1.1, phase: 1.3, freq: 0.40, noiseSeed: 613 },
      { name: 'Services PMI (CS/procure.ch)',       asOfLastMtg: '50.8', latest: '51.2',  change: '+0.4',  lastUpd: '05 May 2025', units: 'Index SA',  mean: 51.2,  std: 3.5,  amp: 0.9, phase: 0.7, freq: 0.36, noiseSeed: 614 },
      { name: 'Capacity Utilization (%)',           asOfLastMtg: '81.5', latest: '82.1',  change: '+0.6',  lastUpd: '14 May 2025', units: '% SA',      mean: 82.1,  std: 2.0,  amp: 0.7, phase: 1.1, freq: 0.26, noiseSeed: 615 },
    ],
  },
  {
    name: 'Housing Market', bias: -0.2,
    indicators: [
      { name: 'SECO/Wüest House Prices (y/y)',      asOfLastMtg: '+3.5%', latest: '+3.2%', change: '-0.3',  lastUpd: '15 May 2025', units: '% y/y',     mean: 3.2,   std: 1.5,  amp: 0.8, phase: 0.4, freq: 0.28, noiseSeed: 616 },
      { name: 'Building Permits (y/y)',             asOfLastMtg: '-7.2%', latest: '-8.5%', change: '-1.3',  lastUpd: '08 May 2025', units: '% y/y',     mean: -8.5,  std: 8.0,  amp: 1.2, phase: 1.0, freq: 0.42, noiseSeed: 617 },
      { name: 'Housing Starts (y/y)',               asOfLastMtg: '-5.5%', latest: '-6.2%', change: '-0.7',  lastUpd: '08 May 2025', units: '% y/y',     mean: -6.2,  std: 7.0,  amp: 1.1, phase: 1.2, freq: 0.40, noiseSeed: 618 },
      { name: 'Residential Property Prices (y/y)', asOfLastMtg: '+3.8%', latest: '+3.5%', change: '-0.3',  lastUpd: '30 Apr 2025', units: '% y/y',     mean: 3.5,   std: 1.5,  amp: 0.8, phase: 0.6, freq: 0.28, noiseSeed: 619 },
      { name: 'UBS Real Estate Bubble Index',       asOfLastMtg: '1.18', latest: '1.12',  change: '-0.06', lastUpd: '30 Apr 2025', units: 'Index',     mean: 1.12,  std: 0.15, amp: 0.6, phase: 0.5, freq: 0.22, noiseSeed: 620 },
      { name: 'Mortgage Lending (y/y)',             asOfLastMtg: '+2.5%', latest: '+2.8%', change: '+0.3',  lastUpd: '30 Apr 2025', units: '% y/y',     mean: 2.8,   std: 0.8,  amp: 0.7, phase: 1.4, freq: 0.24, noiseSeed: 621 },
      { name: 'Construction Investment (y/y)',      asOfLastMtg: '-6.5%', latest: '-5.2%', change: '+1.3',  lastUpd: '15 May 2025', units: '% y/y',     mean: -5.2,  std: 4.0,  amp: 1.0, phase: 1.6, freq: 0.38, noiseSeed: 622 },
    ],
  },
  {
    name: 'Labour Market', bias: -0.1,
    indicators: [
      { name: 'Unemployment Rate — SECO',           asOfLastMtg: '2.6%',  latest: '2.5%',  change: '-0.1',  lastUpd: '08 May 2025', units: '% SA',      mean: 2.5,   std: 0.2,  amp: 0.5, phase: 1.5, freq: 0.20, noiseSeed: 623 },
      { name: 'Employment Change (q/q)',            asOfLastMtg: '+0.4%', latest: '+0.3%', change: '-0.1',  lastUpd: '29 May 2025', units: '% q/q SA',  mean: 0.3,   std: 0.3,  amp: 0.6, phase: 1.4, freq: 0.22, noiseSeed: 624 },
      { name: 'Job Vacancies (k, SECO)',            asOfLastMtg: '88',    latest: '82',    change: '-6',    lastUpd: '08 May 2025', units: 'k SA',      mean: 82.0,  std: 12.0, amp: 0.9, phase: 1.1, freq: 0.32, noiseSeed: 625 },
      { name: 'Hours Worked (y/y)',                 asOfLastMtg: '+0.8%', latest: '+0.5%', change: '-0.3',  lastUpd: '29 May 2025', units: '% y/y',     mean: 0.5,   std: 0.8,  amp: 0.8, phase: 1.0, freq: 0.40, noiseSeed: 626 },
      { name: 'Short-Time Work (k)',                asOfLastMtg: '15.2',  latest: '12.5',  change: '-2.7',  lastUpd: '15 May 2025', units: 'k SA',      mean: 12.5,  std: 5.0,  amp: 0.9, phase: 0.9, freq: 0.30, noiseSeed: 627 },
      { name: 'Labour Force Participation (%)',     asOfLastMtg: '68.0%', latest: '68.2%', change: '+0.2',  lastUpd: '29 May 2025', units: '% SA',      mean: 68.2,  std: 0.5,  amp: 0.4, phase: 0.7, freq: 0.18, noiseSeed: 628 },
      { name: 'New Registrations — SECO (k)',       asOfLastMtg: '19.2',  latest: '18.5',  change: '-0.7',  lastUpd: '30 Apr 2025', units: 'k SA',      mean: 18.5,  std: 2.0,  amp: 0.7, phase: 0.8, freq: 0.28, noiseSeed: 629 },
    ],
  },
  {
    name: 'Wages', bias: 0.1,
    indicators: [
      { name: 'Nominal Wage Index (y/y)',           asOfLastMtg: '+1.5%', latest: '+1.8%', change: '+0.3',  lastUpd: '29 May 2025', units: '% y/y',     mean: 1.8,   std: 0.5,  amp: 0.6, phase: 0.3, freq: 0.20, noiseSeed: 630 },
      { name: 'Real Wages (y/y)',                   asOfLastMtg: '-0.2%', latest: '+0.8%', change: '+1.0',  lastUpd: '29 May 2025', units: '% y/y',     mean: 0.8,   std: 0.6,  amp: 0.7, phase: 0.5, freq: 0.22, noiseSeed: 631 },
      { name: 'Unit Labour Costs (y/y)',            asOfLastMtg: '+2.5%', latest: '+2.2%', change: '-0.3',  lastUpd: '29 May 2025', units: '% y/y',     mean: 2.2,   std: 0.6,  amp: 0.7, phase: 0.7, freq: 0.22, noiseSeed: 632 },
      { name: 'Negotiated Wages (SGB/SNB survey)',  asOfLastMtg: '+1.8%', latest: '+2.0%', change: '+0.2',  lastUpd: '30 Apr 2025', units: '% y/y',     mean: 2.0,   std: 0.4,  amp: 0.6, phase: 0.9, freq: 0.20, noiseSeed: 633 },
      { name: 'Compensation per Employee (y/y)',    asOfLastMtg: '+1.9%', latest: '+2.1%', change: '+0.2',  lastUpd: '29 May 2025', units: '% y/y',     mean: 2.1,   std: 0.5,  amp: 0.6, phase: 1.1, freq: 0.22, noiseSeed: 634 },
    ],
  },
  {
    name: 'Inflation', bias: -0.3,
    indicators: [
      { name: 'CPI (y/y)',                          asOfLastMtg: '+1.3%', latest: '+1.1%', change: '-0.2',  lastUpd: '08 May 2025', units: '% y/y',     mean: 1.1,   std: 0.5,  amp: 0.8, phase: 0.0, freq: 0.28, noiseSeed: 635 },
      { name: 'Core CPI excl. F&E (y/y)',           asOfLastMtg: '+1.1%', latest: '+0.9%', change: '-0.2',  lastUpd: '08 May 2025', units: '% y/y',     mean: 0.9,   std: 0.4,  amp: 0.7, phase: 0.2, freq: 0.26, noiseSeed: 636 },
      { name: 'Services CPI (y/y)',                 asOfLastMtg: '+2.0%', latest: '+1.8%', change: '-0.2',  lastUpd: '08 May 2025', units: '% y/y',     mean: 1.8,   std: 0.5,  amp: 0.7, phase: 0.4, freq: 0.25, noiseSeed: 637 },
      { name: 'Goods CPI (y/y)',                    asOfLastMtg: '-0.1%', latest: '-0.2%', change: '-0.1',  lastUpd: '08 May 2025', units: '% y/y',     mean: -0.2,  std: 0.6,  amp: 0.8, phase: 0.3, freq: 0.28, noiseSeed: 638 },
      { name: 'PPI (y/y)',                          asOfLastMtg: '-1.8%', latest: '-1.5%', change: '+0.3',  lastUpd: '08 May 2025', units: '% y/y',     mean: -1.5,  std: 2.5,  amp: 1.3, phase: 0.6, freq: 0.36, noiseSeed: 639 },
      { name: 'Import Prices (y/y)',                asOfLastMtg: '-0.8%', latest: '-1.2%', change: '-0.4',  lastUpd: '08 May 2025', units: '% y/y',     mean: -1.2,  std: 2.5,  amp: 1.3, phase: 0.8, freq: 0.40, noiseSeed: 640 },
      { name: 'SNB Inflation Forecast (8q ahead)',  asOfLastMtg: '+1.0%', latest: '+0.8%', change: '-0.2',  lastUpd: '20 Mar 2025', units: '%',         mean: 0.8,   std: 0.3,  amp: 0.5, phase: 0.5, freq: 0.20, noiseSeed: 641 },
      { name: 'Trimmed Mean CPI (y/y)',             asOfLastMtg: '+1.2%', latest: '+1.0%', change: '-0.2',  lastUpd: '08 May 2025', units: '% y/y',     mean: 1.0,   std: 0.4,  amp: 0.7, phase: 0.7, freq: 0.26, noiseSeed: 642 },
    ],
  },
  {
    name: 'Financial Conditions', bias: 0.0,
    indicators: [
      { name: 'SNB Policy Rate',                    asOfLastMtg: '0.25%', latest: '0.25%', change: '—',     lastUpd: '20 Mar 2025', units: '%',         mean: 0.25,  std: 0.05, amp: 0.2, phase: 0.1, freq: 0.10, noiseSeed: 643 },
      { name: 'SARON Overnight',                    asOfLastMtg: '0.22%', latest: '0.22%', change: '—',     lastUpd: '30 May 2025', units: '%',         mean: 0.22,  std: 0.05, amp: 0.2, phase: 0.2, freq: 0.10, noiseSeed: 644 },
      { name: '2y Conf Yield',                      asOfLastMtg: '0.20%', latest: '0.22%', change: '+0.02', lastUpd: '30 May 2025', units: '%',         mean: 0.22,  std: 0.30, amp: 0.8, phase: 0.4, freq: 0.28, noiseSeed: 645 },
      { name: '5y Conf Yield',                      asOfLastMtg: '0.45%', latest: '0.48%', change: '+0.03', lastUpd: '30 May 2025', units: '%',         mean: 0.48,  std: 0.28, amp: 0.9, phase: 0.5, freq: 0.30, noiseSeed: 646 },
      { name: '10y Conf Yield',                     asOfLastMtg: '0.60%', latest: '0.65%', change: '+0.05', lastUpd: '30 May 2025', units: '%',         mean: 0.65,  std: 0.30, amp: 1.0, phase: 0.6, freq: 0.32, noiseSeed: 647 },
      { name: '20y Conf Yield',                     asOfLastMtg: '0.72%', latest: '0.75%', change: '+0.03', lastUpd: '30 May 2025', units: '%',         mean: 0.75,  std: 0.28, amp: 0.9, phase: 0.7, freq: 0.33, noiseSeed: 648 },
      { name: '30y Conf Yield',                     asOfLastMtg: '0.78%', latest: '0.80%', change: '+0.02', lastUpd: '30 May 2025', units: '%',         mean: 0.80,  std: 0.26, amp: 0.9, phase: 0.8, freq: 0.34, noiseSeed: 649 },
      { name: '2s10s Conf Curve',                   asOfLastMtg: '40',    latest: '43',    change: '+3',    lastUpd: '30 May 2025', units: 'bps',       mean: 43.0,  std: 20.0, amp: 1.0, phase: 1.2, freq: 0.36, noiseSeed: 650 },
      { name: 'EUR/CHF',                            asOfLastMtg: '0.9420',latest: '0.9330',change: '-0.009',lastUpd: '30 May 2025', units: 'FX Rate',   mean: 0.933, std: 0.025,amp: 1.0, phase: 1.0, freq: 0.40, noiseSeed: 651 },
      { name: 'SMI Index',                          asOfLastMtg: '11,850',latest: '12,100',change: '+250',  lastUpd: '30 May 2025', units: 'Index',     mean: 12100, std: 500,  amp: 1.0, phase: 0.9, freq: 0.42, noiseSeed: 652 },
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

// ─── Swiss Confederation Yields ───────────────────────────────────────────────
// 5 tenors (2y/5y/10y/20y/30y), Jun '23 – Jun '25
// SNB hiked to 1.75% Jun '23; held; cut Jun '24→1.50%, Sep '24→1.25%, Dec '24→0.75%, Mar '25→0.25%

export const YIELD_TENORS = ['2y', '5y', '10y', '20y', '30y'] as const
export type Tenor = typeof YIELD_TENORS[number]

export const SYNTHETIC_YIELDS: Record<Tenor, number[]> = {
  //          Jun'23 Jul'23 Aug'23 Sep'23 Oct'23 Nov'23 Dec'23 Jan'24 Feb'24 Mar'24 Apr'24 May'24 Jun'24 Jul'24 Aug'24 Sep'24 Oct'24 Nov'24 Dec'24 Jan'25 Feb'25 Mar'25 Apr'25 May'25 Jun'25
  '2y':  [1.05, 1.12, 1.18, 1.22, 1.25, 1.10, 0.98, 0.90, 0.85, 0.80, 0.75, 0.65, 0.55, 0.45, 0.38, 0.30, 0.28, 0.25, 0.22, 0.20, 0.18, 0.20, 0.20, 0.20, 0.22],
  '5y':  [1.02, 1.10, 1.18, 1.22, 1.28, 1.12, 0.98, 0.92, 0.88, 0.82, 0.78, 0.72, 0.62, 0.52, 0.45, 0.40, 0.42, 0.38, 0.38, 0.40, 0.42, 0.45, 0.45, 0.45, 0.48],
  '10y': [1.05, 1.15, 1.25, 1.32, 1.42, 1.28, 1.15, 1.08, 1.05, 1.00, 0.98, 0.92, 0.80, 0.68, 0.60, 0.55, 0.58, 0.52, 0.52, 0.55, 0.58, 0.60, 0.62, 0.62, 0.65],
  '20y': [1.08, 1.18, 1.28, 1.35, 1.45, 1.32, 1.18, 1.12, 1.08, 1.05, 1.02, 0.98, 0.85, 0.75, 0.68, 0.62, 0.65, 0.60, 0.60, 0.62, 0.68, 0.70, 0.72, 0.72, 0.75],
  '30y': [1.10, 1.20, 1.30, 1.38, 1.48, 1.35, 1.22, 1.15, 1.12, 1.08, 1.05, 1.00, 0.88, 0.78, 0.72, 0.68, 0.70, 0.65, 0.65, 0.68, 0.72, 0.75, 0.78, 0.78, 0.80],
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
            {MONTH_COLS.map(m => <th key={m} style={hdrCell}>{m}</th>)}
            <th style={rHdr(R_LASTUPD)}>Last Upd</th>
            <th style={uHdr(R_UNITS)}>Units</th>
            <th style={rHdr(R_AS_OF_MTG)}>At Mtg</th>
            <th style={rHdr(R_LATEST)}>Latest</th>
            <th style={rHdr(R_CHANGE)}>Chg</th>
          </tr>
        </thead>
        <tbody>
          {GROUPS.map((grp) => (
            <React.Fragment key={grp.name}>
              <tr><td colSpan={N_MONTHS + 6} style={grpRow}>{grp.name}</td></tr>
              {grp.indicators.map((ind) => (
                <tr key={ind.name}>
                  <td style={indCell} title={ind.name}>{ind.name}</td>
                  {ind.zscores.map((z, t) => <td key={t} style={cellStyle(z)}>{formatCellValue(z, ind.units)}</td>)}
                  <td style={{ ...rCell, color: '#475569', fontSize: 9, right: R_LASTUPD }}>{ind.lastUpd}</td>
                  <td style={{ ...rCell, color: '#64748b', fontSize: 9, right: R_UNITS }}>{ind.units}</td>
                  <td style={{ ...rCell, color: '#94a3b8', right: R_AS_OF_MTG }}>{ind.asOfLastMtg}</td>
                  <td style={{ ...rCell, color: '#e2e8f0', fontWeight: 600, right: R_LATEST }}>{ind.latest}</td>
                  <td style={{ ...rCell, color: ind.change.startsWith('+') ? '#34d399' : ind.change.startsWith('-') ? '#f87171' : '#64748b', fontWeight: 600, right: R_CHANGE }}>{ind.change}</td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── DFM Factors ─────────────────────────────────────────────────────────────
const DFM_FACTORS = [
  { key: 'broadMacro', label: 'Broad Macro', color: '#94a3b8', groupIndices: [0, 1, 2, 3, 4, 5, 6] },
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
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>5 factors extracted via Dynamic Factor Model &middot; weekly monitoring of Swiss macro fundamentals</p>
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
            {['Broad Macro: avg z-score across all 7 indicator groups','Growth: Real Activity, Business Activity & Housing blocks','Inflation: Inflation block (~8 indicators incl. CPI/Core/Services)','Employment: Labour Market block (~7 indicators incl. SECO unemp.)','Wages: Wages block (~5 indicators incl. Nominal Wage Index)'].map((note, i) => (<div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5 }}><span style={{ color: DFM_FACTORS[i].color, fontSize: 10, flexShrink: 0, marginTop: 1 }}>●</span><span style={{ color: '#475569', fontSize: 10, lineHeight: 1.45 }}>{note}</span></div>))}
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
      <div style={{ marginBottom: 20 }}><h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Swiss Confederation Yield Curve — PCA</h2><p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>Jacobi PCA on 5-tenor Conf curve (2/5/10/20/30y) &middot; {(YIELD_PCA.explainedVar[0] * 100).toFixed(1)}% / {(YIELD_PCA.explainedVar[1] * 100).toFixed(1)}% / {(YIELD_PCA.explainedVar[2] * 100).toFixed(1)}% variance explained</p></div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
        {PC_META.map(({ key, label, color }) => (
          <div key={key} style={{ flex: '1 1 300px', minWidth: 0 }}>
            <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>{label}</p>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={PC_CHART_DATA} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
                <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(2)} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.10)" strokeDasharray="4 4" />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} formatter={(v: number) => [v.toFixed(3), label]} />
                <Line type="monotone" dataKey={key} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ))}
      </div>
      <div>
        <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 10px', fontWeight: 600 }}>Factor Loadings</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead><tr><th style={{ textAlign: 'left', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 8px 6px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', width: 120 }}>Factor</th>{YIELD_TENORS.map(t => <th key={t} style={{ textAlign: 'right', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 6px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>{t}</th>)}</tr></thead>
          <tbody>{PC_META.map(({ key, label, color }, k) => (<tr key={key}><td style={{ padding: '5px 8px 5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} /><span style={{ color: '#cbd5e1', fontSize: 11 }}>{label}</span></div></td>{YIELD_PCA.loadings[k].map((l, j) => <td key={j} style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: Math.abs(l) > 0.4 ? '#f1f5f9' : '#64748b', fontWeight: Math.abs(l) > 0.4 ? 600 : 400 }}>{l >= 0 ? '+' : ''}{l.toFixed(3)}</td>)}</tr>))}</tbody>
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
      <div style={{ marginBottom: 20 }}><h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Rates–Macro Linkage — PC Regressions</h2><p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>OLS: PC1 &amp; PC2 of Conf curve regressed on macro factors &middot; *** p&lt;1% &nbsp;** p&lt;5% &nbsp;* p&lt;10%</p></div>
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
const CONF_10Y_IDX = 2
const CONF_10Y_RAW = SYNTHETIC_YIELDS['10y']
const CONF_10Y_MEAN = CONF_10Y_RAW.reduce((a: number, b: number) => a + b, 0) / CONF_10Y_RAW.length
const CONF_10Y_STD = Math.sqrt(CONF_10Y_RAW.reduce((s: number, v: number) => s + (v - CONF_10Y_MEAN) ** 2, 0) / CONF_10Y_RAW.length)
const PC1_LOAD_10Y = YIELD_PCA.loadings[CONF_10Y_IDX][0]
const PC2_LOAD_10Y = YIELD_PCA.loadings[CONF_10Y_IDX][1]
const CONF_10Y_FAIR_VALUE = YIELD_PCA.scores.map((_sc, t) => {
  const zFitted = PC1_LOAD_10Y * PC1_REG.fitted[t] + PC2_LOAD_10Y * PC2_REG.fitted[t]
  return Math.round((zFitted * CONF_10Y_STD + CONF_10Y_MEAN) * 1000) / 1000
})
const CONF_10Y_PCA_FITTED = YIELD_PCA.scores.map((sc, _t) => {
  const zFitted = PC1_LOAD_10Y * sc[0] + PC2_LOAD_10Y * sc[1]
  return Math.round((zFitted * CONF_10Y_STD + CONF_10Y_MEAN) * 1000) / 1000
})
const CONF_10Y_RICHCHEAP = CONF_10Y_RAW.map((v: number, t: number) => Math.round((v - CONF_10Y_FAIR_VALUE[t]) * 100) / 100)

function SwitzerlandFairValueSection() {
  const fvData = MONTH_COLS.map((month, t) => ({ month, actual: CONF_10Y_RAW[t], pcaFitted: CONF_10Y_PCA_FITTED[t], macroFair: CONF_10Y_FAIR_VALUE[t], richCheap: CONF_10Y_RICHCHEAP[t] }))
  const last = fvData[fvData.length - 1]
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Conf 10y Fair Value</h2>
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
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number, n: string) => [v.toFixed(3) + '%', n === 'actual' ? 'Conf 10y Actual' : n === 'pcaFitted' ? 'PCA Fitted' : 'Macro Fair Value']} />
              <Line type="monotone" dataKey="actual" stroke="#f59e0b" strokeWidth={2} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="pcaFitted" stroke="#34d399" strokeWidth={1.4} strokeDasharray="4 2" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="macroFair" stroke="#818cf8" strokeWidth={1.4} strokeDasharray="6 3" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 6, flexWrap: 'wrap' }}>
            {[{ color: '#f59e0b', label: 'Conf 10y Actual', dash: false }, { color: '#34d399', label: 'PCA Fitted', dash: true }, { color: '#818cf8', label: 'Macro Fair Value', dash: true }].map(({ color, label, dash }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>{dash ? <div style={{ width: 18, height: 0, borderTop: `2px dashed ${color}` }} /> : <div style={{ width: 18, height: 2, background: color, borderRadius: 1 }} />}<span style={{ color: '#475569', fontSize: 10 }}>{label}</span></div>
            ))}
          </div>
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>Rich / Cheap (bps vs macro fair)</p>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={fvData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <defs>
                <linearGradient id="gradCheapCH" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#34d399" stopOpacity={0.3} /><stop offset="95%" stopColor="#34d399" stopOpacity={0.02} /></linearGradient>
                <linearGradient id="gradRichCH" x1="0" y1="1" x2="0" y2="0"><stop offset="5%" stopColor="#f87171" stopOpacity={0.3} /><stop offset="95%" stopColor="#f87171" stopOpacity={0.02} /></linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
              <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => (v * 100).toFixed(0) + 'bp'} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" strokeDasharray="4 4" />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number) => [(v * 100).toFixed(1) + 'bp', 'Rich/Cheap']} />
              <Area type="monotone" dataKey="richCheap" stroke={last.richCheap >= 0 ? '#34d399' : '#f87171'} strokeWidth={1.8} fill={last.richCheap >= 0 ? 'url(#gradCheapCH)' : 'url(#gradRichCH)'} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: last.richCheap >= 0 ? '#34d399' : '#f87171' }}>{last.richCheap >= 0 ? '+' : ''}{(last.richCheap * 100).toFixed(1)}bp</span>
            <span style={{ color: '#475569', fontSize: 11, marginLeft: 6 }}>{last.richCheap >= 0 ? 'cheap vs fair' : 'rich vs fair'} (latest)</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {[{ label: 'Conf 10y Actual', value: (last.actual * 100).toFixed(0) + 'bp', color: '#f59e0b' }, { label: 'PCA Fitted', value: (last.pcaFitted * 100).toFixed(0) + 'bp', color: '#34d399' }, { label: 'Macro Fair Value', value: (last.macroFair * 100).toFixed(0) + 'bp', color: '#818cf8' }, { label: 'Rich/Cheap', value: (last.richCheap >= 0 ? '+' : '') + (last.richCheap * 100).toFixed(1) + 'bp', color: last.richCheap >= 0 ? '#34d399' : '#f87171' }].map(({ label, value, color }) => (
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
      const noise = (Math.sin((m * BDAYS_PER_MONTH + d) * 0.37) * 0.008 + Math.cos((m * BDAYS_PER_MONTH + d) * 0.19) * 0.005)
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
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>2s10s Conf Directionality</h2>
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
const BE_ANCHOR = 0.010
function _genBE(seed: number): number[] {
  return MONTH_COLS.map((_, t) => {
    const base = BE_ANCHOR + Math.sin(t * 0.28 + seed) * 0.0035 + Math.cos(t * 0.14 + seed * 1.3) * 0.002
    return Math.round(base * 10000) / 10000
  })
}
const BE_1Y = _genBE(1.1)
const BE_5Y = _genBE(2.3)
const BE_10Y = _genBE(3.7)
const REAL_10Y_RAW = CONF_10Y_RAW.map((y: number, t: number) => Math.round((y - BE_10Y[t]) * 10000) / 10000)
const BE_DATA = MONTH_COLS.map((month, t) => ({ month, nominal10y: CONF_10Y_RAW[t], real10y: REAL_10Y_RAW[t], be10y: BE_10Y[t], be5y: BE_5Y[t], be1y: BE_1Y[t] }))
function beRegime(nom: number, real: number, be: number): { label: string; color: string } {
  if (nom > 0.012 && real > 0.002) return { label: 'Bear Real', color: '#f87171' }
  if (nom > 0.012 && be > BE_ANCHOR + 0.002) return { label: 'Bear Breakeven', color: '#fb923c' }
  if (nom < 0.007 && real < -0.003) return { label: 'Bull Real', color: '#34d399' }
  if (nom < 0.007 && be < BE_ANCHOR - 0.002) return { label: 'Bull Breakeven', color: '#60a5fa' }
  return { label: 'Neutral', color: '#94a3b8' }
}
function BEDynamicsSection() {
  const last = BE_DATA[BE_DATA.length - 1]
  const regime = beRegime(last.nominal10y, last.real10y, last.be10y)
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Switzerland 10y nominal Conf vs real yield</h2>
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
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number, n: string) => [(v * 100).toFixed(2) + '%', n === 'nominal10y' ? 'Nominal 10y' : n === 'real10y' ? 'Real 10y' : n === 'be10y' ? '10y BE' : n === 'be5y' ? '5y BE' : '1y BE']} />
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
  { id: 'dfm', label: 'DFM Factors' },
  { id: 'pca', label: 'Yield PCA' },
  { id: 'pc-reg', label: 'PC Regressions' },
  { id: 'fair-value', label: 'Fair Value' },
  { id: 'curve', label: 'Curve Dynamics' },
  { id: 'breakeven', label: 'Breakevens' },
  { id: 'heatmap', label: 'Macro Heatmap' },
]
export default function SwitzerlandHeatmap() {
  const [activeSection, setActiveSection] = React.useState('dfm')
  const scrollTo = (id: string) => {
    setActiveSection(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <div style={{ minHeight: '100vh', background: '#080d1a', color: '#f1f5f9', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '18px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <a href="/" style={{ color: '#475569', fontSize: 12, textDecoration: 'none' }}>← Dashboard</a>
          </div>
          <h1 style={{ color: '#f1f5f9', fontSize: 22, fontWeight: 700, margin: 0 }}>Switzerland — Macro Heatmap</h1>
          <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>SNB framework · Conf yields · SARON rate · EUR/CHF</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: '#34d399', fontSize: 12, fontFamily: 'monospace', fontWeight: 600 }}>SNB Policy Rate: 0.25%</div>
          <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>Last mtg: 20 Mar 2025 · Cut from 0.50% (4th consecutive)</div>
          <div style={{ color: '#475569', fontSize: 10, marginTop: 4 }}>Updated: {fmtTimestamp()}</div>
        </div>
      </div>
      <div style={{ position: 'sticky', top: 0, zIndex: 50, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '0 32px', display: 'flex', gap: 0, overflowX: 'auto' }}>
        {NAV_SECTIONS.map(({ id, label }) => (
          <button key={id} onClick={() => scrollTo(id)} style={{ padding: '12px 18px', fontSize: 12, fontWeight: 600, color: activeSection === id ? '#f1f5f9' : '#475569', background: 'none', border: 'none', borderBottom: activeSection === id ? '2px solid #f59e0b' : '2px solid transparent', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 0.15s' }}>{label}</button>
        ))}
      </div>
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 32 }}>
        <div id="dfm"><DFMSection /></div>
        <div id="pca"><YieldPCChart /></div>
        <div id="pc-reg"><PCRegressionSection /></div>
        <div id="fair-value"><SwitzerlandFairValueSection /></div>
        <div id="curve"><CurveDynamicsSection /></div>
        <div id="breakeven"><BEDynamicsSection /></div>
        <div style={cardStyle}><Legend /></div>
        <div id="heatmap"><HeatmapTable /></div>
      </div>
    </div>
  )
}
