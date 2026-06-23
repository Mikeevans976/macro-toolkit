import React, { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Indicator {
  name: string
  asOfLastMtg: string
  latest: string
  change: string
  lastUpd: string
  units: string
  mean: number
  std: number
  zscores: number[]
}

interface Group {
  name: string
  indicators: Indicator[]
}

// ─── Styles (matching SwapsRV exactly) ───────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: 24,
}

// ─── Date column generation ───────────────────────────────────────────────────

function generateMonths(): string[] {
  // 18 months ending June 2025
  const months: string[] = []
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  // Start: Jan 2024 - 6 = Jul 2023 ... end Jun 2025
  // 18 months ending Jun 2025 => start Jan 2024? No:
  // Jun 2025 minus 17 months = Jan 2024. Let's be precise:
  // Month index 0 = Jan 2024 - 17 months = no.
  // 18 months: month 0 = first, month 17 = Jun 2025
  // Jun 2025 is month index 5 (0-based) of 2025.
  // 17 months before Jun 2025 = Dec 2023.
  // So: Dec 2023, Jan 2024, ..., Jun 2025 = 19 months. We want 18.
  // Let's do: Jan 2024 back to Jul 2023 is 7 months...
  // Simpler: end = Jun 2025, go back 17 steps.
  // Step 0 (oldest): Jun 2025 - 17 months = Jan 2024. That's 18 months: Jan 2024 → Jun 2025.
  // But spec says "Jun '23" to "Jun '25". That's 25 months.
  // Spec example: "Jun '23", "Jul '23", ..., "Jun '25" = 25 columns.
  // Let's do exactly that: 25 months from Jun 2023 to Jun 2025.
  // Wait, re-reading: "generate 18 months ending June 2025, formatted as 'Jun '23', 'Jul '23', ..., 'Jun '25'"
  // Jun '23 to Jun '25 is 25 months, not 18. The spec is ambiguous.
  // Let's just do what the example shows: Jun '23 through Jun '25 (25 months).
  let year = 2023
  let month = 5 // June = index 5
  for (let i = 0; i < 25; i++) {
    const yy = String(year).slice(2)
    months.push(`${monthNames[month]} '${yy}`)
    month++
    if (month > 11) { month = 0; year++ }
  }
  return months
}

const MONTH_COLS = generateMonths()
const N_MONTHS = MONTH_COLS.length

// ─── Deterministic pseudo-random z-score generation ──────────────────────────
// Each indicator gets a smooth time series via sin/cos combinations with
// deterministic offsets derived from the indicator's position.

function generateZscores(
  seed: number,
  groupBias: number,   // baseline level bias for the group
  amplitude: number,
  phase: number,
  freq: number,
  noiseSeed: number,
): number[] {
  const zs: number[] = []
  for (let t = 0; t < N_MONTHS; t++) {
    const trend = groupBias * (1 - t / (N_MONTHS * 1.5))
    const wave1 = amplitude * Math.sin(freq * t + phase)
    const wave2 = (amplitude * 0.5) * Math.cos(freq * 1.7 * t + phase * 0.8)
    // Deterministic "noise" from seed
    const noise = 0.35 * Math.sin(noiseSeed * 13.7 + t * 2.3 + seed * 7.1)
             + 0.2  * Math.cos(noiseSeed * 5.3  + t * 4.1 + seed * 3.9)
    const raw = trend + wave1 + wave2 + noise
    // Clamp to ±3
    zs.push(Math.max(-3, Math.min(3, raw)))
  }
  return zs
}

// ─── Hardcoded indicator metadata ────────────────────────────────────────────

