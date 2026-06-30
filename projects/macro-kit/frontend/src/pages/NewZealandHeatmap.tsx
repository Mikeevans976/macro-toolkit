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

// RBNZ last meeting: 28 May 2025 (held OCR at 3.50% — after 5 consecutive cuts from 5.50%)
const GROUPS_META: {
  name: string; bias: number
  indicators: {
    name: string; asOfLastMtg: string; latest: string; change: string
    lastUpd: string; units: string; mean: number; std: number
    amp: number; phase: number; freq: number; noiseSeed: number
  }[]
}[] = [
  {
    name: 'Real Activity', bias: -0.3,
    indicators: [
      { name: 'GDP (q/q SA)',                       asOfLastMtg: '-0.1%', latest: '+0.2%', change: '+0.3',  lastUpd: '19 Jun 2025', units: '% q/q SA',  mean: 0.2,    std: 0.6,  amp: 1.0, phase: 0.5, freq: 0.28, noiseSeed: 801 },
      { name: 'GDP (y/y)',                          asOfLastMtg: '-0.5%', latest: '-0.2%', change: '+0.3',  lastUpd: '19 Jun 2025', units: '% y/y',     mean: -0.2,   std: 0.8,  amp: 1.0, phase: 0.3, freq: 0.26, noiseSeed: 802 },
      { name: 'Retail Sales (q/q vol.)',            asOfLastMtg: '+0.6%', latest: '+0.8%', change: '+0.2',  lastUpd: '22 May 2025', units: '% q/q SA',  mean: 0.8,    std: 1.0,  amp: 1.0, phase: 1.2, freq: 0.42, noiseSeed: 803 },
      { name: 'Building Work Put in Place (q/q)',   asOfLastMtg: '-1.5%', latest: '-0.8%', change: '+0.7',  lastUpd: '04 Jun 2025', units: '% q/q SA',  mean: -0.8,   std: 3.0,  amp: 1.2, phase: 0.8, freq: 0.38, noiseSeed: 804 },
      { name: 'Trade Balance (NZDmn)',              asOfLastMtg: '-412',  latest: '-285',  change: '+127',  lastUpd: '27 May 2025', units: 'NZDmn SA',  mean: -285.0, std: 450.0,amp: 1.0, phase: 0.7, freq: 0.30, noiseSeed: 805 },
      { name: 'Exports (y/y)',                      asOfLastMtg: '+2.5%', latest: '+3.2%', change: '+0.7',  lastUpd: '27 May 2025', units: '% y/y',     mean: 3.2,    std: 5.0,  amp: 1.1, phase: 1.0, freq: 0.34, noiseSeed: 806 },
      { name: 'Current Account (% of GDP)',         asOfLastMtg: '-6.8%', latest: '-6.2%', change: '+0.6',  lastUpd: '19 Jun 2025', units: '% GDP',     mean: -6.2,   std: 1.0,  amp: 0.7, phase: 1.4, freq: 0.24, noiseSeed: 807 },
    ],
  },
  {
    name: 'Business Activity', bias: -0.2,
    indicators: [
      { name: 'BusinessNZ Manufacturing PMI',       asOfLastMtg: '48.5', latest: '49.2',  change: '+0.7',  lastUpd: '16 May 2025', units: 'Index SA',  mean: 49.2,   std: 4.0,  amp: 1.1, phase: 0.4, freq: 0.44, noiseSeed: 808 },
      { name: 'BusinessNZ Services PSI',            asOfLastMtg: '49.8', latest: '50.5',  change: '+0.7',  lastUpd: '09 May 2025', units: 'Index SA',  mean: 50.5,   std: 3.5,  amp: 1.0, phase: 0.6, freq: 0.40, noiseSeed: 809 },
      { name: 'NZIER QSBO — Own Activity',          asOfLastMtg: '-12',  latest: '-5',    change: '+7',    lastUpd: '12 Jun 2025', units: 'Net %',     mean: -5.0,   std: 15.0, amp: 1.1, phase: 0.5, freq: 0.36, noiseSeed: 810 },
      { name: 'NZIER QSBO — Business Confidence',  asOfLastMtg: '-18',  latest: '-10',   change: '+8',    lastUpd: '12 Jun 2025', units: 'Net %',     mean: -10.0,  std: 20.0, amp: 1.2, phase: 0.7, freq: 0.34, noiseSeed: 811 },
      { name: 'ANZ Business Confidence',           asOfLastMtg: '+15',  latest: '+22',   change: '+7',    lastUpd: '30 May 2025', units: 'Net %',     mean: 22.0,   std: 20.0, amp: 1.2, phase: 0.9, freq: 0.38, noiseSeed: 812 },
      { name: 'ANZ Own Activity Outlook',          asOfLastMtg: '+18',  latest: '+24',   change: '+6',    lastUpd: '30 May 2025', units: 'Net %',     mean: 24.0,   std: 15.0, amp: 1.0, phase: 1.1, freq: 0.36, noiseSeed: 813 },
      { name: 'Westpac Consumer Confidence',       asOfLastMtg: '93.2', latest: '96.8',  change: '+3.6',  lastUpd: '28 Apr 2025', units: 'Index',     mean: 96.8,   std: 10.0, amp: 1.0, phase: 1.3, freq: 0.38, noiseSeed: 814 },
      { name: 'NZIER QSBO — Capacity Util. (%)',   asOfLastMtg: '88.5', latest: '89.2',  change: '+0.7',  lastUpd: '12 Jun 2025', units: '% SA',      mean: 89.2,   std: 2.0,  amp: 0.7, phase: 0.3, freq: 0.26, noiseSeed: 815 },
    ],
  },
  {
    name: 'Housing Market', bias: -0.2,
    indicators: [
      { name: 'REINZ HPI (m/m)',                    asOfLastMtg: '+0.2%', latest: '+0.4%', change: '+0.2',  lastUpd: '14 May 2025', units: '% m/m SA',  mean: 0.4,    std: 1.0,  amp: 0.9, phase: 0.4, freq: 0.32, noiseSeed: 816 },
      { name: 'REINZ HPI (y/y)',                    asOfLastMtg: '-2.8%', latest: '-1.5%', change: '+1.3',  lastUpd: '14 May 2025', units: '% y/y',     mean: -1.5,   std: 5.0,  amp: 1.1, phase: 0.3, freq: 0.26, noiseSeed: 817 },
      { name: 'REINZ Median House Price (NZDk)',    asOfLastMtg: '770',   latest: '782',   change: '+12',   lastUpd: '14 May 2025', units: 'NZDk',      mean: 782.0,  std: 30.0, amp: 0.8, phase: 0.5, freq: 0.28, noiseSeed: 818 },
      { name: 'Building Consents (m/m)',            asOfLastMtg: '-3.2%', latest: '+1.8%', change: '+5.0',  lastUpd: '30 Apr 2025', units: '% m/m SA',  mean: 1.8,    std: 8.0,  amp: 1.2, phase: 1.0, freq: 0.44, noiseSeed: 819 },
      { name: 'Housing Loan Approvals (NZDmn)',     asOfLastMtg: '5,820', latest: '6,150', change: '+330',  lastUpd: '29 May 2025', units: 'NZDmn SA',  mean: 6150.0, std: 500.0,amp: 0.9, phase: 0.6, freq: 0.34, noiseSeed: 820 },
      { name: 'CoreLogic NZ HPI (y/y)',             asOfLastMtg: '-3.5%', latest: '-2.0%', change: '+1.5',  lastUpd: '01 May 2025', units: '% y/y',     mean: -2.0,   std: 4.5,  amp: 1.0, phase: 0.8, freq: 0.28, noiseSeed: 821 },
      { name: 'REINZ Days to Sell',                 asOfLastMtg: '42',    latest: '40',    change: '-2',    lastUpd: '14 May 2025', units: 'Days',      mean: 40.0,   std: 5.0,  amp: 0.8, phase: 1.5, freq: 0.30, noiseSeed: 822 },
    ],
  },
  {
    name: 'Labour Market', bias: -0.2,
    indicators: [
      { name: 'Unemployment Rate (HLFS)',           asOfLastMtg: '5.1%',  latest: '5.1%',  change: '—',     lastUpd: '07 May 2025', units: '% SA',      mean: 5.1,    std: 0.3,  amp: 0.6, phase: 1.5, freq: 0.20, noiseSeed: 823 },
      { name: 'Employment Change (q/q)',            asOfLastMtg: '-0.1%', latest: '+0.1%', change: '+0.2',  lastUpd: '07 May 2025', units: '% q/q SA',  mean: 0.1,    std: 0.5,  amp: 0.8, phase: 0.6, freq: 0.36, noiseSeed: 824 },
      { name: 'Participation Rate (%)',             asOfLastMtg: '70.8%', latest: '70.9%', change: '+0.1',  lastUpd: '07 May 2025', units: '% SA',      mean: 70.9,   std: 0.5,  amp: 0.5, phase: 1.3, freq: 0.20, noiseSeed: 825 },
      { name: 'Hours Worked (q/q)',                 asOfLastMtg: '-0.3%', latest: '+0.2%', change: '+0.5',  lastUpd: '07 May 2025', units: '% q/q SA',  mean: 0.2,    std: 0.8,  amp: 0.8, phase: 1.0, freq: 0.38, noiseSeed: 826 },
      { name: 'Underutilization Rate (%)',          asOfLastMtg: '11.8%', latest: '11.6%', change: '-0.2',  lastUpd: '07 May 2025', units: '% SA',      mean: 11.6,   std: 0.6,  amp: 0.6, phase: 1.4, freq: 0.22, noiseSeed: 827 },
      { name: 'Job Ads — SEEK (m/m)',               asOfLastMtg: '-1.5%', latest: '+0.8%', change: '+2.3',  lastUpd: '15 May 2025', units: '% m/m SA',  mean: 0.8,    std: 4.0,  amp: 1.0, phase: 1.1, freq: 0.36, noiseSeed: 828 },
      { name: 'Labour Force Survey — Employed (k)', asOfLastMtg: '2,812', latest: '2,820', change: '+8',    lastUpd: '07 May 2025', units: 'k SA',      mean: 2820.0, std: 15.0, amp: 0.6, phase: 0.9, freq: 0.22, noiseSeed: 829 },
    ],
  },
  {
    name: 'Wages', bias: 0.1,
    indicators: [
      { name: 'Labour Cost Index — LCI (y/y)',      asOfLastMtg: '+3.4%', latest: '+3.3%', change: '-0.1',  lastUpd: '07 May 2025', units: '% y/y',     mean: 3.3,    std: 0.4,  amp: 0.6, phase: 0.3, freq: 0.18, noiseSeed: 830 },
      { name: 'Average Weekly Earnings (y/y)',      asOfLastMtg: '+4.2%', latest: '+4.0%', change: '-0.2',  lastUpd: '07 May 2025', units: '% y/y',     mean: 4.0,    std: 0.6,  amp: 0.7, phase: 0.5, freq: 0.20, noiseSeed: 831 },
      { name: 'Unit Labour Costs (y/y)',            asOfLastMtg: '+4.8%', latest: '+4.5%', change: '-0.3',  lastUpd: '19 Jun 2025', units: '% y/y',     mean: 4.5,    std: 0.7,  amp: 0.7, phase: 0.7, freq: 0.20, noiseSeed: 832 },
      { name: 'Real Wages (y/y)',                   asOfLastMtg: '-0.2%', latest: '+0.1%', change: '+0.3',  lastUpd: '07 May 2025', units: '% y/y',     mean: 0.1,    std: 0.5,  amp: 0.7, phase: 0.9, freq: 0.22, noiseSeed: 833 },
      { name: 'LCI — Private Sector (y/y)',         asOfLastMtg: '+3.6%', latest: '+3.4%', change: '-0.2',  lastUpd: '07 May 2025', units: '% y/y',     mean: 3.4,    std: 0.4,  amp: 0.6, phase: 1.1, freq: 0.20, noiseSeed: 834 },
    ],
  },
  {
    name: 'Inflation', bias: -0.1,
    indicators: [
      { name: 'CPI (q/q)',                          asOfLastMtg: '+0.5%', latest: '+0.7%', change: '+0.2',  lastUpd: '17 Apr 2025', units: '% q/q SA',  mean: 0.7,    std: 0.4,  amp: 0.8, phase: 0.0, freq: 0.28, noiseSeed: 835 },
      { name: 'CPI (y/y)',                          asOfLastMtg: '+2.2%', latest: '+2.5%', change: '+0.3',  lastUpd: '17 Apr 2025', units: '% y/y',     mean: 2.5,    std: 0.5,  amp: 0.8, phase: 0.2, freq: 0.26, noiseSeed: 836 },
      { name: 'Non-Tradables CPI (y/y) — RBNZ key',asOfLastMtg: '+4.5%', latest: '+4.2%', change: '-0.3',  lastUpd: '17 Apr 2025', units: '% y/y',     mean: 4.2,    std: 0.6,  amp: 0.7, phase: 0.4, freq: 0.24, noiseSeed: 837 },
      { name: 'Tradables CPI (y/y)',                asOfLastMtg: '-0.8%', latest: '-0.5%', change: '+0.3',  lastUpd: '17 Apr 2025', units: '% y/y',     mean: -0.5,   std: 0.6,  amp: 0.8, phase: 0.3, freq: 0.28, noiseSeed: 838 },
      { name: 'Services CPI (y/y)',                 asOfLastMtg: '+4.8%', latest: '+4.5%', change: '-0.3',  lastUpd: '17 Apr 2025', units: '% y/y',     mean: 4.5,    std: 0.6,  amp: 0.7, phase: 0.5, freq: 0.24, noiseSeed: 839 },
      { name: 'Food Price Index (m/m)',             asOfLastMtg: '+0.3%', latest: '-0.2%', change: '-0.5',  lastUpd: '13 May 2025', units: '% m/m SA',  mean: -0.2,   std: 1.0,  amp: 1.1, phase: 0.8, freq: 0.44, noiseSeed: 840 },
      { name: 'PPI Inputs (q/q)',                   asOfLastMtg: '+0.8%', latest: '+0.5%', change: '-0.3',  lastUpd: '19 Jun 2025', units: '% q/q SA',  mean: 0.5,    std: 1.5,  amp: 1.1, phase: 1.0, freq: 0.38, noiseSeed: 841 },
      { name: 'RBNZ 2y Inflation Expectations (%)', asOfLastMtg: '2.3%',  latest: '2.2%',  change: '-0.1',  lastUpd: '12 Jun 2025', units: '%',         mean: 2.2,    std: 0.3,  amp: 0.5, phase: 0.6, freq: 0.20, noiseSeed: 842 },
    ],
  },
  {
    name: 'Financial Conditions', bias: 0.0,
    indicators: [
      { name: 'RBNZ Official Cash Rate (OCR)',      asOfLastMtg: '3.50%', latest: '3.50%', change: '—',     lastUpd: '28 May 2025', units: '%',         mean: 3.50,   std: 0.12, amp: 0.2, phase: 0.1, freq: 0.10, noiseSeed: 843 },
      { name: 'NZONIA Overnight',                   asOfLastMtg: '3.48%', latest: '3.48%', change: '—',     lastUpd: '30 May 2025', units: '%',         mean: 3.48,   std: 0.12, amp: 0.2, phase: 0.2, freq: 0.10, noiseSeed: 844 },
      { name: '2y NZGB Yield',                      asOfLastMtg: '3.52%', latest: '3.50%', change: '-0.02', lastUpd: '30 May 2025', units: '%',         mean: 3.50,   std: 0.55, amp: 1.0, phase: 0.4, freq: 0.28, noiseSeed: 845 },
      { name: '5y NZGB Yield',                      asOfLastMtg: '3.98%', latest: '4.00%', change: '+0.02', lastUpd: '30 May 2025', units: '%',         mean: 4.00,   std: 0.38, amp: 1.0, phase: 0.5, freq: 0.30, noiseSeed: 846 },
      { name: '10y NZGB Yield',                     asOfLastMtg: '4.25%', latest: '4.28%', change: '+0.03', lastUpd: '30 May 2025', units: '%',         mean: 4.28,   std: 0.28, amp: 1.0, phase: 0.6, freq: 0.32, noiseSeed: 847 },
      { name: '20y NZGB Yield',                     asOfLastMtg: '4.42%', latest: '4.45%', change: '+0.03', lastUpd: '30 May 2025', units: '%',         mean: 4.45,   std: 0.25, amp: 0.9, phase: 0.7, freq: 0.33, noiseSeed: 848 },
      { name: '30y NZGB Yield',                     asOfLastMtg: '4.48%', latest: '4.50%', change: '+0.02', lastUpd: '30 May 2025', units: '%',         mean: 4.50,   std: 0.24, amp: 0.9, phase: 0.8, freq: 0.34, noiseSeed: 849 },
      { name: '2s10s NZGB Curve',                   asOfLastMtg: '+73',   latest: '+78',   change: '+5',    lastUpd: '30 May 2025', units: 'bps',       mean: 78.0,   std: 35.0, amp: 1.1, phase: 1.2, freq: 0.36, noiseSeed: 850 },
      { name: 'NZD/USD',                            asOfLastMtg: '0.5958',latest: '0.5985',change: '+0.003',lastUpd: '30 May 2025', units: 'FX Rate',   mean: 0.598,  std: 0.022,amp: 1.0, phase: 1.0, freq: 0.40, noiseSeed: 851 },
      { name: 'NZX 50 Index',                       asOfLastMtg: '12,180',latest: '12,350',change: '+170',  lastUpd: '30 May 2025', units: 'Index',     mean: 12350.0,std: 350.0,amp: 1.0, phase: 0.9, freq: 0.42, noiseSeed: 852 },
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

// ─── NZGB Yields ─────────────────────────────────────────────────────────────
// 5 tenors (2y/5y/10y/20y/30y), Jun '23 – Jun '25
// RBNZ held OCR at 5.50% until Aug '24; then cut: Aug→5.25%, Oct→4.75%, Nov→4.25%, Feb '25→3.75%, Apr '25→3.50%

export const YIELD_TENORS = ['2y', '5y', '10y', '20y', '30y'] as const
export type Tenor = typeof YIELD_TENORS[number]

export const SYNTHETIC_YIELDS: Record<Tenor, number[]> = {
  //          Jun'23 Jul'23 Aug'23 Sep'23 Oct'23 Nov'23 Dec'23 Jan'24 Feb'24 Mar'24 Apr'24 May'24 Jun'24 Jul'24 Aug'24 Sep'24 Oct'24 Nov'24 Dec'24 Jan'25 Feb'25 Mar'25 Apr'25 May'25 Jun'25
  '2y':  [5.20, 5.35, 5.45, 5.50, 5.52, 5.42, 5.35, 5.30, 5.28, 5.25, 5.22, 5.18, 5.10, 4.92, 4.65, 4.35, 4.15, 4.00, 3.85, 3.72, 3.58, 3.48, 3.45, 3.48, 3.50],
  '5y':  [4.85, 5.00, 5.10, 5.18, 5.22, 5.05, 4.95, 4.88, 4.82, 4.78, 4.72, 4.65, 4.52, 4.35, 4.12, 3.98, 3.85, 3.78, 3.72, 3.80, 3.88, 3.92, 3.95, 3.98, 4.00],
  '10y': [4.62, 4.78, 4.92, 5.02, 5.08, 4.92, 4.82, 4.78, 4.72, 4.68, 4.65, 4.58, 4.48, 4.35, 4.18, 4.08, 4.05, 4.02, 4.00, 4.08, 4.15, 4.18, 4.22, 4.25, 4.28],
  '20y': [4.75, 4.90, 5.05, 5.15, 5.20, 5.05, 4.95, 4.90, 4.85, 4.80, 4.78, 4.72, 4.62, 4.50, 4.35, 4.25, 4.22, 4.18, 4.15, 4.22, 4.30, 4.35, 4.38, 4.42, 4.45],
  '30y': [4.80, 4.95, 5.10, 5.20, 5.25, 5.10, 5.00, 4.95, 4.90, 4.85, 4.82, 4.78, 4.68, 4.55, 4.40, 4.30, 4.28, 4.22, 4.20, 4.28, 4.35, 4.40, 4.45, 4.48, 4.50],
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
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>5 factors extracted via Dynamic Factor Model &middot; weekly monitoring of New Zealand macro fundamentals</p>
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
            {['Broad Macro: avg z-score across all 7 indicator groups','Growth: Real Activity, Business Activity & Housing blocks','Inflation: Inflation block (~8 indicators incl. CPI/Non-Tradables)','Employment: Labour Market block (~7 indicators incl. HLFS unemp.)','Wages: Wages block (~5 indicators incl. LCI — key RBNZ input)'].map((note, i) => (<div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5 }}><span style={{ color: DFM_FACTORS[i].color, fontSize: 10, flexShrink: 0, marginTop: 1 }}>●</span><span style={{ color: '#475569', fontSize: 10, lineHeight: 1.45 }}>{note}</span></div>))}
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
      <div style={{ marginBottom: 20 }}><h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>NZGB Yield Curve — PCA</h2><p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>Jacobi PCA on 5-tenor NZGB curve (2/5/10/20/30y) &middot; {(YIELD_PCA.explainedVar[0] * 100).toFixed(1)}% / {(YIELD_PCA.explainedVar[1] * 100).toFixed(1)}% / {(YIELD_PCA.explainedVar[2] * 100).toFixed(1)}% variance explained</p></div>
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
      <div style={{ marginBottom: 20 }}><h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Rates–Macro Linkage — PC Regressions</h2><p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>OLS: PC1 &amp; PC2 of NZGB curve regressed on macro factors &middot; *** p&lt;1% &nbsp;** p&lt;5% &nbsp;* p&lt;10%</p></div>
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

// ── Fair Value ──────────────────────────────────────────────────────────────
const NZGB_10Y_IDX = 2
const NZGB_10Y_RAW = SYNTHETIC_YIELDS['10y']
const NZGB_10Y_FAIR_VALUE = NZGB_10Y_RAW.map((_y, i) => {
  const pca_fitted_z = YIELD_PCA.scores[i]?.[0] * YIELD_PCA.loadings[NZGB_10Y_IDX][0] +
    YIELD_PCA.scores[i]?.[1] * YIELD_PCA.loadings[NZGB_10Y_IDX][1] +
    YIELD_PCA.scores[i]?.[2] * YIELD_PCA.loadings[NZGB_10Y_IDX][2]
  const mu = NZGB_10Y_RAW.reduce((a, b) => a + b, 0) / NZGB_10Y_RAW.length
  const sd = Math.sqrt(NZGB_10Y_RAW.map(v => (v - mu) ** 2).reduce((a, b) => a + b, 0) / NZGB_10Y_RAW.length)
  return mu + pca_fitted_z * sd
})
const NZGB_10Y_PCA_FITTED = MONTH_COLS.map((_m, i) => ({
  month: _m,
  actual: +(NZGB_10Y_RAW[i] * 100).toFixed(3),
  fairValue: +(NZGB_10Y_FAIR_VALUE[i] * 100).toFixed(3),
  richCheap: +((NZGB_10Y_RAW[i] - NZGB_10Y_FAIR_VALUE[i]) * 100).toFixed(3),
}))

function NewZealandFairValueSection() {
  const lastPt = NZGB_10Y_PCA_FITTED[NZGB_10Y_PCA_FITTED.length - 1]
  const isRich = lastPt.richCheap < 0
  const absRC = Math.abs(lastPt.richCheap).toFixed(1)
  return (
    <div id="fair-value" style={cardStyle}>
      <h2 style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 700, margin: '0 0 4px', fontFamily: 'monospace' }}>
        New Zealand 10y NZGB — PCA Fair Value
      </h2>
      <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 20px' }}>
        10y NZGB yield vs 3-PC PCA fair value · rich/cheap in bps · current: {isRich ? 'RICH' : 'CHEAP'} {absRC}bps
      </p>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 380px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>Actual vs Fair Value (%)</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={NZGB_10Y_PCA_FITTED} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <defs>
                <linearGradient id="gradCheapNZ" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#34d399" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradRichNZ" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f87171" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f87171" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
              <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(2)} domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} formatter={(v: number) => [v.toFixed(3) + '%']} />
              <Line type="monotone" dataKey="actual" stroke="#f59e0b" strokeWidth={1.8} dot={false} name="Actual" activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="fairValue" stroke="rgba(255,255,255,0.5)" strokeWidth={1.2} strokeDasharray="5 3" dot={false} name="Fair Value" activeDot={{ r: 3, strokeWidth: 0 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ flex: '1 1 340px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>Rich / Cheap (bps)</p>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={NZGB_10Y_PCA_FITTED} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
              <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(1)} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} formatter={(v: number) => [v.toFixed(1) + 'bps', 'Rich/Cheap']} />
              <Area type="monotone" dataKey="richCheap" stroke={isRich ? '#f87171' : '#34d399'} fill={isRich ? 'url(#gradRichNZ)' : 'url(#gradCheapNZ)'} strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
          <p style={{ color: '#475569', fontSize: 10, margin: '8px 0 0', textAlign: 'right' }}>
            negative = rich vs PCA model · positive = cheap
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Curve Dynamics ───────────────────────────────────────────────────────────
const DAILY_N = 504
function _genDailyYield(base: readonly number[], seed: number): number[] {
  const out: number[] = []
  let v = base[0]
  for (let i = 0; i < DAILY_N; i++) {
    const t = i / DAILY_N
    const idx = Math.min(Math.floor(t * base.length), base.length - 1)
    const target = base[idx]
    const noise = (Math.sin(seed * i * 0.07) * 0.0025 + Math.cos(seed * i * 0.13) * 0.0018)
    v = v * 0.92 + target * 0.08 + noise
    out.push(v)
  }
  return out
}
const DAILY_2Y = _genDailyYield(SYNTHETIC_YIELDS['2y'], 817)
const DAILY_10Y = _genDailyYield(SYNTHETIC_YIELDS['10y'], 823)
const CURVE_DATA = (() => {
  const win = 63
  return Array.from({ length: DAILY_N }, (_, i) => {
    const spread = (DAILY_10Y[i] - DAILY_2Y[i]) * 100
    if (i < win) return { day: i + 1, spread: +spread.toFixed(2), bullSteep: null, bearFlat: null }
    let bullSteep = 0, bearFlat = 0
    for (let j = i - win + 1; j <= i; j++) {
      const ds = (DAILY_10Y[j] - DAILY_2Y[j]) - (DAILY_10Y[j - 1] - DAILY_2Y[j - 1])
      const dl = DAILY_10Y[j] - DAILY_10Y[j - 1]
      if (ds > 0 && dl < 0) bullSteep++
      if (ds < 0 && dl > 0) bearFlat++
    }
    return { day: i + 1, spread: +spread.toFixed(2), bullSteep: +(bullSteep / win * 100).toFixed(1), bearFlat: +(bearFlat / win * 100).toFixed(1) }
  })
})()

