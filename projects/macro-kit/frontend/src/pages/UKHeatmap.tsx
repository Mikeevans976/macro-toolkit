import React, { useCallback, useRef, useState } from 'react'
import PageTitle from '../components/PageTitle'
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { ols, jacobiEigen, type OLSResult } from '../lib/math/linalg'
import { cardStyle, stickyBg, zscoreToColors } from '../features/heatmap/styles'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Indicator {
  name: string; asOfLastMtg: string; latest: string; change: string
  lastUpd: string; units: string; mean: number; std: number; zscores: number[]
}
interface Group { name: string; indicators: Indicator[] }

// ─── Styles ───────────────────────────────────────────────────────────────────

// ─── Date columns ─────────────────────────────────────────────────────────────

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

// ─── Z-score generator ────────────────────────────────────────────────────────

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

// ─── UK Indicator Groups ──────────────────────────────────────────────────────
// BoE last meeting: 8 May 2025

const GROUPS_META: {
  name: string; bias: number
  indicators: {
    name: string; asOfLastMtg: string; latest: string; change: string
    lastUpd: string; units: string; mean: number; std: number
    amp: number; phase: number; freq: number; noiseSeed: number
  }[]
}[] = [
  {
    name: 'Real Activity', bias: -0.4,
    indicators: [
      { name: 'UK Real GDP (m/m)',           asOfLastMtg: '-0.1%',latest: '0.3%', change: '+0.4', lastUpd: '12 May 2025', units: '% m/m SA',  mean: 0.3,  std: 0.4, amp: 0.8, phase: 0.2, freq: 0.30, noiseSeed: 7  },
      { name: 'Manufacturing Production',     asOfLastMtg: '-1.1%',latest: '-0.7%',change: '+0.4', lastUpd: '12 May 2025', units: '% m/m SA',  mean: -0.7, std: 0.6, amp: 1.2, phase: 0.5, freq: 0.50, noiseSeed: 8  },
      { name: 'Services Output',             asOfLastMtg: '0.2%', latest: '0.4%', change: '+0.2', lastUpd: '12 May 2025', units: '% m/m SA',  mean: 0.4,  std: 0.4, amp: 0.9, phase: 0.7, freq: 0.44, noiseSeed: 9  },
      { name: 'Construction Output',         asOfLastMtg: '-0.4%',latest: '0.2%', change: '+0.6', lastUpd: '12 May 2025', units: '% m/m SA',  mean: 0.2,  std: 1.0, amp: 1.0, phase: 1.4, freq: 0.36, noiseSeed: 60 },
      { name: 'Retail Sales Vol. ex-Auto Fuel',asOfLastMtg: '-0.8%',latest: '-0.3%',change: '+0.5', lastUpd: '23 May 2025', units: '% m/m SA',  mean: -0.3, std: 0.8, amp: 1.0, phase: 1.0, freq: 0.46, noiseSeed: 10 },
      { name: 'New Car Registrations',       asOfLastMtg: '-12.5%',latest: '-10.4%',change: '+2.1',lastUpd: '06 May 2025',units: '% y/y',   mean: -10.4, std: 8.0, amp: 1.3, phase: 0.8, freq: 0.48, noiseSeed: 11 },
      { name: 'Household Consumption (q/q)', asOfLastMtg: '0.2%', latest: '0.4%', change: '+0.2', lastUpd: '30 Apr 2025', units: '% q/q SA',  mean: 0.4,  std: 0.6, amp: 0.8, phase: 1.3, freq: 0.28, noiseSeed: 61 },
      { name: 'Business Investment (q/q)',   asOfLastMtg: '0.7%', latest: '0.5%', change: '-0.2', lastUpd: '30 Apr 2025', units: '% q/q SA',  mean: 0.5,  std: 1.2, amp: 0.8, phase: 1.2, freq: 0.28, noiseSeed: 12 },
    ],
  },
  {
    name: 'Business Activity', bias: -0.3,
    indicators: [
      { name: 'UK Composite PMI',                   asOfLastMtg: '51.5', latest: '50.4', change: '-1.1', lastUpd: '04 Jun 2025', units: 'Index SA', mean: 50.4, std: 2.5,  amp: 1.2, phase: 0.4, freq: 0.48, noiseSeed: 1  },
      { name: 'Composite PMI New Orders',           asOfLastMtg: '50.8', latest: '49.6', change: '-1.2', lastUpd: '04 Jun 2025', units: 'Index SA', mean: 49.6, std: 2.8,  amp: 1.3, phase: 0.5, freq: 0.49, noiseSeed: 62 },
      { name: 'UK Services PMI',                    asOfLastMtg: '51.3', latest: '50.9', change: '-0.4', lastUpd: '04 Jun 2025', units: 'Index SA', mean: 50.9, std: 2.5,  amp: 1.1, phase: 0.6, freq: 0.46, noiseSeed: 2  },
      { name: 'Services PMI New Business',          asOfLastMtg: '51.1', latest: '50.2', change: '-0.9', lastUpd: '04 Jun 2025', units: 'Index SA', mean: 50.2, std: 2.7,  amp: 1.2, phase: 0.7, freq: 0.47, noiseSeed: 63 },
      { name: 'UK Manufacturing PMI',               asOfLastMtg: '44.9', latest: '45.1', change: '+0.2', lastUpd: '02 Jun 2025', units: 'Index SA', mean: 45.1, std: 3.0,  amp: 1.4, phase: 0.3, freq: 0.52, noiseSeed: 3  },
      { name: 'Manufacturing PMI New Orders',       asOfLastMtg: '43.2', latest: '44.0', change: '+0.8', lastUpd: '02 Jun 2025', units: 'Index SA', mean: 44.0, std: 3.2,  amp: 1.5, phase: 0.4, freq: 0.53, noiseSeed: 64 },
      { name: 'CBI Business Optimism',              asOfLastMtg: '+4',   latest: '+8',   change: '+4',   lastUpd: '24 Apr 2025', units: 'Balance',  mean: 8.0,  std: 15.0, amp: 1.0, phase: 0.9, freq: 0.42, noiseSeed: 4  },
      { name: 'CBI Output Past 3M',                 asOfLastMtg: '-8',   latest: '-4',   change: '+4',   lastUpd: '24 Apr 2025', units: 'Balance',  mean: -4.0, std: 18.0, amp: 1.1, phase: 0.8, freq: 0.43, noiseSeed: 65 },
      { name: 'CBI Output Next 3M',                 asOfLastMtg: '+6',   latest: '+10',  change: '+4',   lastUpd: '24 Apr 2025', units: 'Balance',  mean: 10.0, std: 16.0, amp: 1.0, phase: 1.0, freq: 0.41, noiseSeed: 66 },
      { name: 'BCC Sales',                          asOfLastMtg: '+18',  latest: '+22',  change: '+4',   lastUpd: '15 Apr 2025', units: 'Balance',  mean: 22.0, std: 14.0, amp: 1.0, phase: 0.6, freq: 0.44, noiseSeed: 67 },
      { name: 'BCC New Orders',                     asOfLastMtg: '+12',  latest: '+16',  change: '+4',   lastUpd: '15 Apr 2025', units: 'Balance',  mean: 16.0, std: 15.0, amp: 1.1, phase: 0.7, freq: 0.45, noiseSeed: 68 },
      { name: 'BCC Turnover Expectations',          asOfLastMtg: '+28',  latest: '+32',  change: '+4',   lastUpd: '15 Apr 2025', units: 'Balance',  mean: 32.0, std: 12.0, amp: 0.9, phase: 0.8, freq: 0.43, noiseSeed: 69 },
      { name: 'Lloyds Bus. Barometer (Activity)',   asOfLastMtg: '41',   latest: '44',   change: '+3',   lastUpd: '27 May 2025', units: '% net pos',mean: 44.0, std: 12.0, amp: 1.0, phase: 1.0, freq: 0.46, noiseSeed: 70 },
      { name: 'GfK Consumer Confidence',            asOfLastMtg: '-28',  latest: '-23',  change: '+5',   lastUpd: '30 May 2025', units: 'Balance',  mean: -23.0, std: 8.0, amp: 0.9, phase: 1.1, freq: 0.44, noiseSeed: 5  },
      { name: 'BRC Retail Sales Monitor',           asOfLastMtg: '-0.1%',latest: '+0.3%',change: '+0.4', lastUpd: '06 May 2025', units: '% y/y',   mean: 0.3,  std: 1.5,  amp: 1.0, phase: 1.5, freq: 0.40, noiseSeed: 6  },
    ],
  },
  {
    name: 'Housing Market', bias: -0.8,
    indicators: [
      { name: 'RICS House Price Balance',   asOfLastMtg: '+6',   latest: '+19',  change: '+13',  lastUpd: '15 May 2025', units: 'Balance',  mean: 19.0, std: 20.0, amp: 1.1, phase: 1.3, freq: 0.36, noiseSeed: 13 },
      { name: 'Halifax HPI (m/m)',          asOfLastMtg: '0.3%', latest: '0.4%', change: '+0.1', lastUpd: '07 May 2025', units: '% m/m SA', mean: 0.4,  std: 0.6, amp: 1.0, phase: 0.4, freq: 0.38, noiseSeed: 14 },
      { name: 'Nationwide HPI (m/m)',       asOfLastMtg: '0.1%', latest: '0.3%', change: '+0.2', lastUpd: '01 May 2025', units: '% m/m SA', mean: 0.3,  std: 0.5, amp: 1.0, phase: 0.6, freq: 0.37, noiseSeed: 15 },
      { name: 'Mortgage Approvals',         asOfLastMtg: '63.8k',latest: '64.2k',change: '+0.4k',lastUpd: '30 Apr 2025', units: 'k SA',     mean: 64.2, std: 5.0, amp: 0.9, phase: 0.8, freq: 0.34, noiseSeed: 16 },
      { name: 'Mortgage Transactions',      asOfLastMtg: '85.2k',latest: '88.5k',change: '+3.3k',lastUpd: '23 May 2025', units: 'k SA',     mean: 88.5, std: 8.0, amp: 0.8, phase: 1.0, freq: 0.32, noiseSeed: 17 },
      { name: 'Net Mortgage Lending',       asOfLastMtg: '3.1',  latest: '3.8',  change: '+0.7', lastUpd: '30 Apr 2025', units: 'GBP bn',   mean: 3.8,  std: 1.5, amp: 0.9, phase: 1.2, freq: 0.35, noiseSeed: 18 },
      { name: 'Housebuilding Starts (y/y)', asOfLastMtg: '-8.3%',latest: '-5.2%',change: '+3.1', lastUpd: '15 May 2025', units: '% y/y',    mean: -5.2, std: 8.0, amp: 1.0, phase: 1.5, freq: 0.30, noiseSeed: 19 },
    ],
  },
  {
    name: 'Labour Market', bias: -0.1,
    indicators: [
      // Unemployment & inactivity
      { name: 'ILO Unemployment Rate',           asOfLastMtg: '4.4%', latest: '4.5%', change: '+0.1',  lastUpd: '13 May 2025', units: '% SA',     mean: 4.5,   std: 0.3,   amp: 0.6, phase: 1.5, freq: 0.22, noiseSeed: 20 },
      { name: 'Single Month U/E Rate',           asOfLastMtg: '4.9%', latest: '4.5%', change: '-0.4',  lastUpd: '13 May 2025', units: '% SA',     mean: 4.5,   std: 0.5,   amp: 0.7, phase: 1.3, freq: 0.24, noiseSeed: 71 },
      { name: 'Unemployed (mn.)',                asOfLastMtg: '1.87', latest: '1.81', change: '-0.06', lastUpd: '13 May 2025', units: 'mn. SA',   mean: 1.81,  std: 0.08,  amp: 0.6, phase: 1.4, freq: 0.22, noiseSeed: 72 },
      { name: 'Economic Inactivity Rate',        asOfLastMtg: '21.9%',latest: '21.8%',change: '-0.1',  lastUpd: '13 May 2025', units: '% SA',     mean: 21.8,  std: 0.4,   amp: 0.5, phase: 0.4, freq: 0.20, noiseSeed: 24 },
      { name: 'Economically Active Pop. (mn.)',  asOfLastMtg: '36.11',latest: '36.20',change: '+0.09', lastUpd: '13 May 2025', units: 'mn. SA',   mean: 36.20, std: 0.15,  amp: 0.4, phase: 0.5, freq: 0.18, noiseSeed: 73 },
      // Employment flows
      { name: 'Employment Change (3m)',          asOfLastMtg: '-78k', latest: '-33k', change: '+45k',  lastUpd: '13 May 2025', units: 'k 3m SA',  mean: -33.0, std: 60.0,  amp: 1.0, phase: 0.6, freq: 0.38, noiseSeed: 22 },
      { name: 'Employees: Full-Time Chg.',       asOfLastMtg: '+64k', latest: '+18k', change: '-46k',  lastUpd: '13 May 2025', units: 'k 3m SA',  mean: 18.0,  std: 55.0,  amp: 1.0, phase: 0.7, freq: 0.39, noiseSeed: 74 },
      { name: 'Employees: Part-Time Chg.',       asOfLastMtg: '-42k', latest: '-11k', change: '+31k',  lastUpd: '13 May 2025', units: 'k 3m SA',  mean: -11.0, std: 35.0,  amp: 1.0, phase: 0.8, freq: 0.40, noiseSeed: 75 },
      { name: 'Self-Employed Chg.',              asOfLastMtg: '-18k', latest: '-12k', change: '+6k',   lastUpd: '13 May 2025', units: 'k 3m SA',  mean: -12.0, std: 40.0,  amp: 0.9, phase: 0.9, freq: 0.36, noiseSeed: 76 },
      { name: 'Payrolled Employees (m/m)',       asOfLastMtg: '-33k', latest: '-15k', change: '+18k',  lastUpd: '20 May 2025', units: 'k SA',     mean: -15.0, std: 30.0,  amp: 1.0, phase: 0.9, freq: 0.42, noiseSeed: 25 },
      { name: 'Private Payroll Employees (m/m)', asOfLastMtg: '-96k', latest: '-28k', change: '+68k',  lastUpd: '20 May 2025', units: 'k SA',     mean: -28.0, std: 40.0,  amp: 1.1, phase: 1.0, freq: 0.43, noiseSeed: 77 },
      { name: 'Hours Worked (%M SA)',            asOfLastMtg: '+0.1%',latest: '+0.2%',change: '+0.1',  lastUpd: '13 May 2025', units: '% m/m SA', mean: 0.2,   std: 0.4,   amp: 0.8, phase: 1.1, freq: 0.38, noiseSeed: 78 },
      // Claimant count & vacancies
      { name: 'Claimant Count Change',          asOfLastMtg: '+5.8k',latest: '+2.3k', change: '-3.5k', lastUpd: '20 May 2025', units: 'k SA',     mean: 2.3,   std: 15.0,  amp: 1.1, phase: 0.8, freq: 0.40, noiseSeed: 21 },
      { name: 'Claimant Count (th.)',            asOfLastMtg: '1,720',latest: '1,722', change: '+2',    lastUpd: '20 May 2025', units: 'k SA',     mean: 1722.0,std: 80.0,  amp: 0.8, phase: 1.2, freq: 0.30, noiseSeed: 79 },
      { name: 'Vacancies Experimental (ONS, mn.)',asOfLastMtg: '0.725',latest: '0.705', change: '-0.020',lastUpd: '20 May 2025', units: 'mn. NSA',  mean: 0.705, std: 0.05,  amp: 0.9, phase: 0.9, freq: 0.31, noiseSeed: 85 },
      { name: 'Job Vacancies (mn.)',             asOfLastMtg: '0.760',latest: '0.736', change: '-0.024',lastUpd: '13 May 2025', units: 'mn. SA',   mean: 0.736, std: 0.05,  amp: 0.9, phase: 1.0, freq: 0.32, noiseSeed: 23 },
      { name: 'REC Vacancies',                   asOfLastMtg: '46.2', latest: '46.8',  change: '+0.6',  lastUpd: '10 Jun 2025', units: 'Index SA', mean: 46.8,  std: 3.0,   amp: 1.0, phase: 1.0, freq: 0.42, noiseSeed: 86 },
      { name: 'Vacancies/Unemployed Ratio',      asOfLastMtg: '0.41', latest: '0.40',  change: '-0.01', lastUpd: '13 May 2025', units: 'Ratio',    mean: 0.40,  std: 0.04,  amp: 0.8, phase: 1.1, freq: 0.30, noiseSeed: 80 },
      // Redundancies (HR1)
      { name: 'HR1 Forms Received',              asOfLastMtg: '396',  latest: '248',   change: '-148',  lastUpd: '30 Apr 2025', units: 'Count',    mean: 300.0, std: 80.0,  amp: 1.0, phase: 0.6, freq: 0.44, noiseSeed: 81 },
      { name: 'Potential Redundancies (th.)',    asOfLastMtg: '28',   latest: '22',    change: '-6',    lastUpd: '30 Apr 2025', units: 'k',        mean: 25.0,  std: 8.0,   amp: 1.1, phase: 0.7, freq: 0.45, noiseSeed: 82 },
      { name: 'Employers Submitting HR1',        asOfLastMtg: '356',  latest: '221',   change: '-135',  lastUpd: '30 Apr 2025', units: 'Count',    mean: 280.0, std: 70.0,  amp: 1.0, phase: 0.8, freq: 0.44, noiseSeed: 83 },
      { name: 'Redundancy Rate (%)',             asOfLastMtg: '4.5%', latest: '4.9%',  change: '+0.4',  lastUpd: '30 Apr 2025', units: '%',        mean: 4.5,   std: 0.5,   amp: 0.9, phase: 0.9, freq: 0.38, noiseSeed: 84 },
      // Recruitment surveys
      { name: 'DMP Employment Growth Exp. (1y)', asOfLastMtg: '0.8%', latest: '0.6%',  change: '-0.2',  lastUpd: '29 May 2025', units: '% y/y',    mean: 0.6,   std: 0.5,   amp: 0.7, phase: 0.7, freq: 0.28, noiseSeed: 89 },
      { name: 'Lloyds Bus. Barometer (Employ.)',  asOfLastMtg: '38',   latest: '41',    change: '+3',    lastUpd: '27 May 2025', units: '% net pos', mean: 41.0,  std: 10.0,  amp: 0.9, phase: 0.6, freq: 0.44, noiseSeed: 90 },
      { name: 'PMI Services Employment',         asOfLastMtg: '49.8', latest: '49.2',  change: '-0.6',  lastUpd: '04 Jun 2025', units: 'Index SA', mean: 49.2,  std: 2.0,   amp: 0.9, phase: 0.8, freq: 0.40, noiseSeed: 87 },
      { name: 'PMI Manufacturing Employment',    asOfLastMtg: '44.1', latest: '44.6',  change: '+0.5',  lastUpd: '02 Jun 2025', units: 'Index SA', mean: 44.6,  std: 2.5,   amp: 1.0, phase: 0.9, freq: 0.42, noiseSeed: 88 },
      { name: 'REC Permanent Placements',        asOfLastMtg: '43.1', latest: '43.8',  change: '+0.7',  lastUpd: '10 Jun 2025', units: 'Index SA', mean: 43.8,  std: 3.0,   amp: 1.1, phase: 1.1, freq: 0.44, noiseSeed: 26 },
      { name: 'REC Staff Availability',          asOfLastMtg: '61.8', latest: '62.1',  change: '+0.3',  lastUpd: '10 Jun 2025', units: 'Index SA', mean: 62.1,  std: 2.5,   amp: 0.8, phase: 0.7, freq: 0.38, noiseSeed: 27 },
    ],
  },
  {
    name: 'Wages', bias: 0.7,
    indicators: [
      { name: 'AWE Regular Pay (y/y)',      asOfLastMtg: '5.9%', latest: '5.6%', change: '-0.3', lastUpd: '13 May 2025', units: '% y/y SA',  mean: 5.6, std: 0.6, amp: 0.8, phase: 0.3, freq: 0.22, noiseSeed: 28 },
      { name: 'AWE Total Pay (y/y)',         asOfLastMtg: '6.1%', latest: '5.8%', change: '-0.3', lastUpd: '13 May 2025', units: '% y/y SA',  mean: 5.8, std: 0.6, amp: 0.8, phase: 0.5, freq: 0.21, noiseSeed: 29 },
      { name: 'AWE Private Sector (y/y)',    asOfLastMtg: '6.3%', latest: '5.8%', change: '-0.5', lastUpd: '13 May 2025', units: '% y/y SA',  mean: 5.8, std: 0.7, amp: 0.9, phase: 0.7, freq: 0.23, noiseSeed: 30 },
      { name: 'AWE Public Sector (y/y)',     asOfLastMtg: '5.4%', latest: '5.2%', change: '-0.2', lastUpd: '13 May 2025', units: '% y/y SA',  mean: 5.2, std: 0.5, amp: 0.7, phase: 1.0, freq: 0.20, noiseSeed: 31 },
      { name: 'AWE Services (y/y)',          asOfLastMtg: '6.4%', latest: '6.1%', change: '-0.3', lastUpd: '13 May 2025', units: '% y/y SA',  mean: 6.1, std: 0.6, amp: 0.8, phase: 0.4, freq: 0.22, noiseSeed: 32 },
      { name: 'REC Starting Salaries',       asOfLastMtg: '51.8', latest: '52.4', change: '+0.6', lastUpd: '10 Jun 2025', units: 'Index SA',  mean: 52.4, std: 2.0, amp: 0.7, phase: 0.6, freq: 0.24, noiseSeed: 33 },
      { name: 'Unit Labour Costs (y/y)',     asOfLastMtg: '4.8%', latest: '4.3%', change: '-0.5', lastUpd: '30 Apr 2025', units: '% y/y SA',  mean: 4.3, std: 0.8, amp: 0.9, phase: 0.8, freq: 0.25, noiseSeed: 34 },
    ],
  },
  {
    name: 'Inflation', bias: 0.6,
    indicators: [
      { name: 'CPI Services (y/y)',          asOfLastMtg: '4.8%', latest: '5.0%', change: '+0.2', lastUpd: '21 May 2025', units: '% y/y',     mean: 5.0, std: 0.5, amp: 0.8, phase: 0.0, freq: 0.26, noiseSeed: 35 },
      { name: 'Core CPI (y/y)',              asOfLastMtg: '3.4%', latest: '3.4%', change: '—',    lastUpd: '21 May 2025', units: '% y/y',     mean: 3.4, std: 0.5, amp: 0.7, phase: 0.3, freq: 0.25, noiseSeed: 36 },
      { name: 'Headline CPI (y/y)',          asOfLastMtg: '2.8%', latest: '3.5%', change: '+0.7', lastUpd: '21 May 2025', units: '% y/y',     mean: 3.5, std: 0.8, amp: 1.0, phase: 0.5, freq: 0.28, noiseSeed: 37 },
      { name: 'CPIH (y/y)',                  asOfLastMtg: '2.8%', latest: '3.4%', change: '+0.6', lastUpd: '21 May 2025', units: '% y/y',     mean: 3.4, std: 0.8, amp: 0.9, phase: 0.2, freq: 0.27, noiseSeed: 38 },
      { name: 'RPI (y/y)',                   asOfLastMtg: '3.6%', latest: '4.3%', change: '+0.7', lastUpd: '21 May 2025', units: '% y/y',     mean: 4.3, std: 1.0, amp: 1.0, phase: 0.7, freq: 0.29, noiseSeed: 39 },
      { name: 'PPI Input Prices (y/y)',      asOfLastMtg: '-2.4%',latest: '-1.2%',change: '+1.2', lastUpd: '21 May 2025', units: '% y/y',     mean: -1.2, std: 2.0, amp: 1.3, phase: 0.8, freq: 0.35, noiseSeed: 40 },
      { name: 'PPI Output Prices (y/y)',     asOfLastMtg: '-0.2%',latest: '0.3%', change: '+0.5', lastUpd: '21 May 2025', units: '% y/y',     mean: 0.3,  std: 1.0, amp: 1.1, phase: 1.0, freq: 0.33, noiseSeed: 41 },
      { name: 'BRC Shop Prices (y/y)',       asOfLastMtg: '-0.2%',latest: '0.1%', change: '+0.3', lastUpd: '06 May 2025', units: '% y/y',     mean: 0.1,  std: 0.8, amp: 1.0, phase: 1.1, freq: 0.31, noiseSeed: 42 },
      { name: 'Import Prices (y/y)',         asOfLastMtg: '-1.5%',latest: '-0.8%',change: '+0.7', lastUpd: '30 Apr 2025', units: '% y/y',     mean: -0.8, std: 2.5, amp: 1.2, phase: 0.6, freq: 0.34, noiseSeed: 43 },
      { name: 'Inflation Expectations (1y)', asOfLastMtg: '3.6%', latest: '3.2%', change: '-0.4', lastUpd: '31 May 2025', units: '%',         mean: 3.2,  std: 0.4, amp: 0.7, phase: 0.4, freq: 0.24, noiseSeed: 44 },
    ],
  },
  {
    name: 'Financial Conditions', bias: 0.2,
    indicators: [
      { name: 'BoE Bank Rate',              asOfLastMtg: '4.50%',latest: '4.25%',change: '-0.25',lastUpd: '08 May 2025', units: '%',         mean: 4.25, std: 0.30, amp: 0.6, phase: 0.2, freq: 0.20, noiseSeed: 45 },
      { name: 'SONIA 3M',                   asOfLastMtg: '4.52%',latest: '4.28%',change: '-0.24',lastUpd: '01 Jun 2025', units: '%',         mean: 4.28, std: 0.30, amp: 0.7, phase: 0.3, freq: 0.22, noiseSeed: 46 },
      { name: '2y Gilt Yield',              asOfLastMtg: '4.28%',latest: '4.10%',change: '-0.18',lastUpd: '01 Jun 2025', units: '%',         mean: 4.10, std: 0.35, amp: 0.9, phase: 0.4, freq: 0.32, noiseSeed: 47 },
      { name: '5y Gilt Yield',              asOfLastMtg: '4.42%',latest: '4.18%',change: '-0.24',lastUpd: '01 Jun 2025', units: '%',         mean: 4.18, std: 0.35, amp: 1.0, phase: 0.5, freq: 0.34, noiseSeed: 48 },
      { name: '10y Gilt Yield',             asOfLastMtg: '4.68%',latest: '4.52%',change: '-0.16',lastUpd: '01 Jun 2025', units: '%',         mean: 4.52, std: 0.38, amp: 1.0, phase: 0.6, freq: 0.36, noiseSeed: 49 },
      { name: '20y Gilt Yield',             asOfLastMtg: '5.22%',latest: '5.08%',change: '-0.14',lastUpd: '01 Jun 2025', units: '%',         mean: 5.08, std: 0.42, amp: 1.0, phase: 0.7, freq: 0.38, noiseSeed: 50 },
      { name: '30y Gilt Yield',             asOfLastMtg: '5.38%',latest: '5.18%',change: '-0.20',lastUpd: '01 Jun 2025', units: '%',         mean: 5.18, std: 0.50, amp: 1.1, phase: 0.8, freq: 0.40, noiseSeed: 51 },
      { name: '2s10s Gilt Curve',           asOfLastMtg: '40',   latest: '42',   change: '+2',   lastUpd: '01 Jun 2025', units: 'bps',       mean: 42.0, std: 20.0, amp: 0.8, phase: 1.2, freq: 0.38, noiseSeed: 52 },
      { name: '5s30s Gilt Curve',           asOfLastMtg: '96',   latest: '100',  change: '+4',   lastUpd: '01 Jun 2025', units: 'bps',       mean: 100.0, std: 28.0, amp: 0.9, phase: 1.4, freq: 0.36, noiseSeed: 53 },
      { name: '10y Real Gilt Yield',        asOfLastMtg: '1.68%',latest: '1.52%',change: '-0.16',lastUpd: '01 Jun 2025', units: '%',         mean: 1.52, std: 0.28, amp: 0.9, phase: 0.5, freq: 0.34, noiseSeed: 54 },
      { name: '10y Breakeven Inflation',    asOfLastMtg: '3.00%',latest: '3.00%',change: '—',    lastUpd: '01 Jun 2025', units: '%',         mean: 3.00, std: 0.18, amp: 0.6, phase: 0.8, freq: 0.26, noiseSeed: 55 },
      { name: 'GBP/USD',                    asOfLastMtg: '1.244',latest: '1.268',change: '+0.024',lastUpd: '01 Jun 2025',units: 'FX Rate',   mean: 1.268, std: 0.04, amp: 1.0, phase: 1.0, freq: 0.44, noiseSeed: 56 },
      { name: 'GBP/EUR',                    asOfLastMtg: '1.172',latest: '1.186',change: '+0.014',lastUpd: '01 Jun 2025',units: 'FX Rate',   mean: 1.186, std: 0.03, amp: 0.8, phase: 1.2, freq: 0.42, noiseSeed: 57 },
      { name: 'FTSE 100',                   asOfLastMtg: '8,540',latest: '8,780',change: '+240', lastUpd: '01 Jun 2025', units: 'Index',     mean: 8780.0, std: 350.0, amp: 1.1, phase: 0.9, freq: 0.46, noiseSeed: 58 },
      { name: 'FTSE 250',                   asOfLastMtg: '20,120',latest: '20,950',change: '+830',lastUpd: '01 Jun 2025',units: 'Index',     mean: 20950.0, std: 1200.0, amp: 1.1, phase: 1.1, freq: 0.45, noiseSeed: 59 },
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

// ─── UK Gilt Yields ───────────────────────────────────────────────────────────
// 5 tenors (2y/5y/10y/20y/30y), Jun '23 – Jun '25
// Approximate real dynamics: BoE peak Aug '23 (5.25%), first cut Aug '24,
// Jan '25 fiscal concerns spike (30y near 5.5%), Jun '25 Bank Rate 4.25%

export const YIELD_TENORS = ['2y', '5y', '10y', '20y', '30y'] as const
export type Tenor = typeof YIELD_TENORS[number]

export const SYNTHETIC_YIELDS: Record<Tenor, number[]> = {
  //          Jun'23 Jul'23 Aug'23 Sep'23 Oct'23 Nov'23 Dec'23 Jan'24 Feb'24 Mar'24 Apr'24 May'24 Jun'24 Jul'24 Aug'24 Sep'24 Oct'24 Nov'24 Dec'24 Jan'25 Feb'25 Mar'25 Apr'25 May'25 Jun'25
  '2y':  [4.82, 5.00, 5.18, 5.05, 4.90, 4.65, 4.35, 4.50, 4.68, 4.72, 4.62, 4.58, 4.32, 4.15, 4.05, 4.00, 4.12, 4.08, 4.28, 4.50, 4.48, 4.38, 4.20, 4.08, 4.10],
  '5y':  [4.35, 4.55, 4.70, 4.65, 4.55, 4.30, 4.05, 4.20, 4.40, 4.42, 4.35, 4.28, 4.05, 3.90, 3.85, 3.82, 3.98, 4.02, 4.22, 4.55, 4.52, 4.42, 4.25, 4.12, 4.18],
  '10y': [4.30, 4.50, 4.65, 4.55, 4.65, 4.40, 4.10, 4.22, 4.38, 4.40, 4.35, 4.28, 4.12, 4.00, 3.98, 3.98, 4.20, 4.28, 4.58, 4.88, 4.75, 4.65, 4.58, 4.48, 4.52],
  '20y': [4.50, 4.72, 4.88, 4.80, 4.90, 4.68, 4.38, 4.50, 4.65, 4.68, 4.62, 4.55, 4.38, 4.28, 4.25, 4.28, 4.50, 4.62, 4.95, 5.30, 5.18, 5.08, 5.00, 4.95, 5.08],
  '30y': [4.55, 4.78, 4.98, 4.95, 5.05, 4.82, 4.52, 4.65, 4.80, 4.82, 4.78, 4.72, 4.55, 4.45, 4.42, 4.45, 4.68, 4.82, 5.12, 5.48, 5.35, 5.22, 5.15, 5.10, 5.18],
}

// ─── Yield PCA (Jacobi) ───────────────────────────────────────────────────────

export interface YieldPCAResult {
  scores: number[][]      // [N_MONTHS][3]
  loadings: number[][]    // [3][N_TENORS]
  explainedVar: number[]
  means: number[]
}

function computeYieldPCA(): YieldPCAResult {
  const N = N_MONTHS, M = YIELD_TENORS.length
  const data: number[][] = Array.from({ length: N }, (_, t) =>
    YIELD_TENORS.map(tenor => SYNTHETIC_YIELDS[tenor][t])
  )
  const means = Array.from({ length: M }, (_, j) =>
    data.reduce((s, row) => s + row[j], 0) / N
  )
  const centered = data.map(row => row.map((v, j) => v - means[j]))
  const cov: number[][] = Array.from({ length: M }, (_, i) =>
    Array.from({ length: M }, (_, j) =>
      centered.reduce((s, row) => s + row[i] * row[j], 0) / (N - 1)
    )
  )
  const { values, vectors } = jacobiEigen(cov)
  const totalVar = values.reduce((s, v) => s + Math.abs(v), 0)
  const rawLoadings = vectors.slice(0, 3)
  // Sign conventions: PC1 → 10y positive (idx=2), PC2 → 30y positive (idx=4), PC3 → 5y positive (idx=1)
  const pivots = [rawLoadings[0][2], rawLoadings[1][4], rawLoadings[2][1]]
  const loadings = rawLoadings.map((l, k) => {
    const sign = pivots[k] < 0 ? -1 : 1
    return l.map(v => v * sign)
  })
  const scores = centered.map(row =>
    loadings.map(loading => loading.reduce((s, l, j) => s + l * row[j], 0))
  )
  return { scores, loadings, explainedVar: values.slice(0, 3).map(v => v / totalVar), means }
}

export const YIELD_PCA: YieldPCAResult = computeYieldPCA()

// ─── Color helpers ────────────────────────────────────────────────────────────

function formatCellValue(value: number, units: string): string {
  if (units === 'FX Rate') return value.toFixed(3)
  if (units === 'bps') return value.toFixed(0)
  if (Math.abs(value) >= 1000) return value.toFixed(0)
  return value.toFixed(1)
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend() {
  const steps = [
    { bg: '#a85a4b', fg: '#fbeee9', label: '≥ +2σ' },
    { bg: '#7a4a42', fg: '#f1ddd7', label: '+1σ' },
    { bg: '#3f3034', fg: '#e4c9c2', label: '+0.5σ' },
    { bg: '#151b23', fg: '#c6ced8', label: '0' },
    { bg: '#22303d', fg: '#bcd6e6', label: '−0.5σ' },
    { bg: '#2f5670', fg: '#e3f0f7', label: '−1σ' },
    { bg: '#4a86a8', fg: '#f2f9fc', label: '≤ −2σ' },
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ color: '#8995a2', fontSize: 11, marginRight: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Z-score scale</span>
      {steps.map(s => (
        <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 36, height: 20, background: s.bg, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: s.fg, fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 600 }}>{s.label}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Heatmap Table ────────────────────────────────────────────────────────────

const CELL_W = 52, CELL_H = 28, INDICATOR_W_DEFAULT = 190
const RIGHT_COL_W = 76, UNITS_COL_W = 88
function HeatmapTable() {
  const [indicatorW, setIndicatorW] = useState(INDICATOR_W_DEFAULT)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: indicatorW }
    function onMouseMove(ev: MouseEvent) {
      if (!dragRef.current) return
      setIndicatorW(Math.max(120, dragRef.current.startW + ev.clientX - dragRef.current.startX))
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
    return { width: CELL_W, minWidth: CELL_W, maxWidth: CELL_W, height: CELL_H, textAlign: 'center', fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 10, fontWeight: 500, color: fg, background: bg, padding: 0, border: '1px solid rgba(7,9,12,0.5)', userSelect: 'none' }
  }
  const hdrCell: React.CSSProperties = { width: CELL_W, minWidth: CELL_W, maxWidth: CELL_W, textAlign: 'center', color: '#9aa5b1', fontSize: 10, fontFamily: "'Geist Mono', ui-monospace, monospace", padding: '5px 2px', fontWeight: 600, whiteSpace: 'nowrap', background: stickyBg, borderBottom: '1px solid rgba(200,220,240,0.07)', position: 'sticky', top: 0, zIndex: 2 }
  const indHdr: React.CSSProperties = { width: indicatorW, minWidth: indicatorW, maxWidth: indicatorW, textAlign: 'left', color: '#9aa5b1', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '5px 12px', fontWeight: 600, background: stickyBg, borderBottom: '1px solid rgba(200,220,240,0.07)', position: 'sticky', top: 0, left: 0, zIndex: 4, overflow: 'visible' }
  const rHdr = (ro: number): React.CSSProperties => ({ width: RIGHT_COL_W, minWidth: RIGHT_COL_W, maxWidth: RIGHT_COL_W, textAlign: 'center', color: '#9aa5b1', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '5px 4px', fontWeight: 600, background: stickyBg, borderBottom: '1px solid rgba(200,220,240,0.07)', position: 'sticky', top: 0, right: ro, zIndex: 4, whiteSpace: 'nowrap' })
  const indCell: React.CSSProperties = { width: indicatorW, minWidth: indicatorW, maxWidth: indicatorW, color: '#c3ccd6', fontSize: 11, padding: '0 12px', height: CELL_H, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: 0, background: stickyBg, borderBottom: '1px solid rgba(200,220,240,0.04)', borderRight: '1px solid rgba(200,220,240,0.07)', zIndex: 1 }
  const grpRow: React.CSSProperties = { background: 'rgba(200,220,240,0.025)', color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, padding: '4px 12px', height: 22, position: 'sticky', left: 0, zIndex: 1 }
  const rCell: React.CSSProperties = { width: RIGHT_COL_W, minWidth: RIGHT_COL_W, maxWidth: RIGHT_COL_W, textAlign: 'center', fontSize: 10, fontFamily: "'Geist Mono', ui-monospace, monospace", padding: 0, height: CELL_H, borderBottom: '1px solid rgba(200,220,240,0.04)', borderLeft: '1px solid rgba(200,220,240,0.06)', background: stickyBg }
  const uHdr = (ro: number): React.CSSProperties => ({ width: UNITS_COL_W, minWidth: UNITS_COL_W, maxWidth: UNITS_COL_W, textAlign: 'center', color: '#9aa5b1', fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '0.05em', padding: '5px 4px', fontWeight: 600, background: stickyBg, borderBottom: '1px solid rgba(200,220,240,0.07)', position: 'sticky' as const, top: 0, right: ro, zIndex: 4, whiteSpace: 'nowrap' as const })

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
                <div style={{ width: 2, height: 14, borderRadius: 1, background: 'rgba(200,220,240,0.18)' }} />
              </div>
            </th>
            {MONTH_COLS.map((m, i) => <th key={i} style={hdrCell}>{m}</th>)}
            <th style={{ ...rHdr(R_LASTUPD), borderLeft: '1px solid rgba(200,220,240,0.07)' }}>Last Upd</th>
            <th style={{ ...uHdr(R_UNITS), borderLeft: '1px solid rgba(200,220,240,0.04)' }}>Units</th>
            <th style={{ ...rHdr(R_AS_OF_MTG), borderLeft: '1px solid rgba(200,220,240,0.04)' }}>As of MTG</th>
            <th style={{ ...rHdr(R_LATEST), borderLeft: '1px solid rgba(200,220,240,0.04)' }}>Latest</th>
            <th style={{ ...rHdr(R_CHANGE), borderLeft: '1px solid rgba(200,220,240,0.04)' }}>Change</th>
          </tr>
        </thead>
        <tbody>
          {GROUPS.map(group => (
            <React.Fragment key={group.name}>
              <tr style={{ background: 'rgba(200,220,240,0.025)' }}>
                <td colSpan={N_MONTHS + 6} style={grpRow}>{group.name}</td>
              </tr>
              {group.indicators.map(ind => (
                <tr key={ind.name}
                  onMouseEnter={e => { e.currentTarget.querySelectorAll('td').forEach(td => { if ((td as HTMLElement).dataset.heatcell !== '1') (td as HTMLElement).style.background = 'rgba(200,220,240,0.04)' }) }}
                  onMouseLeave={e => { e.currentTarget.querySelectorAll('td').forEach(td => { if ((td as HTMLElement).dataset.heatcell !== '1') (td as HTMLElement).style.background = stickyBg }) }}
                >
                  <td style={indCell}>{ind.name}</td>
                  {ind.zscores.map((z, ci) => (
                    <td key={ci} style={cellStyle(z)} data-heatcell="1">
                      {formatCellValue(ind.mean + z * ind.std, ind.units)}
                    </td>
                  ))}
                  <td style={{ ...rCell, position: 'sticky', right: R_LASTUPD, zIndex: 2, color: '#9aa5b1', fontSize: 9 }}>{ind.lastUpd}</td>
                  <td style={{ width: UNITS_COL_W, minWidth: UNITS_COL_W, maxWidth: UNITS_COL_W, textAlign: 'center', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace", padding: 0, height: CELL_H, borderBottom: '1px solid rgba(200,220,240,0.04)', borderLeft: '1px solid rgba(200,220,240,0.06)', background: stickyBg, position: 'sticky', right: R_UNITS, zIndex: 2, color: '#8995a2', whiteSpace: 'nowrap' }}>{ind.units}</td>
                  <td style={{ ...rCell, position: 'sticky', right: R_AS_OF_MTG, zIndex: 2, color: '#c6ced8' }}>{ind.asOfLastMtg}</td>
                  <td style={{ ...rCell, position: 'sticky', right: R_LATEST, zIndex: 2, color: '#e4eaf1', fontWeight: 600 }}>{ind.latest}</td>
                  <td style={{ ...rCell, position: 'sticky', right: R_CHANGE, zIndex: 2, fontWeight: 600, color: ind.change === '—' ? '#2a333d' : ind.change.startsWith('+') ? '#6fc2a2' : '#e2826f' }}>{ind.change}</td>
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
  { key: 'broadMacro', label: 'Broad Macro', color: '#c6ced8', groupIndices: [0, 1, 3, 4, 5] },
  { key: 'growth',     label: 'Growth',      color: '#6fc2a2', groupIndices: [0, 1, 2] },
  { key: 'inflation',  label: 'Inflation',   color: '#e2826f', groupIndices: [5] },
  { key: 'employment', label: 'Employment',  color: '#86c0de', groupIndices: [3] },
  { key: 'wages',      label: 'Wages',       color: '#b49fdb', groupIndices: [4] },
]

function computeFactor(groupIndices: number[]): number[] {
  const all: number[][] = []
  groupIndices.forEach(gi => GROUPS[gi].indicators.forEach(ind => all.push(ind.zscores)))
  return Array.from({ length: N_MONTHS }, (_, t) => {
    const vals = all.map(zs => zs[t])
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100) / 100
  })
}

const FACTOR_SERIES: Record<string, number[]> = Object.fromEntries(
  DFM_FACTORS.map(f => [f.key, computeFactor(f.groupIndices)])
)
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
        <h2 style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 500, letterSpacing: '-0.01em', margin: 0 }}>Macro Factors — DFM Synthesis</h2>
        <p style={{ color: '#8995a2', fontSize: 12, margin: '4px 0 0' }}>5 factors extracted via Dynamic Factor Model &middot; weekly monitoring of UK macro fundamentals</p>
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={DFM_CHART_DATA} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
              <CartesianGrid stroke="rgba(200,220,240,0.05)" strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={{ stroke: 'rgba(200,220,240,0.08)' }} interval={3} />
              <YAxis domain={[-2.5, 2.5]} tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={false} tickCount={6} />
              <ReferenceLine y={0} stroke="rgba(200,220,240,0.12)" strokeDasharray="4 4" />
              <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }} labelStyle={{ color: '#9aa5b1', marginBottom: 4 }} formatter={(value: number, name: string) => { const f = DFM_FACTORS.find(f => f.key === name); return [value.toFixed(2) + 'σ', f?.label ?? name] }} />
              {DFM_FACTORS.map(f => <Line key={f.key} type="monotone" dataKey={f.key} stroke={f.color} strokeWidth={1.8} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />)}
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 8 }}>
            {DFM_FACTORS.map(f => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 24, height: 2, borderRadius: 1, background: f.color }} />
                <span style={{ color: '#c6ced8', fontSize: 11 }}>{f.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <p style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Factor summary</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr>{['Factor','Level (σ)','Δ1m','Δ3m','Δ12m','Z'].map((h, i) => <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', color: '#8995a2', fontWeight: 600, fontSize: 10, padding: '4px 6px 6px', borderBottom: '1px solid rgba(200,220,240,0.07)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {DFM_FACTORS.map(f => {
                  const st = FACTOR_STATS[f.key]
                  const lc = st.current > 0.3 ? '#e2826f' : st.current < -0.3 ? '#86c0de' : '#c6ced8'
                  const dc = (d: number) => d > 0.05 ? '#e2826f' : d < -0.05 ? '#86c0de' : '#8995a2'
                  const zc = st.zscore > 0.5 ? '#e2826f' : st.zscore < -0.5 ? '#86c0de' : '#c6ced8'
                  const fmt = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2)
                  return (
                    <tr key={f.key}>
                      <td style={{ padding: '5px 6px', borderBottom: '1px solid rgba(200,220,240,0.04)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, flexShrink: 0 }} />
                          <span style={{ color: '#c3ccd6', fontSize: 11, whiteSpace: 'nowrap' }}>{f.label}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(200,220,240,0.04)', fontFamily: "'Geist Mono', ui-monospace, monospace", color: lc, fontWeight: 600 }}>{fmt(st.current)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(200,220,240,0.04)', fontFamily: "'Geist Mono', ui-monospace, monospace", color: dc(st.d1m) }}>{fmt(st.d1m)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(200,220,240,0.04)', fontFamily: "'Geist Mono', ui-monospace, monospace", color: dc(st.d3m) }}>{fmt(st.d3m)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(200,220,240,0.04)', fontFamily: "'Geist Mono', ui-monospace, monospace", color: dc(st.d12m) }}>{fmt(st.d12m)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(200,220,240,0.04)', fontFamily: "'Geist Mono', ui-monospace, monospace", color: zc, fontWeight: 600 }}>{fmt(st.zscore)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ background: 'rgba(200,220,240,0.02)', border: '1px solid rgba(200,220,240,0.06)', borderRadius: 6, padding: '12px 14px' }}>
            <p style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Methodology</p>
            {[
              'Broad Macro: avg z-score across activity, inflation, labour & wage series',
              'Growth: Business Activity, Real Activity & Housing blocks',
              'Inflation: Inflation block (~10 indicators)',
              'Employment: Labour Market block (~8 indicators)',
              'Wages: Wages block (~7 indicators)',
            ].map((note, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5 }}>
                <span style={{ color: DFM_FACTORS[i].color, fontSize: 10, flexShrink: 0, marginTop: 1 }}>●</span>
                <span style={{ color: '#8995a2', fontSize: 10, lineHeight: 1.45 }}>{note}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── OLS helpers ─────────────────────────────────────────────────────────────

// ─── PC Regressions ───────────────────────────────────────────────────────────

const REG_FACTORS: { key: string; label: string; color: string }[] = [
  { key: 'broadMacro', label: 'Broad Macro', color: '#c6ced8' },
  { key: 'growth',     label: 'Growth',      color: '#6fc2a2' },
  { key: 'inflation',  label: 'Inflation',   color: '#e2826f' },
  { key: 'employment', label: 'Employment',  color: '#86c0de' },
]
const REG_X: number[][] = Array.from({ length: N_MONTHS }, (_, t) => REG_FACTORS.map(f => FACTOR_SERIES[f.key][t]))
const PC1_REG: OLSResult = ols(YIELD_PCA.scores.map(s => s[0]), REG_X)
const PC2_REG: OLSResult = ols(YIELD_PCA.scores.map(s => s[1]), REG_X)

const PC_META = [
  { key: 'pc1', label: 'PC1 — Level',     color: '#d6ad66' },
  { key: 'pc2', label: 'PC2 — Slope',     color: '#6fc2a2' },
  { key: 'pc3', label: 'PC3 — Curvature', color: '#b49fdb' },
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
          <h2 style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 500, letterSpacing: '-0.01em', margin: 0 }}>Gilt Yield Curve — Principal Components</h2>
          <p style={{ color: '#8995a2', fontSize: 12, margin: '4px 0 0' }}>PCA on 2/5/10/20/30y Gilt yields &middot; synthetic data</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {PC_META.map((pc, k) => (
            <div key={pc.key} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6, padding: '4px 10px' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: pc.color }} />
              <span style={{ color: '#c6ced8', fontSize: 11 }}>{pc.label}</span>
              <span style={{ color: pc.color, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 600 }}>{(YIELD_PCA.explainedVar[k] * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={PC_CHART_DATA} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(200,220,240,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={{ stroke: 'rgba(200,220,240,0.08)' }} interval={3} />
          <YAxis tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(2)} />
          <ReferenceLine y={0} stroke="rgba(200,220,240,0.12)" strokeDasharray="4 4" />
          <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }} labelStyle={{ color: '#9aa5b1', marginBottom: 4 }} formatter={(v: number, n: string) => { const pc = PC_META.find(p => p.key === n); return [v.toFixed(3), pc?.label ?? n] }} />
          {PC_META.map(pc => <Line key={pc.key} type="monotone" dataKey={pc.key} stroke={pc.color} strokeWidth={1.8} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />)}
        </LineChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 20 }}>
        <p style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Factor loadings (eigenvectors)</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', color: '#8995a2', fontWeight: 600, fontSize: 10, padding: '4px 8px 6px 0', borderBottom: '1px solid rgba(200,220,240,0.07)', width: 120 }}>Factor</th>
              {YIELD_TENORS.map(t => <th key={t} style={{ textAlign: 'right', color: '#8995a2', fontWeight: 600, fontSize: 10, padding: '4px 6px 6px', borderBottom: '1px solid rgba(200,220,240,0.07)' }}>{t}</th>)}
            </tr>
          </thead>
          <tbody>
            {PC_META.map((pc, k) => (
              <tr key={pc.key}>
                <td style={{ padding: '5px 8px 5px 0', borderBottom: '1px solid rgba(200,220,240,0.04)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: pc.color, flexShrink: 0 }} />
                    <span style={{ color: '#c3ccd6', fontSize: 11 }}>{pc.label}</span>
                  </div>
                </td>
                {YIELD_PCA.loadings[k].map((l, j) => (
                  <td key={j} style={{ textAlign: 'right', padding: '5px 6px', borderBottom: '1px solid rgba(200,220,240,0.04)', fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 10, color: l > 0.05 ? '#6fc2a2' : l < -0.05 ? '#e2826f' : '#8995a2' }}>
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

// ─── PC Regression Section ────────────────────────────────────────────────────

const REG_CHART_DATA = MONTH_COLS.map((month, t) => ({
  month,
  pc1Actual: Math.round(YIELD_PCA.scores[t][0] * 1000) / 1000,
  pc1Fitted: Math.round(PC1_REG.fitted[t] * 1000) / 1000,
  pc2Actual: Math.round(YIELD_PCA.scores[t][1] * 1000) / 1000,
  pc2Fitted: Math.round(PC2_REG.fitted[t] * 1000) / 1000,
}))

function tStatColor(t: number): string {
  const a = Math.abs(t)
  return a >= 2.58 ? '#6fc2a2' : a >= 1.96 ? '#dfbb78' : a >= 1.65 ? '#c6ced8' : '#8995a2'
}

function RegressionTable({ reg, pcLabel }: { reg: OLSResult; pcLabel: string }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
        <span style={{ color: '#c6ced8', fontSize: 13, fontWeight: 600 }}>{pcLabel}</span>
        <span style={{ background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.09)', borderRadius: 6, padding: '2px 8px', fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 11, color: '#eef2f6' }}>R² = {reg.rSquared.toFixed(3)}</span>
        <span style={{ background: 'rgba(200,220,240,0.05)', border: '1px solid rgba(200,220,240,0.09)', borderRadius: 6, padding: '2px 8px', fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 11, color: '#c6ced8' }}>adj. R² = {reg.adjRSquared.toFixed(3)}</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead><tr>{['Factor','Coeff.','t-stat','Sig.'].map(h => <th key={h} style={{ textAlign: h === 'Factor' ? 'left' : 'right', color: '#8995a2', fontWeight: 600, fontSize: 10, padding: '4px 8px 6px', borderBottom: '1px solid rgba(200,220,240,0.07)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
        <tbody>
          {REG_FACTORS.map((f, k) => {
            const b = reg.coefficients[k], t = reg.tStats[k]
            return (
              <tr key={f.key}>
                <td style={{ padding: '5px 8px', borderBottom: '1px solid rgba(200,220,240,0.04)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: f.color, flexShrink: 0 }} />
                    <span style={{ color: '#c3ccd6', fontSize: 11 }}>{f.label}</span>
                  </div>
                </td>
                <td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(200,220,240,0.04)', fontFamily: "'Geist Mono', ui-monospace, monospace", color: b >= 0 ? '#6fc2a2' : '#e2826f', fontWeight: 600 }}>{b >= 0 ? '+' : ''}{b.toFixed(4)}</td>
                <td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(200,220,240,0.04)', fontFamily: "'Geist Mono', ui-monospace, monospace", color: tStatColor(t) }}>{t >= 0 ? '+' : ''}{t.toFixed(2)}</td>
                <td style={{ textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid rgba(200,220,240,0.04)', color: tStatColor(t), fontWeight: 600 }}>{Math.abs(t) >= 2.58 ? '***' : Math.abs(t) >= 1.96 ? '**' : Math.abs(t) >= 1.65 ? '*' : '—'}</td>
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
        <h2 style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 500, letterSpacing: '-0.01em', margin: 0 }}>Rates–Macro Linkage — PC Regressions</h2>
        <p style={{ color: '#8995a2', fontSize: 12, margin: '4px 0 0' }}>OLS: PC1 &amp; PC2 of Gilt curve regressed on macro factors &middot; *** p&lt;1% &nbsp;** p&lt;5% &nbsp;* p&lt;10%</p>
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
        {[
          { label: 'PC1 — Level', actualKey: 'pc1Actual', fittedKey: 'pc1Fitted', color: '#d6ad66' },
          { label: 'PC2 — Slope', actualKey: 'pc2Actual', fittedKey: 'pc2Fitted', color: '#6fc2a2' },
        ].map(({ label, actualKey, fittedKey, color }) => (
          <div key={label} style={{ flex: '1 1 400px', minWidth: 0 }}>
            <p style={{ color: '#9aa5b1', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>{label}</p>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={REG_CHART_DATA} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="rgba(200,220,240,0.05)" strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fill: '#8995a2', fontSize: 8, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={{ stroke: 'rgba(200,220,240,0.08)' }} interval={4} />
                <YAxis tick={{ fill: '#8995a2', fontSize: 8, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(2)} />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.10)" strokeDasharray="4 4" />
                <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, fontSize: 10, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }} labelStyle={{ color: '#9aa5b1', marginBottom: 4 }} formatter={(v: number, n: string) => [v.toFixed(3), n.includes('Actual') ? 'Actual' : 'Fitted']} />
                <Line type="monotone" dataKey={actualKey} stroke={color} strokeWidth={1.8} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                <Line type="monotone" dataKey={fittedKey} stroke="rgba(200,220,240,0.45)" strokeWidth={1.2} strokeDasharray="5 3" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 2, background: color, borderRadius: 1 }} /><span style={{ color: '#8995a2', fontSize: 10 }}>Actual</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 0, borderTop: '2px dashed rgba(200,220,240,0.45)', borderRadius: 1 }} /><span style={{ color: '#8995a2', fontSize: 10 }}>Fitted</span></div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}><RegressionTable reg={PC1_REG} pcLabel="PC1 — Level" /></div>
        <div style={{ width: '1px', background: 'rgba(200,220,240,0.07)', flexShrink: 0 }} />
        <div style={{ flex: '1 1 280px', minWidth: 0 }}><RegressionTable reg={PC2_REG} pcLabel="PC2 — Slope" /></div>
      </div>
    </div>
  )
}

// ─── 10y Gilt Fair Value ──────────────────────────────────────────────────────

const GILT_10Y_IDX = YIELD_TENORS.indexOf('10y') // = 2

const GILT_10Y_FAIR_VALUE: number[] = Array.from({ length: N_MONTHS }, (_, t) =>
  YIELD_PCA.means[GILT_10Y_IDX]
  + YIELD_PCA.loadings[0][GILT_10Y_IDX] * PC1_REG.fitted[t]
  + YIELD_PCA.loadings[1][GILT_10Y_IDX] * PC2_REG.fitted[t]
)
const GILT_10Y_PCA_FITTED: number[] = Array.from({ length: N_MONTHS }, (_, t) =>
  YIELD_PCA.means[GILT_10Y_IDX]
  + YIELD_PCA.loadings[0][GILT_10Y_IDX] * YIELD_PCA.scores[t][0]
  + YIELD_PCA.loadings[1][GILT_10Y_IDX] * YIELD_PCA.scores[t][1]
)
const GILT_10Y_RICHCHEAP: number[] = SYNTHETIC_YIELDS['10y'].map(
  (y, t) => Math.round((y - GILT_10Y_FAIR_VALUE[t]) * 100 * 10) / 10
)

// ─── Curve FV table ───────────────────────────────────────────────────────────

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

// ─── Gilt Fair Value Section ──────────────────────────────────────────────────

const FV_CHART_DATA = MONTH_COLS.map((month, t) => ({
  month,
  actual:    Math.round(SYNTHETIC_YIELDS['10y'][t] * 100) / 100,
  pcaFitted: Math.round(GILT_10Y_PCA_FITTED[t] * 100) / 100,
  fairValue: Math.round(GILT_10Y_FAIR_VALUE[t] * 100) / 100,
  richCheap: GILT_10Y_RICHCHEAP[t],
}))

function GiltFairValueSection() {
  const current = SYNTHETIC_YIELDS['10y'][N_MONTHS - 1]
  const fv = GILT_10Y_FAIR_VALUE[N_MONTHS - 1]
  const rc = GILT_10Y_RICHCHEAP[N_MONTHS - 1]
  const rcColor = rc > 5 ? '#6fc2a2' : rc < -5 ? '#e2826f' : '#c6ced8'
  const rcLabel = rc < 0 ? 'Rich' : 'Cheap'
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 500, letterSpacing: '-0.01em', margin: 0 }}>10y Gilt — Macro Fair Value</h2>
          <p style={{ color: '#8995a2', fontSize: 12, margin: '4px 0 0' }}>PCA inversion: ŷ = μ + L₁·PĈ₁ + L₂·PĈ₂ &middot; macro-implied level via OLS</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { label: 'Actual', value: `${current.toFixed(2)}%`, color: '#d6ad66' },
            { label: 'PCA (PC1+PC2)', value: `${GILT_10Y_PCA_FITTED[N_MONTHS - 1].toFixed(2)}%`, color: '#6fc2a2' },
            { label: 'Macro Fair Value', value: `${fv.toFixed(2)}%`, color: '#c6ced8' },
            { label: rcLabel, value: `${Math.abs(rc).toFixed(1)} bps`, color: rcColor },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6, padding: '6px 12px', textAlign: 'center' }}>
              <div style={{ color: '#8995a2', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
              <div style={{ color, fontSize: 13, fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 600 }}>{value}</div>
            </div>
          ))}
        </div>
      </div>
      <p style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Actual vs macro fair value (%)</p>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={FV_CHART_DATA} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(200,220,240,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={{ stroke: 'rgba(200,220,240,0.08)' }} interval={3} />
          <YAxis tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={false} tickFormatter={v => `${v.toFixed(2)}%`} domain={['auto', 'auto']} />
          <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace" }} labelStyle={{ color: '#9aa5b1', marginBottom: 4 }} formatter={(v: number, name: string) => [`${v.toFixed(3)}%`, name === 'actual' ? 'Actual 10y Gilt' : name === 'pcaFitted' ? 'PCA (PC1+PC2)' : 'Macro Fair Value']} />
          <Line type="monotone" dataKey="actual"    stroke="#d6ad66" strokeWidth={2}   dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
          <Line type="monotone" dataKey="pcaFitted" stroke="#6fc2a2" strokeWidth={1.5} strokeDasharray="3 2" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
          <Line type="monotone" dataKey="fairValue" stroke="#c6ced8" strokeWidth={1.5} strokeDasharray="5 3" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 20, marginTop: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 20, height: 2, background: '#d6ad66', borderRadius: 1 }} /><span style={{ color: '#8995a2', fontSize: 10 }}>Actual 10y Gilt</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 20, height: 0, borderTop: '2px dashed #6fc2a2' }} /><span style={{ color: '#8995a2', fontSize: 10 }}>PCA reconstruction (PC1+PC2)</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 20, height: 0, borderTop: '2px dashed #c6ced8' }} /><span style={{ color: '#8995a2', fontSize: 10 }}>Macro fair value</span></div>
      </div>
      <p style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>Rich / cheap vs fair value (bps) — positive = cheap, negative = rich</p>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={FV_CHART_DATA} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <defs>
            <linearGradient id="gradCheapUK" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#6fc2a2" stopOpacity={0.25} /><stop offset="95%" stopColor="#6fc2a2" stopOpacity={0.02} /></linearGradient>
            <linearGradient id="gradRichUK" x1="0" y1="1" x2="0" y2="0"><stop offset="5%" stopColor="#e2826f" stopOpacity={0.25} /><stop offset="95%" stopColor="#e2826f" stopOpacity={0.02} /></linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(200,220,240,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={{ stroke: 'rgba(200,220,240,0.08)' }} interval={3} />
          <YAxis tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={false} tickFormatter={v => `${v > 0 ? '+' : ''}${v}bp`} />
          <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" />
          <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace" }} labelStyle={{ color: '#9aa5b1', marginBottom: 4 }} formatter={(v: number) => [`${v > 0 ? '+' : ''}${v.toFixed(1)} bps`, v >= 0 ? 'Cheap' : 'Rich']} />
          <Area type="monotone" dataKey="richCheap" stroke="#c6ced8" strokeWidth={1.5} fill={rc >= 0 ? 'url(#gradCheapUK)' : 'url(#gradRichUK)'} />
        </AreaChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 28 }}>
        <p style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>Curve macro fair value</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead><tr>{['', 'Current', 'Fair Value', 'Resid (bp)', 'StdDev (bp)', 'Z-Score'].map((h, i) => <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', color: '#8995a2', fontWeight: 600, fontSize: 10, padding: '4px 10px 6px', borderBottom: '1px solid rgba(200,220,240,0.07)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>
            {CURVE_FV_ROWS.map((row, i) => {
              const absZ = Math.abs(row.zscore)
              const zBg = absZ >= 1.5 ? (row.zscore > 0 ? 'rgba(111,194,162,0.12)' : 'rgba(226,130,111,0.12)') : 'transparent'
              const zColor = row.zscore > 0.5 ? '#6fc2a2' : row.zscore < -0.5 ? '#e2826f' : '#c6ced8'
              const sep = i === 4 ? '1px solid rgba(200,220,240,0.10)' : '1px solid rgba(200,220,240,0.04)'
              return (
                <tr key={row.label} style={{ background: zBg }}>
                  <td style={{ padding: '6px 10px', borderBottom: sep, color: '#c3ccd6', fontWeight: 600, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{row.label}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }}>{row.isSpread ? `${row.current.toFixed(1)} bp` : `${row.current.toFixed(2)}%`}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#c6ced8' }}>{row.isSpread ? `${row.fv.toFixed(1)} bp` : `${row.fv.toFixed(2)}%`}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: "'Geist Mono', ui-monospace, monospace", color: row.resid > 0 ? '#6fc2a2' : '#e2826f' }}>{row.resid > 0 ? '+' : ''}{row.resid.toFixed(1)}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#8995a2' }}>{row.stddev.toFixed(1)}</td>
                  <td style={{ textAlign: 'right', padding: '6px 10px', borderBottom: sep, fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 600, color: zColor }}>{row.zscore > 0 ? '+' : ''}{row.zscore.toFixed(2)}</td>
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
  const monthly = SYNTHETIC_YIELDS[tenor]
  const seed = _TENOR_SEEDS[tenor] ?? 2.0
  const out: number[] = []
  for (let m = 0; m < N_MONTHS - 1; m++) {
    const y0 = monthly[m], y1 = monthly[m + 1]
    for (let d = 0; d < BDAYS_PER_MONTH; d++) {
      const interp = y0 + (y1 - y0) * (d / BDAYS_PER_MONTH)
      const noise = 0.018 * Math.sin((m * 7 + d) * 1.31 + seed) + 0.012 * Math.cos((m * 3 + d) * 2.73 + seed * 0.7)
      out.push(interp + noise)
    }
  }
  out.push(monthly[N_MONTHS - 1])
  return out
}

const DAILY_2Y  = _genDailyYield('2y')
const DAILY_10Y = _genDailyYield('10y')

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
    const monthLabel = (t % BDAYS_PER_MONTH === 0) ? MONTH_COLS[Math.floor(t / BDAYS_PER_MONTH)] : null
    results.push({ idx: t - ROLL_DAYS, pct: Math.round(match / ROLL_DAYS * 1000) / 10, monthLabel })
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
      if      (dLong < 0 && dSpread > 0) bs++
      else if (dLong < 0 && dSpread <= 0) bf++
      else if (dLong > 0 && dSpread > 0) bes++
      else                                bef++
    }
    const total = bs + bf + bes + bef || 1
    const monthLabel = (t % BDAYS_PER_MONTH === 0) ? MONTH_COLS[Math.floor(t / BDAYS_PER_MONTH)] : null
    results.push({ idx: t - ROLL_DAYS, monthLabel, bullSteep: Math.round(bs / total * 100), bullFlat: Math.round(bf / total * 100), bearSteep: Math.round(bes / total * 100), bearFlat: Math.round(bef / total * 100) })
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
          <h2 style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 500, letterSpacing: '-0.01em', margin: 0 }}>2s10s Gilt Directionality</h2>
          <p style={{ color: '#8995a2', fontSize: 12, margin: '4px 0 0' }}>% of daily moves bull-steepening or bear-flattening &middot; 3-month rolling window</p>
        </div>
        <div style={{ background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6, padding: '6px 14px', textAlign: 'center' }}>
          <div style={{ color: '#8995a2', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Current</div>
          <div style={{ color: DIR_CURRENT_PCT > 55 ? '#6fc2a2' : DIR_CURRENT_PCT < 40 ? '#e2826f' : '#d6ad66', fontSize: 20, fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 600 }}>{DIR_CURRENT_PCT.toFixed(1)}%</div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(200,220,240,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="idx" type="number" scale="linear" domain={[0, DAILY_DIR.length - 1]} ticks={DIR_MONTH_TICKS} tickFormatter={idx => { const pt = DAILY_DIR.find(d => d.idx === idx); return pt?.monthLabel ?? '' }} tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={{ stroke: 'rgba(200,220,240,0.08)' }} interval={0} />
          <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={false} tickCount={6} />
          <ReferenceLine y={50} stroke="rgba(200,220,240,0.12)" strokeDasharray="4 4" />
          <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }} labelStyle={{ color: '#9aa5b1', marginBottom: 4 }} labelFormatter={idx => DAILY_DIR.filter(d => d.monthLabel && d.idx <= (idx as number)).slice(-1)[0]?.monthLabel ?? String(idx)} formatter={(v: number) => [`${v.toFixed(1)}%`, 'Bull-Steep + Bear-Flat']} />
          <Line type="monotone" dataKey="pct" stroke="#d6ad66" strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0, fill: '#d6ad66' }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <p style={{ color: '#77828f', fontSize: 9, margin: '8px 0 24px', fontStyle: 'italic' }}>Bull-steepening: Gilts rally &amp; spread widens. Bear-flattening: Gilts sell off &amp; spread narrows. &gt;50% = macro-driven directionality.</p>

      {/* Balance of risks */}
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <p style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Tail likelihoods — 2s10s Gilt</p>
            <p style={{ color: '#77828f', fontSize: 9, margin: '3px 0 0', fontStyle: 'italic' }}>Bull-steepening + bear-flattening &nbsp;·&nbsp; high = deteriorating carry &nbsp;·&nbsp; 3m rolling</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ label: 'Current', val: tailData[tailData.length - 1].tail, color: tailData[tailData.length - 1].tail > tailAvg ? '#e2826f' : '#6fc2a2' }, { label: 'Avg', val: tailAvg, color: '#8995a2' }].map(({ label, val, color }) => (
              <div key={label} style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '4px 12px', textAlign: 'center' }}>
                <div style={{ color: '#8995a2', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
                <div style={{ color, fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 13, fontWeight: 600 }}>{val}%</div>
              </div>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={tailData} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="rgba(200,220,240,0.05)" strokeDasharray="3 3" />
            <XAxis dataKey="idx" type="number" scale="linear" domain={[0, tailData.length - 1]} ticks={ticks} tickFormatter={idx => labelFor(idx as number)} tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={{ stroke: 'rgba(200,220,240,0.08)' }} interval={0} />
            <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={false} tickCount={6} />
            <ReferenceLine y={tailAvg} stroke="rgba(200,220,240,0.25)" strokeDasharray="4 4" label={{ value: 'avg', position: 'insideTopRight', fill: '#8995a2', fontSize: 9 }} />
            <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }} labelStyle={{ color: '#9aa5b1', marginBottom: 4 }} labelFormatter={idx => labelFor(idx as number)} formatter={(v: number) => [`${v}%`, 'Tail likelihood']} />
            <Line type="monotone" dataKey="tail" stroke="#c6ced8" strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── BE Dynamics (10y Gilt breakeven) ────────────────────────────────────────
// UK 10y breakeven = nominal 10y Gilt - 10y real yield (linker)
// Synthetic real yield: nominal - BE where BE oscillates around 3%
const DAILY_10Y_REAL2: number[] = DAILY_10Y.map((nom, i) => {
  const be = 0.030 + 0.003 * Math.sin(i * 0.05 + 0.8) + 0.002 * Math.cos(i * 0.12 + 1.2)
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
      if      (dNom < 0 && dBE > 0) bw++
      else if (dNom < 0 && dBE <= 0) bt++
      else if (dNom > 0 && dBE > 0) bew++
      else                            bet++
    }
    const total = bw + bt + bew + bet || 1
    const monthLabel = (t % BDAYS_PER_MONTH === 0) ? MONTH_COLS[Math.floor(t / BDAYS_PER_MONTH)] : null
    results.push({ idx: t - ROLL_DAYS, monthLabel, bullWide: Math.round(bw / total * 100), bullTight: Math.round(bt / total * 100), bearWide: Math.round(bew / total * 100), bearTight: Math.round(bet / total * 100) })
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
          <h2 style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 500, letterSpacing: '-0.01em', margin: 0 }}>10y Breakeven Dynamics</h2>
          <p style={{ color: '#8995a2', fontSize: 12, margin: '4px 0 0' }}>UK 10y nominal Gilt vs real yield (linker) &middot; 4-regime BE directionality &middot; 3m rolling</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { label: 'Bear-Wide (Expansion)', val: last.bearWide, color: '#e2826f' },
            { label: 'Bull-Tight (Slowdown)', val: last.bullTight, color: '#86c0de' },
          ].map(({ label, val, color }) => (
            <div key={label} style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '4px 12px', textAlign: 'center' }}>
              <div style={{ color: '#8995a2', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>{label}</div>
              <div style={{ color, fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 13, fontWeight: 600 }}>{val}%</div>
            </div>
          ))}
        </div>
      </div>

      {/* Balance of risks chart */}
      <p style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>BE dynamic — orthodox regime (bear-wide + bull-tight)</p>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={BE_DIR.map(d => ({ idx: d.idx, orthodox: d.bearWide + d.bullTight, nonOrthodox: d.bullWide + d.bearTight }))} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(200,220,240,0.05)" strokeDasharray="3 3" />
          <XAxis dataKey="idx" type="number" scale="linear" domain={[0, BE_DIR.length - 1]} ticks={BE_TICKS} tickFormatter={idx => BE_LABEL_FOR(idx as number)} tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={{ stroke: 'rgba(200,220,240,0.08)' }} interval={0} />
          <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={false} tickCount={6} />
          <ReferenceLine y={50} stroke="rgba(200,220,240,0.10)" strokeDasharray="4 4" />
          <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }} labelStyle={{ color: '#9aa5b1', marginBottom: 4 }} labelFormatter={idx => BE_LABEL_FOR(idx as number)} formatter={(v: number, n: string) => [`${v}%`, n === 'orthodox' ? 'Orthodox (bear-wide + bull-tight)' : 'Non-orthodox']} />
          <Line type="monotone" dataKey="orthodox" stroke="#6fc2a2" strokeWidth={1.8} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
          <Line type="monotone" dataKey="nonOrthodox" stroke="#e2826f" strokeWidth={1.2} strokeDasharray="4 3" dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 2, background: '#6fc2a2', borderRadius: 1 }} /><span style={{ color: '#8995a2', fontSize: 10 }}>Orthodox (current: {orthodox}%)</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}><div style={{ width: 18, height: 0, borderTop: '2px dashed #e2826f' }} /><span style={{ color: '#8995a2', fontSize: 10 }}>Non-orthodox</span></div>
      </div>

      {/* Dispersion */}
      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <p style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Dispersion in BE dynamic — 3m rolling</p>
            <p style={{ color: '#77828f', fontSize: 9, margin: '3px 0 0', fontStyle: 'italic' }}>↓ dispersion = conviction &nbsp;·&nbsp; ↑ dispersion = mixed signals</p>
          </div>
          <div style={{ background: 'rgba(200,220,240,0.03)', border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '4px 12px', textAlign: 'center' }}>
            <div style={{ color: '#8995a2', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>avg</div>
            <div style={{ color: '#6fc2a2', fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 13, fontWeight: 600 }}>{BE_DISP_AVG.toFixed(1)}%</div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={BE_ROLLING_DISP} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="rgba(200,220,240,0.05)" strokeDasharray="3 3" />
            <XAxis dataKey="idx" type="number" scale="linear" domain={[0, BE_ROLLING_DISP.length - 1]} ticks={BE_TICKS} tickFormatter={idx => BE_LABEL_FOR(idx as number)} tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={{ stroke: 'rgba(200,220,240,0.08)' }} interval={0} />
            <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fill: '#8995a2', fontSize: 9, fontFamily: "'Geist Mono', ui-monospace, monospace" }} tickLine={false} axisLine={false} tickCount={6} />
            <ReferenceLine y={BE_DISP_AVG} stroke="rgba(111,194,162,0.3)" strokeDasharray="4 4" />
            <Tooltip contentStyle={{ background: '#0b0f14', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 6, fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace", color: '#e4eaf1' }} labelStyle={{ color: '#9aa5b1', marginBottom: 4 }} labelFormatter={idx => BE_LABEL_FOR(idx as number)} formatter={(v: number) => [`${v.toFixed(1)}%`, 'BE dispersion']} />
            <Line type="monotone" dataKey="disp" stroke="#6fc2a2" strokeWidth={1.5} dot={false} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p style={{ color: '#77828f', fontSize: 9, margin: '10px 0 0', fontStyle: 'italic' }}>Orthodox moves: Expansion (bear-wide, BEs widen as growth accelerates) + Slowdown (bull-tight, BEs narrow as growth slows). Non-orthodox: Stagflation (bull-wide) or Goldilocks (bear-tight).</p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function fmtTimestamp(d: Date): string {
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export default function UKHeatmap() {
  const [timestamp, setTimestamp] = useState(() => fmtTimestamp(new Date()))
  const [refreshing, setRefreshing] = useState(false)

  function handleRefresh() {
    setRefreshing(true)
    setTimeout(() => { setTimestamp(fmtTimestamp(new Date())); setRefreshing(false) }, 600)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#07090c' }}>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse at 50% -10%, rgba(106,169,204,0.06) 0%, transparent 55%)' }} />

      <header style={{ position: 'sticky', top: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', background: 'rgba(7,9,12,0.85)', borderBottom: '1px solid rgba(200,220,240,0.07)', backdropFilter: 'blur(12px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <PageTitle category="Macro Fundamentals" categoryId="macro-fundamentals" flag="🇬🇧" title={<>United Kingdom — Macro Heatmap</>} subtitle={<>Dynamic Factor Model · Simulated Data</>} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={handleRefresh} disabled={refreshing}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(200,220,240,0.06)', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6, padding: '5px 12px', color: '#c6ced8', fontSize: 12, cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.5 : 1, transition: 'all 0.15s' }}
            onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.background = 'rgba(200,220,240,0.1)'; e.currentTarget.style.color = '#e4eaf1' } }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(200,220,240,0.06)'; e.currentTarget.style.color = '#c6ced8' }}
          >
            <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6, padding: '5px 12px' }}>
            <span style={{ color: '#8995a2', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Generated</span>
            <span style={{ color: '#c6ced8', fontSize: 11, fontFamily: "'Geist Mono', ui-monospace, monospace", fontWeight: 500 }}>{timestamp}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(106,169,204,0.08)', border: '1px solid rgba(106,169,204,0.18)', borderRadius: 6, padding: '5px 12px' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#6aa9cc', opacity: 0.8 }} />
            <span style={{ color: '#86c0de', fontSize: 11, fontWeight: 500 }}>Jun 2023 – Jun 2025</span>
          </div>
        </div>
      </header>

      <main style={{ position: 'relative', maxWidth: 1600, margin: '0 auto', padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <DFMSection />
        <YieldPCChart />
        <PCRegressionSection />
        <GiltFairValueSection />
        <CurveDynamicsSection />
        <BEDynamicsSection />

        <div style={cardStyle}><Legend /></div>

        <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid rgba(200,220,240,0.06)' }}>
            <h2 style={{ color: '#e4eaf1', fontSize: 14, fontWeight: 500, letterSpacing: '-0.01em', margin: 0 }}>Macro Fundamentals — Z-Score Heatmap</h2>
            <p style={{ color: '#8995a2', fontSize: 12, margin: 0, marginTop: 3 }}>Z-scores relative to 3-year rolling window &middot; 25 monthly observations &middot; 59 indicators across 7 blocks</p>
          </div>
          <div style={{ padding: '0 0 4px' }}><HeatmapTable /></div>
        </div>

        <p style={{ color: '#77828f', fontSize: 10, textAlign: 'center', margin: 0, fontStyle: 'italic' }}>
          Data is simulated for illustrative purposes only. Z-scores generated via deterministic DFM-inspired time series.
        </p>
      </main>
    </div>
  )
}