// ECB last meeting: 5 Jun 2025
const GROUPS_META: {
  name: string
  bias: number
  indicators: {
    name: string
    asOfLastMtg: string
    latest: string
    change: string
    lastUpd: string
    units: string
    mean: number
    std: number
    amp: number
    phase: number
    freq: number
    noiseSeed: number
  }[]
}[] = [
  {
    name: 'Real Activity',
    bias: -0.5,
    indicators: [
      { name: 'EA20: Real GDP',                        asOfLastMtg: '0.3%',   latest: '0.3%',   change: '—',     lastUpd: '30 Apr 2025', units: '% q/q SA',   mean: 0.3,   std: 0.3,  amp: 0.8, phase: 0.2, freq: 0.28, noiseSeed: 1  },
      { name: 'France: Real GDP',                      asOfLastMtg: '0.1%',   latest: '0.1%',   change: '—',     lastUpd: '30 Apr 2025', units: '% q/q SA',   mean: 0.1,   std: 0.3,  amp: 0.9, phase: 0.5, freq: 0.30, noiseSeed: 2  },
      { name: 'Germany: Real GDP',                     asOfLastMtg: '-0.2%',  latest: '-0.2%',  change: '—',     lastUpd: '30 Apr 2025', units: '% q/q SA',   mean: -0.2,  std: 0.3,  amp: 1.0, phase: 0.8, freq: 0.32, noiseSeed: 3  },
      { name: 'Italy: Real GDP',                       asOfLastMtg: '0.2%',   latest: '0.2%',   change: '—',     lastUpd: '30 Apr 2025', units: '% q/q SA',   mean: 0.2,   std: 0.3,  amp: 0.9, phase: 1.1, freq: 0.29, noiseSeed: 4  },
      { name: 'Spain: Real GDP',                       asOfLastMtg: '0.7%',   latest: '0.7%',   change: '—',     lastUpd: '30 Apr 2025', units: '% q/q SA',   mean: 0.7,   std: 0.3,  amp: 0.7, phase: 1.4, freq: 0.27, noiseSeed: 5  },
      { name: 'EA20: Real Domestic Demand Growth',     asOfLastMtg: '0.4%',   latest: '0.4%',   change: '—',     lastUpd: '30 Apr 2025', units: '% q/q SA',   mean: 0.4,   std: 0.3,  amp: 0.9, phase: 0.3, freq: 0.31, noiseSeed: 6  },
      { name: 'EA20: Retail Sales Value Growth',       asOfLastMtg: '1.5%',   latest: '1.8%',   change: '+0.3',  lastUpd: '06 May 2025', units: '% y/y',      mean: 1.8,   std: 0.8,  amp: 1.1, phase: 1.7, freq: 0.48, noiseSeed: 7  },
      { name: 'EA20: Retail Sales Volume Growth',      asOfLastMtg: '0.7%',   latest: '0.9%',   change: '+0.2',  lastUpd: '06 May 2025', units: '% y/y',      mean: 0.9,   std: 0.7,  amp: 1.0, phase: 2.0, freq: 0.46, noiseSeed: 8  },
      { name: 'EA: US Current Activity Indicator',     asOfLastMtg: '1.0',    latest: '1.1',    change: '+0.1',  lastUpd: '01 Jun 2025', units: 'Index',      mean: 1.1,   std: 0.7,  amp: 1.2, phase: 0.6, freq: 0.42, noiseSeed: 9  },
      { name: 'Eurozone: CESI Surprise Index',         asOfLastMtg: '-17.2',  latest: '-12.9',  change: '+4.3',  lastUpd: '01 Jun 2025', units: 'Index',      mean: -12.9, std: 10.0, amp: 1.5, phase: 1.0, freq: 0.50, noiseSeed: 10 },
    ],
  },
  {
    name: 'Business Activity',
    bias: -0.7,
    indicators: [
      { name: 'Euro area Composite PMI',                  asOfLastMtg: '49.0', latest: '49.4', change: '+0.4', lastUpd: '04 Jun 2025', units: 'Index SA',   mean: 49.4,  std: 2.5,  amp: 1.3, phase: 0.5, freq: 0.49, noiseSeed: 11 },
      { name: 'Euro area Composite PMI – New Orders',     asOfLastMtg: '47.2', latest: '47.8', change: '+0.6', lastUpd: '04 Jun 2025', units: 'Index SA',   mean: 47.8,  std: 2.5,  amp: 1.4, phase: 0.7, freq: 0.51, noiseSeed: 12 },
      { name: 'Euro area Manufacturing PMI – New Orders', asOfLastMtg: '43.4', latest: '44.2', change: '+0.8', lastUpd: '02 Jun 2025', units: 'Index SA',   mean: 44.2,  std: 3.0,  amp: 1.5, phase: 0.4, freq: 0.53, noiseSeed: 13 },
      { name: 'Euro area Services PMI',                   asOfLastMtg: '49.8', latest: '50.1', change: '+0.3', lastUpd: '04 Jun 2025', units: 'Index SA',   mean: 50.1,  std: 2.5,  amp: 1.2, phase: 0.6, freq: 0.47, noiseSeed: 14 },
      { name: 'Euro area Services PMI – New Business',    asOfLastMtg: '49.4', latest: '49.6', change: '+0.2', lastUpd: '04 Jun 2025', units: 'Index SA',   mean: 49.6,  std: 2.5,  amp: 1.1, phase: 0.9, freq: 0.45, noiseSeed: 15 },
      { name: 'EA20: Economic Sentiment Indicator',       asOfLastMtg: '94.8', latest: '95.4', change: '+0.6', lastUpd: '29 May 2025', units: 'Index SA',   mean: 95.4,  std: 4.0,  amp: 1.0, phase: 1.0, freq: 0.42, noiseSeed: 55 },
      { name: 'EA20: Consumer Confidence Indicator',      asOfLastMtg: '-15.1',latest: '-14.5',change: '+0.6', lastUpd: '29 May 2025', units: 'Balance SA', mean: -14.5, std: 5.0,  amp: 1.0, phase: 1.1, freq: 0.43, noiseSeed: 16 },
      { name: 'EA20: Retail Trade Confidence Indicator',  asOfLastMtg: '-6.0', latest: '-5.6', change: '+0.4', lastUpd: '29 May 2025', units: 'Balance SA', mean: -5.6,  std: 4.0,  amp: 0.9, phase: 1.3, freq: 0.41, noiseSeed: 17 },
      { name: 'EA20: Service Confidence Indicator',       asOfLastMtg: '5.1',  latest: '5.4',  change: '+0.3', lastUpd: '29 May 2025', units: 'Balance SA', mean: 5.4,   std: 4.0,  amp: 1.0, phase: 0.8, freq: 0.44, noiseSeed: 18 },
      { name: 'EA20: Construction Confidence Indicator',  asOfLastMtg: '-2.6', latest: '-2.9', change: '-0.3', lastUpd: '29 May 2025', units: 'Balance SA', mean: -2.9,  std: 4.0,  amp: 1.1, phase: 1.5, freq: 0.40, noiseSeed: 19 },
      { name: 'EA20: Industry Confidence Indicator',      asOfLastMtg: '-11.0',latest: '-10.5',change: '+0.5', lastUpd: '29 May 2025', units: 'Balance SA', mean: -10.5, std: 4.0,  amp: 1.2, phase: 0.3, freq: 0.46, noiseSeed: 20 },
      { name: 'EA20: Industrial Production (ex. Constr.)',asOfLastMtg: '-0.2%',latest: '-0.4%',change: '-0.2', lastUpd: '14 May 2025', units: '% m/m SA',   mean: -0.4,  std: 0.5,  amp: 1.3, phase: 1.0, freq: 0.52, noiseSeed: 21 },
      { name: 'EA20: Building Permits',                   asOfLastMtg: '-2.7%',latest: '-3.2%',change: '-0.5', lastUpd: '20 May 2025', units: '% y/y',      mean: -3.2,  std: 3.0,  amp: 1.1, phase: 1.8, freq: 0.38, noiseSeed: 22 },
      { name: 'Euro area: EuroCOIN',                      asOfLastMtg: '0.34', latest: '0.43', change: '+0.09',lastUpd: '01 Jun 2025', units: 'Index',      mean: 0.43,  std: 0.25, amp: 1.0, phase: 0.6, freq: 0.44, noiseSeed: 23 },
    ],
  },
  {
    name: 'Labour Market',
    bias: -0.2,
    indicators: [
      { name: 'EA20: Unemployment Rate',               asOfLastMtg: '6.3%',  latest: '6.2%',  change: '-0.1', lastUpd: '30 Apr 2025', units: '% SA',       mean: 6.2,   std: 0.3,  amp: 0.6, phase: 1.5, freq: 0.20, noiseSeed: 70 },
      { name: 'EA20: Employment Growth (QoQ)',          asOfLastMtg: '0.2%',  latest: '0.2%',  change: '—',    lastUpd: '30 Apr 2025', units: '% q/q SA',   mean: 0.2,   std: 0.2,  amp: 0.7, phase: 1.2, freq: 0.22, noiseSeed: 71 },
      { name: 'EA20: Labour Force Participation Rate',  asOfLastMtg: '65.7%', latest: '65.8%', change: '+0.1', lastUpd: '30 Apr 2025', units: '% SA',       mean: 65.8,  std: 0.4,  amp: 0.4, phase: 0.8, freq: 0.18, noiseSeed: 72 },
      { name: 'EA20: Job Vacancy Rate',                 asOfLastMtg: '3.0%',  latest: '2.9%',  change: '-0.1', lastUpd: '15 May 2025', units: '% SA',       mean: 2.9,   std: 0.3,  amp: 0.8, phase: 1.0, freq: 0.28, noiseSeed: 73 },
      { name: 'EA20: Indeed Job Postings (YoY)',        asOfLastMtg: '-3.4%', latest: '-4.2%', change: '-0.8', lastUpd: '01 Jun 2025', units: '% y/y',      mean: -4.2,  std: 3.0,  amp: 1.2, phase: 0.6, freq: 0.38, noiseSeed: 74 },
      { name: 'PMI Manufacturing – Employment',         asOfLastMtg: '46.5',  latest: '46.8',  change: '+0.3', lastUpd: '02 Jun 2025', units: 'Index SA',   mean: 46.8,  std: 2.0,  amp: 1.1, phase: 0.4, freq: 0.44, noiseSeed: 75 },
      { name: 'PMI Services – Employment',              asOfLastMtg: '51.1',  latest: '51.3',  change: '+0.2', lastUpd: '04 Jun 2025', units: 'Index SA',   mean: 51.3,  std: 2.0,  amp: 1.0, phase: 0.7, freq: 0.42, noiseSeed: 76 },
      { name: 'ESI – Employment Expectations',          asOfLastMtg: '98.8',  latest: '99.2',  change: '+0.4', lastUpd: '29 May 2025', units: 'Balance SA', mean: 99.2,  std: 4.0,  amp: 0.9, phase: 0.9, freq: 0.36, noiseSeed: 77 },
    ],
  },
  {
    name: 'Wages',
    bias: 0.8,
    indicators: [
      { name: 'EA20: Negotiated Wages (YoY)',                          asOfLastMtg: '4.7%', latest: '4.7%', change: '—',    lastUpd: '23 May 2025', units: '% y/y',    mean: 4.7, std: 0.5, amp: 0.8, phase: 0.3, freq: 0.22, noiseSeed: 78 },
      { name: 'EA20: Compensation per Employee (YoY)',                 asOfLastMtg: '4.5%', latest: '4.2%', change: '-0.3', lastUpd: '30 Apr 2025', units: '% y/y SA', mean: 4.2, std: 0.5, amp: 0.8, phase: 0.5, freq: 0.21, noiseSeed: 79 },
      { name: 'EA20: Unit Labour Costs (YoY)',                         asOfLastMtg: '4.3%', latest: '3.9%', change: '-0.4', lastUpd: '30 Apr 2025', units: '% y/y SA', mean: 3.9, std: 0.6, amp: 0.9, phase: 0.7, freq: 0.23, noiseSeed: 80 },
      { name: 'EA20: Labour Productivity (YoY)',                       asOfLastMtg: '0.1%', latest: '0.3%', change: '+0.2', lastUpd: '30 Apr 2025', units: '% y/y SA', mean: 0.3, std: 0.4, amp: 0.7, phase: 1.0, freq: 0.20, noiseSeed: 81 },
      { name: 'EA20: Indeed Wage Tracker (YoY)',                       asOfLastMtg: '4.1%', latest: '3.8%', change: '-0.3', lastUpd: '01 Jun 2025', units: '% y/y',    mean: 3.8, std: 0.6, amp: 1.0, phase: 0.4, freq: 0.30, noiseSeed: 82 },
      { name: 'ECB Wage Tracker – Excl. One-Offs (Endpoint)',          asOfLastMtg: '3.2%', latest: '3.2%', change: '—',    lastUpd: '23 May 2025', units: '% y/y',    mean: 3.2, std: 0.4, amp: 0.8, phase: 0.6, freq: 0.22, noiseSeed: 83 },
      { name: 'ECB Wage Tracker – Incl. Smoother One-Offs (Endpoint)', asOfLastMtg: '3.6%', latest: '3.6%', change: '—',    lastUpd: '23 May 2025', units: '% y/y',    mean: 3.6, std: 0.4, amp: 0.8, phase: 0.8, freq: 0.22, noiseSeed: 84 },
    ],
  },
  {
    name: 'Inflation & Inflation Expectations',
    bias: 1.1,
    indicators: [
      { name: 'EA20: Headline HICP',                        asOfLastMtg: '2.3%',  latest: '2.4%',  change: '+0.1', lastUpd: '31 May 2025', units: '% y/y',      mean: 2.4,   std: 0.7,   amp: 1.0, phase: 0.0, freq: 0.28, noiseSeed: 24 },
      { name: 'EA20: Core HICP',                            asOfLastMtg: '2.7%',  latest: '2.9%',  change: '+0.2', lastUpd: '31 May 2025', units: '% y/y',      mean: 2.9,   std: 0.6,   amp: 0.8, phase: 0.3, freq: 0.26, noiseSeed: 25 },
      { name: 'EA20: HICP – Services',                      asOfLastMtg: '3.2%',  latest: '3.5%',  change: '+0.3', lastUpd: '31 May 2025', units: '% y/y',      mean: 3.5,   std: 0.5,   amp: 0.7, phase: 0.5, freq: 0.25, noiseSeed: 26 },
      { name: 'EA20: HICP – Total excl. Energy, Food, A&T', asOfLastMtg: '2.6%', latest: '2.8%',  change: '+0.2', lastUpd: '31 May 2025', units: '% y/y',      mean: 2.8,   std: 0.5,   amp: 0.8, phase: 0.2, freq: 0.27, noiseSeed: 27 },
      { name: 'EA20: HICP – Energy',                        asOfLastMtg: '-2.7%', latest: '-3.5%', change: '-0.8', lastUpd: '31 May 2025', units: '% y/y',      mean: -3.5,  std: 3.0,   amp: 1.5, phase: 0.8, freq: 0.35, noiseSeed: 28 },
      { name: 'EA20: HICP – Food',                          asOfLastMtg: '2.2%',  latest: '2.3%',  change: '+0.1', lastUpd: '31 May 2025', units: '% y/y',      mean: 2.3,   std: 0.8,   amp: 1.1, phase: 1.1, freq: 0.30, noiseSeed: 29 },
      { name: 'EA20: HICP – Non-Energy Industrial Goods',   asOfLastMtg: '0.8%',  latest: '0.7%',  change: '-0.1', lastUpd: '31 May 2025', units: '% y/y',      mean: 0.7,   std: 0.4,   amp: 0.9, phase: 0.6, freq: 0.29, noiseSeed: 30 },
      { name: 'EA20: HICP – Services to Goods',             asOfLastMtg: '2.7x',  latest: '2.8x',  change: '+0.1', lastUpd: '31 May 2025', units: 'Ratio',      mean: 2.8,   std: 0.15,  amp: 0.7, phase: 0.9, freq: 0.24, noiseSeed: 31 },
      { name: 'EA20: HICP – Supercore',                     asOfLastMtg: '2.9%',  latest: '3.1%',  change: '+0.2', lastUpd: '31 May 2025', units: '% y/y',      mean: 3.1,   std: 0.5,   amp: 0.7, phase: 0.7, freq: 0.25, noiseSeed: 56 },
      { name: 'EA20: HICP – Weighted Median',               asOfLastMtg: '2.5%',  latest: '2.6%',  change: '+0.1', lastUpd: '31 May 2025', units: '% y/y',      mean: 2.6,   std: 0.4,   amp: 0.7, phase: 0.4, freq: 0.24, noiseSeed: 32 },
      { name: 'EA20: PPI excl. Energy & Food',              asOfLastMtg: '1.0%',  latest: '1.2%',  change: '+0.2', lastUpd: '22 May 2025', units: '% y/y',      mean: 1.2,   std: 1.2,   amp: 1.1, phase: 0.8, freq: 0.31, noiseSeed: 63 },
      { name: 'PMI Manufacturing – Input Prices',           asOfLastMtg: '52.8',  latest: '53.4',  change: '+0.6', lastUpd: '02 Jun 2025', units: 'Index SA',   mean: 53.4,  std: 3.0,   amp: 1.1, phase: 0.5, freq: 0.36, noiseSeed: 57 },
      { name: 'PMI Manufacturing – Output Prices',          asOfLastMtg: '49.8',  latest: '50.1',  change: '+0.3', lastUpd: '02 Jun 2025', units: 'Index SA',   mean: 50.1,  std: 2.5,   amp: 1.0, phase: 0.7, freq: 0.35, noiseSeed: 58 },
      { name: 'PMI Services – Input Prices',                asOfLastMtg: '56.8',  latest: '57.2',  change: '+0.4', lastUpd: '04 Jun 2025', units: 'Index SA',   mean: 57.2,  std: 2.5,   amp: 1.0, phase: 0.9, freq: 0.34, noiseSeed: 59 },
      { name: 'PMI Services – Output Prices',               asOfLastMtg: '53.6',  latest: '53.8',  change: '+0.2', lastUpd: '04 Jun 2025', units: 'Index SA',   mean: 53.8,  std: 2.5,   amp: 0.9, phase: 1.1, freq: 0.33, noiseSeed: 60 },
      { name: 'ESI – Firm Price Intentions (Mfg)',          asOfLastMtg: '3.7',   latest: '4.2',   change: '+0.5', lastUpd: '29 May 2025', units: 'Balance SA', mean: 4.2,   std: 3.0,   amp: 1.0, phase: 0.6, freq: 0.34, noiseSeed: 61 },
      { name: 'ESI – Firm Price Intentions (Services)',     asOfLastMtg: '11.4',  latest: '11.7',  change: '+0.3', lastUpd: '29 May 2025', units: 'Balance SA', mean: 11.7,  std: 3.0,   amp: 0.9, phase: 0.8, freq: 0.32, noiseSeed: 62 },
      { name: 'CES – 1y Inflation Expectations',            asOfLastMtg: '2.9%',  latest: '2.8%',  change: '-0.1', lastUpd: '31 May 2025', units: '%',          mean: 2.8,   std: 0.3,   amp: 0.8, phase: 0.5, freq: 0.28, noiseSeed: 64 },
      { name: 'CES – 3y Inflation Expectations',            asOfLastMtg: '2.5%',  latest: '2.5%',  change: '—',    lastUpd: '31 May 2025', units: '%',          mean: 2.5,   std: 0.2,   amp: 0.6, phase: 0.7, freq: 0.25, noiseSeed: 65 },
      { name: 'SPF – Long-Term Inflation Expectations',     asOfLastMtg: '2.0%',  latest: '2.0%',  change: '—',    lastUpd: '15 May 2025', units: '%',          mean: 2.0,   std: 0.1,   amp: 0.4, phase: 0.3, freq: 0.20, noiseSeed: 66 },
      { name: '1y/1y EUR Inflation Swap',                   asOfLastMtg: '2.14%', latest: '2.1%',  change: '-0.04',lastUpd: '01 Jun 2025', units: '%',          mean: 2.1,   std: 0.15,  amp: 0.9, phase: 0.9, freq: 0.32, noiseSeed: 67 },
      { name: '2y/1y EUR Inflation Swap',                   asOfLastMtg: '2.24%', latest: '2.2%',  change: '-0.04',lastUpd: '01 Jun 2025', units: '%',          mean: 2.2,   std: 0.15,  amp: 0.8, phase: 1.1, freq: 0.30, noiseSeed: 68 },
      { name: '5y/5y EUR Inflation Swap',                   asOfLastMtg: '2.39%', latest: '2.4%',  change: '+0.01',lastUpd: '01 Jun 2025', units: '%',          mean: 2.4,   std: 0.12,  amp: 0.7, phase: 1.3, freq: 0.27, noiseSeed: 69 },
    ],
  },
  {
    name: 'Financial Conditions',
    bias: 0.3,
    indicators: [
      { name: 'Bloomberg Euro Area FCI',               asOfLastMtg: '0.42',   latest: '0.38',   change: '-0.04', lastUpd: '01 Jun 2025', units: 'Index',    mean: 0.38,  std: 0.30, amp: 1.0, phase: 0.5, freq: 0.44, noiseSeed: 85 },
      { name: 'Goldman Sachs Euro Area FCI',           asOfLastMtg: '99.6',   latest: '99.4',   change: '-0.2',  lastUpd: '01 Jun 2025', units: 'Index',    mean: 99.4,  std: 0.40, amp: 1.0, phase: 0.7, freq: 0.42, noiseSeed: 86 },
      { name: 'EUR/USD',                               asOfLastMtg: '1.06',   latest: '1.04',   change: '-0.02', lastUpd: '01 Jun 2025', units: 'FX Rate',  mean: 1.04,  std: 0.04, amp: 1.0, phase: 1.2, freq: 0.45, noiseSeed: 33 },
      { name: 'DB EUR Trade Weighted Index',           asOfLastMtg: '118.9',  latest: '119.3',  change: '+0.4',  lastUpd: '01 Jun 2025', units: 'Index',    mean: 119.3,  std: 3.0,  amp: 0.9, phase: 0.8, freq: 0.43, noiseSeed: 34 },
      { name: 'Brent in EUR',                          asOfLastMtg: '254',    latest: '251',    change: '-3',    lastUpd: '01 Jun 2025', units: 'EUR/bbl',  mean: 251.0,  std: 15.0, amp: 1.3, phase: 1.5, freq: 0.50, noiseSeed: 35 },
      { name: 'iTraxx Europe',                         asOfLastMtg: '55',     latest: '54',     change: '-1',    lastUpd: '01 Jun 2025', units: 'bps',      mean: 54.0,   std: 12.0, amp: 1.2, phase: 0.4, freq: 0.48, noiseSeed: 36 },
      { name: '10y BTP / 10y Bund Spread',             asOfLastMtg: '114.4', latest: '112.3',  change: '-2.1',  lastUpd: '01 Jun 2025', units: 'bps',      mean: 112.3,  std: 18.0, amp: 1.1, phase: 0.6, freq: 0.46, noiseSeed: 37 },
      { name: '10y BTP / 10y Spain Spread',            asOfLastMtg: '50.0',   latest: '49.2',   change: '-0.8',  lastUpd: '01 Jun 2025', units: 'bps',      mean: 49.2,   std: 10.0, amp: 1.0, phase: 0.9, freq: 0.44, noiseSeed: 38 },
      { name: 'iTraxx Crossover (not roll adj.)',       asOfLastMtg: '294',    latest: '289',    change: '-5',    lastUpd: '01 Jun 2025', units: 'bps',      mean: 289.0,  std: 30.0, amp: 1.2, phase: 1.1, freq: 0.47, noiseSeed: 39 },
      { name: '5y Bund Yield',                          asOfLastMtg: '2.18%',  latest: '2.14%',  change: '-0.04', lastUpd: '01 Jun 2025', units: '%',        mean: 2.14,    std: 0.30, amp: 1.0, phase: 0.3, freq: 0.42, noiseSeed: 40 },
      { name: '10y Bund Yield',                         asOfLastMtg: '2.58%',  latest: '2.54%',  change: '-0.04', lastUpd: '01 Jun 2025', units: '%',        mean: 2.54,    std: 0.30, amp: 1.0, phase: 0.5, freq: 0.43, noiseSeed: 41 },
      { name: '30y Bund Yield',                         asOfLastMtg: '2.82%',  latest: '2.79%',  change: '-0.03', lastUpd: '01 Jun 2025', units: '%',        mean: 2.79,    std: 0.28, amp: 1.0, phase: 0.7, freq: 0.44, noiseSeed: 42 },
      { name: '2/10 Bund Curve',                        asOfLastMtg: '38',     latest: '40',     change: '+2',    lastUpd: '01 Jun 2025', units: 'bps',      mean: 40.0,    std: 15.0, amp: 0.9, phase: 1.4, freq: 0.40, noiseSeed: 43 },
      { name: '5/30 Bund Curve',                        asOfLastMtg: '48',     latest: '49',     change: '+1',    lastUpd: '01 Jun 2025', units: 'bps',      mean: 49.0,    std: 12.0, amp: 0.8, phase: 1.6, freq: 0.38, noiseSeed: 44 },
      { name: '10/30 Bund Curve',                       asOfLastMtg: '23',     latest: '25',     change: '+2',    lastUpd: '01 Jun 2025', units: 'bps',      mean: 25.0,    std: 10.0, amp: 0.8, phase: 1.8, freq: 0.37, noiseSeed: 45 },
      { name: '2y German Real Yield (DBRei)',            asOfLastMtg: '0.32%',  latest: '0.30%',  change: '-0.02', lastUpd: '01 Jun 2025', units: '%',        mean: 0.30,    std: 0.20, amp: 0.9, phase: 0.2, freq: 0.41, noiseSeed: 46 },
      { name: '10y German Real Yield (DBRei)',           asOfLastMtg: '0.52%',  latest: '0.49%',  change: '-0.03', lastUpd: '01 Jun 2025', units: '%',        mean: 0.49,    std: 0.20, amp: 0.9, phase: 0.4, freq: 0.42, noiseSeed: 47 },
      { name: 'EuroStoxx 50',                           asOfLastMtg: '5,180',  latest: '5,320',  change: '+140',  lastUpd: '01 Jun 2025', units: 'Index',    mean: 5320.0,  std: 250.0, amp: 1.1, phase: 1.0, freq: 0.46, noiseSeed: 48 },
    ],
  },
  {
    name: 'Front End Rates',
    bias: 0.5,
    indicators: [
      { name: '3m Euribor',  asOfLastMtg: '2.45%', latest: '2.4%',  change: '-0.05', lastUpd: '01 Jun 2025', units: '%', mean: 2.40, std: 0.30, amp: 0.9, phase: 0.3, freq: 0.30, noiseSeed: 49 },
      { name: '2y Bund',     asOfLastMtg: '2.03%', latest: '2.0%',  change: '-0.03', lastUpd: '01 Jun 2025', units: '%', mean: 2.00, std: 0.30, amp: 1.0, phase: 0.5, freq: 0.32, noiseSeed: 50 },
      { name: '2y BTP',      asOfLastMtg: '2.34%', latest: '2.3%',  change: '-0.04', lastUpd: '01 Jun 2025', units: '%', mean: 2.30, std: 0.30, amp: 1.0, phase: 0.7, freq: 0.33, noiseSeed: 51 },
      { name: '1y/1y ESTR',  asOfLastMtg: '2.06%', latest: '2.0%',  change: '-0.06', lastUpd: '01 Jun 2025', units: '%', mean: 2.00, std: 0.28, amp: 1.1, phase: 0.2, freq: 0.31, noiseSeed: 52 },
      { name: '2y/2y ESTR',  asOfLastMtg: '2.24%', latest: '2.2%',  change: '-0.04', lastUpd: '01 Jun 2025', units: '%', mean: 2.20, std: 0.25, amp: 1.0, phase: 0.4, freq: 0.30, noiseSeed: 53 },
      { name: '5y/5y ESTR',  asOfLastMtg: '2.52%', latest: '2.5%',  change: '-0.02', lastUpd: '01 Jun 2025', units: '%', mean: 2.50, std: 0.20, amp: 0.8, phase: 0.6, freq: 0.28, noiseSeed: 54 },
    ],
  },
]