function CurveDynamicsSection() {
  const last = CURVE_DATA[CURVE_DATA.length - 1]
  return (
    <div id="curve" style={cardStyle}>
      <h2 style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 700, margin: '0 0 4px', fontFamily: 'monospace' }}>
        2s10s NZGB Directionality
      </h2>
      <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 20px' }}>
        Daily 2s10s spread (bps) · 63-day rolling bull-steep &amp; bear-flat % · current spread: {last.spread.toFixed(0)}bps
      </p>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 380px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>2s10s Spread (bps)</p>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={CURVE_DATA} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <defs>
                <linearGradient id="gradSpreadNZ" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#818cf8" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#818cf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fill: '#475569', fontSize: 8 }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={63} tickFormatter={v => `D${v}`} />
              <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} formatter={(v: number) => [v.toFixed(1) + 'bps', '2s10s']} labelFormatter={v => `Day ${v}`} />
              <Area type="monotone" dataKey="spread" stroke="#818cf8" fill="url(#gradSpreadNZ)" strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div style={{ flex: '1 1 340px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>63-day Rolling Regime (%)</p>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={CURVE_DATA.slice(63)} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fill: '#475569', fontSize: 8 }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={63} tickFormatter={v => `D${v}`} />
              <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => v + '%'} domain={[0, 60]} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} formatter={(v: number, n: string) => [v.toFixed(1) + '%', n]} labelFormatter={v => `Day ${v}`} />
              <Line type="monotone" dataKey="bullSteep" stroke="#34d399" strokeWidth={1.5} dot={false} name="Bull-Steep" activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="bearFlat" stroke="#f87171" strokeWidth={1.5} dot={false} name="Bear-Flat" activeDot={{ r: 3, strokeWidth: 0 }} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 14, height: 2, background: '#34d399', borderRadius: 1 }} /><span style={{ color: '#475569', fontSize: 10 }}>Bull-Steep</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 14, height: 2, background: '#f87171', borderRadius: 1 }} /><span style={{ color: '#475569', fontSize: 10 }}>Bear-Flat</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Breakeven Dynamics ───────────────────────────────────────────────────────
