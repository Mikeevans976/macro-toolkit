import React, { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12, padding: 24,
}

function generateMonths(): string[] {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const out: string[] = []
  let y = 2023, m = 5
  for (let i = 0; i < 25; i++) {
    out.push(`${names[m]} '${String(y).slice(2)}`)
    if (++m > 11) { m = 0; y++ }
  }
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
    const noise = 0.35 * Math.sin(noiseSeed * 13.7 + t * 2.3 + seed * 7.1)
               + 0.20 * Math.cos(noiseSeed * 5.3  + t * 4.1 + seed * 3.9)
    zs.push(Math.max(-3, Math.min(3, trend + wave1 + wave2 + noise)))
  }
  return zs
}

// BoJ last meeting: 30 Apr 2025 (held at 0.50%)
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
      { name: 'Real GDP (q/q, SAAR)',              asOfLastMtg: '+0.1%',  latest: '-0.7%', change: '-0.8',  lastUpd: '30 Apr 2025', units: '% q/q SA',  mean: -0.7,   std: 0.8,   amp: 0.9, phase: 0.2, freq: 0.28, noiseSeed: 201 },
      { name: 'Industrial Production (m/m)',        asOfLastMtg: '+0.2%',  latest: '-0.2%', change: '-0.4',  lastUpd: '30 May 2025', units: '% m/m SA',  mean: -0.2,   std: 0.8,   amp: 1.1, phase: 0.5, freq: 0.50, noiseSeed: 202 },
      { name: 'Tertiary Industry Activity (m/m)',   asOfLastMtg: '+0.4%',  latest: '+0.3%', change: '-0.1',  lastUpd: '16 May 2025', units: '% m/m SA',  mean: 0.3,    std: 0.5,   amp: 0.9, phase: 0.8, freq: 0.42, noiseSeed: 203 },
      { name: 'Retail Sales (m/m)',                 asOfLastMtg: '+0.6%',  latest: '+0.4%', change: '-0.2',  lastUpd: '30 May 2025', units: '% m/m SA',  mean: 0.4,    std: 0.6,   amp: 1.0, phase: 1.0, freq: 0.46, noiseSeed: 204 },
      { name: 'Household Spending (m/m SA)',        asOfLastMtg: '+0.3%',  latest: '-0.5%', change: '-0.8',  lastUpd: '06 May 2025', units: '% m/m SA',  mean: -0.5,   std: 1.0,   amp: 1.1, phase: 0.7, freq: 0.48, noiseSeed: 205 },
      { name: 'Machinery Orders (m/m)',             asOfLastMtg: '+2.1%',  latest: '-2.3%', change: '-4.4',  lastUpd: '19 May 2025', units: '% m/m SA',  mean: -2.3,   std: 5.0,   amp: 1.2, phase: 1.2, freq: 0.54, noiseSeed: 206 },
      { name: 'All Industry Activity (m/m)',        asOfLastMtg: '+0.3%',  latest: '-0.1%', change: '-0.4',  lastUpd: '20 May 2025', units: '% m/m SA',  mean: -0.1,   std: 0.5,   amp: 0.8, phase: 1.4, freq: 0.38, noiseSeed: 207 },
    ],
  },
  {
    name: 'Business Activity', bias: 0.2,
    indicators: [
      { name: 'Tankan Large Mfg DI',               asOfLastMtg: '+13',    latest: '+12',   change: '-1',    lastUpd: '01 Apr 2025', units: 'DI',        mean: 12.0,   std: 8.0,   amp: 1.2, phase: 0.4, freq: 0.30, noiseSeed: 208 },
      { name: 'Tankan Large Non-Mfg DI',           asOfLastMtg: '+35',    latest: '+35',   change: '—',     lastUpd: '01 Apr 2025', units: 'DI',        mean: 35.0,   std: 6.0,   amp: 0.9, phase: 0.5, freq: 0.26, noiseSeed: 209 },
      { name: 'Tankan Large Mfg Outlook DI',       asOfLastMtg: '+11',    latest: '+9',    change: '-2',    lastUpd: '01 Apr 2025', units: 'DI',        mean: 9.0,    std: 8.0,   amp: 1.2, phase: 0.6, freq: 0.31, noiseSeed: 210 },
      { name: 'Tankan Large Non-Mfg Outlook DI',   asOfLastMtg: '+28',    latest: '+28',   change: '—',     lastUpd: '01 Apr 2025', units: 'DI',        mean: 28.0,   std: 5.0,   amp: 0.9, phase: 0.7, freq: 0.27, noiseSeed: 211 },
      { name: 'Jibun Bank Composite PMI',          asOfLastMtg: '51.8',   latest: '51.2',  change: '-0.6',  lastUpd: '22 May 2025', units: 'Index SA',  mean: 51.2,   std: 2.0,   amp: 1.0, phase: 0.3, freq: 0.44, noiseSeed: 212 },
      { name: 'Jibun Bank Mfg PMI',               asOfLastMtg: '48.4',   latest: '48.5',  change: '+0.1',  lastUpd: '01 May 2025', units: 'Index SA',  mean: 48.5,   std: 2.5,   amp: 1.2, phase: 0.4, freq: 0.48, noiseSeed: 213 },
      { name: 'Jibun Bank Services PMI',          asOfLastMtg: '53.1',   latest: '53.0',  change: '-0.1',  lastUpd: '07 May 2025', units: 'Index SA',  mean: 53.0,   std: 2.2,   amp: 1.0, phase: 0.5, freq: 0.45, noiseSeed: 214 },
      { name: 'Economy Watchers Current DI',       asOfLastMtg: '47.2',   latest: '45.8',  change: '-1.4',  lastUpd: '09 May 2025', units: 'DI',        mean: 45.8,   std: 4.0,   amp: 1.1, phase: 0.8, freq: 0.42, noiseSeed: 215 },
      { name: 'Consumer Confidence Index',         asOfLastMtg: '36.2',   latest: '35.8',  change: '-0.4',  lastUpd: '15 May 2025', units: 'Index',     mean: 35.8,   std: 2.5,   amp: 1.0, phase: 1.0, freq: 0.40, noiseSeed: 216 },
    ],
  },
  {
    name: 'Housing Market', bias: -0.5,
    indicators: [
      { name: 'Housing Starts (y/y)',              asOfLastMtg: '-2.4%',  latest: '-3.5%', change: '-1.1',  lastUpd: '30 Apr 2025', units: '% y/y',     mean: -3.5,   std: 3.0,   amp: 1.0, phase: 0.4, freq: 0.34, noiseSeed: 217 },
      { name: 'Housing Starts (k, SAAR)',          asOfLastMtg: '834',    latest: '820',   change: '-14',   lastUpd: '30 Apr 2025', units: 'k SAAR',    mean: 820.0,  std: 50.0,  amp: 1.0, phase: 0.5, freq: 0.36, noiseSeed: 218 },
      { name: 'Construction Orders (y/y)',         asOfLastMtg: '-3.1%',  latest: '-4.2%', change: '-1.1',  lastUpd: '30 May 2025', units: '% y/y',     mean: -4.2,   std: 5.0,   amp: 1.1, phase: 0.6, freq: 0.38, noiseSeed: 219 },
      { name: 'Residential Investment (q/q)',      asOfLastMtg: '-0.2%',  latest: '-0.4%', change: '-0.2',  lastUpd: '30 Apr 2025', units: '% q/q SA',  mean: -0.4,   std: 1.0,   amp: 0.9, phase: 0.8, freq: 0.30, noiseSeed: 220 },
      { name: 'Machine Tool Orders (y/y)',         asOfLastMtg: '-1.2%',  latest: '-2.1%', change: '-0.9',  lastUpd: '09 May 2025', units: '% y/y',     mean: -2.1,   std: 8.0,   amp: 1.2, phase: 1.0, freq: 0.52, noiseSeed: 221 },
    ],
  },
  {
    name: 'Labour Market', bias: 0.3,
    indicators: [
      { name: 'Unemployment Rate',                 asOfLastMtg: '2.5%',   latest: '2.5%',  change: '—',     lastUpd: '30 May 2025', units: '% SA',      mean: 2.5,    std: 0.1,   amp: 0.4, phase: 1.5, freq: 0.20, noiseSeed: 222 },
      { name: 'Jobs-to-Applicants Ratio',          asOfLastMtg: '1.24',   latest: '1.24',  change: '—',     lastUpd: '30 May 2025', units: 'Ratio SA',  mean: 1.24,   std: 0.04,  amp: 0.5, phase: 1.4, freq: 0.22, noiseSeed: 223 },
      { name: 'Employment Change (m/m)',           asOfLastMtg: '+21k',   latest: '+18k',  change: '-3',    lastUpd: '30 May 2025', units: 'k SA',      mean: 18.0,   std: 20.0,  amp: 1.0, phase: 0.6, freq: 0.38, noiseSeed: 224 },
      { name: 'Labour Force Participation',        asOfLastMtg: '63.1%',  latest: '63.2%', change: '+0.1',  lastUpd: '30 May 2025', units: '% SA',      mean: 63.2,   std: 0.3,   amp: 0.4, phase: 0.5, freq: 0.18, noiseSeed: 225 },
      { name: 'Total Hours Worked (m/m)',          asOfLastMtg: '+0.1%',  latest: '-0.2%', change: '-0.3',  lastUpd: '30 May 2025', units: '% m/m SA',  mean: -0.2,   std: 0.8,   amp: 0.9, phase: 1.0, freq: 0.44, noiseSeed: 226 },
      { name: 'Regular Employees (y/y)',           asOfLastMtg: '+1.9%',  latest: '+1.8%', change: '-0.1',  lastUpd: '30 May 2025', units: '% y/y',     mean: 1.8,    std: 0.3,   amp: 0.6, phase: 0.7, freq: 0.24, noiseSeed: 227 },
      { name: 'Part-time Workers (y/y)',           asOfLastMtg: '+1.4%',  latest: '+1.2%', change: '-0.2',  lastUpd: '30 May 2025', units: '% y/y',     mean: 1.2,    std: 0.5,   amp: 0.7, phase: 0.8, freq: 0.26, noiseSeed: 228 },
      { name: 'Tankan Employment DI (large all)',  asOfLastMtg: '-5',     latest: '-4',    change: '+1',    lastUpd: '01 Apr 2025', units: 'DI',        mean: -4.0,   std: 4.0,   amp: 0.8, phase: 1.2, freq: 0.28, noiseSeed: 229 },
    ],
  },
  {
    name: 'Wages', bias: 0.8,
    indicators: [
      { name: 'Total Cash Earnings (y/y)',         asOfLastMtg: '3.2%',   latest: '3.5%',  change: '+0.3',  lastUpd: '09 May 2025', units: '% y/y',     mean: 3.5,    std: 0.5,   amp: 0.8, phase: 0.3, freq: 0.22, noiseSeed: 230 },
      { name: 'Scheduled Cash Earnings (y/y)',     asOfLastMtg: '2.8%',   latest: '3.1%',  change: '+0.3',  lastUpd: '09 May 2025', units: '% y/y',     mean: 3.1,    std: 0.4,   amp: 0.7, phase: 0.5, freq: 0.21, noiseSeed: 231 },
      { name: 'Real Wages (y/y)',                  asOfLastMtg: '+0.2%',  latest: '+0.4%', change: '+0.2',  lastUpd: '09 May 2025', units: '% y/y',     mean: 0.4,    std: 0.5,   amp: 0.7, phase: 0.7, freq: 0.20, noiseSeed: 232 },
      { name: 'Special Payments / Bonuses (y/y)',  asOfLastMtg: '5.8%',   latest: '6.2%',  change: '+0.4',  lastUpd: '09 May 2025', units: '% y/y',     mean: 6.2,    std: 1.5,   amp: 1.1, phase: 0.9, freq: 0.26, noiseSeed: 233 },
      { name: 'Overtime Pay (y/y)',                asOfLastMtg: '1.5%',   latest: '1.8%',  change: '+0.3',  lastUpd: '09 May 2025', units: '% y/y',     mean: 1.8,    std: 0.6,   amp: 0.8, phase: 1.0, freq: 0.24, noiseSeed: 234 },
      { name: 'Shunto Spring Wage (y/y)',          asOfLastMtg: '5.1%',   latest: '5.1%',  change: '—',     lastUpd: '14 Mar 2025', units: '% y/y',     mean: 5.1,    std: 0.8,   amp: 0.6, phase: 0.4, freq: 0.18, noiseSeed: 235 },
    ],
  },
  {
    name: 'Inflation', bias: 0.5,
    indicators: [
      { name: 'CPI Headline (y/y)',               asOfLastMtg: '3.6%',   latest: '3.6%',  change: '—',     lastUpd: '23 May 2025', units: '% y/y',     mean: 3.6,    std: 0.5,   amp: 0.8, phase: 0.0, freq: 0.26, noiseSeed: 236 },
      { name: 'CPI ex-Fresh Food (y/y)',          asOfLastMtg: '3.2%',   latest: '3.2%',  change: '—',     lastUpd: '23 May 2025', units: '% y/y',     mean: 3.2,    std: 0.4,   amp: 0.7, phase: 0.3, freq: 0.25, noiseSeed: 237 },
      { name: 'CPI ex-Fresh Food & Energy (y/y)', asOfLastMtg: '2.9%',   latest: '2.8%',  change: '-0.1',  lastUpd: '23 May 2025', units: '% y/y',     mean: 2.8,    std: 0.4,   amp: 0.7, phase: 0.4, freq: 0.24, noiseSeed: 238 },
      { name: 'CPI Fresh Food (y/y)',             asOfLastMtg: '7.8%',   latest: '7.2%',  change: '-0.6',  lastUpd: '23 May 2025', units: '% y/y',     mean: 7.2,    std: 1.5,   amp: 1.2, phase: 0.5, freq: 0.36, noiseSeed: 239 },
      { name: 'CPI Energy (y/y)',                 asOfLastMtg: '4.8%',   latest: '4.5%',  change: '-0.3',  lastUpd: '23 May 2025', units: '% y/y',     mean: 4.5,    std: 1.2,   amp: 1.1, phase: 0.6, freq: 0.32, noiseSeed: 240 },
      { name: 'Tokyo CPI ex-Fresh Food (y/y)',    asOfLastMtg: '3.4%',   latest: '3.6%',  change: '+0.2',  lastUpd: '25 Apr 2025', units: '% y/y',     mean: 3.6,    std: 0.4,   amp: 0.7, phase: 0.2, freq: 0.25, noiseSeed: 241 },
      { name: 'CGPI (y/y)',                       asOfLastMtg: '4.0%',   latest: '4.2%',  change: '+0.2',  lastUpd: '13 May 2025', units: '% y/y',     mean: 4.2,    std: 0.8,   amp: 1.0, phase: 0.7, freq: 0.30, noiseSeed: 242 },
      { name: 'Import Prices Yen-Based (y/y)',    asOfLastMtg: '0.2%',   latest: '-2.1%', change: '-2.3',  lastUpd: '13 May 2025', units: '% y/y',     mean: -2.1,   std: 3.0,   amp: 1.2, phase: 0.8, freq: 0.38, noiseSeed: 243 },
      { name: 'Inflation Expectations 1y',        asOfLastMtg: '2.9%',   latest: '2.8%',  change: '-0.1',  lastUpd: '09 May 2025', units: '%',         mean: 2.8,    std: 0.3,   amp: 0.6, phase: 0.5, freq: 0.22, noiseSeed: 244 },
      { name: '10y JGB BEI',                      asOfLastMtg: '1.50%',  latest: '1.52%', change: '+0.02', lastUpd: '30 May 2025', units: '%',         mean: 1.52,   std: 0.15,  amp: 0.6, phase: 0.8, freq: 0.20, noiseSeed: 245 },
    ],
  },
  {
    name: 'Financial Conditions', bias: 0.3,
    indicators: [
      { name: 'BoJ Policy Rate',                  asOfLastMtg: '0.50%',  latest: '0.50%', change: '—',     lastUpd: '30 Apr 2025', units: '%',         mean: 0.50,   std: 0.15,  amp: 0.4, phase: 0.2, freq: 0.16, noiseSeed: 246 },
      { name: 'TONA 3M',                          asOfLastMtg: '0.43%',  latest: '0.45%', change: '+0.02', lastUpd: '30 May 2025', units: '%',         mean: 0.45,   std: 0.12,  amp: 0.5, phase: 0.3, freq: 0.18, noiseSeed: 247 },
      { name: '2y JGB Yield',                     asOfLastMtg: '0.82%',  latest: '0.78%', change: '-0.04', lastUpd: '30 May 2025', units: '%',         mean: 0.78,   std: 0.22,  amp: 0.8, phase: 0.4, freq: 0.30, noiseSeed: 248 },
      { name: '5y JGB Yield',                     asOfLastMtg: '1.02%',  latest: '0.98%', change: '-0.04', lastUpd: '30 May 2025', units: '%',         mean: 0.98,   std: 0.25,  amp: 0.9, phase: 0.5, freq: 0.32, noiseSeed: 249 },
      { name: '10y JGB Yield',                    asOfLastMtg: '1.50%',  latest: '1.42%', change: '-0.08', lastUpd: '30 May 2025', units: '%',         mean: 1.42,   std: 0.30,  amp: 1.0, phase: 0.6, freq: 0.34, noiseSeed: 250 },
      { name: '20y JGB Yield',                    asOfLastMtg: '2.42%',  latest: '2.38%', change: '-0.04', lastUpd: '30 May 2025', units: '%',         mean: 2.38,   std: 0.45,  amp: 1.1, phase: 0.7, freq: 0.36, noiseSeed: 251 },
      { name: '30y JGB Yield',                    asOfLastMtg: '2.85%',  latest: '2.75%', change: '-0.10', lastUpd: '30 May 2025', units: '%',         mean: 2.75,   std: 0.52,  amp: 1.2, phase: 0.8, freq: 0.38, noiseSeed: 252 },
      { name: '2s10s JGB Curve',                  asOfLastMtg: '68',     latest: '64',    change: '-4',    lastUpd: '30 May 2025', units: 'bps',       mean: 64.0,   std: 22.0,  amp: 1.0, phase: 1.2, freq: 0.36, noiseSeed: 253 },
      { name: '5s30s JGB Curve',                  asOfLastMtg: '183',    latest: '177',   change: '-6',    lastUpd: '30 May 2025', units: 'bps',       mean: 177.0,  std: 45.0,  amp: 1.0, phase: 1.4, freq: 0.34, noiseSeed: 254 },
      { name: '10y JGB Real Yield',               asOfLastMtg: '-0.08%', latest: '-0.10%',change: '-0.02', lastUpd: '30 May 2025', units: '%',         mean: -0.10,  std: 0.18,  amp: 0.8, phase: 0.5, freq: 0.30, noiseSeed: 255 },
      { name: '10y JGB BEI (mkt)',                asOfLastMtg: '1.58%',  latest: '1.52%', change: '-0.06', lastUpd: '30 May 2025', units: '%',         mean: 1.52,   std: 0.18,  amp: 0.7, phase: 0.8, freq: 0.26, noiseSeed: 256 },
      { name: 'USD/JPY',                          asOfLastMtg: '145.2',  latest: '143.5', change: '-1.7',  lastUpd: '30 May 2025', units: 'FX Rate',   mean: 143.5,  std: 5.0,   amp: 1.1, phase: 1.0, freq: 0.42, noiseSeed: 257 },
      { name: 'EUR/JPY',                          asOfLastMtg: '162.8',  latest: '161.8', change: '-1.0',  lastUpd: '30 May 2025', units: 'FX Rate',   mean: 161.8,  std: 6.0,   amp: 1.0, phase: 1.1, freq: 0.40, noiseSeed: 258 },
      { name: 'Nikkei 225',                       asOfLastMtg: '35,620', latest: '38,450',change: '+2830', lastUpd: '30 May 2025', units: 'Index',     mean: 38450.0,std: 2500.0,amp: 1.1, phase: 0.9, freq: 0.44, noiseSeed: 259 },
      { name: 'TOPIX',                            asOfLastMtg: '2,510',  latest: '2,760', change: '+250',  lastUpd: '30 May 2025', units: 'Index',     mean: 2760.0, std: 180.0, amp: 1.1, phase: 1.0, freq: 0.43, noiseSeed: 260 },
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

// ─── JGB Yields ───────────────────────────────────────────────────────────────
// 5 tenors (2y/5y/10y/20y/30y), Jun '23 – Jun '25
// YCC in place until Mar '24; BoJ ended NIRP Mar '24; hiked Jul '24 (0.25%), Jan '25 (0.50%)
// Long end very elevated in 2025 due to BoJ QE tapering and fiscal concerns

export const YIELD_TENORS = ['2y', '5y', '10y', '20y', '30y'] as const
export type Tenor = typeof YIELD_TENORS[number]

export const SYNTHETIC_YIELDS: Record<Tenor, number[]> = {
  //          Jun'23 Jul'23 Aug'23 Sep'23 Oct'23 Nov'23 Dec'23 Jan'24 Feb'24 Mar'24 Apr'24 May'24 Jun'24 Jul'24 Aug'24 Sep'24 Oct'24 Nov'24 Dec'24 Jan'25 Feb'25 Mar'25 Apr'25 May'25 Jun'25
  '2y':  [0.05, 0.06, 0.08, 0.07, 0.10, 0.09, 0.07, 0.12, 0.15, 0.18, 0.28, 0.32, 0.34, 0.38, 0.45, 0.52, 0.38, 0.40, 0.45, 0.65, 0.68, 0.70, 0.82, 0.75, 0.78],
  '5y':  [0.18, 0.20, 0.28, 0.25, 0.42, 0.40, 0.35, 0.42, 0.45, 0.50, 0.62, 0.65, 0.60, 0.65, 0.72, 0.78, 0.65, 0.68, 0.72, 0.88, 0.90, 0.92, 1.02, 0.95, 0.98],
  '10y': [0.40, 0.62, 0.65, 0.77, 0.95, 0.88, 0.62, 0.68, 0.72, 0.78, 0.88, 0.92, 1.02, 1.05, 0.92, 0.85, 0.95, 1.05, 1.08, 1.22, 1.48, 1.52, 1.50, 1.38, 1.42],
  '20y': [1.05, 1.25, 1.35, 1.48, 1.68, 1.55, 1.22, 1.28, 1.35, 1.42, 1.52, 1.58, 1.72, 1.78, 1.65, 1.55, 1.68, 1.78, 1.85, 2.10, 2.38, 2.42, 2.48, 2.35, 2.38],
  '30y': [1.25, 1.45, 1.58, 1.72, 1.92, 1.78, 1.45, 1.52, 1.58, 1.65, 1.78, 1.85, 1.98, 2.05, 1.92, 1.82, 1.95, 2.08, 2.15, 2.45, 2.72, 2.78, 2.85, 2.70, 2.75],
}

// ─── Jacobi PCA ───────────────────────────────────────────────────────────────

function jacobiEigen(mat: number[][]): { values: number[]; vectors: number[][] } {
  const n = mat.length
  const a = mat.map(r => [...r])
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  )
  for (let iter = 0; iter < 500; iter++) {
    let maxVal = 0, p = 0, q = 1
    for (let i = 0; i < n - 1; i++)
      for (let j = i + 1; j < n; j++)
        if (Math.abs(a[i][j]) > maxVal) { maxVal = Math.abs(a[i][j]); p = i; q = j }
    if (maxVal < 1e-12) break
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(1 + theta * theta))
    const c = 1 / Math.sqrt(1 + t * t), s = t * c
    const app = a[p][p], aqq = a[q][q], apq = a[p][q]
    a[p][p] = app - t * apq; a[q][q] = aqq + t * apq; a[p][q] = 0; a[q][p] = 0
    for (let i = 0; i < n; i++) {
      if (i !== p && i !== q) {
        const aip = a[i][p], aiq = a[i][q]
        a[i][p] = a[p][i] = c * aip - s * aiq
        a[i][q] = a[q][i] = s * aip + c * aiq
      }
    }
    for (let i = 0; i < n; i++) {
      const vip = v[i][p], viq = v[i][q]
      v[i][p] = c * vip - s * viq; v[i][q] = s * vip + c * viq
    }
  }
  const pairs = Array.from({ length: n }, (_, k) => ({
    val: a[k][k], vec: Array.from({ length: n }, (_, r) => v[r][k]),
  })).sort((x, y) => y.val - x.val)
  return { values: pairs.map(p => p.val), vectors: pairs.map(p => p.vec) }
}