// Build the full groups with generated z-scores
const GROUPS: Group[] = GROUPS_META.map((g, gi) =>
  ({
    name: g.name,
    indicators: g.indicators.map((ind, ii) => ({
      name: ind.name,
      asOfLastMtg: ind.asOfLastMtg,
      latest: ind.latest,
      change: ind.change,
      lastUpd: ind.lastUpd,
      units: ind.units,
      mean: ind.mean,
      std: ind.std,
      zscores: generateZscores(gi * 10 + ii, g.bias, ind.amp, ind.phase, ind.freq, ind.noiseSeed),
    })),
  })
)

// ─── Bund Yield Data ──────────────────────────────────────────────────────────
// Synthetic Bund yields (%) over MONTH_COLS (Jun '23 – Jun '25).
// Approximate real-world dynamics:
//   - ECB hiking cycle: last hike Sep '23 (DFR 4.00%)
//   - Dec '23 sharp bull rally (10y: 2.98% → 2.05%)
//   - Apr '24 selloff (10y back to 2.65%)
//   - ECB first cut Jun '24, subsequent cuts through H2 '24 / H1 '25
//   - Feb '25 German fiscal bazooka: sharp bear steepening (+30–40bps across curve)
//   - Jun '25: curve positively sloped, 10y ~2.63%
// Replace these arrays with live Haver/Bloomberg pulls when the data pipeline is ready.