const BE_ANCHOR = 0.022
const BE_DATA = MONTH_COLS.map((m, i) => {
  const t = i / (MONTH_COLS.length - 1)
  const nom = SYNTHETIC_YIELDS['10y'][i]
  const real = nom - BE_ANCHOR - 0.008 * Math.sin(i * 0.41 + 1.1) + 0.003 * Math.cos(i * 0.27)
  const be = nom - real
  return { month: m, nominal: +(nom * 100).toFixed(3), real: +(real * 100).toFixed(3), breakeven: +(be * 100).toFixed(3), t }
})

function beRegime(nom: number, be: number): { label: string; color: string } {
  if (nom > 0.045 && be > 0.022) return { label: 'Bear — High BEs', color: '#f87171' }
  if (nom > 0.045 && be <= 0.022) return { label: 'Bear — Low BEs', color: '#fb923c' }
  if (nom <= 0.038 && be > 0.022) return { label: 'Bull — High BEs', color: '#818cf8' }
  return { label: 'Bull — Low BEs', color: '#34d399' }
}

function BEDynamicsSection() {
  const lastBE = BE_DATA[BE_DATA.length - 1]
  const regime = beRegime(lastBE.nominal / 100, lastBE.breakeven / 100)
  return (
    <div id="breakeven" style={cardStyle}>
      <h2 style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 700, margin: '0 0 4px', fontFamily: 'monospace' }}>
        New Zealand 10y nominal NZGB vs real yield
      </h2>
      <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 20px' }}>
        Monthly nominal vs real yield decomposition · 10y breakeven · current regime:{' '}
        <span style={{ color: regime.color, fontWeight: 700 }}>{regime.label}</span>
      </p>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 380px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>Nominal / Real / Breakeven (%)</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={BE_DATA} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={4} />
              <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(2)} domain={['auto', 'auto']} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }} formatter={(v: number) => [v.toFixed(3) + '%']} />
              <Line type="monotone" dataKey="nominal" stroke="#f59e0b" strokeWidth={1.8} dot={false} name="Nominal" activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="real" stroke="#60a5fa" strokeWidth={1.5} dot={false} name="Real" activeDot={{ r: 3, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="breakeven" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Breakeven" activeDot={{ r: 3, strokeWidth: 0 }} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 14, height: 2, background: '#f59e0b', borderRadius: 1 }} /><span style={{ color: '#475569', fontSize: 10 }}>Nominal</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 14, height: 2, background: '#60a5fa', borderRadius: 1 }} /><span style={{ color: '#475569', fontSize: 10 }}>Real</span></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 0, borderTop: '2px dashed #a78bfa' }} /><span style={{ color: '#475569', fontSize: 10 }}>Breakeven</span></div>
          </div>
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 12px', fontWeight: 600 }}>Regime Classification</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              { label: 'Bear — High BEs', color: '#f87171', desc: 'nom > 4.5% · BE > 2.2%' },
              { label: 'Bear — Low BEs', color: '#fb923c', desc: 'nom > 4.5% · BE ≤ 2.2%' },
              { label: 'Bull — High BEs', color: '#818cf8', desc: 'nom ≤ 3.8% · BE > 2.2%' },
              { label: 'Bull — Low BEs', color: '#34d399', desc: 'nom ≤ 3.8% · BE ≤ 2.2%' },
            ].map(r => (
              <div key={r.label} style={{ background: regime.label === r.label ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)', borderRadius: 8, padding: '10px 12px', border: `1px solid ${regime.label === r.label ? r.color + '55' : 'rgba(255,255,255,0.06)'}` }}>
                <div style={{ color: r.color, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>{r.label}</div>
                <div style={{ color: '#475569', fontSize: 10 }}>{r.desc}</div>
                {regime.label === r.label && <div style={{ color: r.color, fontSize: 9, marginTop: 4, fontWeight: 600 }}>▶ CURRENT</div>}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16, padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
            <div style={{ color: '#64748b', fontSize: 10, marginBottom: 6 }}>Latest readings</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8', fontSize: 11 }}>10y Nominal</span><span style={{ color: '#f59e0b', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>{lastBE.nominal.toFixed(2)}%</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8', fontSize: 11 }}>10y Real</span><span style={{ color: '#60a5fa', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>{lastBE.real.toFixed(2)}%</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#94a3b8', fontSize: 11 }}>10y BE</span><span style={{ color: '#a78bfa', fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>{lastBE.breakeven.toFixed(2)}%</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTimestamp(): string {
  return new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
}

// ── Nav ───────────────────────────────────────────────────────────────────────
const NAV_SECTIONS = [
  { id: 'dfm', label: 'DFM Factors' },
  { id: 'pca', label: 'Yield PCA' },
  { id: 'pc-reg', label: 'PC Regressions' },
  { id: 'fair-value', label: 'Fair Value' },
  { id: 'curve', label: 'Curve Dynamics' },
  { id: 'breakeven', label: 'Breakevens' },
  { id: 'heatmap', label: 'Heatmap' },
]

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function NewZealandHeatmap() {
  const [activeSection, setActiveSection] = React.useState('dfm')

  const scrollTo = (id: string) => {
    setActiveSection(id)
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const lastRow = GROUPS_META[GROUPS_META.length - 1].indicators[0]
  const rateVal = (lastRow as { latest?: string }).latest ?? 'N/A'

  return (
    <div style={{ minHeight: '100vh', background: '#080d1a', fontFamily: 'monospace' }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)', borderBottom: '1px solid rgba(255,255,255,0.08)', padding: '24px 32px 20px' }}>
        <div style={{ maxWidth: 1400, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                <span style={{ fontSize: 28 }}>🇳🇿</span>
                <h1 style={{ color: '#f1f5f9', fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: '-0.5px' }}>
                  New Zealand — Macro Heatmap
                </h1>
              </div>
              <p style={{ color: '#64748b', fontSize: 12, margin: 0 }}>
                RBNZ framework · NZGB yields · NZONIA rate · NZD/USD · Non-Tradables CPI
              </p>
            </div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#64748b', fontSize: 10, marginBottom: 2 }}>RBNZ OCR</div>
                <div style={{ color: '#34d399', fontSize: 20, fontWeight: 800 }}>3.50%</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#64748b', fontSize: 10, marginBottom: 2 }}>Last mtg</div>
                <div style={{ color: '#94a3b8', fontSize: 12, fontWeight: 600 }}>28 May 2025</div>
                <div style={{ color: '#475569', fontSize: 10 }}>Held (after 5 cuts from 5.50%)</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#64748b', fontSize: 10, marginBottom: 2 }}>Updated</div>
                <div style={{ color: '#475569', fontSize: 10 }}>{fmtTimestamp()}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sticky nav */}
      <div style={{ position: 'sticky', top: 0, zIndex: 50, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(8px)' }}>
        <div style={{ maxWidth: 1400, margin: '0 auto', padding: '0 32px', display: 'flex', gap: 0, overflowX: 'auto' }}>
          {NAV_SECTIONS.map(s => (
            <button key={s.id} onClick={() => scrollTo(s.id)} style={{ background: 'none', border: 'none', borderBottom: activeSection === s.id ? '2px solid #818cf8' : '2px solid transparent', color: activeSection === s.id ? '#818cf8' : '#475569', padding: '12px 16px', fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'monospace', transition: 'color 0.15s' }}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 32px 64px' }}>
        {/* DFM Section */}
        <div id="dfm"><DFMSection /></div>

        {/* Yield PCA */}
        <YieldPCChart />

        {/* PC Regressions */}
        <PCRegressionSection />

        {/* Fair Value */}
        <NewZealandFairValueSection />

        {/* Curve Dynamics */}
        <CurveDynamicsSection />

        {/* Breakeven Dynamics */}
        <BEDynamicsSection />

        {/* Legend */}
        <div style={cardStyle}>
          <Legend />
        </div>

        {/* Heatmap */}
        <div id="heatmap" style={{ ...cardStyle, overflowX: 'auto' }}>
          <h2 style={{ color: '#f1f5f9', fontSize: 16, fontWeight: 700, margin: '0 0 4px', fontFamily: 'monospace' }}>
            Macro Indicator Heatmap — New Zealand
          </h2>
          <p style={{ color: '#64748b', fontSize: 11, margin: '0 0 20px' }}>
            Monthly z-scores · Jun 2023 – Jun 2025 · colour scale: red ≤ −2 · green ≥ +2
          </p>
          <HeatmapTable />
          <div style={{ color: '#334155', fontSize: 10, marginTop: 16, textAlign: 'right' }}>
            {rateVal} · synthetic illustration · not investment advice
          </div>
        </div>
      </div>
    </div>
  )
}