export interface YieldPCAResult {
  scores: number[][]; loadings: number[][]; explainedVar: number[]; means: number[]
}

function computeYieldPCA(): YieldPCAResult {
  const N = N_MONTHS, M = YIELD_TENORS.length
  const data: number[][] = Array.from({ length: N }, (_, t) => YIELD_TENORS.map(tenor => SYNTHETIC_YIELDS[tenor][t]))
  const means = Array.from({ length: M }, (_, j) => data.reduce((s, row) => s + row[j], 0) / N)
  const centered = data.map(row => row.map((v, j) => v - means[j]))
  const cov: number[][] = Array.from({ length: M }, (_, i) =>
    Array.from({ length: M }, (_, j) => centered.reduce((s, row) => s + row[i] * row[j], 0) / (N - 1))
  )
  const { values, vectors } = jacobiEigen(cov)
  const totalVar = values.reduce((s, v) => s + Math.abs(v), 0)
  const rawLoadings = vectors.slice(0, 3)
  const pivots = [rawLoadings[0][2], rawLoadings[1][4], rawLoadings[2][1]]
  const loadings = rawLoadings.map((l, k) => { const sign = pivots[k] < 0 ? -1 : 1; return l.map(v => v * sign) })
  const scores = centered.map(row => loadings.map(loading => loading.reduce((s, l, j) => s + l * row[j], 0)))
  return { scores, loadings, explainedVar: values.slice(0, 3).map(v => v / totalVar), means }
}