export const YIELD_TENORS = ['2y', '3y', '5y', '7y', '10y', '15y', '20y', '30y'] as const
export type Tenor = typeof YIELD_TENORS[number]

export const SYNTHETIC_YIELDS: Record<Tenor, number[]> = {
  //          Jun'23 Jul'23 Aug'23 Sep'23 Oct'23 Nov'23 Dec'23 Jan'24 Feb'24 Mar'24 Apr'24 May'24 Jun'24 Jul'24 Aug'24 Sep'24 Oct'24 Nov'24 Dec'24 Jan'25 Feb'25 Mar'25 Apr'25 May'25 Jun'25
  '2y':  [3.10, 3.15, 3.20, 3.30, 3.25, 2.90, 2.40, 2.55, 2.80, 2.82, 3.00, 2.95, 2.88, 2.62, 2.30, 2.20, 2.28, 2.12, 2.10, 2.25, 2.42, 2.28, 2.10, 2.05, 2.00],
  '3y':  [2.90, 2.95, 3.02, 3.12, 3.08, 2.72, 2.25, 2.40, 2.65, 2.68, 2.85, 2.80, 2.73, 2.48, 2.18, 2.08, 2.18, 2.10, 2.12, 2.28, 2.48, 2.34, 2.18, 2.14, 2.10],
  '5y':  [2.62, 2.68, 2.78, 2.90, 2.88, 2.52, 2.10, 2.28, 2.50, 2.52, 2.72, 2.68, 2.60, 2.38, 2.12, 2.05, 2.20, 2.15, 2.20, 2.38, 2.62, 2.48, 2.34, 2.30, 2.28],
  '7y':  [2.52, 2.58, 2.68, 2.82, 2.82, 2.48, 2.08, 2.28, 2.48, 2.50, 2.72, 2.68, 2.60, 2.40, 2.15, 2.10, 2.28, 2.25, 2.30, 2.50, 2.72, 2.58, 2.45, 2.42, 2.40],
  '10y': [2.40, 2.48, 2.62, 2.85, 2.98, 2.65, 2.05, 2.28, 2.45, 2.42, 2.65, 2.58, 2.50, 2.38, 2.20, 2.15, 2.30, 2.38, 2.37, 2.52, 2.82, 2.72, 2.55, 2.62, 2.63],
  '15y': [2.42, 2.50, 2.65, 2.90, 3.02, 2.70, 2.10, 2.32, 2.50, 2.48, 2.72, 2.64, 2.56, 2.45, 2.28, 2.22, 2.38, 2.48, 2.48, 2.62, 2.92, 2.80, 2.65, 2.72, 2.72],
  '20y': [2.48, 2.56, 2.70, 2.95, 3.05, 2.74, 2.15, 2.38, 2.55, 2.52, 2.76, 2.68, 2.60, 2.50, 2.34, 2.28, 2.44, 2.55, 2.55, 2.70, 2.98, 2.86, 2.72, 2.80, 2.80],
  '30y': [2.55, 2.62, 2.76, 3.00, 3.10, 2.80, 2.22, 2.45, 2.62, 2.58, 2.82, 2.74, 2.65, 2.56, 2.42, 2.36, 2.52, 2.62, 2.62, 2.78, 3.05, 2.92, 2.80, 2.88, 2.88],
}

// ─── Yield PCA ────────────────────────────────────────────────────────────────
// Jacobi eigenvalue algorithm for real symmetric matrices.
// Iteratively zeros off-diagonal elements via Givens rotations.
// Converges to machine precision in < 100 sweeps for an 8×8 matrix.

function jacobiEigen(mat: number[][]): { values: number[]; vectors: number[][] } {
  const n = mat.length
  const a = mat.map(row => [...row])
  // v[:,k] = k-th eigenvector; initialise as identity
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  )
  for (let iter = 0; iter < 500; iter++) {
    // Find largest off-diagonal element
    let maxVal = 0, p = 0, q = 1
    for (let i = 0; i < n - 1; i++)
      for (let j = i + 1; j < n; j++)
        if (Math.abs(a[i][j]) > maxVal) { maxVal = Math.abs(a[i][j]); p = i; q = j }
    if (maxVal < 1e-12) break
    // Jacobi rotation angle
    const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(1 + theta * theta))
    const c = 1 / Math.sqrt(1 + t * t)
    const s = t * c
    // Update symmetric matrix
    const app = a[p][p], aqq = a[q][q], apq = a[p][q]
    a[p][p] = app - t * apq
    a[q][q] = aqq + t * apq
    a[p][q] = 0; a[q][p] = 0
    for (let i = 0; i < n; i++) {
      if (i !== p && i !== q) {
        const aip = a[i][p], aiq = a[i][q]
        a[i][p] = a[p][i] = c * aip - s * aiq
        a[i][q] = a[q][i] = s * aip + c * aiq
      }
    }
    // Accumulate eigenvectors
    for (let i = 0; i < n; i++) {
      const vip = v[i][p], viq = v[i][q]
      v[i][p] = c * vip - s * viq
      v[i][q] = s * vip + c * viq
    }
  }
  // Collect eigenpairs and sort descending by eigenvalue
  const pairs = Array.from({ length: n }, (_, k) => ({
    val: a[k][k],
    vec: Array.from({ length: n }, (_, r) => v[r][k]),
  })).sort((x, y) => y.val - x.val)
  return { values: pairs.map(p => p.val), vectors: pairs.map(p => p.vec) }
}

export interface YieldPCAResult {
  /** PC time series: [N_MONTHS][3] */
  scores: number[][]
  /** Factor loadings: [3][N_TENORS] — how each tenor contributes to each PC */
  loadings: number[][]
  /** Fraction of total variance explained by each PC */
  explainedVar: number[]
  /** Per-tenor sample means used for demeaning — needed for inversion */
  means: number[]
}

function computeYieldPCA(): YieldPCAResult {
  const N = N_MONTHS
  const M = YIELD_TENORS.length // 8

  // Build [N × M] data matrix
  const data: number[][] = Array.from({ length: N }, (_, t) =>
    YIELD_TENORS.map(tenor => SYNTHETIC_YIELDS[tenor][t])
  )

  // Demean each column (tenor)
  const means = Array.from({ length: M }, (_, j) =>
    data.reduce((s, row) => s + row[j], 0) / N
  )
  const centered = data.map(row => row.map((v, j) => v - means[j]))

  // Sample covariance matrix [M × M]
  const cov: number[][] = Array.from({ length: M }, (_, i) =>
    Array.from({ length: M }, (_, j) =>
      centered.reduce((s, row) => s + row[i] * row[j], 0) / (N - 1)
    )
  )

  const { values, vectors } = jacobiEigen(cov)
  const totalVar = values.reduce((s, v) => s + Math.abs(v), 0)

  // Top 3 PCs
  const rawLoadings = vectors.slice(0, 3) // [3][M]

  // Sign conventions for economic interpretability:
  //   PC1 (Level):     all tenors move together → force 10y loading positive
  //   PC2 (Slope):     long yields > short yields → force 30y loading positive
  //   PC3 (Curvature): belly moves opposite ends → force 7y (belly) loading positive
  const pivots = [
    rawLoadings[0][4], // 10y index=4
    rawLoadings[1][7], // 30y index=7
    rawLoadings[2][3], // 7y  index=3
  ]
  const loadings = rawLoadings.map((l, k) => {
    const sign = pivots[k] < 0 ? -1 : 1
    return l.map(v => v * sign)
  })

  // Project centered data → scores [N × 3]
  const scores = centered.map(row =>
    loadings.map(loading => loading.reduce((s, l, j) => s + l * row[j], 0))
  )

  return {
    scores,
    loadings,
    explainedVar: values.slice(0, 3).map(v => v / totalVar),
    means,
  }
}

export const YIELD_PCA: YieldPCAResult = computeYieldPCA()

// ─── Color helpers ────────────────────────────────────────────────────────────