export const YIELD_PCA: YieldPCAResult = computeYieldPCA()

// ─── Color helpers ────────────────────────────────────────────────────────────

function formatCellValue(value: number, units: string): string {
  if (units === 'FX Rate') return value.toFixed(1)
  if (units === 'bps') return value.toFixed(0)
  if (units === 'DI') return (value >= 0 ? '+' : '') + value.toFixed(0)
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
  const steps = [
    { bg: '#7F1D1D', fg: '#ffffff', label: '≥ +2σ' },
    { bg: '#DC2626', fg: '#ffffff', label: '+1σ' },
    { bg: '#FCA5A5', fg: '#0f172a', label: '+0.5σ' },
    { bg: '#F1F5F9', fg: '#0f172a', label: '0' },
    { bg: '#93C5FD', fg: '#0f172a', label: '−0.5σ' },
    { bg: '#2563EB', fg: '#ffffff', label: '−1σ' },
    { bg: '#1E3A5F', fg: '#ffffff', label: '≤ −2σ' },
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ color: '#475569', fontSize: 11, marginRight: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Z-score scale</span>
      {steps.map(s => (
        <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 36, height: 20, background: s.bg, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: s.fg, fontSize: 9, fontFamily: 'monospace', fontWeight: 600 }}>{s.label}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Heatmap Table ────────────────────────────────────────────────────────────

const CELL_W = 52, CELL_H = 28, INDICATOR_W_DEFAULT = 220
const RIGHT_COL_W = 76, UNITS_COL_W = 92
const stickyBg = '#080d1a'

function HeatmapTable() {
  const [indicatorW, setIndicatorW] = useState(INDICATOR_W_DEFAULT)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: indicatorW }
    function onMouseMove(ev: MouseEvent) { if (!dragRef.current) return; setIndicatorW(Math.max(120, dragRef.current.startW + ev.clientX - dragRef.current.startX)) }
    function onMouseUp() { dragRef.current = null; window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp) }
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp)
  }, [indicatorW])

  const cellStyle = (z: number): React.CSSProperties => {
    const { bg, fg } = zscoreToColors(z)
    return { width: CELL_W, minWidth: CELL_W, maxWidth: CELL_W, height: CELL_H, textAlign: 'center', fontFamily: 'monospace', fontSize: 10, fontWeight: 500, color: fg, background: bg, padding: 0, border: '1px solid rgba(8,13,26,0.5)', userSelect: 'none' }
  }
  const hdrCell: React.CSSProperties = { width: CELL_W, minWidth: CELL_W, maxWidth: CELL_W, textAlign: 'center', color: '#64748b', fontSize: 10, fontFamily: 'monospace', padding: '5px 2px', fontWeight: 600, whiteSpace: 'nowrap', background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, zIndex: 2 }
  const indHdr: React.CSSProperties = { width: indicatorW, minWidth: indicatorW, maxWidth: indicatorW, textAlign: 'left', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '5px 12px', fontWeight: 600, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, left: 0, zIndex: 4, overflow: 'visible' }
  const rHdr = (ro: number): React.CSSProperties => ({ width: RIGHT_COL_W, minWidth: RIGHT_COL_W, maxWidth: RIGHT_COL_W, textAlign: 'center', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '5px 4px', fontWeight: 600, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, right: ro, zIndex: 4, whiteSpace: 'nowrap' })
  const indCell: React.CSSProperties = { width: indicatorW, minWidth: indicatorW, maxWidth: indicatorW, color: '#cbd5e1', fontSize: 11, padding: '0 12px', height: CELL_H, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: 0, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.04)', borderRight: '1px solid rgba(255,255,255,0.07)', zIndex: 1 }
  const grpRow: React.CSSProperties = { background: 'rgba(255,255,255,0.025)', color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, padding: '4px 12px', height: 22, position: 'sticky', left: 0, zIndex: 1 }
  const rCell: React.CSSProperties = { width: RIGHT_COL_W, minWidth: RIGHT_COL_W, maxWidth: RIGHT_COL_W, textAlign: 'center', fontSize: 10, fontFamily: 'monospace', padding: 0, height: CELL_H, borderBottom: '1px solid rgba(255,255,255,0.04)', borderLeft: '1px solid rgba(255,255,255,0.06)', background: stickyBg }
  const uHdr = (ro: number): React.CSSProperties => ({ width: UNITS_COL_W, minWidth: UNITS_COL_W, maxWidth: UNITS_COL_W, textAlign: 'center', color: '#64748b', fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '0.05em', padding: '5px 4px', fontWeight: 600, background: stickyBg, borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky' as const, top: 0, right: ro, zIndex: 4, whiteSpace: 'nowrap' as const })
  const R_CHANGE = 0, R_LATEST = RIGHT_COL_W, R_AS_OF_MTG = RIGHT_COL_W * 2
  const R_UNITS = RIGHT_COL_W * 3, R_LASTUPD = RIGHT_COL_W * 3 + UNITS_COL_W

  return (
    <div style={{ overflowX: 'auto', overflowY: 'visible' }}>
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: indicatorW + CELL_W * N_MONTHS + RIGHT_COL_W * 4 + UNITS_COL_W }}>
        <colgroup>
          <col style={{ width: indicatorW }} />
          {MONTH_COLS.map((_, i) => <col key={i} style={{ width: CELL_W }} />)}
          <col style={{ width: RIGHT_COL_W }} /><col style={{ width: UNITS_COL_W }} />
          <col style={{ width: RIGHT_COL_W }} /><col style={{ width: RIGHT_COL_W }} /><col style={{ width: RIGHT_COL_W }} />
        </colgroup>
        <thead>
          <tr>
            <th style={indHdr}>
              Indicator
              <div onMouseDown={onResizeMouseDown} style={{ position: 'absolute', top: 0, right: 0, width: 6, height: '100%', cursor: 'col-resize', userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 2, height: 14, borderRadius: 1, background: 'rgba(255,255,255,0.18)' }} />
              </div>
            </th>
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
              <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
                <td colSpan={N_MONTHS + 6} style={grpRow}>{group.name}</td>
              </tr>
              {group.indicators.map(ind => (
                <tr key={ind.name}
                  onMouseEnter={e => { e.currentTarget.querySelectorAll('td').forEach(td => { if ((td as HTMLElement).dataset.heatcell !== '1') (td as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }) }}
                  onMouseLeave={e => { e.currentTarget.querySelectorAll('td').forEach(td => { if ((td as HTMLElement).dataset.heatcell !== '1') (td as HTMLElement).style.background = stickyBg }) }}
                >
                  <td style={indCell}>{ind.name}</td>
                  {ind.zscores.map((z, ci) => (
                    <td key={ci} style={cellStyle(z)} data-heatcell="1">
                      {formatCellValue(ind.mean + z * ind.std, ind.units)}
                    </td>
                  ))}
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

// ─── DFM Factor Synthesis ─────────────────────────────────────────────────────
// Group indices: 0=Real Activity, 1=Business Activity, 2=Housing, 3=Labour, 4=Wages, 5=Inflation, 6=Financial

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
  return Array.from({ length: N_MONTHS }, (_, t) => {
    const vals = all.map(zs => zs[t])
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100) / 100
  })
}

const FACTOR_SERIES: Record<string, number[]> = Object.fromEntries(DFM_FACTORS.map(f => [f.key, computeFactor(f.groupIndices)]))
const DFM_CHART_DATA = MONTH_COLS.map((month, t) => {
  const obj: Record<string, string | number> = { month }
  DFM_FACTORS.forEach(f => { obj[f.key] = FACTOR_SERIES[f.key][t] })
  return obj
})

interface FactorStats { current: number; d1m: number; d3m: number; d12m: number; zscore: number }
const FACTOR_STATS: Record<string, FactorStats> = Object.fromEntries(
  DFM_FACTORS.map(f => {
    const s = FACTOR_SERIES[f.key]
    const current = s[N_MONTHS - 1]
    const mean = s.reduce((a, b) => a + b, 0) / s.length
    const std = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length)
    return [f.key, { current, d1m: current - s[N_MONTHS - 2], d3m: current - s[N_MONTHS - 4], d12m: current - s[N_MONTHS - 13], zscore: std > 0 ? (current - mean) / std : 0 }]
  })
)

function DFMSection() {
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Macro Factors — DFM Synthesis</h2>
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>5 factors extracted via Dynamic Factor Model &middot; weekly monitoring of Japan macro fundamentals</p>
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
          <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 8 }}>
            {DFM_FACTORS.map(f => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 24, height: 2, borderRadius: 1, background: f.color }} />
                <span style={{ color: '#94a3b8', fontSize: 11 }}>{f.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Factor summary</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead><tr>{['Factor','Level (σ)','Δ1m','Δ3m','Δ12m','Z'].map((h, i) => <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 6px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
              <tbody>
                {DFM_FACTORS.map(f => {
                  const st = FACTOR_STATS[f.key]
                  const lc = st.current > 0.3 ? '#f87171' : st.current < -0.3 ? '#60a5fa' : '#94a3b8'
                  const dc = (d: number) => d > 0.05 ? '#f87171' : d < -0.05 ? '#60a5fa' : '#475569'
                  const zc = st.zscore > 0.5 ? '#f87171' : st.zscore < -0.5 ? '#60a5fa' : '#94a3b8'
                  const fmt = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2)
                  return (
                    <tr key={f.key}>
                      <td style={{ padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, flexShrink: 0 }} />
                          <span style={{ color: '#cbd5e1', fontSize: 11, whiteSpace: 'nowrap' }}>{f.label}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: lc, fontWeight: 700 }}>{fmt(st.current)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: dc(st.d1m) }}>{fmt(st.d1m)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: dc(st.d3m) }}>{fmt(st.d3m)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: dc(st.d12m) }}>{fmt(st.d12m)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: zc, fontWeight: 600 }}>{fmt(st.zscore)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '12px 14px' }}>
            <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Methodology</p>
            {[
              'Broad Macro: avg z-score across activity, inflation, labour & wage series',
              'Growth: Business Activity, Real Activity & Housing blocks',
              'Inflation: Inflation block (~10 indicators incl. CPI/CGPI/BEI)',
              'Employment: Labour Market block (~8 indicators)',
              'Wages: Wages block (~6 indicators incl. Shunto, Cash Earnings)',
            ].map((note, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5 }}>
                <span style={{ color: DFM_FACTORS[i].color, fontSize: 10, flexShrink: 0, marginTop: 1 }}>●</span>
                <span style={{ color: '#475569', fontSize: 10, lineHeight: 1.45 }}>{note}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── OLS helpers ──────────────────────────────────────────────────────────────

function matTranspose(A: number[][]): number[][] { return A[0].map((_, j) => A.map(r => r[j])) }
function matMul(A: number[][], B: number[][]): number[][] {
  return Array.from({ length: A.length }, (_, i) =>
    Array.from({ length: B[0].length }, (_, j) =>
      Array.from({ length: B.length }, (_, k) => A[i][k] * B[k][j]).reduce((a, b) => a + b, 0)))
}
function matVecMul(A: number[][], v: number[]): number[] { return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0)) }
function matInv(A: number[][]): number[][] {
  const n = A.length
  const aug = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col++) {
    let mx = col
    for (let r = col + 1; r < n; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[mx][col])) mx = r;
    [aug[col], aug[mx]] = [aug[mx], aug[col]]
    const pv = aug[col][col]
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pv
    for (let r = 0; r < n; r++) { if (r === col) continue; const f = aug[r][col]; for (let j = 0; j < 2 * n; j++) aug[r][j] -= f * aug[col][j] }
  }
  return aug.map(row => row.slice(n))
}
interface OLSResult { coefficients: number[]; tStats: number[]; rSquared: number; adjRSquared: number; fitted: number[]; residuals: number[] }
function ols(y: number[], X: number[][]): OLSResult {
  const N = y.length, K = X[0].length
  const Xt = matTranspose(X), XtX = matMul(Xt, X), Xty = matVecMul(Xt, y)
  const beta = matVecMul(matInv(XtX), Xty)
  const fitted = X.map(row => row.reduce((s, x, j) => s + x * beta[j], 0))
  const residuals = y.map((yi, i) => yi - fitted[i])
  const yMean = y.reduce((s, v) => s + v, 0) / N
  const TSS = y.reduce((s, v) => s + (v - yMean) ** 2, 0)
  const RSS = residuals.reduce((s, r) => s + r ** 2, 0)
  const rSquared = 1 - RSS / TSS
  const adjRSquared = 1 - (RSS / (N - K)) / (TSS / (N - 1))
  const sigma2 = RSS / (N - K)
  const XtXinv = matInv(XtX)
  return { coefficients: beta, tStats: beta.map((b, j) => b / Math.sqrt(sigma2 * XtXinv[j][j])), rSquared, adjRSquared, fitted, residuals }
}