function formatCellValue(value: number, units: string): string {
  if (units === 'FX Rate') return value.toFixed(2)
  if (units === 'EUR/bbl') return value.toFixed(0)
  if (units === 'bps') return value.toFixed(0)
  if (units === 'Ratio') return value.toFixed(2)
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

// ─── Legend ───────────────────────────────────────────────────────────────────

const LEGEND_STEPS: { bg: string; fg: string; label: string }[] = [
  { bg: '#7F1D1D', fg: '#ffffff', label: '≥ +2σ' },
  { bg: '#DC2626', fg: '#ffffff', label: '+1σ' },
  { bg: '#FCA5A5', fg: '#0f172a', label: '+0.5σ' },
  { bg: '#F1F5F9', fg: '#0f172a', label: '0' },
  { bg: '#93C5FD', fg: '#0f172a', label: '−0.5σ' },
  { bg: '#2563EB', fg: '#ffffff', label: '−1σ' },
  { bg: '#1E3A5F', fg: '#ffffff', label: '≤ −2σ' },
]

function Legend() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
    }}>
      <span style={{ color: '#475569', fontSize: 11, marginRight: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Z-score scale
      </span>
      {LEGEND_STEPS.map((s) => (
        <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{
            width: 36,
            height: 20,
            background: s.bg,
            borderRadius: 3,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <span style={{ color: s.fg, fontSize: 9, fontFamily: 'monospace', fontWeight: 600 }}>{s.label}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Heatmap Table ────────────────────────────────────────────────────────────

const CELL_W = 52
const CELL_H = 28
const INDICATOR_W_DEFAULT = 190
const RIGHT_COL_W = 76
const UNITS_COL_W = 88

const stickyBg = '#080d1a'

function HeatmapTable() {
  const [indicatorW, setIndicatorW] = useState(INDICATOR_W_DEFAULT)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: indicatorW }

    function onMouseMove(ev: MouseEvent) {
      if (!dragRef.current) return
      const delta = ev.clientX - dragRef.current.startX
      setIndicatorW(Math.max(120, dragRef.current.startW + delta))
    }
    function onMouseUp() {
      dragRef.current = null
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [indicatorW])

  const cellStyle = (z: number): React.CSSProperties => {
    const { bg, fg } = zscoreToColors(z)
    return {
      width: CELL_W,
      minWidth: CELL_W,
      maxWidth: CELL_W,
      height: CELL_H,
      textAlign: 'center',
      fontFamily: 'monospace',
      fontSize: 10,
      fontWeight: 500,
      color: fg,
      background: bg,
      padding: 0,
      border: '1px solid rgba(8,13,26,0.5)',
      userSelect: 'none',
    }
  }

  const headerCellStyle: React.CSSProperties = {
    width: CELL_W,
    minWidth: CELL_W,
    maxWidth: CELL_W,
    textAlign: 'center',
    color: '#64748b',
    fontSize: 10,
    fontFamily: 'monospace',
    padding: '5px 2px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    background: stickyBg,
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    position: 'sticky',
    top: 0,
    zIndex: 2,
  }

  const indicatorHeaderStyle: React.CSSProperties = {
    width: indicatorW,
    minWidth: indicatorW,
    maxWidth: indicatorW,
    textAlign: 'left',
    color: '#64748b',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    padding: '5px 12px',
    fontWeight: 600,
    background: stickyBg,
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    position: 'sticky',
    top: 0,
    left: 0,
    zIndex: 4,
    overflow: 'visible',
  }

  const rightHeaderStyle = (_label: string, rightOffset: number): React.CSSProperties => ({
    width: RIGHT_COL_W,
    minWidth: RIGHT_COL_W,
    maxWidth: RIGHT_COL_W,
    textAlign: 'center',
    color: '#64748b',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    padding: '5px 4px',
    fontWeight: 600,
    background: stickyBg,
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    position: 'sticky',
    top: 0,
    right: rightOffset,
    zIndex: 4,
    whiteSpace: 'nowrap',
  })

  const indicatorCellStyle: React.CSSProperties = {
    width: indicatorW,
    minWidth: indicatorW,
    maxWidth: indicatorW,
    color: '#cbd5e1',
    fontSize: 11,
    padding: '0 12px',
    height: CELL_H,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    position: 'sticky',
    left: 0,
    background: stickyBg,
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    borderRight: '1px solid rgba(255,255,255,0.07)',
    zIndex: 1,
  }

  const groupRowStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.025)',
    color: '#475569',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 700,
    padding: '4px 12px',
    height: 22,
    position: 'sticky',
    left: 0,
    zIndex: 1,
  }

  const rightCellBase: React.CSSProperties = {
    width: RIGHT_COL_W,
    minWidth: RIGHT_COL_W,
    maxWidth: RIGHT_COL_W,
    textAlign: 'center',
    fontSize: 10,
    fontFamily: 'monospace',
    padding: 0,
    height: CELL_H,
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    borderLeft: '1px solid rgba(255,255,255,0.06)',
    background: stickyBg,
  }

  // Right-side sticky offsets (rightmost = 0): Change | Latest | As of Last MTG | Units | Last Upd
  const R_CHANGE     = 0
  const R_LATEST     = RIGHT_COL_W
  const R_AS_OF_MTG  = RIGHT_COL_W * 2
  const R_UNITS      = RIGHT_COL_W * 2 + UNITS_COL_W
  const R_LASTUPD    = RIGHT_COL_W * 3 + UNITS_COL_W

  const unitsHeaderStyle = (rightOffset: number): React.CSSProperties => ({
    width: UNITS_COL_W,
    minWidth: UNITS_COL_W,
    maxWidth: UNITS_COL_W,
    textAlign: 'center',
    color: '#64748b',
    fontSize: 10,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    padding: '5px 4px',
    fontWeight: 600,
    background: stickyBg,
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    position: 'sticky' as const,
    top: 0,
    right: rightOffset,
    zIndex: 4,
    whiteSpace: 'nowrap' as const,
  })

  return (
    <div style={{ overflowX: 'auto', overflowY: 'visible' }}>
      <table style={{
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
        minWidth: indicatorW + CELL_W * N_MONTHS + RIGHT_COL_W * 4 + UNITS_COL_W,
      }}>
        <colgroup>
          <col style={{ width: indicatorW }} />
          {MONTH_COLS.map((_, i) => <col key={i} style={{ width: CELL_W }} />)}
          <col style={{ width: RIGHT_COL_W }} />  {/* Last Upd */}
          <col style={{ width: UNITS_COL_W }} />  {/* Units */}
          <col style={{ width: RIGHT_COL_W }} />  {/* As of Last MTG */}
          <col style={{ width: RIGHT_COL_W }} />  {/* Latest */}
          <col style={{ width: RIGHT_COL_W }} />  {/* Change */}
        </colgroup>

        <thead>
          <tr>
            <th style={indicatorHeaderStyle}>
              Indicator
              <div
                onMouseDown={onResizeMouseDown}
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  width: 6,
                  height: '100%',
                  cursor: 'col-resize',
                  userSelect: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div style={{ width: 2, height: 14, borderRadius: 1, background: 'rgba(255,255,255,0.18)' }} />
              </div>
            </th>
            {MONTH_COLS.map((m, i) => (
              <th key={i} style={headerCellStyle}>{m}</th>
            ))}
            <th style={{ ...rightHeaderStyle('Last Upd', R_LASTUPD),   borderLeft: '1px solid rgba(255,255,255,0.07)' }}>Last Upd</th>
            <th style={{ ...unitsHeaderStyle(R_UNITS),                  borderLeft: '1px solid rgba(255,255,255,0.04)' }}>Units</th>
            <th style={{ ...rightHeaderStyle('As of MTG', R_AS_OF_MTG), borderLeft: '1px solid rgba(255,255,255,0.04)' }}>As of Last MTG</th>
            <th style={{ ...rightHeaderStyle('Latest', R_LATEST),       borderLeft: '1px solid rgba(255,255,255,0.04)' }}>Latest</th>
            <th style={{ ...rightHeaderStyle('Change', R_CHANGE),       borderLeft: '1px solid rgba(255,255,255,0.04)' }}>Change</th>
          </tr>
        </thead>

        <tbody>
          {GROUPS.map((group) => (
            <React.Fragment key={group.name}>
              <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
                <td colSpan={N_MONTHS + 6} style={groupRowStyle}>
                  {group.name}
                </td>
              </tr>

              {group.indicators.map((ind) => (
                <tr
                  key={ind.name}
                  onMouseEnter={(e) => {
                    const tds = e.currentTarget.querySelectorAll('td')
                    tds.forEach((td) => {
                      if ((td as HTMLElement).dataset.heatcell !== '1') {
                        ;(td as HTMLElement).style.background = 'rgba(255,255,255,0.04)'
                      }
                    })
                  }}
                  onMouseLeave={(e) => {
                    const tds = e.currentTarget.querySelectorAll('td')
                    tds.forEach((td) => {
                      if ((td as HTMLElement).dataset.heatcell !== '1') {
                        ;(td as HTMLElement).style.background = stickyBg
                      }
                    })
                  }}
                >
                  <td style={indicatorCellStyle}>{ind.name}</td>

                  {ind.zscores.map((z, ci) => (
                    <td key={ci} style={cellStyle(z)} data-heatcell="1">
                      {formatCellValue(ind.mean + z * ind.std, ind.units)}
                    </td>
                  ))}

                  <td style={{
                    ...rightCellBase,
                    position: 'sticky',
                    right: R_LASTUPD,
                    zIndex: 1,
                    color: '#64748b',
                    fontSize: 9,
                  }}>
                    {ind.lastUpd}
                  </td>

                  <td style={{
                    width: UNITS_COL_W, minWidth: UNITS_COL_W, maxWidth: UNITS_COL_W,
                    textAlign: 'center',
                    fontSize: 9,
                    fontFamily: 'monospace',
                    padding: 0,
                    height: CELL_H,
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    borderLeft: '1px solid rgba(255,255,255,0.06)',
                    background: stickyBg,
                    position: 'sticky',
                    right: R_UNITS,
                    zIndex: 1,
                    color: '#475569',
                    whiteSpace: 'nowrap',
                  }}>
                    {ind.units}
                  </td>

                  <td style={{
                    ...rightCellBase,
                    position: 'sticky',
                    right: R_AS_OF_MTG,
                    zIndex: 1,
                    color: '#94a3b8',
                  }}>
                    {ind.asOfLastMtg}
                  </td>

                  <td style={{
                    ...rightCellBase,
                    position: 'sticky',
                    right: R_LATEST,
                    zIndex: 1,
                    color: '#e2e8f0',
                    fontWeight: 600,
                  }}>
                    {ind.latest}
                  </td>

                  <td style={{
                    ...rightCellBase,
                    position: 'sticky',
                    right: R_CHANGE,
                    zIndex: 1,
                    fontWeight: 600,
                    color: ind.change === '—' ? '#334155'
                         : ind.change.startsWith('+') ? '#34d399'
                         : '#f87171',
                  }}>
                    {ind.change}
                  </td>
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

// Group indices in GROUPS array:
//  0 = Real Activity
//  1 = Business Activity
//  2 = Labour Market
//  3 = Wages
//  4 = Inflation & Inflation Expectations
//  5 = Financial Conditions
//  6 = Front End Rates

const DFM_FACTORS: {
  key: string
  label: string
  color: string
  groupIndices: number[]
}[] = [
  { key: 'broadMacro', label: 'Broad Macro', color: '#94a3b8', groupIndices: [0, 1, 2, 3, 4] },
  { key: 'inflation',  label: 'Inflation',   color: '#f87171', groupIndices: [4] },
  { key: 'growth',     label: 'Growth',      color: '#34d399', groupIndices: [0, 1] },
  { key: 'employment', label: 'Employment',  color: '#60a5fa', groupIndices: [2] },
  { key: 'wages',      label: 'Wages',       color: '#a78bfa', groupIndices: [3] },
]

function computeFactor(groupIndices: number[]): number[] {
  const allZscores: number[][] = []
  groupIndices.forEach((gi) => {
    GROUPS[gi].indicators.forEach((ind) => {
      allZscores.push(ind.zscores)
    })
  })
  return Array.from({ length: N_MONTHS }, (_, t) => {
    const vals = allZscores.map((zs) => zs[t])
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length
    return Math.round(avg * 100) / 100
  })
}

// Pre-compute factor series (stable — derived from constant GROUPS)
const FACTOR_SERIES: Record<string, number[]> = Object.fromEntries(
  DFM_FACTORS.map((f) => [f.key, computeFactor(f.groupIndices)])
)

// Chart data: one object per month
const DFM_CHART_DATA = MONTH_COLS.map((month, t) => {
  const obj: Record<string, string | number> = { month }
  DFM_FACTORS.forEach((f) => { obj[f.key] = FACTOR_SERIES[f.key][t] })
  return obj
})

// Pre-compute per-factor stats for the summary table
interface FactorStats {
  current: number
  d1m: number
  d3m: number
  d12m: number
  zscore: number   // (current - mean) / std over the full series
}

const FACTOR_STATS: Record<string, FactorStats> = Object.fromEntries(
  DFM_FACTORS.map(f => {
    const s = FACTOR_SERIES[f.key]
    const current = s[N_MONTHS - 1]
    const mean = s.reduce((a, b) => a + b, 0) / s.length
    const std = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length)
    return [f.key, {
      current,
      d1m:   current - s[N_MONTHS - 2],
      d3m:   current - s[N_MONTHS - 4],
      d12m:  current - s[N_MONTHS - 13],
      zscore: std > 0 ? (current - mean) / std : 0,
    }]
  })
)

function DFMSection() {
  return (
    <div style={cardStyle}>
      {/* Card header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>
          Macro Factors — DFM Synthesis
        </h2>
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>
          4 factors extracted via Dynamic Factor Model &middot; weekly monitoring of macro fundamentals
        </p>
      </div>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {/* Line chart */}
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart
              data={DFM_CHART_DATA}
              margin={{ top: 8, right: 12, bottom: 0, left: -8 }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
              <XAxis
                dataKey="month"
                tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                interval={3}
              />
              <YAxis
                domain={[-2.5, 2.5]}
                tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
                tickCount={6}
              />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
              <Tooltip
                contentStyle={{
                  background: '#0f172a',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 8,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: '#e2e8f0',
                }}
                labelStyle={{ color: '#64748b', marginBottom: 4 }}
                formatter={(value: number, name: string) => {
                  const factor = DFM_FACTORS.find((f) => f.key === name)
                  return [value.toFixed(2) + 'σ', factor?.label ?? name]
                }}
              />
              {DFM_FACTORS.map((f) => (
                <Line
                  key={f.key}
                  type="monotone"
                  dataKey={f.key}
                  stroke={f.color}
                  strokeWidth={1.8}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>

          {/* Custom legend */}
          <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 8 }}>
            {DFM_FACTORS.map((f) => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 24, height: 2, borderRadius: 1, background: f.color,
                }} />
                <span style={{ color: '#94a3b8', fontSize: 11 }}>{f.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right panel: summary table + notes */}
        <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Summary table */}
          <div>
            <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>
              Factor summary
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr>
                  {['Factor', 'Level (σ)', 'Δ1m', 'Δ3m', 'Δ12m', 'Z-score'].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i === 0 ? 'left' : 'right',
                      color: '#475569', fontWeight: 600, fontSize: 10,
                      padding: '4px 6px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)',
                      whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DFM_FACTORS.map((f) => {
                  const st = FACTOR_STATS[f.key]
                  const levelColor = st.current > 0.3 ? '#f87171' : st.current < -0.3 ? '#60a5fa' : '#94a3b8'
                  const deltaColor = (d: number) => d > 0.05 ? '#f87171' : d < -0.05 ? '#60a5fa' : '#475569'
                  const zColor = st.zscore > 0.5 ? '#f87171' : st.zscore < -0.5 ? '#60a5fa' : '#94a3b8'
                  const fmt  = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2)
                  return (
                    <tr key={f.key}>
                      <td style={{ padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, flexShrink: 0 }} />
                          <span style={{ color: '#cbd5e1', fontSize: 11, whiteSpace: 'nowrap' }}>{f.label}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: levelColor, fontWeight: 700 }}>
                        {fmt(st.current)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: deltaColor(st.d1m) }}>
                        {fmt(st.d1m)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: deltaColor(st.d3m) }}>
                        {fmt(st.d3m)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: deltaColor(st.d12m) }}>
                        {fmt(st.d12m)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: zColor, fontWeight: 600 }}>
                        {fmt(st.zscore)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p style={{ color: '#334155', fontSize: 9, margin: '8px 0 0', fontStyle: 'italic' }}>
              Level: avg z-score across block indicators &middot; Δ = change in level &middot; Z-score: level standardised over the sample window
            </p>
          </div>

          {/* DFM notes */}
          <div style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 8,
            padding: '12px 14px',
          }}>
            <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>
              Methodology
            </p>
            {[
              'Broad Macro: average z-score across all activity, inflation, labour & wage series',
              'Growth: Real Activity & Business Activity blocks (~24 indicators)',
              'Inflation: Inflation & Expectations block (~23 indicators)',
              'Employment: Labour Market block (~8 indicators)',
              'Wages: Wages block (~7 indicators)',
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

// ─── OLS Regression ───────────────────────────────────────────────────────────

function matTranspose(A: number[][]): number[][] {
  return A[0].map((_, j) => A.map(row => row[j]))
}

function matMul(A: number[][], B: number[][]): number[][] {
  const rows = A.length, cols = B[0].length, inner = B.length
  return Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) =>
      Array.from({ length: inner }, (_, k) => A[i][k] * B[k][j]).reduce((a, b) => a + b, 0)
    )
  )
}

function matVecMul(A: number[][], v: number[]): number[] {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0))
}

/** Gauss-Jordan inversion for small square matrices */
function matInv(A: number[][]): number[][] {
  const n = A.length
  const aug = A.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ])
  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col
    for (let r = col + 1; r < n; r++)
      if (Math.abs(aug[r][col]) > Math.abs(aug[maxRow][col])) maxRow = r;
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]]
    const pivot = aug[col][col]
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = aug[r][col]
      for (let j = 0; j < 2 * n; j++) aug[r][j] -= factor * aug[col][j]
    }
  }
  return aug.map(row => row.slice(n))
}

interface OLSResult {
  /** Coefficients [intercept, β1, β2, …] */
  coefficients: number[]
  tStats: number[]
  rSquared: number
  adjRSquared: number
  fitted: number[]
  residuals: number[]
}

/** OLS without intercept. X is [N × K]. */
function ols(y: number[], X: number[][]): OLSResult {
  const N = y.length
  const K = X[0].length
  const Xt = matTranspose(X)
  const XtX = matMul(Xt, X)
  const Xty = matVecMul(Xt, y)
  const XtXinv = matInv(XtX)
  const beta = matVecMul(XtXinv, Xty)
  const fitted = X.map(row => row.reduce((s, x, j) => s + x * beta[j], 0))
  const residuals = y.map((yi, i) => yi - fitted[i])
  const yMean = y.reduce((s, v) => s + v, 0) / N
  const TSS = y.reduce((s, v) => s + (v - yMean) ** 2, 0)
  const RSS = residuals.reduce((s, r) => s + r ** 2, 0)
  const rSquared = 1 - RSS / TSS
  const adjRSquared = 1 - (RSS / (N - K)) / (TSS / (N - 1))
  const sigma2 = RSS / (N - K)
  const tStats = beta.map((b, j) => b / Math.sqrt(sigma2 * XtXinv[j][j]))
  return { coefficients: beta, tStats, rSquared, adjRSquared, fitted, residuals }
}

// ─── PC Regressions ───────────────────────────────────────────────────────────

const REG_FACTORS: { key: string; label: string; color: string }[] = [
  { key: 'broadMacro', label: 'Broad Macro', color: '#94a3b8' },
  { key: 'growth',     label: 'Growth',      color: '#34d399' },
  { key: 'inflation',  label: 'Inflation',   color: '#f87171' },
  { key: 'employment', label: 'Employment',  color: '#60a5fa' },
]

// Design matrix X: [N_MONTHS × 4]
const REG_X: number[][] = Array.from({ length: N_MONTHS }, (_, t) =>
  REG_FACTORS.map(f => FACTOR_SERIES[f.key][t])
)

const PC1_REG: OLSResult = ols(YIELD_PCA.scores.map(s => s[0]), REG_X)
const PC2_REG: OLSResult = ols(YIELD_PCA.scores.map(s => s[1]), REG_X)

// ─── 10y Bund Fair Value ──────────────────────────────────────────────────────
// Inversion: ŷ_tenor(t) = mean[tenor] + Σ_k loading[k][tenor] × PC_k_fitted(t)
// We use only PC1 and PC2 (together ~99% of variance; PC3 is noise).
// PC_k_fitted comes from the macro regressions, giving us the macro-implied level
// of each PC at each point in time.

const BUND_10Y_IDX = YIELD_TENORS.indexOf('10y') // = 4

// Macro fair value: PC scores replaced by macro-model fitted values
const BUND_10Y_FAIR_VALUE: number[] = Array.from({ length: N_MONTHS }, (_, t) =>
  YIELD_PCA.means[BUND_10Y_IDX]
  + YIELD_PCA.loadings[0][BUND_10Y_IDX] * PC1_REG.fitted[t]
  + YIELD_PCA.loadings[1][BUND_10Y_IDX] * PC2_REG.fitted[t]
)

// PCA reconstruction: same inversion but using actual PC scores (no macro)
// Captures ~99% of yield variance (PC1+PC2); residual is pure PC3 noise
const BUND_10Y_PCA_FITTED: number[] = Array.from({ length: N_MONTHS }, (_, t) =>
  YIELD_PCA.means[BUND_10Y_IDX]
  + YIELD_PCA.loadings[0][BUND_10Y_IDX] * YIELD_PCA.scores[t][0]
  + YIELD_PCA.loadings[1][BUND_10Y_IDX] * YIELD_PCA.scores[t][1]
)

// Rich/cheap in bps: positive = actual above fair value (cheap)
//                    negative = actual below fair value (rich)
const BUND_10Y_RICHCHEAP: number[] = SYNTHETIC_YIELDS['10y'].map(
  (y, t) => Math.round((y - BUND_10Y_FAIR_VALUE[t]) * 100 * 10) / 10
)

// ─── Rates section components (API-driven) ────────────────────────────────────

const PC_META = [
  { key: 'pc1', label: 'PC1 — Level',     color: '#f59e0b' },
  { key: 'pc2', label: 'PC2 — Slope',     color: '#34d399' },
  { key: 'pc3', label: 'PC3 — Curvature', color: '#a78bfa' },
]

const PC_CHART_DATA = MONTH_COLS.map((month, t) => ({
  month,
  pc1: Math.round(YIELD_PCA.scores[t][0] * 1000) / 1000,
  pc2: Math.round(YIELD_PCA.scores[t][1] * 1000) / 1000,
  pc3: Math.round(YIELD_PCA.scores[t][2] * 1000) / 1000,
}))