const REG_FACTORS: { key: string; label: string; color: string }[] = [
  { key: 'broadMacro', label: 'Broad Macro', color: '#94a3b8' },
  { key: 'growth',     label: 'Growth',      color: '#34d399' },
  { key: 'inflation',  label: 'Inflation',   color: '#f87171' },
  { key: 'employment', label: 'Employment',  color: '#60a5fa' },
]
const REG_X: number[][] = Array.from({ length: N_MONTHS }, (_, t) => REG_FACTORS.map(f => FACTOR_SERIES[f.key][t]))
const PC1_REG: OLSResult = ols(YIELD_PCA.scores.map(s => s[0]), REG_X)
const PC2_REG: OLSResult = ols(YIELD_PCA.scores.map(s => s[1]), REG_X)

const PC_META = [
  { key: 'pc1', label: 'PC1 — Level',     color: '#f59e0b' },
  { key: 'pc2', label: 'PC2 — Slope',     color: '#34d399' },
  { key: 'pc3', label: 'PC3 — Curvature', color: '#a78bfa' },
]
const PC_CHART_DATA = MONTH_COLS.map((month, t) => ({
  month, pc1: Math.round(YIELD_PCA.scores[t][0] * 1000) / 1000,
  pc2: Math.round(YIELD_PCA.scores[t][1] * 1000) / 1000,
  pc3: Math.round(YIELD_PCA.scores[t][2] * 1000) / 1000,
}))