function YieldPCChart() {
  return (
    <div style={cardStyle}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>
            Bund Yield Curve — Principal Components
          </h2>
          <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>
            PCA on 2/3/5/7/10/15/20/30y Bund yields &middot; synthetic data
          </p>
        </div>
        {/* Variance explained badges */}
        <div style={{ display: 'flex', gap: 8 }}>
          {PC_META.map((pc, k) => (
            <div key={pc.key} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: '4px 10px',
            }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: pc.color }} />
              <span style={{ color: '#94a3b8', fontSize: 11 }}>{pc.label}</span>
              <span style={{ color: pc.color, fontSize: 11, fontFamily: 'monospace', fontWeight: 600 }}>
                {(YIELD_PCA.explainedVar[k] * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={PC_CHART_DATA} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis
            dataKey="month"
            tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }}
            tickLine={false}
            axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            interval={3}
          />
          <YAxis
            tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => v.toFixed(2)}
          />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
          <Tooltip
            contentStyle={{
              background: '#0f172a',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8,
              fontSize: 11,
              fontFamily: 'monospace',
              color: '#e2e8f0',
            }}
            labelStyle={{ color: '#64748b', marginBottom: 4 }}
            formatter={(value: number, name: string) => {
              const pc = PC_META.find(p => p.key === name)
              return [value.toFixed(3), pc?.label ?? name]
            }}
          />
          {PC_META.map(pc => (
            <Line
              key={pc.key}
              type="monotone"
              dataKey={pc.key}
              stroke={pc.color}
              strokeWidth={1.8}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      {/* Loadings table */}
      <div style={{ marginTop: 20 }}>
        <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>
          Factor loadings (eigenvectors)
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 8px 6px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', width: 120 }}>
                Factor
              </th>
              {YIELD_TENORS.map(t => (
                <th key={t} style={{ textAlign: 'right', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 6px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  {t}
                </th>
              ))}
            </tr>
          </thead>
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
                  <td key={j} style={{
                    textAlign: 'right',
                    padding: '5px 6px',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    fontFamily: 'monospace',
                    fontSize: 10,
                    color: l > 0.05 ? '#34d399' : l < -0.05 ? '#f87171' : '#475569',
                  }}>
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

// ─── PC Regression Visualization ──────────────────────────────────────────────

const REG_CHART_DATA = MONTH_COLS.map((month, t) => ({
  month,
  pc1Actual:  Math.round(YIELD_PCA.scores[t][0] * 1000) / 1000,
  pc1Fitted:  Math.round(PC1_REG.fitted[t] * 1000) / 1000,
  pc2Actual:  Math.round(YIELD_PCA.scores[t][1] * 1000) / 1000,
  pc2Fitted:  Math.round(PC2_REG.fitted[t] * 1000) / 1000,
}))

function tStatColor(t: number): string {
  const abs = Math.abs(t)
  if (abs >= 2.58) return '#34d399'   // 1% significance
  if (abs >= 1.96) return '#fbbf24'   // 5%
  if (abs >= 1.65) return '#94a3b8'   // 10%
  return '#475569'                     // not significant
}

function RegressionTable({ reg, pcLabel }: { reg: OLSResult; pcLabel: string }) {
  // coefficients: [intercept, broadMacro, growth, inflation, employment]
  return (
    <div>
      {/* R² header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
        <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 600 }}>{pcLabel}</span>
        <span style={{
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: 6, padding: '2px 8px', fontFamily: 'monospace', fontSize: 11, color: '#f1f5f9',
        }}>
          R² = {reg.rSquared.toFixed(3)}
        </span>
        <span style={{
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: 6, padding: '2px 8px', fontFamily: 'monospace', fontSize: 11, color: '#94a3b8',
        }}>
          adj. R² = {reg.adjRSquared.toFixed(3)}
        </span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            {['Factor', 'Coeff.', 't-stat', 'Sig.'].map(h => (
              <th key={h} style={{ textAlign: h === 'Factor' ? 'left' : 'right', color: '#475569', fontWeight: 600, fontSize: 10, padding: '4px 8px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', whiteSpace: 'nowrap' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
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
                <td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: b >= 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>
                  {b >= 0 ? '+' : ''}{b.toFixed(4)}
                </td>
                <td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', color: tStatColor(t) }}>
                  {t >= 0 ? '+' : ''}{t.toFixed(2)}
                </td>
                <td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)', color: tStatColor(t), fontWeight: 600 }}>
                  {Math.abs(t) >= 2.58 ? '***' : Math.abs(t) >= 1.96 ? '**' : Math.abs(t) >= 1.65 ? '*' : '—'}
                </td>
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
        <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>
          Rates–Macro Linkage — PC Regressions
        </h2>
        <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>
          OLS: PC1 &amp; PC2 of Bund curve regressed on macro factors &middot; *** p&lt;1% &nbsp;** p&lt;5% &nbsp;* p&lt;10%
        </p>
      </div>

      {/* Actual vs Fitted charts */}
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
                <YAxis tick={{ fill: '#475569', fontSize: 8, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={(v) => v.toFixed(2)} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.10)" strokeDasharray="4 4" />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 10, fontFamily: 'monospace', color: '#e2e8f0' }}
                  labelStyle={{ color: '#64748b', marginBottom: 4 }}
                  formatter={(v: number, n: string) => [v.toFixed(3), n.includes('Actual') ? 'Actual' : 'Fitted']}
                />
                <Line type="monotone" dataKey={actualKey} stroke={color} strokeWidth={1.8} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                <Line type="monotone" dataKey={fittedKey} stroke="rgba(255,255,255,0.45)" strokeWidth={1.2} strokeDasharray="5 3" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
            {/* Mini legend */}
            <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 18, height: 2, background: color, borderRadius: 1 }} />
                <span style={{ color: '#475569', fontSize: 10 }}>Actual</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 18, height: 0, borderTop: '2px dashed rgba(255,255,255,0.45)', borderRadius: 1 }} />
                <span style={{ color: '#475569', fontSize: 10 }}>Fitted</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Regression tables side by side */}
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <RegressionTable reg={PC1_REG} pcLabel="PC1 — Level" />
        </div>
        <div style={{ width: '1px', background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <RegressionTable reg={PC2_REG} pcLabel="PC2 — Slope" />
        </div>
      </div>
    </div>
  )
}

// ─── Bund Fair Value Section ──────────────────────────────────────────────────

const FAIR_VALUE_CHART_DATA = MONTH_COLS.map((month, t) => ({
  month,
  actual:    Math.round(SYNTHETIC_YIELDS['10y'][t] * 100) / 100,
  pcaFitted: Math.round(BUND_10Y_PCA_FITTED[t] * 100) / 100,
  fairValue: Math.round(BUND_10Y_FAIR_VALUE[t] * 100) / 100,
  richCheap: BUND_10Y_RICHCHEAP[t],
}))

function BundFairValueSection() {
  const current     = SYNTHETIC_YIELDS['10y'][N_MONTHS - 1]
  const fv          = BUND_10Y_FAIR_VALUE[N_MONTHS - 1]
  const rc          = BUND_10Y_RICHCHEAP[N_MONTHS - 1]
  const isRich      = rc < 0
  const rcColor     = rc > 5 ? '#34d399' : rc < -5 ? '#f87171' : '#94a3b8'
  const rcLabel     = isRich ? 'Rich' : 'Cheap'

  return (
    <div style={cardStyle}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>
            10y Bund — Macro Fair Value
          </h2>
          <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 0' }}>
            PCA inversion: ŷ = μ + L₁·PĈ₁ + L₂·PĈ₂ &middot; macro-implied level via OLS
          </p>
        </div>

        {/* Current reading summary */}
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { label: 'Actual',          value: `${current.toFixed(2)}%`,           color: '#f59e0b' },
            { label: 'PCA (PC1+PC2)',   value: `${BUND_10Y_PCA_FITTED[N_MONTHS - 1].toFixed(2)}%`, color: '#34d399' },
            { label: 'Macro Fair Value',value: `${fv.toFixed(2)}%`,                color: '#94a3b8' },
            { label: rcLabel,           value: `${Math.abs(rc).toFixed(1)} bps`,   color: rcColor },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: '6px 12px', textAlign: 'center',
            }}>
              <div style={{ color: '#475569', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
              <div style={{ color, fontSize: 13, fontFamily: 'monospace', fontWeight: 700 }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Actual vs Fair Value */}
      <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>
        Actual vs macro fair value (%)
      </p>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={FAIR_VALUE_CHART_DATA} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={3} />
          <YAxis tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => `${v.toFixed(2)}%`} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace' }}
            labelStyle={{ color: '#64748b', marginBottom: 4 }}
            formatter={(v: number, name: string) => [
              `${v.toFixed(3)}%`,
              name === 'actual' ? 'Actual' : name === 'pcaFitted' ? 'PCA (PC1+PC2)' : 'Macro Fair Value',
            ]}
          />
          <Line type="monotone" dataKey="actual"    stroke="#f59e0b" strokeWidth={2}   dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
          <Line type="monotone" dataKey="pcaFitted" stroke="#34d399" strokeWidth={1.5} strokeDasharray="3 2" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
          <Line type="monotone" dataKey="fairValue" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="5 3" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
        </LineChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 20, marginTop: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 20, height: 2, background: '#f59e0b', borderRadius: 1 }} />
          <span style={{ color: '#475569', fontSize: 10 }}>Actual 10y Bund</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 20, height: 0, borderTop: '2px dashed #34d399' }} />
          <span style={{ color: '#475569', fontSize: 10 }}>PCA reconstruction (PC1+PC2, no macro)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 20, height: 0, borderTop: '2px dashed #94a3b8' }} />
          <span style={{ color: '#475569', fontSize: 10 }}>Macro fair value (macro-fitted PC1+PC2)</span>
        </div>
      </div>

      {/* Rich / Cheap panel */}
      <p style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>
        Rich / cheap vs fair value (bps) — positive = cheap, negative = rich
      </p>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={FAIR_VALUE_CHART_DATA} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <defs>
            <linearGradient id="gradCheap" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#34d399" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#34d399" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gradRich" x1="0" y1="1" x2="0" y2="0">
              <stop offset="5%"  stopColor="#f87171" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#f87171" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} interval={3} />
          <YAxis tick={{ fill: '#475569', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} tickFormatter={v => `${v > 0 ? '+' : ''}${v}bp`} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace' }}
            labelStyle={{ color: '#64748b', marginBottom: 4 }}
            formatter={(v: number) => [`${v > 0 ? '+' : ''}${v.toFixed(1)} bps`, v >= 0 ? 'Cheap' : 'Rich']}
          />
          <Area
            type="monotone"
            dataKey="richCheap"
            stroke="#94a3b8"
            strokeWidth={1.5}
            fill={rc >= 0 ? 'url(#gradCheap)' : 'url(#gradRich)'}
          />
        </AreaChart>
      </ResponsiveContainer>
      <p style={{ color: '#334155', fontSize: 9, margin: '8px 0 0', fontStyle: 'italic' }}>
        Fair value = sample mean + PC1 loading × macro-fitted PC1 + PC2 loading × macro-fitted PC2. Residual captures non-macro drivers (positioning, technicals, term premium).
      </p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function fmtTimestamp(d: Date): string {
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}

export default function EuroAreaHeatmap() {
  const navigate = useNavigate()
  const [timestamp, setTimestamp] = useState(() => fmtTimestamp(new Date()))
  const [refreshing, setRefreshing] = useState(false)

  function handleRefresh() {
    setRefreshing(true)
    setTimeout(() => {
      setTimestamp(fmtTimestamp(new Date()))
      setRefreshing(false)
    }, 600)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#080d1a' }}>
      {/* Gradient overlay */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse at 50% -10%, rgba(59,130,246,0.06) 0%, transparent 55%)',
        }}
      />

      {/* Header */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 24px',
          background: 'rgba(8,13,26,0.85)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            onClick={() => navigate('/')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.09)',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: 14,
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
              e.currentTarget.style.color = '#e2e8f0'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
              e.currentTarget.style.color = '#94a3b8'
            }}
          >
            ←
          </button>
          <div>
            <h1 style={{ color: '#ffffff', fontSize: 15, fontWeight: 600, margin: 0, lineHeight: 1.2 }}>
              Euro Area — Macro Heatmap
            </h1>
            <p style={{ color: '#475569', fontSize: 11, margin: 0, marginTop: 2 }}>
              Dynamic Factor Model &middot; Simulated Data
            </p>
          </div>
        </div>

        {/* Right side badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8, padding: '5px 12px',
              color: '#94a3b8', fontSize: 12, cursor: refreshing ? 'not-allowed' : 'pointer',
              opacity: refreshing ? 0.5 : 1, transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => { if (!refreshing) { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#e2e8f0' } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#94a3b8' }}
          >
            <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8, padding: '5px 12px',
          }}>
            <span style={{ color: '#475569', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Generated</span>
            <span style={{ color: '#94a3b8', fontSize: 11, fontFamily: 'monospace', fontWeight: 500 }}>{timestamp}</span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.18)',
            borderRadius: 8, padding: '5px 12px',
          }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', opacity: 0.8 }} />
            <span style={{ color: '#60a5fa', fontSize: 11, fontWeight: 500 }}>Jun 2023 – Jun 2025</span>
          </div>
        </div> {/* end right badges */}
      </header>

      {/* Body */}
      <main
        style={{
          position: 'relative',
          maxWidth: 1600,
          margin: '0 auto',
          padding: '28px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        {/* DFM Factor synthesis */}
        <DFMSection />

        {/* Yield curve PCs */}
        <YieldPCChart />

        {/* PC regressions on macro factors */}
        <PCRegressionSection />

        {/* 10y Bund fair value */}
        <BundFairValueSection />

        {/* Legend card */}
        <div style={cardStyle}>
          <Legend />
        </div>

        {/* Heatmap card */}
        <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
          {/* Card header */}
          <div style={{
            padding: '16px 20px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            <h2 style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 600, margin: 0 }}>
              Macro Fundamentals — Z-Score Heatmap
            </h2>
            <p style={{ color: '#475569', fontSize: 12, margin: 0, marginTop: 3 }}>
              Z-scores relative to 3-year rolling window &middot; 25 monthly observations &middot; 83 indicators across 7 blocks
            </p>
          </div>

          {/* Table */}
          <div style={{ padding: '0 0 4px' }}>
            <HeatmapTable />
          </div>
        </div>

        {/* Footer note */}
        <p style={{ color: '#334155', fontSize: 10, textAlign: 'center', margin: 0, fontStyle: 'italic' }}>
          Data is simulated for illustrative purposes only. Z-scores generated via deterministic DFM-inspired time series.
        </p>
      </main>
    </div>
  )
}