function YieldPCChart() {
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>JGB Yield Curve — Principal Components</h2>
          <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>PCA on 2/5/10/20/30y JGB yields &middot; synthetic data</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {PC_META.map((pc, k) => (
            <div key={pc.key} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '4px 10px' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: pc.color }} />
              <span style={{ color: '#94a3b8', fontSize: 11 }}>{pc.label}</span>
              <span style={{ color: pc.color, fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>{(YIELD_PCA.explainedVar[k] * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
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
          <tbody>
            {PC_META.map((pc, k) => (
              <tr key={pc.key}>
                <td style={{ padding: '5px 8px 5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: pc.color, flexShrink: 0 }} />
                    <span style={{ color: '#cbd5e1', fontSize: 11 }}>{pc.label}</span>
                  </div>
                </td>
                {YIELD_PCA.loadings[k].map((l, j) => (
                  <td key={j} style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', fontSize: 10, color: l > 0.05 ? '#34d399' : l < -0.05 ? '#f87171' : '#475569' }}>
                    {l >= 0 ? '+' : ''}{l.toFixed(3)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const REG_CHART_DATA = MONTH_COLS.map((month, t) => ({
  month,
  pc1Actual: Math.round(YIELD_PCA.scores[t][0] * 1000) / 1000,
  pc1Fitted: Math.round(PC1_REG.fitted[t] * 1000) / 1000,
  pc2Actual: Math.round(YIELD_PCA.scores[t][1] * 1000) / 1000,
  pc2Fitted: Math.round(PC2_REG.fitted[t] * 1000) / 1000,
}))

function tStatColor(t: number): string {
  const a = Math.abs(t)
  return a >= 2.58 ? '#34d399' : a >= 1.96 ? '#fbbf24' : a >= 1.65 ? '#94a3b8' : '#475569'
}

function RegressionTable({ reg, pcLabel }: { reg: OLSResult; pcLabel: string }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
        <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 600 }}>{pcLabel}</span>
        <span style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6, padding: '2px 8px', fontFamily: 'monospace', fontSize: 11, color: '#f1f5f9' }}>R² = {reg.rSquared.toFixed(3)}</span>
        <span style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6, padding: '2px 8px', fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>adj. R² = {reg.adjRSquared.toFixed(3)}</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead><tr>{['Factor','Coeff.','t-stat','Sig.'].map(h => <th key={h} style={{ textAlign: h === 'Factor' ? 'left' : 'right', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 8px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
        <tbody>
          {REG_FACTORS.map((f, k) => {
            const b = reg.coefficients[k], t = reg.tStats[k]
            return (
              <tr key={f.key}>
                <td style={{ padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, flexShrink: 0 }} />
                    <span style={{ color: '#cbd5e1', fontSize: 11 }}>{f.label}</span>
                  </div>
                </td>
                <td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: b >= 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>{b >= 0 ? '+' : ''}{b.toFixed(4)}</td>
                <td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: tStatColor(t) }}>{t >= 0 ? '+' : ''}{t.toFixed(2)}</td>
                <td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', color: tStatColor(t), fontWeight: 600 }}>{Math.abs(t) >= 2.58 ? '***' : Math.abs(t) >= 1.96 ? '**' : Math.abs(t) >= 1.65 ? '*' : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PCRegressionSection() {
  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Rates–Macro Linkage — PC Regressions</h2>
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>OLS: PC1 &amp; PC2 of JGB curve regressed on macro factors &middot; *** p&lt;1% &nbsp;** p&lt;5% &nbsp;* p&lt;10%</p>
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
        {[
          { label: 'PC1 — Level', actualKey: 'pc1Actual', fittedKey: 'pc1Fitted', color: '#f59e0b' },
          { label: 'PC2 — Slope', actualKey: 'pc2Actual', fittedKey: 'pc2Fitted', color: '#34d399' },
        ].map(({ label, actualKey, fittedKey, color }) => (
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
            <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 2, background: color, borderRadius: 1 }} /><span style={{ color: '#475569', fontSize: 10 }}>Actual</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 0, borderTop: '2px dashed rgba(255,255,255,0.45)', borderRadius: 1 }} /><span style={{ color: '#475569', fontSize: 10 }}>Fitted</span></div>
            </div>
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

// ─── 10y JGB Fair Value ───────────────────────────────────────────────────────

const JGB_10Y_IDX = YIELD_TENORS.indexOf('10y')

const JGB_10Y_FAIR_VALUE: number[] = Array.from({ length: N_MONTHS }, (_, t) =>
  YIELD_PCA.means[JGB_10Y_IDX]
  + YIELD_PCA.loadings[0][JGB_10Y_IDX] * PC1_REG.fitted[t]
  + YIELD_PCA.loadings[1][JGB_10Y_IDX] * PC2_REG.fitted[t]
)
const JGB_10Y_PCA_FITTED: number[] = Array.from({ length: N_MONTHS }, (_, t) =>
  YIELD_PCA.means[JGB_10Y_IDX]
  + YIELD_PCA.loadings[0][JGB_10Y_IDX] * YIELD_PCA.scores[t][0]
  + YIELD_PCA.loadings[1][JGB_10Y_IDX] * YIELD_PCA.scores[t][1]
)
const JGB_10Y_RICHCHEAP: number[] = SYNTHETIC_YIELDS['10y'].map(
  (y, t) => Math.round((y - JGB_10Y_FAIR_VALUE[t]) * 100 * 10) / 10
)

interface CurveFVRow { label: string; current: number; fv: number; resid: number; stddev: number; zscore: number; isSpread: boolean }

function computeCurveFV(): CurveFVRow[] {
  const OUTRIGHTS: { label: Tenor; idx: number }[] = [
    { label: '2y', idx: 0 }, { label: '5y', idx: 1 }, { label: '10y', idx: 2 }, { label: '30y', idx: 4 },
  ]
  const fvSeries: Partial<Record<Tenor, number[]>> = {}
  const rows: CurveFVRow[] = []
  for (const { label, idx } of OUTRIGHTS) {
    const fv = Array.from({ length: N_MONTHS }, (_, t) =>
      YIELD_PCA.means[idx] + YIELD_PCA.loadings[0][idx] * PC1_REG.fitted[t] + YIELD_PCA.loadings[1][idx] * PC2_REG.fitted[t]
    )
    fvSeries[label] = fv
    const residSeries = SYNTHETIC_YIELDS[label].map((y, t) => (y - fv[t]) * 100)
    const mean = residSeries.reduce((a, b) => a + b, 0) / residSeries.length
    const stddev = Math.sqrt(residSeries.reduce((a, v) => a + (v - mean) ** 2, 0) / residSeries.length)
    const resid = residSeries[N_MONTHS - 1]
    rows.push({ label, current: SYNTHETIC_YIELDS[label][N_MONTHS - 1], fv: fv[N_MONTHS - 1], resid, stddev, zscore: stddev > 0 ? resid / stddev : 0, isSpread: false })
  }
  for (const { label, long, short } of [{ label: '2s10s', long: '10y' as Tenor, short: '2y' as Tenor }, { label: '5s30s', long: '30y' as Tenor, short: '5y' as Tenor }]) {
    const actualSpread = Array.from({ length: N_MONTHS }, (_, t) => (SYNTHETIC_YIELDS[long][t] - SYNTHETIC_YIELDS[short][t]) * 100)
    const fvSpread = Array.from({ length: N_MONTHS }, (_, t) => (fvSeries[long]![t] - fvSeries[short]![t]) * 100)
    const residSeries = actualSpread.map((s, t) => s - fvSpread[t])
    const mean = residSeries.reduce((a, b) => a + b, 0) / residSeries.length
    const stddev = Math.sqrt(residSeries.reduce((a, v) => a + (v - mean) ** 2, 0) / residSeries.length)
    const resid = residSeries[N_MONTHS - 1]
    rows.push({ label, current: actualSpread[N_MONTHS - 1], fv: fvSpread[N_MONTHS - 1], resid, stddev, zscore: stddev > 0 ? resid / stddev : 0, isSpread: true })
  }
  return rows
}
const CURVE_FV_ROWS: CurveFVRow[] = computeCurveFV()

const FV_CHART_DATA = MONTH_COLS.map((month, t) => ({
  month,
  actual:    Math.round(SYNTHETIC_YIELDS['10y'][t] * 100) / 100,
  pcaFitted: Math.round(JGB_10Y_PCA_FITTED[t] * 100) / 100,
  fairValue: Math.round(JGB_10Y_FAIR_VALUE[t] * 100) / 100,
  richCheap: JGB_10Y_RICHCHEAP[t],
}))

function JGBFairValueSection() {
  const current = SYNTHETIC_YIELDS['10y'][N_MONTHS - 1]
  const fv = JGB_10Y_FAIR_VALUE[N_MONTHS - 1]
  const rc = JGB_10Y_RICHCHEAP[N_MONTHS - 1]
  const rcColor = rc > 5 ? '#34d399' : rc < -5 ? '#f87171' : '#94a3b8'
  const rcLabel = rc < 0 ? 'Rich' : 'Cheap'
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>10y JGB — Macro Fair Value</h2>
          <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>PCA inversion: ŷ = μ + L₁·PĈ₁ + L₂·PĈ₂ &middot; macro-implied level via OLS</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { label: 'Actual', value: `${current.toFixed(2)}%`, color: '#f59e0b' },
            { label: 'PCA (PC1+PC2)', value: `${JGB_10Y_PCA_FITTED[N_MONTHS - 1].toFixed(2)}%`, color: '#34d399' },
            { label: 'Macro Fair Value', value: `${fv.toFixed(2)}%`, color: '#94a3b8' },
            { label: rcLabel, value: `${Math.abs(rc).toFixed(1)} bps`, color: rcColor },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '6px 12px', textAlign: 'center' }}>
              <div style={{ color: '#475569', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
              <div style={{ color, fontSize: 13, fontFamily: 'monospace', fontWeight: 700 }}>{value}</div>
            </div>
          ))}
        </div>
      </div>
      <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Actual vs macro fair value (%)</p>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={FV_CHART_DATA} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={3} />
          <YAxis tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => `${v.toFixed(2)}%`} domain={['auto', 'auto']} />
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number, name: string) => [`${v.toFixed(3)}%`, name === 'actual' ? 'Actual 10y JGB' : name === 'pcaFitted' ? 'PCA (PC1+PC2)' : 'Macro Fair Value']} />
          <Line type="monotone" dataKey="actual"    stroke="#f59e0b" strokeWidth={2}   dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
          <Line type="monotone" dataKey="pcaFitted" stroke="#34d399" strokeWidth={1.5} strokeDasharray="3 2" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
          <Line type="monotone" dataKey="fairValue" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="5 3" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 20, marginTop: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 20, height: 2, background: '#f59e0b', borderRadius: 1 }} /><span style={{ color: '#475569', fontSize: 10 }}>Actual 10y JGB</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 20, height: 0, borderTop: '2px dashed #34d399' }} /><span style={{ color: '#475569', fontSize: 10 }}>PCA reconstruction (PC1+PC2)</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 20, height: 0, borderTop: '2px dashed #94a3b8' }} /><span style={{ color: '#475569', fontSize: 10 }}>Macro fair value</span></div>
      </div>
      <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Rich / cheap vs fair value (bps) — positive = cheap, negative = rich</p>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={FV_CHART_DATA} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <defs>
            <linearGradient id="gradCheapJP" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#34d399" stopOpacity={0.25} /><stop offset="95%" stopColor="#34d399" stopOpacity={0.02} /></linearGradient>
            <linearGradient id="gradRichJP" x1="0" y1="1" x2="0" y2="0"><stop offset="5%" stopColor="#f87171" stopOpacity={0.25} /><stop offset="95%" stopColor="#f87171" stopOpacity={0.02} /></linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={3} />
          <YAxis tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => `${v > 0 ? '+' : ''}${v}bp`} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} formatter={(v: number) => [`${v > 0 ? '+' : ''}${v.toFixed(1)} bps`, v >= 0 ? 'Cheap' : 'Rich']} />
          <Area type="monotone" dataKey="richCheap" stroke="#94a3b8" strokeWidth={1.5} fill={rc >= 0 ? 'url(#gradCheapJP)' : 'url(#gradRichJP)'} />
        </AreaChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 28 }}>
        <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>Curve macro fair value</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead><tr>{['', 'Current', 'Fair Value', 'Resid (bp)', 'StdDev (bp)', 'Z-Score'].map((h, i) => <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 10px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>
            {CURVE_FV_ROWS.map((row, i) => {
              const absZ = Math.abs(row.zscore)
              const zBg = absZ >= 1.5 ? (row.zscore > 0 ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)') : 'transparent'
              const zColor = row.zscore > 0.5 ? '#34d399' : row.zscore < -0.5 ? '#f87171' : '#94a3b8'
              const sep = i === 4 ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(255,255,255,0.04)'
              return (
                <tr key={row.label} style={{ background: zBg }}>
                  <td style={{ padding: '6px 10px', borderBottom: sep, color: '#cbd5e1', fontWeight: 600, fontSize: 11, fontFamily: 'monospace' }}>{row.label}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: 'monospace', color: '#e2e8f0' }}>{row.isSpread ? `${row.current.toFixed(1)} bp` : `${row.current.toFixed(2)}%`}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: 'monospace', color: '#94a3b8' }}>{row.isSpread ? `${row.fv.toFixed(1)} bp` : `${row.fv.toFixed(2)}%`}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: 'monospace', color: row.resid > 0 ? '#34d399' : '#f87171' }}>{row.resid > 0 ? '+' : ''}{row.resid.toFixed(1)}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: 'monospace', color: '#475569' }}>{row.stddev.toFixed(1)}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: 'monospace', fontWeight: 700, color: zColor }}>{row.zscore > 0 ? '+' : ''}{row.zscore.toFixed(2)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── 2s10s Directionality ─────────────────────────────────────────────────────

const BDAYS_PER_MONTH = 21
const N_DAILY = (N_MONTHS - 1) * BDAYS_PER_MONTH + 1
const _TENOR_SEEDS: Partial<Record<Tenor, number>> = { '2y': 1.1, '5y': 2.5, '10y': 3.7, '20y': 4.9, '30y': 5.6 }

function _genDailyYield(tenor: Tenor): number[] {
  const monthly = SYNTHETIC_YIELDS[tenor], seed = _TENOR_SEEDS[tenor] ?? 2.0, out: number[] = []
  for (let m = 0; m < N_MONTHS - 1; m++) {
    const y0 = monthly[m], y1 = monthly[m + 1]
    for (let d = 0; d < BDAYS_PER_MONTH; d++) {
      const interp = y0 + (y1 - y0) * (d / BDAYS_PER_MONTH)
      out.push(interp + 0.018 * Math.sin((m * 7 + d) * 1.31 + seed) + 0.012 * Math.cos((m * 3 + d) * 2.73 + seed * 0.7))
    }
  }
  out.push(monthly[N_MONTHS - 1])
  return out
}

const DAILY_2Y = _genDailyYield('2y'), DAILY_10Y = _genDailyYield('10y')
const ROLL_DAYS = 63

interface DirPoint { idx: number; pct: number; monthLabel: string | null }
interface FullDirPoint { idx: number; monthLabel: string | null; bullSteep: number; bullFlat: number; bearSteep: number; bearFlat: number }

function computeDailyDir(): DirPoint[] {
  const results: DirPoint[] = []
  for (let t = ROLL_DAYS; t < N_DAILY; t++) {
    let match = 0
    for (let i = t - ROLL_DAYS + 1; i <= t; i++) {
      const dLong = DAILY_10Y[i] - DAILY_10Y[i - 1]
      const dSpread = (DAILY_10Y[i] - DAILY_2Y[i]) - (DAILY_10Y[i - 1] - DAILY_2Y[i - 1])
      if (Math.abs(dLong) < 1e-7) continue
      if ((dLong < 0 && dSpread > 0) || (dLong > 0 && dSpread < 0)) match++
    }
    results.push({ idx: t - ROLL_DAYS, pct: Math.round(match / ROLL_DAYS * 1000) / 10, monthLabel: (t % BDAYS_PER_MONTH === 0) ? MONTH_COLS[Math.floor(t / BDAYS_PER_MONTH)] : null })
  }
  return results
}

function computeFullDir(longArr: number[], shortArr: number[]): FullDirPoint[] {
  const n = longArr.length, results: FullDirPoint[] = []
  for (let t = ROLL_DAYS; t < n; t++) {
    let bs = 0, bf = 0, bes = 0, bef = 0
    for (let i = t - ROLL_DAYS + 1; i <= t; i++) {
      const dLong = longArr[i] - longArr[i - 1]
      const dSpread = (longArr[i] - shortArr[i]) - (longArr[i - 1] - shortArr[i - 1])
      if (Math.abs(dLong) < 1e-7) continue
      if (dLong < 0 && dSpread > 0) bs++
      else if (dLong < 0 && dSpread <= 0) bf++
      else if (dLong > 0 && dSpread > 0) bes++
      else bef++
    }
    const total = bs + bf + bes + bef || 1
    results.push({ idx: t - ROLL_DAYS, monthLabel: (t % BDAYS_PER_MONTH === 0) ? MONTH_COLS[Math.floor(t / BDAYS_PER_MONTH)] : null, bullSteep: Math.round(bs / total * 100), bullFlat: Math.round(bf / total * 100), bearSteep: Math.round(bes / total * 100), bearFlat: Math.round(bef / total * 100) })
  }
  return results
}

const DAILY_DIR = computeDailyDir()
const DIR_MONTH_TICKS = DAILY_DIR.filter(d => d.monthLabel !== null).map(d => d.idx)
const DIR_CURRENT_PCT = DAILY_DIR[DAILY_DIR.length - 1].pct
const DIR_2S10S = computeFullDir(DAILY_10Y, DAILY_2Y)

function CurveDynamicsSection() {
  const chartData = DAILY_DIR.map(d => ({ idx: d.idx, pct: d.pct }))
  const tailData = DIR_2S10S.map(d => ({ idx: d.idx, tail: d.bullSteep + d.bearFlat }))
  const tailAvg = Math.round(tailData.reduce((s, d) => s + d.tail, 0) / tailData.length)
  const ticks = DIR_2S10S.filter(d => d.monthLabel !== null).map(d => d.idx)
  const labelFor = (idx: number) => DIR_2S10S.filter(d => d.monthLabel && d.idx <= idx).slice(-1)[0]?.monthLabel ?? ''
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>2s10s JGB Directionality</h2>
          <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>% of daily moves bull-steepening or bear-flattening &middot; 3-month rolling window</p>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '6px 14px', textAlign: 'center' }}>
          <div style={{ color: '#475569', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Current</div>
          <div style={{ color: DIR_CURRENT_PCT > 55 ? '#34d399' : DIR_CURRENT_PCT < 40 ? '#f87171' : '#f59e0b', fontSize: 20, fontFamily: 'monospace', fontWeight: 700 }}>{DIR_CURRENT_PCT.toFixed(1)}%</div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="idx" type="number" scale="linear" domain={[0, DAILY_DIR.length - 1]} ticks={DIR_MONTH_TICKS} tickFormatter={idx => DAILY_DIR.find(d => d.idx === idx)?.monthLabel ?? ''} tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={0} />
          <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickCount={6} />
          <ReferenceLine y={50} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} labelFormatter={idx => DAILY_DIR.filter(d => d.monthLabel && d.idx <= (idx as number)).slice(-1)[0]?.monthLabel ?? String(idx)} formatter={(v: number) => [`${v.toFixed(1)}%`, 'Bull-Steep + Bear-Flat']} />
          <Line type="monotone" dataKey="pct" stroke="#f59e0b" strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0, fill: '#f59e0b' }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <p style={{ color: '#334155', fontSize: 9, margin: '8px 0 24px', fontStyle: 'italic' }}>Bull-steepening: JGBs rally &amp; spread widens. Bear-flattening: JGBs sell off &amp; spread narrows. &gt;50% = macro-driven directionality.</p>
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Tail likelihoods — 2s10s JGB</p>
            <p style={{ color: '#334155', fontSize: 9, margin: '3px 0 0', fontStyle: 'italic' }}>Bull-steepening + bear-flattening &nbsp;·&nbsp; 3m rolling</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ label: 'Current', val: tailData[tailData.length - 1].tail, color: tailData[tailData.length - 1].tail > tailAvg ? '#f87171' : '#34d399' }, { label: 'Avg', val: tailAvg, color: '#475569' }].map(({ label, val, color }) => (
              <div key={label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '4px 12px', textAlign: 'center' }}>
                <div style={{ color: '#475569', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
                <div style={{ color, fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>{val}%</div>
              </div>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={tailData} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
            <XAxis dataKey="idx" type="number" scale="linear" domain={[0, tailData.length - 1]} ticks={ticks} tickFormatter={idx => labelFor(idx as number)} tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={0} />
            <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickCount={6} />
            <ReferenceLine y={tailAvg} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" label={{ value: 'avg', position: 'insideTopRight', fill: '#475569', fontSize: 9 }} />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} labelFormatter={idx => labelFor(idx as number)} formatter={(v: number) => [`${v}%`, 'Tail likelihood']} />
            <Line type="monotone" dataKey="tail" stroke="#94a3b8" strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── BE Dynamics (10y JGB breakeven) ─────────────────────────────────────────
// Japan 10y BEI oscillates around 1.5% (nominal JGB - JGBi linker)
const DAILY_10Y_REAL2: number[] = DAILY_10Y.map((nom, i) => {
  const be = 0.015 + 0.002 * Math.sin(i * 0.05 + 0.8) + 0.0015 * Math.cos(i * 0.12 + 1.2)
  return nom - be
})

type FullBEPoint = { idx: number; monthLabel: string | null; bullWide: number; bullTight: number; bearWide: number; bearTight: number }

function computeBEDir(nomArr: number[], realArr: number[]): FullBEPoint[] {
  const n = nomArr.length, results: FullBEPoint[] = []
  for (let t = ROLL_DAYS; t < n; t++) {
    let bw = 0, bt = 0, bew = 0, bet = 0
    for (let i = t - ROLL_DAYS + 1; i <= t; i++) {
      const dNom = nomArr[i] - nomArr[i - 1]
      const dBE  = (nomArr[i] - realArr[i]) - (nomArr[i - 1] - realArr[i - 1])
      if (Math.abs(dNom) < 1e-7) continue
      if (dNom < 0 && dBE > 0) bw++
      else if (dNom < 0 && dBE <= 0) bt++
      else if (dNom > 0 && dBE > 0) bew++
      else bet++
    }
    const total = bw + bt + bew + bet || 1
    results.push({ idx: t - ROLL_DAYS, monthLabel: (t % BDAYS_PER_MONTH === 0) ? MONTH_COLS[Math.floor(t / BDAYS_PER_MONTH)] : null, bullWide: Math.round(bw / total * 100), bullTight: Math.round(bt / total * 100), bearWide: Math.round(bew / total * 100), bearTight: Math.round(bet / total * 100) })
  }
  return results
}

const BE_DIR = computeBEDir(DAILY_10Y, DAILY_10Y_REAL2)
const BE_TICKS = BE_DIR.filter(d => d.monthLabel !== null).map(d => d.idx)
const BE_LABEL_FOR = (idx: number) => BE_DIR.filter(d => d.monthLabel && d.idx <= idx).slice(-1)[0]?.monthLabel ?? ''
const _DISP_MAX = Math.sqrt(1875)
function regimeDisp(a: number, b: number, c: number, d: number): number {
  return Math.round(Math.sqrt([a, b, c, d].reduce((s, p) => s + (p - 25) ** 2, 0) / 4) / _DISP_MAX * 1000) / 10
}
const BE_ROLLING_DISP = BE_DIR.map(d => ({ idx: d.idx, disp: regimeDisp(d.bullWide, d.bullTight, d.bearWide, d.bearTight) }))
const BE_DISP_AVG = Math.round(BE_ROLLING_DISP.reduce((s, d) => s + d.disp, 0) / BE_ROLLING_DISP.length * 10) / 10

function BEDynamicsSection() {
  const last = BE_DIR[BE_DIR.length - 1]
  const orthodox = last.bearWide + last.bullTight
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>10y Breakeven Dynamics</h2>
          <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>Japan 10y nominal JGB vs real yield (JGBi) &middot; 4-regime BE directionality &middot; 3m rolling</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[{ label: 'Bear-Wide (Expansion)', val: last.bearWide, color: '#f87171' }, { label: 'Bull-Tight (Slowdown)', val: last.bullTight, color: '#60a5fa' }].map(({ label, val, color }) => (
            <div key={label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '4px 12px', textAlign: 'center' }}>
              <div style={{ color: '#475569', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>{label}</div>
              <div style={{ color, fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>{val}%</div>
            </div>
          ))}
        </div>
      </div>
      <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>BE dynamic — orthodox regime (bear-wide + bull-tight)</p>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={BE_DIR.map(d => ({ idx: d.idx, orthodox: d.bearWide + d.bullTight, nonOrthodox: d.bullWide + d.bearTight }))} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="idx" type="number" scale="linear" domain={[0, BE_DIR.length - 1]} ticks={BE_TICKS} tickFormatter={idx => BE_LABEL_FOR(idx as number)} tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={0} />
          <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickCount={6} />
          <ReferenceLine y={50} stroke="rgba(255,255,255,0.10)" strokeDasharray="4 4" />
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} labelFormatter={idx => BE_LABEL_FOR(idx as number)} formatter={(v: number, n: string) => [`${v}%`, n === 'orthodox' ? 'Orthodox (bear-wide + bull-tight)' : 'Non-orthodox']} />
          <Line type="monotone" dataKey="orthodox" stroke="#34d399" strokeWidth={1.8} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
          <Line type="monotone" dataKey="nonOrthodox" stroke="#f87171" strokeWidth={1.2} strokeDasharray="4 3" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 2, background: '#34d399', borderRadius: 1 }} /><span style={{ color: '#475569', fontSize: 10 }}>Orthodox (current: {orthodox}%)</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 0, borderTop: '2px dashed #f87171' }} /><span style={{ color: '#475569', fontSize: 10 }}>Non-orthodox</span></div>
      </div>
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Dispersion in BE dynamic — 3m rolling</p>
            <p style={{ color: '#334155', fontSize: 9, margin: '3px 0 0', fontStyle: 'italic' }}>↓ dispersion = conviction &nbsp;·&nbsp; ↑ dispersion = mixed signals</p>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '4px 12px', textAlign: 'center' }}>
            <div style={{ color: '#475569', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>avg</div>
            <div style={{ color: '#34d399', fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>{BE_DISP_AVG.toFixed(1)}%</div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={BE_ROLLING_DISP} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
            <XAxis dataKey="idx" type="number" scale="linear" domain={[0, BE_ROLLING_DISP.length - 1]} ticks={BE_TICKS} tickFormatter={idx => BE_LABEL_FOR(idx as number)} tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={0} />
            <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickCount={6} />
            <ReferenceLine y={BE_DISP_AVG} stroke="rgba(52,211,153,0.3)" strokeDasharray="4 4" />
            <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: '#e2e8f0' }} labelStyle={{ color: '#64748b', marginBottom: 4 }} labelFormatter={idx => BE_LABEL_FOR(idx as number)} formatter={(v: number) => [`${v.toFixed(1)}%`, 'BE dispersion']} />
            <Line type="monotone" dataKey="disp" stroke="#34d399" strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p style={{ color: '#334155', fontSize: 9, margin: '10px 0 0', fontStyle: 'italic' }}>Orthodox moves: Expansion (bear-wide, BEI widens as reflation accelerates) + Slowdown (bull-tight, BEI narrows as growth slows). Non-orthodox: Stagflation (bull-wide) or Goldilocks (bear-tight).</p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function fmtTimestamp(d: Date): string {
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export default function JapanHeatmap() {
  const navigate = useNavigate()
  const [timestamp, setTimestamp] = useState(() => fmtTimestamp(new Date()))
  const [refreshing, setRefreshing] = useState(false)
  function handleRefresh() {
    setRefreshing(true)
    setTimeout(() => { setTimestamp(fmtTimestamp(new Date())); setRefreshing(false) }, 600)
  }
  return (
    <div style={{ minHeight: '100vh', background: '#080d1a' }}>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse at 50% -10%, rgba(59,130,246,0.06) 0%, transparent 55%)' }} />
      <header style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', background: 'rgba(8,13,26,0.85)', borderBottom: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(12px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button onClick={() => navigate('/')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', color: '#94a3b8', cursor: 'pointer', fontSize: 14 }} onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#e2e8f0' }} onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#94a3b8' }}>←</button>
          <div>
            <h1 style={{ color: '#ffffff', fontSize: 15, fontWeight: 600, margin: 0, lineHeight: 1.2 }}>Japan — Macro Heatmap</h1>
            <p style={{ color: '#475569', fontSize: 11, margin: 0, marginTop: 2 }}>Dynamic Factor Model &middot; Simulated Data</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={handleRefresh} disabled={refreshing} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '5px 12px', color: '#94a3b8', fontSize: 12, cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.5 : 1 }} onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#e2e8f0' } }} onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#94a3b8' }}>
            <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '5px 12px' }}>
            <span style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Generated</span>
            <span style={{ color: '#94a3b8', fontSize: 11, fontFamily: 'monospace', fontWeight: 500 }}>{timestamp}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.18)', borderRadius: 8, padding: '5px 12px' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', opacity: 0.8 }} />
            <span style={{ color: '#60a5fa', fontSize: 11, fontWeight: 500 }}>Jun 2023 – Jun 2025</span>
          </div>
        </div>
      </header>
      <main style={{ position: 'relative', maxWidth: 1600, margin: '0 auto', padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <DFMSection />
        <YieldPCChart />
        <PCRegressionSection />
        <JGBFairValueSection />
        <CurveDynamicsSection />
        <BEDynamicsSection />
        <div style={cardStyle}><Legend /></div>
        <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>Macro Fundamentals — Z-Score Heatmap</h2>
            <p style={{ color: '#475569', fontSize: 12, margin: 0, marginTop: 3 }}>Z-scores relative to 3-year rolling window &middot; 25 monthly observations &middot; 60 indicators across 7 blocks</p>
          </div>
          <div style={{ padding: '0 0 4px' }}><HeatmapTable /></div>
        </div>
        <p style={{ color: '#334155', fontSize: 10, textAlign: 'center', margin: 0, fontStyle: 'italic' }}>
          Data is simulated for illustrative purposes only. Z-scores generated via deterministic DFM-inspired time series.
        </p>
      </main>
    </div>
  )
}
