import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, LineChart, Line, Legend,
  AreaChart, Area, ScatterChart, Scatter, ZAxis,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface BinStat {
  label: string; bin: number
  mean: number; std: number; t_stat: number; p_value: number
  win_rate: number; n: number
}

interface SeasonalStats {
  n_obs: number; date_range: [string, string]
  dow: BinStat[]; month: BinStat[]; dom: BinStat[]
  tom: BinStat[]; quarter_end: BinStat[]
}


interface BacktestMetrics {
  total_return: number; ann_return: number; sharpe: number
  max_drawdown: number; win_rate: number
  days_in_market: number; pct_in_market: number
}

interface AnnualRow {
  year: number; strat_total: number
  sharpe: number; win_rate: number; n_trades: number
}

interface BacktestResult {
  metrics: BacktestMetrics
  equity_curve: { dates: string[]; strategy: number[]; drawdown: number[]; windowStarts: number[] }
  annual: AnnualRow[]
}

interface CustomLeg {
  startMonth: number; startDay: number
  endMonth: number;   endDay: number
  direction: 1 | -1
}

interface Rule {
  type: 'dow' | 'month' | 'dom_quintile' | 'tom' | 'quarter_end' | 'custom'
  bins: number[]
  direction: 1 | -1
  customLegs?: CustomLeg[]
}

// Fetched series data (from Bloomberg via backend)
interface SeriesData {
  expression: string
  dates: string[]
  values: number[]
  n_obs: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BG = '#080d1a'
const stickyBg = '#080d1a'
const cardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12, padding: 20,
}
const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.08em', color: '#64748b', marginBottom: 12,
}
const ACCENT = '#06B6D4'
const ACCENT_DIM = 'rgba(6,182,212,0.18)'
const ACCENT_BORDER = 'rgba(6,182,212,0.50)'

const DOW_NAMES   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DOM_LABELS  = ['1–6', '7–12', '13–18', '19–23', '24–31']
const TOM_LABELS  = ['-3d', '-2d', '-1d', '+1d', '+2d', '+3d']
const TOM_BINS    = [-3, -2, -1, 1, 2, 3]
const QE_LABELS   = ['-5d','-4d','-3d','-2d','-1d','+1d','+2d','+3d','+4d','+5d']
const QE_BINS     = [-5,-4,-3,-2,-1,1,2,3,4,5]

const RULE_BIN_META: Record<Rule['type'], { labels: string[]; bins: number[] }> = {
  dow:          { labels: DOW_NAMES,   bins: [0,1,2,3,4] },
  month:        { labels: MONTH_NAMES, bins: [1,2,3,4,5,6,7,8,9,10,11,12] },
  dom_quintile: { labels: DOM_LABELS,  bins: [1,2,3,4,5] },
  tom:          { labels: TOM_LABELS,  bins: TOM_BINS },
  quarter_end:  { labels: QE_LABELS,   bins: QE_BINS },
  custom:       { labels: [],          bins: [] },
}

const EXAMPLE_EXPRESSIONS = [
  'GDBR10 Index',
  'GDBR10 Index - GDBR2 Index',
  'GDBR30 Index - 2 * GDBR10 Index + GDBR2 Index',
  'USGG10YR Index - GDBR10 Index',
  'EURUSD Curncy',
  'SPX Index',
]

// ─── Synthetic data (simulation mode) ────────────────────────────────────────

const SYNTHETIC_INSTRUMENTS: Record<string, { label: string; mu: number; sigma: number; trend: number; seed: number }> = {
  '10Y_Bund':    { label: '10Y Bund Yield',        mu: 2.50, sigma: 0.60, trend: -0.0003, seed: 1  },
  '10Y_Gilt':    { label: '10Y Gilt Yield',         mu: 4.00, sigma: 0.70, trend: -0.0002, seed: 2  },
  '10Y_UST':     { label: '10Y UST Yield',          mu: 4.20, sigma: 0.65, trend: -0.0002, seed: 3  },
  'EUR_USD':     { label: 'EUR/USD',                mu: 1.08, sigma: 0.04, trend:  0.0001, seed: 4  },
  'GBP_USD':     { label: 'GBP/USD',               mu: 1.27, sigma: 0.05, trend:  0.0001, seed: 5  },
  'EuroStoxx50': { label: 'EuroStoxx 50',           mu: 4500, sigma: 300,  trend:  0.0008, seed: 6  },
  'FTSE100':     { label: 'FTSE 100',               mu: 7800, sigma: 350,  trend:  0.0006, seed: 7  },
  'SPX':         { label: 'S&P 500',                mu: 4800, sigma: 400,  trend:  0.0010, seed: 8  },
  '2s10s_EUR':   { label: '2s10s EUR Curve (bps)',  mu: 50,   sigma: 40,   trend:  0.0002, seed: 9  },
  '2s10s_GBP':   { label: '2s10s GBP Curve (bps)', mu: 40,   sigma: 35,   trend:  0.0002, seed: 10 },
}

function makeLCG(seed: number) {
  let s = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000 }
}

function generateSyntheticSeries(id: string): SeriesData {
  const cfg = SYNTHETIC_INSTRUMENTS[id]
  const rng = makeLCG(cfg.seed * 7 + 42)

  // Build business-day date array (2010–2025)
  const dates: string[] = []
  const d = new Date(2010, 0, 4) // first Monday of 2010
  while (d.getFullYear() < 2025) {
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10))
    d.setDate(d.getDate() + 1)
  }
  const n = dates.length

  // Generate daily changes
  const changes: number[] = []
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(rng(), 1e-10), u2 = rng()
    const noise = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * (cfg.sigma / Math.sqrt(252))
    const seasonal =
      cfg.sigma * 0.15 * Math.sin(2 * Math.PI * i / 252 + cfg.seed) +
      cfg.sigma * 0.08 * Math.sin(4 * Math.PI * i / 252 + cfg.seed * 1.3) +
      cfg.sigma * 0.05 * Math.sin(12 * Math.PI * i / 252 + cfg.seed * 0.7)
    const dom = new Date(dates[i] + 'T00:00:00').getDate()
    const tomBump = (dom <= 3 || dom >= 28) ? cfg.sigma * 0.08 / Math.sqrt(252) : 0
    const dow2 = new Date(dates[i] + 'T00:00:00').getDay()
    const dowBump = dow2 === 1 ? -cfg.sigma * 0.06 / Math.sqrt(252) : dow2 === 5 ? cfg.sigma * 0.06 / Math.sqrt(252) : 0
    changes.push(noise + seasonal + tomBump + dowBump + cfg.trend)
  }
  const meanChange = changes.reduce((a, b) => a + b, 0) / n
  const values: number[] = []
  let cum = 0
  for (let i = 0; i < n; i++) { cum += changes[i] - meanChange; values.push(+(cfg.mu + cum).toFixed(6)) }

  return { expression: `[Simulated] ${cfg.label}`, dates, values, n_obs: n }
}

// ─── Normal CDF (Abramowitz & Stegun) ────────────────────────────────────────

function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const pdf = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
  const p = 1 - pdf * poly
  return x >= 0 ? p : 1 - p
}

function tTestPValue(tStat: number): number {
  return 2 * (1 - normalCDF(Math.abs(tStat)))
}

// ─── Day-data builder (from fetched dates + values) ──────────────────────────

interface DayData {
  date: Date; ret: number
  dow: number; month: number; dom: number; domQ: number
  tomOffset: number | null; qeOffset: number | null
}

function buildDayData(series: SeriesData): DayData[] {
  const dates = series.dates.map(d => new Date(d + 'T00:00:00'))
  const vals  = series.values

  // Daily returns
  const rets: number[] = []
  for (let i = 1; i < vals.length; i++) rets.push(vals[i] - vals[i - 1])
  if (rets.length === 0) return []

  const retDates = dates.slice(1)

  // Month-end indices (last index of each month in the full series)
  const monthEndIdx: number[] = []
  for (let i = 0; i < dates.length - 1; i++) {
    if (dates[i].getMonth() !== dates[i + 1].getMonth()) monthEndIdx.push(i)
  }
  monthEndIdx.push(dates.length - 1)

  // Quarter-end indices
  const quarterEndIdx: number[] = []
  for (let i = 0; i < dates.length - 1; i++) {
    const q1 = Math.floor(dates[i].getMonth() / 3)
    const q2 = Math.floor(dates[i + 1].getMonth() / 3)
    const y1 = dates[i].getFullYear()
    const y2 = dates[i + 1].getFullYear()
    if (q1 !== q2 || y1 !== y2) quarterEndIdx.push(i)
  }
  quarterEndIdx.push(dates.length - 1)

  // TOM offset map: full-series index → offset
  const tomMap = new Map<number, number>()
  for (const me of monthEndIdx) {
    for (let off = -3; off <= -1; off++) {
      const t = me + off
      if (t >= 0) tomMap.set(t, off)
    }
    for (let off = 1; off <= 3; off++) {
      const t = me + off
      if (t < dates.length) tomMap.set(t, off)
    }
  }

  // QE offset map
  const qeMap = new Map<number, number>()
  for (const qe of quarterEndIdx) {
    for (let off = -5; off <= -1; off++) {
      const t = qe + off
      if (t >= 0) qeMap.set(t, off)
    }
    for (let off = 1; off <= 5; off++) {
      const t = qe + off
      if (t < dates.length) qeMap.set(t, off)
    }
  }

  // Build DayData for return dates (index in full array = i+1)
  return retDates.map((d, ri) => {
    const fullIdx = ri + 1
    const dom = d.getDate()
    const domQ = dom <= 6 ? 1 : dom <= 12 ? 2 : dom <= 18 ? 3 : dom <= 23 ? 4 : 5
    return {
      date: d,
      ret: rets[ri],
      dow: d.getDay() - 1,     // 0=Mon…4=Fri (getDay: 1=Mon…5=Fri)
      month: d.getMonth() + 1, // 1–12
      dom,
      domQ,
      tomOffset: tomMap.get(fullIdx) ?? null,
      qeOffset:  qeMap.get(fullIdx) ?? null,
    }
  })
}

// ─── Bin statistics ───────────────────────────────────────────────────────────

function binStats(vals: number[], label: string, bin: number): BinStat {
  const n = vals.length
  if (n < 2) return { label, bin, mean: 0, std: 0, t_stat: 0, p_value: 1, win_rate: 0.5, n }
  const mean = vals.reduce((a, b) => a + b, 0) / n
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
  const std = Math.sqrt(variance)
  const se = std / Math.sqrt(n)
  const t_stat = se > 0 ? mean / se : 0
  const p_value = tTestPValue(t_stat)
  const win_rate = vals.filter(v => v > 0).length / n
  return {
    label, bin,
    mean: +mean.toFixed(6), std: +std.toFixed(6),
    t_stat: +t_stat.toFixed(3), p_value: +p_value.toFixed(4),
    win_rate: +win_rate.toFixed(4), n,
  }
}

// ─── Seasonal stats + heatmap (computed in browser) ──────────────────────────

function computeSeasonalStats(days: DayData[]): SeasonalStats {
  const dow   = DOW_NAMES.map((lbl, i) => binStats(days.filter(d => d.dow === i).map(d => d.ret), lbl, i))
  const month = MONTH_NAMES.map((lbl, i) => binStats(days.filter(d => d.month === i + 1).map(d => d.ret), lbl, i + 1))
  const dom   = DOM_LABELS.map((lbl, i) => binStats(days.filter(d => d.domQ === i + 1).map(d => d.ret), lbl, i + 1))
  const tom   = TOM_BINS.map((b, i) => binStats(days.filter(d => d.tomOffset === b).map(d => d.ret), TOM_LABELS[i], b))
  const quarter_end = QE_BINS.map((b, i) => binStats(days.filter(d => d.qeOffset === b).map(d => d.ret), QE_LABELS[i], b))

  const first = days[0].date.toISOString().slice(0, 10)
  const last  = days[days.length - 1].date.toISOString().slice(0, 10)
  return { n_obs: days.length, date_range: [first, last], dow, month, dom, tom, quarter_end }
}


function computeBacktest(days: DayData[], rule: Rule): BacktestResult {
  const signals = days.map(d => {
    if (rule.type === 'custom') {
      const dVal = d.month * 100 + d.dom
      for (const leg of rule.customLegs ?? []) {
        if (!leg.startMonth || !leg.startDay || !leg.endMonth || !leg.endDay) continue
        const sVal = leg.startMonth * 100 + leg.startDay
        const eVal = leg.endMonth * 100 + leg.endDay
        const inWindow = sVal <= eVal ? dVal >= sVal && dVal <= eVal : dVal >= sVal || dVal <= eVal
        if (inWindow) return leg.direction
      }
      return 0
    }
    let active = false
    switch (rule.type) {
      case 'dow':          active = rule.bins.includes(d.dow); break
      case 'month':        active = rule.bins.includes(d.month); break
      case 'dom_quintile': active = rule.bins.includes(d.domQ); break
      case 'tom':          active = d.tomOffset !== null && rule.bins.includes(d.tomOffset); break
      case 'quarter_end':  active = d.qeOffset !== null && rule.bins.includes(d.qeOffset); break
    }
    return active ? rule.direction : 0
  })

  const stratRets = days.map((d, i) => signals[i] * d.ret)

  // Build equity curve over active days only (no flat sections between windows)
  let stratCum = 0, runMax = 0
  const eqDates: string[] = [], eqStrat: number[] = [], eqDd: number[] = []
  const windowStarts: number[] = []
  let prevRawIdx = -2
  for (let i = 0; i < days.length; i++) {
    if (signals[i] === 0) continue
    // New window starts when there's a gap in the original day indices
    if (i > prevRawIdx + 1) windowStarts.push(eqDates.length)
    prevRawIdx = i
    stratCum += stratRets[i]
    runMax = Math.max(runMax, stratCum)
    eqDates.push(days[i].date.toISOString().slice(0, 10))
    eqStrat.push(+stratCum.toFixed(4))
    eqDd.push(+(stratCum - runMax).toFixed(4))
  }

  // Helper: annualised return and vol computed exclusively over active days
  function activeStats(rets: number[]) {
    const active = rets.filter(v => v !== 0)
    if (active.length < 2) return { annRet: 0, vol: 0, sharpe: 0 }
    const mean = active.reduce((a, b) => a + b, 0) / active.length
    const variance = active.reduce((a, b) => a + (b - mean) ** 2, 0) / (active.length - 1)
    const annRet = mean * 252
    const vol    = Math.sqrt(variance) * Math.sqrt(252)
    return { annRet, vol, sharpe: vol > 0 ? annRet / vol : 0 }
  }

  const years = [...new Set(days.map(d => d.date.getFullYear()))].sort()
  const annual: AnnualRow[] = years.map(yr => {
    const ys = stratRets.filter((_, i) => days[i].date.getFullYear() === yr)
    const active = ys.filter(v => v !== 0)
    const { sharpe } = activeStats(ys)
    return {
      year: yr,
      strat_total: +ys.reduce((a, b) => a + b, 0).toFixed(4),
      sharpe:      +sharpe.toFixed(3),
      win_rate:    active.length > 0 ? +(active.filter(v => v > 0).length / active.length).toFixed(4) : 0.5,
      n_trades:    active.length,
    }
  })

  const activeAll = stratRets.filter(v => v !== 0)
  const { annRet: annRetAll, sharpe: sharpeAll } = activeStats(stratRets)

  return {
    metrics: {
      total_return:   +stratRets.reduce((a, b) => a + b, 0).toFixed(4),
      ann_return:     +annRetAll.toFixed(4),
      sharpe:         +sharpeAll.toFixed(3),
      max_drawdown:   eqDd.length > 0 ? Math.min(...eqDd) : 0,
      win_rate:       activeAll.length > 0 ? +(activeAll.filter(v => v > 0).length / activeAll.length).toFixed(4) : 0.5,
      days_in_market: activeAll.length,
      pct_in_market:  +(activeAll.length / stratRets.length).toFixed(4),
    },
    equity_curve: { dates: eqDates, strategy: eqStrat, drawdown: eqDd, windowStarts },
    annual,
  }
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

// ─── Monthly returns table ────────────────────────────────────────────────────

interface MonthlyTable {
  years: number[]
  data: Record<number, Record<number, number>>  // [year][month 1-12] = total change
  yearTotals: Record<number, number>
  monthAvgs: Record<number, number>
  monthMedians: Record<number, number>
  monthP25: Record<number, number>
  monthP75: Record<number, number>
  monthHitRatio: Record<number, number>  // % of years with positive change
  vmin: number; vmax: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)).toFixed(4)
}

function computeMonthlyTable(days: DayData[]): MonthlyTable {
  const data: Record<number, Record<number, number>> = {}
  for (const d of days) {
    const yr = d.date.getFullYear()
    const mo = d.date.getMonth() + 1
    if (!data[yr]) data[yr] = {}
    data[yr][mo] = (data[yr][mo] ?? 0) + d.ret
  }
  const years = Object.keys(data).map(Number).sort()

  for (const yr of years)
    for (const mo of Object.keys(data[yr]).map(Number))
      data[yr][mo] = +data[yr][mo].toFixed(4)

  const yearTotals: Record<number, number> = {}
  for (const yr of years)
    yearTotals[yr] = +Object.values(data[yr]).reduce((a, b) => a + b, 0).toFixed(4)

  const monthAvgs: Record<number, number> = {}
  const monthMedians: Record<number, number> = {}
  const monthP25: Record<number, number> = {}
  const monthP75: Record<number, number> = {}
  const monthHitRatio: Record<number, number> = {}

  for (let mo = 1; mo <= 12; mo++) {
    const vals = years.map(yr => data[yr][mo]).filter(v => v !== undefined).sort((a, b) => a - b)
    if (vals.length === 0) {
      monthAvgs[mo] = monthMedians[mo] = monthP25[mo] = monthP75[mo] = monthHitRatio[mo] = 0
      continue
    }
    monthAvgs[mo]     = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)
    monthMedians[mo]  = percentile(vals, 50)
    monthP25[mo]      = percentile(vals, 25)
    monthP75[mo]      = percentile(vals, 75)
    monthHitRatio[mo] = +(vals.filter(v => v > 0).length / vals.length).toFixed(4)
  }

  const allVals = years.flatMap(yr => Object.values(data[yr]))
  return { years, data, yearTotals, monthAvgs, monthMedians, monthP25, monthP75, monthHitRatio, vmin: Math.min(...allVals), vmax: Math.max(...allVals) }
}

function MonthlyReturnsTable({ table, selectedYears }: { table: MonthlyTable; selectedYears: number[] }) {
  const { data, yearTotals } = table

  const years = table.years.filter(yr => selectedYears.includes(yr))

  // Only show months that have data for at least one selected year
  const months = Array.from({ length: 12 }, (_, i) => i + 1).filter(mo =>
    years.some(yr => data[yr]?.[mo] !== undefined)
  )

  // Recompute summary stats from selected years only
  const monthAvgs: Record<number, number> = {}
  const monthMedians: Record<number, number> = {}
  const monthP25: Record<number, number> = {}
  const monthP75: Record<number, number> = {}
  const monthHitRatio: Record<number, number> = {}
  const monthTStats: Record<number, number> = {}
  const monthPValues: Record<number, number> = {}
  for (let mo = 1; mo <= 12; mo++) {
    const vals = years.map(yr => data[yr]?.[mo]).filter((v): v is number => v !== undefined).sort((a, b) => a - b)
    if (vals.length === 0) {
      monthAvgs[mo] = monthMedians[mo] = monthP25[mo] = monthP75[mo] = monthHitRatio[mo] = 0
      monthTStats[mo] = 0; monthPValues[mo] = 1
      continue
    }
    const n = vals.length
    const mean = vals.reduce((a, b) => a + b, 0) / n
    const std = n > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
    const se = std / Math.sqrt(n)
    const t = se > 0 ? mean / se : 0
    monthAvgs[mo]     = +mean.toFixed(4)
    monthMedians[mo]  = percentile(vals, 50)
    monthP25[mo]      = percentile(vals, 25)
    monthP75[mo]      = percentile(vals, 75)
    monthHitRatio[mo] = +(vals.filter(v => v > 0).length / n).toFixed(4)
    monthTStats[mo]   = +t.toFixed(2)
    monthPValues[mo]  = +tTestPValue(t).toFixed(4)
  }
  const selVals = years.flatMap(yr => Object.values(data[yr] ?? {}))
  const vmin = selVals.length > 0 ? Math.min(...selVals) : table.vmin
  const vmax = selVals.length > 0 ? Math.max(...selVals) : table.vmax

  function cellColor(v: number): string {
    if (v === 0) return 'transparent'
    const mid = 0
    if (v > mid) {
      const t = Math.min(1, v / Math.max(vmax, 1e-9))
      return `rgba(34,197,94,${0.12 + t * 0.45})`
    }
    const t = Math.min(1, Math.abs(v) / Math.max(Math.abs(vmin), 1e-9))
    return `rgba(239,68,68,${0.12 + t * 0.45})`
  }

  const thStyle: React.CSSProperties = {
    color: '#475569', fontWeight: 600, fontSize: 10,
    textTransform: 'uppercase', letterSpacing: '0.05em',
    padding: '5px 8px', whiteSpace: 'nowrap',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
  }

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>Monthly Returns — Total Change per Month</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left' }}>Year</th>
              {months.map(mo => <th key={mo} style={{ ...thStyle, textAlign: 'right' }}>{MONTH_NAMES[mo - 1]}</th>)}
              <th style={{ ...thStyle, textAlign: 'right', color: '#64748b' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {years.map(yr => (
              <tr key={yr} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ color: '#94a3b8', padding: '4px 8px', fontWeight: 600, fontSize: 11 }}>{yr}</td>
                {months.map(mo => {
                  const v = data[yr][mo]
                  return (
                    <td key={mo} style={{
                      padding: '4px 8px', textAlign: 'right',
                      fontFamily: 'monospace', fontSize: 10,
                      background: v !== undefined ? cellColor(v) : 'transparent',
                      color: v !== undefined ? '#e2e8f0' : '#334155',
                      borderRadius: 3,
                    }}>
                      {v !== undefined ? (v >= 0 ? '+' : '') + v.toFixed(3) : '—'}
                    </td>
                  )
                })}
                <td style={{
                  padding: '4px 8px', textAlign: 'right',
                  fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
                  color: yearTotals[yr] >= 0 ? '#22c55e' : '#ef4444',
                }}>
                  {yearTotals[yr] >= 0 ? '+' : ''}{yearTotals[yr].toFixed(3)}
                </td>
              </tr>
            ))}
            {/* Average row */}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.10)' }}>
              <td style={{ color: '#64748b', padding: '5px 8px', fontWeight: 700, fontSize: 11 }}>Avg</td>
              {months.map(mo => {
                const v = monthAvgs[mo]
                return (
                  <td key={mo} style={{
                    padding: '5px 8px', textAlign: 'right',
                    fontFamily: 'monospace', fontSize: 10, fontWeight: 600,
                    background: cellColor(v),
                    color: '#e2e8f0', borderRadius: 3,
                  }}>
                    {v >= 0 ? '+' : ''}{v.toFixed(3)}
                  </td>
                )
              })}
              <td />
            </tr>
            {/* Median row */}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <td style={{ color: '#64748b', padding: '5px 8px', fontWeight: 700, fontSize: 11 }}>Median</td>
              {months.map(mo => {
                const v = monthMedians[mo]
                return (
                  <td key={mo} style={{
                    padding: '5px 8px', textAlign: 'right',
                    fontFamily: 'monospace', fontSize: 10, fontWeight: 600,
                    background: cellColor(v),
                    color: '#e2e8f0', borderRadius: 3,
                  }}>
                    {v >= 0 ? '+' : ''}{v.toFixed(3)}
                  </td>
                )
              })}
              <td />
            </tr>
            {/* P25 row */}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <td style={{ color: '#64748b', padding: '5px 8px', fontWeight: 700, fontSize: 11 }}>P25</td>
              {months.map(mo => {
                const v = monthP25[mo]
                return (
                  <td key={mo} style={{
                    padding: '5px 8px', textAlign: 'right',
                    fontFamily: 'monospace', fontSize: 10,
                    background: cellColor(v),
                    color: '#cbd5e1', borderRadius: 3,
                  }}>
                    {v >= 0 ? '+' : ''}{v.toFixed(3)}
                  </td>
                )
              })}
              <td />
            </tr>
            {/* P75 row */}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <td style={{ color: '#64748b', padding: '5px 8px', fontWeight: 700, fontSize: 11 }}>P75</td>
              {months.map(mo => {
                const v = monthP75[mo]
                return (
                  <td key={mo} style={{
                    padding: '5px 8px', textAlign: 'right',
                    fontFamily: 'monospace', fontSize: 10,
                    background: cellColor(v),
                    color: '#cbd5e1', borderRadius: 3,
                  }}>
                    {v >= 0 ? '+' : ''}{v.toFixed(3)}
                  </td>
                )
              })}
              <td />
            </tr>
            {/* Hit Ratio row */}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <td style={{ color: '#64748b', padding: '5px 8px', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }}>Hit Ratio</td>
              {months.map(mo => {
                const v = monthHitRatio[mo]
                const color = v >= 0.6 ? '#22c55e' : v >= 0.5 ? '#86efac' : v >= 0.4 ? '#fca5a5' : '#ef4444'
                return (
                  <td key={mo} style={{
                    padding: '5px 8px', textAlign: 'right',
                    fontFamily: 'monospace', fontSize: 10, fontWeight: 600,
                    color, borderRadius: 3,
                  }}>
                    {(v * 100).toFixed(0)}%
                  </td>
                )
              })}
              <td />
            </tr>
            {/* t-stat row */}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={{ color: '#64748b', padding: '5px 8px', fontWeight: 700, fontSize: 11 }}>t-stat</td>
              {months.map(mo => {
                const v = monthTStats[mo]
                const abs = Math.abs(v)
                const color = abs >= 2 ? '#f1f5f9' : abs >= 1.5 ? '#94a3b8' : '#475569'
                return (
                  <td key={mo} style={{
                    padding: '5px 8px', textAlign: 'right',
                    fontFamily: 'monospace', fontSize: 10, fontWeight: abs >= 2 ? 700 : 400,
                    color, borderRadius: 3,
                  }}>
                    {v >= 0 ? '+' : ''}{v.toFixed(2)}
                  </td>
                )
              })}
              <td />
            </tr>
            {/* p-value row */}
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <td style={{ color: '#64748b', padding: '5px 8px', fontWeight: 700, fontSize: 11 }}>p-val</td>
              {months.map(mo => {
                const v = monthPValues[mo]
                return (
                  <td key={mo} style={{
                    padding: '5px 8px', textAlign: 'right',
                    fontFamily: 'monospace', fontSize: 10, fontWeight: v < 0.05 ? 700 : 400,
                    color: sigColor(v), borderRadius: 3,
                  }}>
                    {v < 0.001 ? '<.001' : v.toFixed(3)}
                  </td>
                )
              })}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, color: '#64748b' }}>
          <div style={{ width: 12, height: 12, borderRadius: 2, background: 'rgba(239,68,68,0.55)' }} />negative
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, color: '#64748b' }}>
          <div style={{ width: 12, height: 12, borderRadius: 2, background: 'rgba(34,197,94,0.55)' }} />positive
        </div>
      </div>
    </div>
  )
}

// ─── Window returns table (5 equal intervals) ────────────────────────────────

interface WindowTable {
  years: number[]
  data: Record<number, Record<number, number>>   // [year][interval 0-4]
  yearTotals: Record<number, number>
  intervalLabels: string[]
  intervalAvgs: Record<number, number>
  intervalMedians: Record<number, number>
  intervalP25: Record<number, number>
  intervalP75: Record<number, number>
  intervalHitRatio: Record<number, number>
  vmin: number; vmax: number
}

function computeWindowTable(filteredDays: DayData[]): WindowTable | null {
  if (filteredDays.length === 0) return null

  // Group and sort by year
  const yearMap = new Map<number, DayData[]>()
  for (const d of filteredDays) {
    const yr = d.date.getFullYear()
    if (!yearMap.has(yr)) yearMap.set(yr, [])
    yearMap.get(yr)!.push(d)
  }
  for (const [, days] of yearMap) days.sort((a, b) => a.date.getTime() - b.date.getTime())

  const years = [...yearMap.keys()].sort()

  // Reference year for interval labels (most trading days)
  const refYr = years.reduce((best, yr) =>
    (yearMap.get(yr)?.length ?? 0) > (yearMap.get(best)?.length ?? 0) ? yr : best, years[0])
  const refDays = yearMap.get(refYr)!
  const refN = refDays.length

  // 5 equal interval boundaries on reference year
  const bounds = Array.from({ length: 6 }, (_, i) => Math.round(i * refN / 5))

  // Labels: "Apr 23 – May 11" style from reference year
  const fmt = (d: DayData) => `${MONTH_NAMES[d.month - 1].slice(0, 3)} ${d.dom}`
  const intervalLabels = Array.from({ length: 5 }, (_, i) =>
    `${fmt(refDays[bounds[i]])} – ${fmt(refDays[Math.min(bounds[i + 1] - 1, refN - 1)])}`
  )

  // Compute per-year interval returns
  const data: Record<number, Record<number, number>> = {}
  for (const yr of years) {
    const days = yearMap.get(yr)!
    const n = days.length
    data[yr] = {}
    for (let i = 0; i < 5; i++) {
      const s = Math.round(i * n / 5)
      const e = Math.round((i + 1) * n / 5)
      data[yr][i] = +(days.slice(s, e).reduce((sum, d) => sum + d.ret, 0)).toFixed(4)
    }
  }

  const yearTotals: Record<number, number> = {}
  for (const yr of years)
    yearTotals[yr] = +(Object.values(data[yr]).reduce((a, b) => a + b, 0)).toFixed(4)

  const intervalAvgs: Record<number, number> = {}
  const intervalMedians: Record<number, number> = {}
  const intervalP25: Record<number, number> = {}
  const intervalP75: Record<number, number> = {}
  const intervalHitRatio: Record<number, number> = {}

  for (let i = 0; i < 5; i++) {
    const vals = years.map(yr => data[yr][i]).sort((a, b) => a - b)
    intervalAvgs[i]     = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)
    intervalMedians[i]  = percentile(vals, 50)
    intervalP25[i]      = percentile(vals, 25)
    intervalP75[i]      = percentile(vals, 75)
    intervalHitRatio[i] = +(vals.filter(v => v > 0).length / vals.length).toFixed(4)
  }

  const allVals = years.flatMap(yr => Object.values(data[yr]))
  return { years, data, yearTotals, intervalLabels, intervalAvgs, intervalMedians, intervalP25, intervalP75, intervalHitRatio, vmin: Math.min(...allVals), vmax: Math.max(...allVals) }
}

function WindowReturnsTable({ table, selectedYears }: { table: WindowTable; selectedYears: number[] }) {
  const { data, yearTotals, intervalLabels, vmin, vmax } = table
  const years = table.years.filter(yr => selectedYears.includes(yr))
  const INTERVALS = [0, 1, 2, 3, 4]

  // Recompute stats for selected years
  const avgs: Record<number, number> = {}, medians: Record<number, number> = {}
  const p25: Record<number, number> = {}, p75: Record<number, number> = {}
  const hitRatio: Record<number, number> = {}
  for (const i of INTERVALS) {
    const vals = years.map(yr => data[yr]?.[i] ?? 0).sort((a, b) => a - b)
    avgs[i]     = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : 0
    medians[i]  = percentile(vals, 50)
    p25[i]      = percentile(vals, 25)
    p75[i]      = percentile(vals, 75)
    hitRatio[i] = vals.length ? +(vals.filter(v => v > 0).length / vals.length).toFixed(4) : 0
  }

  // Total column stats across selected years
  const totalVals = years.map(yr => yearTotals[yr] ?? 0).sort((a, b) => a - b)
  const totalAvg      = totalVals.length ? +(totalVals.reduce((a, b) => a + b, 0) / totalVals.length).toFixed(4) : 0
  const totalMedian   = percentile(totalVals, 50)
  const totalP25      = percentile(totalVals, 25)
  const totalP75      = percentile(totalVals, 75)
  const totalHitRatio = totalVals.length ? +(totalVals.filter(v => v > 0).length / totalVals.length).toFixed(4) : 0

  const selVals = years.flatMap(yr => Object.values(data[yr] ?? {}))
  const sVmin = selVals.length ? Math.min(...selVals) : vmin
  const sVmax = selVals.length ? Math.max(...selVals) : vmax

  function cellColor(v: number) {
    if (v === 0) return 'transparent'
    if (v > 0) { const t = Math.min(1, v / Math.max(sVmax, 1e-9)); return `rgba(34,197,94,${0.12 + t * 0.45})` }
    const t = Math.min(1, Math.abs(v) / Math.max(Math.abs(sVmin), 1e-9))
    return `rgba(239,68,68,${0.12 + t * 0.45})`
  }

  const thStyle: React.CSSProperties = {
    color: '#475569', fontWeight: 600, fontSize: 10, textTransform: 'uppercase',
    letterSpacing: '0.05em', padding: '5px 8px', whiteSpace: 'nowrap',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
  }

  const statRow = (label: string, vals: Record<number, number>, totalVal: number, fmt?: (v: number) => string) => (
    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
      <td style={{ color: '#64748b', padding: '5px 8px', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }}>{label}</td>
      {INTERVALS.map(i => {
        const v = vals[i]
        const display = fmt ? fmt(v) : `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
        const color = fmt ? (v >= 0.6 ? '#22c55e' : v >= 0.5 ? '#86efac' : v >= 0.4 ? '#fca5a5' : '#ef4444') : '#e2e8f0'
        return (
          <td key={i} style={{
            padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 10, fontWeight: 600,
            background: fmt ? 'transparent' : cellColor(v), color, borderRadius: 3,
          }}>{display}</td>
        )
      })}
      <td style={{
        padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
        color: fmt
          ? (totalVal >= 0.6 ? '#22c55e' : totalVal >= 0.5 ? '#86efac' : totalVal >= 0.4 ? '#fca5a5' : '#ef4444')
          : (totalVal >= 0 ? '#22c55e' : '#ef4444'),
      }}>
        {fmt ? fmt(totalVal) : `${totalVal >= 0 ? '+' : ''}${totalVal.toFixed(3)}`}
      </td>
    </tr>
  )

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>Window Returns — 5 Equal Intervals</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left' }}>Year</th>
              {INTERVALS.map(i => (
                <th key={i} style={{ ...thStyle, textAlign: 'right' }}>{intervalLabels[i]}</th>
              ))}
              <th style={{ ...thStyle, textAlign: 'right', color: '#64748b' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {years.map(yr => (
              <tr key={yr} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ color: '#94a3b8', padding: '4px 8px', fontWeight: 600, fontSize: 11 }}>{yr}</td>
                {INTERVALS.map(i => {
                  const v = data[yr]?.[i] ?? 0
                  return (
                    <td key={i} style={{
                      padding: '4px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 10,
                      background: cellColor(v), color: '#e2e8f0', borderRadius: 3,
                    }}>
                      {v >= 0 ? '+' : ''}{v.toFixed(3)}
                    </td>
                  )
                })}
                <td style={{
                  padding: '4px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
                  color: yearTotals[yr] >= 0 ? '#22c55e' : '#ef4444',
                }}>
                  {yearTotals[yr] >= 0 ? '+' : ''}{yearTotals[yr].toFixed(3)}
                </td>
              </tr>
            ))}
            {statRow('Avg',       avgs,     totalAvg,      undefined)}
            {statRow('Median',    medians,  totalMedian,   undefined)}
            {statRow('P25',       p25,      totalP25,      undefined)}
            {statRow('P75',       p75,      totalP75,      undefined)}
            {statRow('Hit Ratio', hitRatio, totalHitRatio, v => `${(v * 100).toFixed(0)}%`)}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, color: '#64748b' }}>
          <div style={{ width: 12, height: 12, borderRadius: 2, background: 'rgba(239,68,68,0.55)' }} />negative
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, color: '#64748b' }}>
          <div style={{ width: 12, height: 12, borderRadius: 2, background: 'rgba(34,197,94,0.55)' }} />positive
        </div>
      </div>
    </div>
  )
}

// ─── Cumulative year chart ────────────────────────────────────────────────────

const YEAR_COLORS = [
  '#06B6D4','#22c55e','#f59e0b','#ef4444','#8b5cf6',
  '#ec4899','#14b8a6','#f97316','#84cc16','#3b82f6',
  '#a855f7','#10b981','#eab308','#f43f5e','#0ea5e9',
]

// Approximate trading-day index within year for start of each month (full-year fallback)

function CumulativeYearChart({ days, selectedYears }: { days: DayData[]; selectedYears: number[] }) {
  // Group returns by year
  const yearMap = new Map<number, number[]>()
  for (const d of days) {
    const yr = d.date.getFullYear()
    if (!yearMap.has(yr)) yearMap.set(yr, [])
    yearMap.get(yr)!.push(d.ret)
  }
  const years = [...yearMap.keys()].sort().filter(yr => selectedYears.includes(yr))

  // Pre-compute cumulative sums per year
  const cumByYear = new Map<number, number[]>()
  let maxLen = 0
  for (const yr of years) {
    const rets = yearMap.get(yr)!
    const cum: number[] = []
    let s = 0
    for (const r of rets) { s += r; cum.push(+(s).toFixed(5)) }
    cumByYear.set(yr, cum)
    maxLen = Math.max(maxLen, cum.length)
  }

  // Build chart data: one row per trading-day index
  type ChartRow = { dayIdx: number } & Record<string, number | null>
  const data: ChartRow[] = []
  for (let i = 0; i < maxLen; i++) {
    const row: ChartRow = { dayIdx: i }
    const vals: number[] = []
    for (const yr of years) {
      const cum = cumByYear.get(yr)!
      if (i < cum.length) { row[String(yr)] = cum[i]; vals.push(cum[i]) }
      else row[String(yr)] = null
    }
    row['Average'] = vals.length > 0 ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(5) : null
    data.push(row)
  }

  const mostRecentYear = years[years.length - 1]

  // Compute tick positions from reference year — always include start and end dates
  const tickPositions: { dayIdx: number; label: string }[] = []
  let refSlice: DayData[] = []
  if (years.length > 0) {
    const refYr = years.reduce((best, yr) =>
      (yearMap.get(yr)?.length ?? 0) > (yearMap.get(best)?.length ?? 0) ? yr : best, years[0])
    const refRets = yearMap.get(refYr)!
    const refDays = days.filter(d => d.date.getFullYear() === refYr && selectedYears.includes(refYr))
    refSlice = refDays.slice(0, refRets.length)

    const fmtD = (d: DayData) => `${MONTH_NAMES[d.month - 1].slice(0, 3)} ${d.dom}`

    // First date (window start)
    if (refSlice.length > 0) tickPositions.push({ dayIdx: 0, label: fmtD(refSlice[0]) })

    // Month boundaries in between
    const seen = new Set<number>()
    seen.add(refSlice[0]?.month - 1)
    refSlice.forEach((d, i) => {
      const mo = d.month - 1
      if (!seen.has(mo) && i > 0 && i < refSlice.length - 1) {
        seen.add(mo)
        tickPositions.push({ dayIdx: i, label: MONTH_NAMES[mo] })
      }
    })

    // Last date (window end)
    if (refSlice.length > 1) {
      const last = refSlice.length - 1
      tickPositions.push({ dayIdx: last, label: fmtD(refSlice[last]) })
    }
  }

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>Cumulative Change by Year — Daily</div>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="dayIdx"
            type="number"
            domain={[0, maxLen - 1]}
            ticks={tickPositions.map(t => t.dayIdx)}
            tickFormatter={i => tickPositions.find(t => t.dayIdx === i)?.label ?? ''}
            tick={{ fill: '#475569', fontSize: 10 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: '#475569', fontSize: 10 }}
            axisLine={false} tickLine={false}
            tickFormatter={v => v.toFixed(2)}
          />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const idx = label as number
              const refDay = refSlice[idx]
              const dateLabel = refDay
                ? `${MONTH_NAMES[refDay.month - 1]} ${refDay.dom}`
                : `Day ${idx}`
              return (
                <div style={{
                  background: 'rgba(8,13,26,0.95)', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 8, padding: '8px 12px', fontSize: 11, maxHeight: 240, overflowY: 'auto',
                }}>
                  <div style={{ color: '#64748b', marginBottom: 6, fontWeight: 600 }}>
                    {dateLabel}
                  </div>
                  {payload
                    .filter(p => p.value !== null)
                    .sort((a, b) => (b.value as number) - (a.value as number))
                    .map(p => (
                      <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, color: p.color }}>
                        <span>{p.dataKey}</span>
                        <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                          {(p.value as number) >= 0 ? '+' : ''}{(p.value as number).toFixed(3)}
                        </span>
                      </div>
                    ))}
                </div>
              )
            }}
            cursor={{ stroke: 'rgba(255,255,255,0.10)' }}
          />
          <Legend
            wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
            formatter={(value) => (
              <span style={{
                color: value === 'Average' ? '#f1f5f9'
                  : String(value) === String(mostRecentYear) ? '#f1f5f9'
                  : '#475569',
                fontWeight: value === 'Average' ? 700 : 400,
              }}>{value}</span>
            )}
          />
          {years.map((yr, i) => (
            <Line
              key={yr}
              type="monotone"
              dataKey={String(yr)}
              stroke={YEAR_COLORS[i % YEAR_COLORS.length]}
              strokeWidth={yr === mostRecentYear ? 2 : 1}
              opacity={yr === mostRecentYear ? 0.85 : 0.35}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
          <Line
            key="Average"
            type="monotone"
            dataKey="Average"
            stroke="#ffffff"
            strokeWidth={3}
            opacity={1}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
            strokeDasharray="0"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Window selector ─────────────────────────────────────────────────────────

function WindowSelector({ onChange }: {
  onChange: (start: string, end: string) => void
}) {
  const [lsm, setLsm] = useState(1)
  const [lsd, setLsd] = useState(1)
  const [lem, setLem] = useState(12)
  const [led, setLed] = useState(31)

  const fmt = (m: number, d: number) =>
    m && d ? `${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` : ''

  // Propagate to parent only when fully set; clear when partial
  useEffect(() => {
    onChange(fmt(lsm, lsd), fmt(lem, led))
  }, [lsm, lsd, lem, led])

  const selectStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 7, padding: '4px 8px', color: '#e2e8f0', fontSize: 12,
    cursor: 'pointer', outline: 'none',
  }
  const DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
  const active = !!(lsm && lsd && lem && led)

  return (
    <div style={{ ...cardStyle, padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>
          Time window
        </div>
        <span style={{ fontSize: 11, color: '#475569' }}>From</span>
        <select value={lsm} style={selectStyle} onChange={e => setLsm(+e.target.value)}>
          <option value={0} style={{ background: '#0f172a' }}>Month</option>
          {MONTH_NAMES.map((name, i) => <option key={i} value={i+1} style={{ background: '#0f172a' }}>{name}</option>)}
        </select>
        <select value={lsd} style={selectStyle} onChange={e => setLsd(+e.target.value)}>
          <option value={0} style={{ background: '#0f172a' }}>Day</option>
          {DAYS.map(d => <option key={d} value={d} style={{ background: '#0f172a' }}>{d}</option>)}
        </select>
        <span style={{ fontSize: 11, color: '#475569' }}>To</span>
        <select value={lem} style={selectStyle} onChange={e => setLem(+e.target.value)}>
          <option value={0} style={{ background: '#0f172a' }}>Month</option>
          {MONTH_NAMES.map((name, i) => <option key={i} value={i+1} style={{ background: '#0f172a' }}>{name}</option>)}
        </select>
        <select value={led} style={selectStyle} onChange={e => setLed(+e.target.value)}>
          <option value={0} style={{ background: '#0f172a' }}>Day</option>
          {DAYS.map(d => <option key={d} value={d} style={{ background: '#0f172a' }}>{d}</option>)}
        </select>
        {active
          ? <button onClick={() => { setLsm(0); setLsd(0); setLem(0); setLed(0) }} style={{
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 6, padding: '3px 10px', color: '#64748b', fontSize: 11, cursor: 'pointer',
            }}>Clear</button>
          : <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>Select month + day for both ends</span>
        }
      </div>
    </div>
  )
}

// ─── Year selector ────────────────────────────────────────────────────────────

function YearSelector({ allYears, selectedYears, onChange }: {
  allYears: number[]
  selectedYears: number[]
  onChange: (years: number[]) => void
}) {
  const allSelected = selectedYears.length === allYears.length

  return (
    <div style={{ ...cardStyle, padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>
          Sample years
        </div>
        <button
          onClick={() => onChange(allYears)}
          style={{
            background: allSelected ? ACCENT_DIM : 'rgba(255,255,255,0.04)',
            border: `1px solid ${allSelected ? ACCENT_BORDER : 'rgba(255,255,255,0.07)'}`,
            borderRadius: 5, padding: '2px 9px',
            color: allSelected ? ACCENT : '#475569', fontSize: 10, fontWeight: 700, cursor: 'pointer',
          }}>All</button>
        <button
          onClick={() => onChange([])}
          style={{
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 5, padding: '2px 9px',
            color: '#475569', fontSize: 10, cursor: 'pointer',
          }}>None</button>
        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)' }} />
        {allYears.map(yr => {
          const active = selectedYears.includes(yr)
          return (
            <button key={yr} onClick={() => {
              onChange(active ? selectedYears.filter(y => y !== yr) : [...selectedYears, yr].sort())
            }} style={{
              background: active ? ACCENT_DIM : 'rgba(255,255,255,0.03)',
              border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.06)'}`,
              borderRadius: 5, padding: '2px 8px',
              color: active ? ACCENT : '#475569',
              fontSize: 10, fontWeight: active ? 700 : 400, cursor: 'pointer',
            }}>{yr}</button>
          )
        })}
      </div>
    </div>
  )
}


function sigColor(p: number): string {
  if (p < 0.01) return '#22c55e'
  if (p < 0.05) return '#86efac'
  if (p < 0.10) return '#fbbf24'
  return '#475569'
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: {
  active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'rgba(8,13,26,0.95)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 8, padding: '8px 12px', fontSize: 12,
    }}>
      <div style={{ color: '#64748b', marginBottom: 4 }}>{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color, display: 'flex', gap: 10, justifyContent: 'space-between' }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{p.value.toFixed(4)}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Expression input ─────────────────────────────────────────────────────────

function ExpressionInput({ onLoad, onSimulate, loading }: {
  onLoad: (expr: string, start: string) => void
  onSimulate: (series: SeriesData) => void
  loading: boolean
}) {
  const [mode, setMode] = useState<'bbg' | 'simulate'>('simulate')
  const [expr, setExpr] = useState('')
  const [start, setStart] = useState('2010-01-01')
  const [simId, setSimId] = useState('10Y_Bund')

  const modeBtn = (m: 'bbg' | 'simulate', label: string) => {
    const active = mode === m
    return (
      <button onClick={() => setMode(m)} style={{
        background: active ? ACCENT_DIM : 'rgba(255,255,255,0.05)',
        border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.08)'}`,
        borderRadius: 7, padding: '5px 14px',
        color: active ? ACCENT : '#64748b',
        fontSize: 12, fontWeight: active ? 700 : 400, cursor: 'pointer',
      }}>{label}</button>
    )
  }

  return (
    <div style={cardStyle}>
      {/* Mode toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        {modeBtn('simulate', 'Simulate')}
        {modeBtn('bbg', 'Bloomberg')}
        {mode === 'simulate' && (
          <span style={{ fontSize: 11, color: '#475569', marginLeft: 4 }}>
            Deterministic synthetic data — no Bloomberg connection required
          </span>
        )}
      </div>

      {/* ── Simulate mode ── */}
      {mode === 'simulate' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>Instrument</div>
          <select
            value={simId}
            onChange={e => setSimId(e.target.value)}
            style={{
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: '6px 12px', color: '#e2e8f0', fontSize: 13, cursor: 'pointer',
            }}
          >
            {Object.entries(SYNTHETIC_INSTRUMENTS).map(([id, cfg]) => (
              <option key={id} value={id} style={{ background: '#0f172a' }}>{cfg.label}</option>
            ))}
          </select>
          <button
            onClick={() => onSimulate(generateSyntheticSeries(simId))}
            style={{
              background: ACCENT_DIM, border: `1px solid ${ACCENT_BORDER}`,
              borderRadius: 8, padding: '7px 20px',
              color: ACCENT, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Load Simulation
          </button>
        </div>
      )}

      {/* ── Bloomberg mode ── */}
      {mode === 'bbg' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
              Bloomberg ticker or arithmetic combination (requires Terminal connection):
            </div>
            <input
              value={expr}
              onChange={e => setExpr(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && expr.trim() && !loading) onLoad(expr.trim(), start) }}
              placeholder="e.g. GDBR10 Index  or  GDBR10 Index - GDBR2 Index"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8, padding: '9px 14px',
                color: '#e2e8f0', fontSize: 13, fontFamily: 'monospace', outline: 'none',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>Start date</div>
              <input
                type="date" value={start} onChange={e => setStart(e.target.value)}
                style={{
                  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 8, padding: '6px 10px', color: '#e2e8f0', fontSize: 12, outline: 'none',
                }}
              />
            </div>
            <button
              onClick={() => { if (expr.trim() && !loading) onLoad(expr.trim(), start) }}
              disabled={!expr.trim() || loading}
              style={{
                background: !expr.trim() || loading ? 'rgba(255,255,255,0.05)' : ACCENT_DIM,
                border: `1px solid ${!expr.trim() || loading ? 'rgba(255,255,255,0.08)' : ACCENT_BORDER}`,
                borderRadius: 8, padding: '7px 20px',
                color: !expr.trim() || loading ? '#475569' : ACCENT,
                fontSize: 13, fontWeight: 700,
                cursor: !expr.trim() || loading ? 'not-allowed' : 'pointer',
              }}
            >
              {loading ? 'Loading…' : 'Load'}
            </button>
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Examples</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {EXAMPLE_EXPRESSIONS.map(ex => (
                <button key={ex} onClick={() => setExpr(ex)} style={{
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: 6, padding: '3px 10px',
                  color: '#64748b', fontSize: 11, fontFamily: 'monospace', cursor: 'pointer',
                }}>{ex}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ─── Irregular window scan ────────────────────────────────────────────────────

interface ScanPattern {
  startDoy: number; endDoy: number
  startLabel: string; endLabel: string
  calDays: number; avgTradingDays: number
  meanYearReturn: number
  t_stat: number; p_value: number; adj_p: number
  win_rate: number; n_years: number
  yearReturns: { year: number; ret: number }[]
}

function computeWindowScan(days: DayData[]): ScanPattern[] {
  if (days.length === 0) return []

  const REF = new Date(2020, 0, 0).getTime()   // Dec 31 2019 — reference epoch
  const toDoy = (month: number, dom: number) =>
    Math.round((new Date(2020, month - 1, dom).getTime() - REF) / 86400000)
  const doyLabel = (doy: number) => {
    const d = new Date(2020, 0, doy)
    return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`
  }

  // Annotate each day with doy
  const annotated = days.map(d => ({ ...d, doy: toDoy(d.month, d.dom) }))
  const years = [...new Set(days.map(d => d.date.getFullYear()))].sort()

  // Per-year prefix sums over doy (1-366)
  type YearPfx = { cumRet: Float64Array; cumCnt: Int32Array }
  const pfx = new Map<number, YearPfx>()
  for (const yr of years) {
    const cumRet = new Float64Array(368)
    const cumCnt = new Int32Array(368)
    for (const d of annotated) {
      if (d.date.getFullYear() === yr) { cumRet[d.doy] += d.ret; cumCnt[d.doy] = 1 }
    }
    for (let i = 1; i <= 366; i++) { cumRet[i] += cumRet[i - 1]; cumCnt[i] += cumCnt[i - 1] }
    pfx.set(yr, { cumRet, cumCnt })
  }

  const MIN_TDAYS = 2
  const MIN_YEARS = Math.max(5, Math.floor(years.length * 0.7))
  const MIN_CAL = 3
  const MAX_CAL = 40

  // Accumulate all candidate windows
  const candidates: {
    s: number; e: number
    yearRets: number[]; validYears: number[]
    tradingDays: number[]; mean: number; t: number; p: number
  }[] = []

  for (let s = 1; s <= 366; s++) {
    for (let calLen = MIN_CAL; calLen <= MAX_CAL && s + calLen - 1 <= 366; calLen++) {
      const e = s + calLen - 1
      const yearRets: number[] = [], validYears: number[] = [], tradingDays: number[] = []

      for (const yr of years) {
        const { cumRet, cumCnt } = pfx.get(yr)!
        const td = cumCnt[e] - cumCnt[s - 1]
        if (td < MIN_TDAYS) continue
        yearRets.push(cumRet[e] - cumRet[s - 1])
        validYears.push(yr)
        tradingDays.push(td)
      }
      if (yearRets.length < MIN_YEARS) continue

      const n = yearRets.length
      const mean = yearRets.reduce((a, b) => a + b, 0) / n
      const vari = yearRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
      const se = Math.sqrt(vari / n)
      const t = se > 0 ? mean / se : 0
      const p = 2 * (1 - normalCDF(Math.abs(t)))
      candidates.push({ s, e, yearRets, validYears, tradingDays, mean, t, p })
    }
  }

  // Benjamini–Hochberg FDR correction
  const m = candidates.length
  if (m === 0) return []
  const order = [...candidates.keys()].sort((i, j) => candidates[i].p - candidates[j].p)
  const adjP = new Float64Array(m).fill(1)
  let minSoFar = 1
  for (let k = m - 1; k >= 0; k--) {
    const idx = order[k]
    minSoFar = Math.min(minSoFar, Math.min(1, (candidates[idx].p * m) / (k + 1)))
    adjP[idx] = minSoFar
  }

  // Greedy non-overlapping selection, separately for each direction
  function greedyTop(pool: typeof candidates, sign: 1 | -1): typeof candidates {
    const sorted = pool
      .filter(c => sign === 1 ? c.mean > 0 : c.mean <= 0)
      .sort((a, b) => Math.abs(b.t) - Math.abs(a.t))
    const selected: typeof candidates = []
    const covered = new Set<number>()
    for (const c of sorted) {
      if ([...Array(c.e - c.s + 1)].some((_, k) => covered.has(c.s + k))) continue
      for (let d = c.s; d <= c.e; d++) covered.add(d)
      selected.push(c)
      if (selected.length >= 12) break
    }
    return selected
  }

  const kept = [...greedyTop(candidates, 1), ...greedyTop(candidates, -1)]

  return kept.map(c => {
    const n = c.yearRets.length
    const idx = candidates.indexOf(c)
    return {
      startDoy: c.s, endDoy: c.e,
      startLabel: doyLabel(c.s), endLabel: doyLabel(c.e),
      calDays: c.e - c.s + 1,
      avgTradingDays: Math.round(c.tradingDays.reduce((a, b) => a + b, 0) / n),
      meanYearReturn: +c.mean.toFixed(4),
      t_stat: +c.t.toFixed(3),
      p_value: +c.p.toFixed(4),
      adj_p: +adjP[idx].toFixed(4),
      win_rate: +(c.yearRets.filter(r => r > 0).length / n).toFixed(4),
      n_years: n,
      yearReturns: c.validYears.map((yr, i) => ({ year: yr, ret: +c.yearRets[i].toFixed(4) })),
    }
  })
}

function WindowScanSection({ patterns, days, selectedYears }: {
  patterns: ScanPattern[]
  days: DayData[]
  selectedYears: number[]
}) {
  const [sortBy, setSortBy] = useState<'tstat' | 'adj_p'>('tstat')

  const cmp = sortBy === 'tstat'
    ? (a: ScanPattern, b: ScanPattern) => Math.abs(b.t_stat) - Math.abs(a.t_stat)
    : (a: ScanPattern, b: ScanPattern) => a.adj_p - b.adj_p

  const positive = patterns.filter(p => p.meanYearReturn > 0).sort(cmp)
  const negative = patterns.filter(p => p.meanYearReturn <= 0).sort(cmp)

  // ── Cumulative chart with shaded windows ──────────────────────────────────
  const REF_EPOCH = new Date(2020, 0, 0).getTime()
  const toDoy = (month: number, dom: number) =>
    Math.round((new Date(2020, month - 1, dom).getTime() - REF_EPOCH) / 86400000)

  // Group returns by year (respecting selectedYears)
  const yearMap = new Map<number, DayData[]>()
  for (const d of days) {
    const yr = d.date.getFullYear()
    if (!selectedYears.includes(yr)) continue
    if (!yearMap.has(yr)) yearMap.set(yr, [])
    yearMap.get(yr)!.push(d)
  }
  const chartYears = [...yearMap.keys()].sort()

  // Reference year for tick labels + doy→idx mapping
  const refYr = chartYears.length > 0
    ? chartYears.reduce((best, yr) =>
        (yearMap.get(yr)?.length ?? 0) > (yearMap.get(best)?.length ?? 0) ? yr : best, chartYears[0])
    : null
  const refDays = refYr
    ? [...(yearMap.get(refYr) ?? [])].sort((a, b) => a.date.getTime() - b.date.getTime())
    : []
  const refDoyByIdx = refDays.map(d => toDoy(d.month, d.dom))

  // Map scan patterns to trading-day index ranges on the reference year
  const windowShades = patterns.map(p => {
    let x1 = -1, x2 = -1
    for (let i = 0; i < refDoyByIdx.length; i++) {
      if (refDoyByIdx[i] >= p.startDoy && x1 === -1) x1 = i
      if (refDoyByIdx[i] <= p.endDoy) x2 = i
    }
    if (x1 === -1 || x2 < x1) return null
    return { x1, x2, isPos: p.meanYearReturn > 0, label: `${p.startLabel}–${p.endLabel}` }
  }).filter(Boolean) as { x1: number; x2: number; isPos: boolean; label: string }[]

  // Build chart data
  const cumByYear = new Map<number, number[]>()
  let maxLen = 0
  for (const yr of chartYears) {
    const rets = [...(yearMap.get(yr) ?? [])].sort((a, b) => a.date.getTime() - b.date.getTime()).map(d => d.ret)
    let s = 0
    const cum = rets.map(r => +(s += r).toFixed(5))
    cumByYear.set(yr, cum)
    maxLen = Math.max(maxLen, cum.length)
  }

  type ChartRow = { dayIdx: number } & Record<string, number | null>
  const chartData: ChartRow[] = Array.from({ length: maxLen }, (_, i) => {
    const row: ChartRow = { dayIdx: i }
    const vals: number[] = []
    for (const yr of chartYears) {
      const cum = cumByYear.get(yr)!
      if (i < cum.length) { row[String(yr)] = cum[i]; vals.push(cum[i]) }
      else row[String(yr)] = null
    }
    row['Average'] = vals.length > 0 ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(5) : null
    return row
  })

  // Tick positions from reference year
  const tickPositions: { dayIdx: number; label: string }[] = []
  if (refDays.length > 0) {
    const fmtD = (d: DayData) => `${MONTH_NAMES[d.month - 1].slice(0, 3)} ${d.dom}`
    tickPositions.push({ dayIdx: 0, label: fmtD(refDays[0]) })
    const seen = new Set([refDays[0].month - 1])
    refDays.forEach((d, i) => {
      const mo = d.month - 1
      if (!seen.has(mo) && i > 0 && i < refDays.length - 1) { seen.add(mo); tickPositions.push({ dayIdx: i, label: MONTH_NAMES[mo] }) }
    })
    tickPositions.push({ dayIdx: refDays.length - 1, label: fmtD(refDays[refDays.length - 1]) })
  }

  const mostRecentYear = chartYears[chartYears.length - 1]

  const thStyle: React.CSSProperties = {
    color: '#475569', fontWeight: 600, fontSize: 10, textTransform: 'uppercase',
    letterSpacing: '0.05em', padding: '5px 8px', whiteSpace: 'nowrap',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
  }

  function MiniDist({ rows }: { rows: { year: number; ret: number }[] }) {
    const max = Math.max(...rows.map(r => Math.abs(r.ret)), 1e-9)
    return (
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 22, width: rows.length * 7 }}>
        {rows.map(r => {
          const h = Math.max(2, Math.round(Math.abs(r.ret) / max * 18))
          const color = r.ret >= 0 ? 'rgba(34,197,94,0.70)' : 'rgba(239,68,68,0.70)'
          return <div key={r.year} title={`${r.year}: ${r.ret >= 0 ? '+' : ''}${r.ret.toFixed(3)}`}
            style={{ width: 5, height: h, background: color, borderRadius: 1, flexShrink: 0 }} />
        })}
      </div>
    )
  }

  function Table({ rows, isPos }: { rows: ScanPattern[]; isPos: boolean }) {
    if (rows.length === 0) return null
    const accent = isPos ? '#22c55e' : '#ef4444'
    return (
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 10, color: accent, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
          {isPos ? 'Bullish' : 'Bearish'} windows — {rows.length} found
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                {['Window', '~T.Days', 'Mean / yr', 't-stat', 'p-val', 'FDR adj-p', 'Win rate', 'Yrs', 'Dist.'].map(h => (
                  <th key={h} style={{ ...thStyle, textAlign: h === 'Window' || h === 'Dist.' ? 'left' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontSize: 11, fontWeight: 600, color: '#f1f5f9', whiteSpace: 'nowrap' }}>
                    {p.startLabel} – {p.endLabel}
                  </td>
                  <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 11, color: '#64748b' }}>
                    ~{p.avgTradingDays}d
                  </td>
                  <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: accent }}>
                    {p.meanYearReturn >= 0 ? '+' : ''}{p.meanYearReturn.toFixed(3)}
                  </td>
                  <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>
                    {p.t_stat >= 0 ? '+' : ''}{p.t_stat.toFixed(2)}
                  </td>
                  <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 11, color: sigColor(p.p_value) }}>
                    {p.p_value < 0.001 ? '<0.001' : p.p_value.toFixed(3)}
                  </td>
                  <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 11, color: sigColor(p.adj_p) }}>
                    {p.adj_p < 0.001 ? '<0.001' : p.adj_p.toFixed(3)}
                  </td>
                  <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>
                    {(p.win_rate * 100).toFixed(0)}%
                  </td>
                  <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'monospace', fontSize: 11, color: '#64748b' }}>
                    {p.n_years}
                  </td>
                  <td style={{ padding: '5px 8px' }}>
                    <MiniDist rows={p.yearReturns} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={sectionLabel}>Irregular Window Scan</div>
          <div style={{ fontSize: 11, color: '#475569', marginTop: -8, maxWidth: 560 }}>
            Scans every calendar window from 3 to 40 days, tests cross-year mean with a t-test,
            then deduplicates overlapping windows. p-values are raw; FDR adj-p uses Benjamini–Hochberg across all ~{(366 * 38 / 2).toLocaleString()} candidates.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: '#475569' }}>Sort by</span>
          {(['tstat', 'adj_p'] as const).map(s => {
            const active = sortBy === s
            return (
              <button key={s} onClick={() => setSortBy(s)} style={{
                background: active ? ACCENT_DIM : 'rgba(255,255,255,0.04)',
                border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.07)'}`,
                borderRadius: 6, padding: '3px 10px',
                color: active ? ACCENT : '#475569',
                fontSize: 11, fontWeight: active ? 700 : 400, cursor: 'pointer',
              }}>{s === 'tstat' ? '|t-stat|' : 'FDR adj-p'}</button>
            )
          })}
        </div>
      </div>

      {/* Cumulative chart with shaded windows */}
      {chartData.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 4, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              {/* Shaded windows — render before lines so they sit behind */}
              {windowShades.map((w, i) => (
                <ReferenceArea
                  key={i}
                  x1={w.x1} x2={w.x2}
                  fill={w.isPos ? 'rgba(34,197,94,0.13)' : 'rgba(239,68,68,0.13)'}
                  stroke={w.isPos ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)'}
                  strokeWidth={1}
                  label={{ value: w.label, position: 'insideTop', fontSize: 9, fill: w.isPos ? '#22c55e' : '#ef4444', opacity: 0.8 }}
                />
              ))}
              <XAxis
                dataKey="dayIdx" type="number"
                domain={[0, maxLen - 1]}
                ticks={tickPositions.map(t => t.dayIdx)}
                tickFormatter={i => tickPositions.find(t => t.dayIdx === i)?.label ?? ''}
                tick={{ fill: '#475569', fontSize: 10 }}
                axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} tickLine={false}
              />
              <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(2)} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const idx = label as number
                  const refDay = refDays[idx]
                  const dateLabel = refDay ? `${MONTH_NAMES[refDay.month - 1]} ${refDay.dom}` : `Day ${idx}`
                  return (
                    <div style={{ background: 'rgba(8,13,26,0.95)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', fontSize: 11, maxHeight: 220, overflowY: 'auto' }}>
                      <div style={{ color: '#64748b', marginBottom: 4 }}>{dateLabel}</div>
                      {payload.filter(p => p.value !== null).sort((a, b) => (b.value as number) - (a.value as number)).map(p => (
                        <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, color: p.color }}>
                          <span>{p.dataKey}</span>
                          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{(p.value as number) >= 0 ? '+' : ''}{(p.value as number).toFixed(3)}</span>
                        </div>
                      ))}
                    </div>
                  )
                }}
                cursor={{ stroke: 'rgba(255,255,255,0.10)' }}
              />
              <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
                formatter={value => (
                  <span style={{ color: value === 'Average' ? '#f1f5f9' : String(value) === String(mostRecentYear) ? '#f1f5f9' : '#475569', fontWeight: value === 'Average' ? 700 : 400 }}>{value}</span>
                )}
              />
              {chartYears.map((yr, i) => (
                <Line key={yr} type="monotone" dataKey={String(yr)}
                  stroke={YEAR_COLORS[i % YEAR_COLORS.length]}
                  strokeWidth={yr === mostRecentYear ? 2 : 1}
                  opacity={yr === mostRecentYear ? 0.85 : 0.30}
                  dot={false} connectNulls={false} isAnimationActive={false}
                />
              ))}
              <Line key="Average" type="monotone" dataKey="Average"
                stroke="#ffffff" strokeWidth={3} opacity={1}
                dot={false} connectNulls={false} isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          {/* Window legend */}
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 10, color: '#64748b' }}>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <div style={{ width: 14, height: 10, background: 'rgba(34,197,94,0.25)', border: '1px solid rgba(34,197,94,0.45)', borderRadius: 2 }} />
              bullish window
            </div>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <div style={{ width: 14, height: 10, background: 'rgba(239,68,68,0.25)', border: '1px solid rgba(239,68,68,0.45)', borderRadius: 2 }} />
              bearish window
            </div>
          </div>
        </div>
      )}

      {patterns.length === 0
        ? <div style={{ color: '#334155', fontSize: 12, fontStyle: 'italic', textAlign: 'center', padding: '20px 0' }}>No data available.</div>
        : <>
            <Table rows={positive} isPos={true} />
            <Table rows={negative} isPos={false} />
          </>
      }

      <div style={{ fontSize: 10, color: '#334155', marginTop: 4 }}>
        ★ FDR adj-p &lt; 0.10 suggests a robust pattern after multiple-testing correction. Raw p-val reflects single-window significance only.
      </div>
    </div>
  )
}

// ─── Bar chart panel ──────────────────────────────────────────────────────────

function StatBarChart({ title, data }: { title: string; data: BinStat[] }) {
  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>{title}</div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: data.length > 6 ? 28 : 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="label"
            tick={{ fill: '#475569', fontSize: 10 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            tickLine={false} interval={0}
            angle={data.length > 6 ? -40 : 0}
            textAnchor={data.length > 6 ? 'end' : 'middle'}
          />
          <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(3)} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const d = payload[0].payload as BinStat
              return (
                <div style={{ background: 'rgba(8,13,26,0.95)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                  <div style={{ color: '#94a3b8', marginBottom: 4, fontWeight: 600 }}>{d.label}</div>
                  <div style={{ color: d.mean >= 0 ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>
                    {d.mean >= 0 ? '+' : ''}{d.mean.toFixed(5)}
                  </div>
                  <div style={{ color: sigColor(d.p_value), fontSize: 11, marginTop: 2 }}>
                    p = {d.p_value < 0.001 ? '<0.001' : d.p_value.toFixed(4)} · n = {d.n}
                  </div>
                </div>
              )
            }}
          />
          <Bar dataKey="mean" radius={[3, 3, 0, 0]}>
            {data.map((d, i) => <Cell key={i} fill={d.mean >= 0 ? '#22c55e' : '#ef4444'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Significance table ───────────────────────────────────────────────────────

function SignificanceTable({ stats }: { stats: SeasonalStats }) {
  type DimKey = 'dow' | 'month' | 'dom' | 'tom' | 'quarter_end'
  const DIM_LABELS: Record<DimKey, string> = {
    dow: 'Day of Week', month: 'Month', dom: 'Day-of-Month',
    tom: 'Turn-of-Month', quarter_end: 'Quarter-End',
  }
  const allRows = (['dow','month','dom','tom','quarter_end'] as DimKey[]).flatMap(dim =>
    stats[dim].map(row => ({ ...row, dim: DIM_LABELS[dim] }))
  ).sort((a, b) => a.p_value - b.p_value)

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>Statistical Significance — All Bins (sorted by p-value)</div>
      <div style={{ overflowY: 'auto', maxHeight: 320 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead style={{ position: 'sticky', top: 0, background: stickyBg }}>
            <tr>
              {['Dimension','Bin','Mean','Std','t-stat','p-value','Win Rate','N'].map(h => (
                <th key={h} style={{
                  color: '#475569', textAlign: h === 'Dimension' || h === 'Bin' ? 'left' : 'right',
                  padding: '4px 8px', fontWeight: 600, whiteSpace: 'nowrap',
                  borderBottom: '1px solid rgba(255,255,255,0.07)',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {allRows.map((row, i) => (
              <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ color: '#64748b', padding: '4px 8px', whiteSpace: 'nowrap' }}>{row.dim}</td>
                <td style={{ color: '#94a3b8', padding: '4px 8px', fontWeight: 600 }}>{row.label}</td>
                <td style={{ color: row.mean >= 0 ? '#22c55e' : '#ef4444', padding: '4px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                  {row.mean >= 0 ? '+' : ''}{row.mean.toFixed(5)}
                </td>
                <td style={{ color: '#64748b', padding: '4px 8px', textAlign: 'right', fontFamily: 'monospace' }}>{row.std.toFixed(5)}</td>
                <td style={{ color: '#94a3b8', padding: '4px 8px', textAlign: 'right', fontFamily: 'monospace' }}>{row.t_stat.toFixed(2)}</td>
                <td style={{ color: sigColor(row.p_value), padding: '4px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                  {row.p_value < 0.001 ? '<0.001' : row.p_value.toFixed(4)}
                </td>
                <td style={{ color: '#94a3b8', padding: '4px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                  {(row.win_rate * 100).toFixed(1)}%
                </td>
                <td style={{ color: '#64748b', padding: '4px 8px', textAlign: 'right', fontFamily: 'monospace' }}>{row.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 10, color: '#64748b' }}>
        <span style={{ color: '#22c55e' }}>■ p&lt;0.01</span>
        <span style={{ color: '#86efac' }}>■ p&lt;0.05</span>
        <span style={{ color: '#fbbf24' }}>■ p&lt;0.10</span>
        <span style={{ color: '#475569' }}>■ p≥0.10</span>
      </div>
    </div>
  )
}

// ─── Strategy builder ─────────────────────────────────────────────────────────

function StrategyBuilder({ rule, onChange }: { rule: Rule; onChange: (r: Rule) => void }) {
  const meta = RULE_BIN_META[rule.type]

  const typeOptions: { value: Rule['type']; label: string }[] = [
    { value: 'dow',          label: 'Day of Week' },
    { value: 'month',        label: 'Month of Year' },
    { value: 'dom_quintile', label: 'Day of Month' },
    { value: 'tom',          label: 'Turn of Month' },
    { value: 'quarter_end',  label: 'Quarter-End Window' },
    { value: 'custom',       label: 'Custom Windows' },
  ]

  function toggleBin(bin: number) {
    const next = rule.bins.includes(bin)
      ? rule.bins.filter(b => b !== bin)
      : [...rule.bins, bin]
    onChange({ ...rule, bins: next })
  }

  function updateLeg(i: number, patch: Partial<CustomLeg>) {
    const legs = [...(rule.customLegs ?? [])]
    legs[i] = { ...legs[i], ...patch }
    onChange({ ...rule, customLegs: legs })
  }

  function addLeg() {
    onChange({ ...rule, customLegs: [...(rule.customLegs ?? []), { startMonth: 0, startDay: 0, endMonth: 0, endDay: 0, direction: 1 }] })
  }

  function removeLeg(i: number) {
    const legs = (rule.customLegs ?? []).filter((_, j) => j !== i)
    onChange({ ...rule, customLegs: legs })
  }

  const selectStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6, padding: '4px 7px', color: '#e2e8f0', fontSize: 12, cursor: 'pointer', outline: 'none',
  }
  const DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>Strategy Builder</div>

      {/* Dimension selector */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Seasonal Dimension</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {typeOptions.map(o => {
            const active = rule.type === o.value
            return (
              <button key={o.value} onClick={() => onChange({
                ...rule, type: o.value, bins: [],
                customLegs: o.value === 'custom' && !rule.customLegs?.length
                  ? [{ startMonth: 0, startDay: 0, endMonth: 0, endDay: 0, direction: 1 }]
                  : rule.customLegs,
              })} style={{
                background: active ? ACCENT_DIM : 'rgba(255,255,255,0.05)',
                border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 7, padding: '5px 12px',
                color: active ? ACCENT : '#64748b',
                fontSize: 12, fontWeight: active ? 700 : 400, cursor: 'pointer',
              }}>{o.label}</button>
            )
          })}
        </div>
      </div>

      {/* Standard dimension: direction + bin picker */}
      {rule.type !== 'custom' && (
        <>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Direction</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {([1, -1] as const).map(d => {
                const active = rule.direction === d
                return (
                  <button key={d} onClick={() => onChange({ ...rule, direction: d })} style={{
                    background: active ? (d === 1 ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)') : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${active ? (d === 1 ? 'rgba(34,197,94,0.50)' : 'rgba(239,68,68,0.50)') : 'rgba(255,255,255,0.08)'}`,
                    borderRadius: 7, padding: '5px 14px',
                    color: active ? (d === 1 ? '#22c55e' : '#ef4444') : '#64748b',
                    fontSize: 12, fontWeight: active ? 700 : 400, cursor: 'pointer',
                  }}>{d === 1 ? 'Long' : 'Short'}</button>
                )
              })}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Select Bins</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {meta.labels.map((lbl, i) => {
                const bin = meta.bins[i]
                const active = rule.bins.includes(bin)
                return (
                  <button key={bin} onClick={() => toggleBin(bin)} style={{
                    background: active ? ACCENT_DIM : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.07)'}`,
                    borderRadius: 6, padding: '4px 10px',
                    color: active ? ACCENT : '#475569',
                    fontSize: 11, fontWeight: active ? 700 : 400, cursor: 'pointer',
                  }}>{lbl}</button>
                )
              })}
            </div>
            {rule.bins.length === 0 && (
              <div style={{ marginTop: 10, fontSize: 11, color: '#475569', fontStyle: 'italic' }}>
                Select at least one bin to run a backtest.
              </div>
            )}
          </div>
        </>
      )}

      {/* Custom windows */}
      {rule.type === 'custom' && (
        <div>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Windows
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(rule.customLegs ?? []).map((leg, i) => {
              const isLong = leg.direction === 1
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                  background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '8px 12px',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}>
                  <span style={{ fontSize: 11, color: '#475569', minWidth: 28 }}>#{i + 1}</span>

                  <span style={{ fontSize: 11, color: '#475569' }}>From</span>
                  <select value={leg.startMonth} style={selectStyle} onChange={e => updateLeg(i, { startMonth: +e.target.value })}>
                    <option value={0} style={{ background: '#0f172a' }}>Month</option>
                    {MONTH_NAMES.map((m, mi) => <option key={mi} value={mi + 1} style={{ background: '#0f172a' }}>{m}</option>)}
                  </select>
                  <select value={leg.startDay} style={selectStyle} onChange={e => updateLeg(i, { startDay: +e.target.value })}>
                    <option value={0} style={{ background: '#0f172a' }}>Day</option>
                    {DAYS.map(d => <option key={d} value={d} style={{ background: '#0f172a' }}>{d}</option>)}
                  </select>

                  <span style={{ fontSize: 11, color: '#475569' }}>To</span>
                  <select value={leg.endMonth} style={selectStyle} onChange={e => updateLeg(i, { endMonth: +e.target.value })}>
                    <option value={0} style={{ background: '#0f172a' }}>Month</option>
                    {MONTH_NAMES.map((m, mi) => <option key={mi} value={mi + 1} style={{ background: '#0f172a' }}>{m}</option>)}
                  </select>
                  <select value={leg.endDay} style={selectStyle} onChange={e => updateLeg(i, { endDay: +e.target.value })}>
                    <option value={0} style={{ background: '#0f172a' }}>Day</option>
                    {DAYS.map(d => <option key={d} value={d} style={{ background: '#0f172a' }}>{d}</option>)}
                  </select>

                  <button onClick={() => updateLeg(i, { direction: isLong ? -1 : 1 })} style={{
                    background: isLong ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)',
                    border: `1px solid ${isLong ? 'rgba(34,197,94,0.50)' : 'rgba(239,68,68,0.50)'}`,
                    borderRadius: 6, padding: '4px 12px',
                    color: isLong ? '#22c55e' : '#ef4444',
                    fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  }}>{isLong ? 'Long' : 'Short'}</button>

                  <button onClick={() => removeLeg(i)} style={{
                    background: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 6, padding: '4px 8px',
                    color: '#475569', fontSize: 13, cursor: 'pointer', lineHeight: 1,
                  }}>×</button>
                </div>
              )
            })}
          </div>

          <button onClick={addLeg} style={{
            marginTop: 10,
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 7, padding: '6px 14px',
            color: '#64748b', fontSize: 12, cursor: 'pointer',
          }}>+ Add window</button>

          {!(rule.customLegs ?? []).some(l => l.startMonth && l.startDay && l.endMonth && l.endDay) && (
            <div style={{ marginTop: 10, fontSize: 11, color: '#475569', fontStyle: 'italic' }}>
              Define at least one complete window to run a backtest.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Seasonality Screener ─────────────────────────────────────────────────────

interface ScreenerItem {
  id: string; name: string; group: string
  amp: number; phase: number; sigma: number
}

interface ScreenerResult {
  id: string; name: string; group: string
  mean: number; std: number; t_stat: number; p_value: number
  win_rate: number; n_years: number
  yearReturns: { year: number; ret: number }[]
}

const SCREENER_UNIVERSE: ScreenerItem[] = [
  // Rates
  { id: 'GDBR10',   name: '10y Bund',          group: 'Rates',       amp: 0.15, phase: 0.42, sigma: 1.2 },
  { id: 'GDBR2',    name: '2y Bund',            group: 'Rates',       amp: 0.08, phase: 0.15, sigma: 0.9 },
  { id: 'GDBR5',    name: '5y Bund',            group: 'Rates',       amp: 0.12, phase: 0.38, sigma: 1.0 },
  { id: 'GDBR30',   name: '30y Bund',           group: 'Rates',       amp: 0.18, phase: 0.45, sigma: 1.5 },
  { id: 'USGG10YR', name: '10y UST',            group: 'Rates',       amp: 0.10, phase: 0.22, sigma: 1.3 },
  { id: 'USGG2YR',  name: '2y UST',             group: 'Rates',       amp: 0.06, phase: 0.10, sigma: 0.8 },
  { id: 'USGG30YR', name: '30y UST',            group: 'Rates',       amp: 0.14, phase: 0.28, sigma: 1.4 },
  { id: 'GTGBP10Y', name: '10y Gilt',           group: 'Rates',       amp: 0.13, phase: 0.40, sigma: 1.2 },
  { id: 'GTFRF10Y', name: '10y OAT',            group: 'Rates',       amp: 0.11, phase: 0.43, sigma: 1.1 },
  { id: 'GTESP10Y', name: '10y Bono',           group: 'Rates',       amp: 0.09, phase: 0.35, sigma: 1.8 },
  // Curves
  { id: 'GDBR10-2', name: 'Bund 2s10s',         group: 'Curves',      amp: 0.20, phase: 0.55, sigma: 0.8 },
  { id: 'GDBR30-10',name: 'Bund 10s30s',        group: 'Curves',      amp: 0.16, phase: 0.60, sigma: 0.7 },
  { id: 'UST-2s10s', name: 'UST 2s10s',         group: 'Curves',      amp: 0.14, phase: 0.48, sigma: 0.9 },
  // Spreads
  { id: 'OAT-BUND',  name: 'OAT–Bund Spread',   group: 'Spreads',     amp: 0.25, phase: 0.30, sigma: 1.5 },
  { id: 'BTP-BUND',  name: 'BTP–Bund Spread',   group: 'Spreads',     amp: 0.18, phase: 0.25, sigma: 2.0 },
  { id: 'SPGB-BUND', name: 'Bono–Bund Spread',  group: 'Spreads',     amp: 0.12, phase: 0.20, sigma: 1.7 },
  // FX
  { id: 'EURUSD',   name: 'EUR/USD',             group: 'FX',          amp: 0.04, phase: 0.62, sigma: 0.6 },
  { id: 'GBPUSD',   name: 'GBP/USD',             group: 'FX',          amp: 0.05, phase: 0.58, sigma: 0.7 },
  { id: 'USDJPY',   name: 'USD/JPY',             group: 'FX',          amp: 0.06, phase: 0.20, sigma: 0.9 },
  { id: 'EURCHF',   name: 'EUR/CHF',             group: 'FX',          amp: 0.03, phase: 0.35, sigma: 0.5 },
  // Equity
  { id: 'SX5E',     name: 'EuroStoxx 50',        group: 'Equity',      amp: 0.07, phase: 0.75, sigma: 2.5 },
  { id: 'SPX',      name: 'S&P 500',             group: 'Equity',      amp: 0.09, phase: 0.70, sigma: 2.2 },
  { id: 'UKX',      name: 'FTSE 100',            group: 'Equity',      amp: 0.06, phase: 0.72, sigma: 2.0 },
  // Swaps
  { id: 'EUSA10',   name: '10y EUR IRS',         group: 'Swaps',       amp: 0.14, phase: 0.41, sigma: 1.1 },
  { id: 'EUSA2',    name: '2y EUR IRS',          group: 'Swaps',       amp: 0.07, phase: 0.18, sigma: 0.85 },
  { id: 'USSWAP10', name: '10y USD IRS',         group: 'Swaps',       amp: 0.10, phase: 0.24, sigma: 1.2 },
  // Inflation
  { id: 'EHIA10Y',  name: '10y EUR Inf. Swap',   group: 'Inflation',   amp: 0.22, phase: 0.50, sigma: 0.6 },
  { id: 'USSA10Y',  name: '10y USD Inf. Swap',   group: 'Inflation',   amp: 0.15, phase: 0.45, sigma: 0.7 },
  // Commodities
  { id: 'CL1',      name: 'Crude Oil',            group: 'Commodities', amp: 0.08, phase: 0.15, sigma: 3.0 },
  { id: 'GC1',      name: 'Gold',                 group: 'Commodities', amp: 0.05, phase: 0.55, sigma: 1.5 },
]

const SCREENER_GROUPS = [...new Set(SCREENER_UNIVERSE.map(s => s.group))]

const GROUP_COLORS: Record<string, string> = {
  Rates: '#06B6D4', Curves: '#8B5CF6', Spreads: '#F59E0B',
  FX: '#10B981', Equity: '#EF4444', Swaps: '#3B82F6',
  Inflation: '#F97316', Commodities: '#84CC16',
}

function lcg(seed: number): () => number {
  let s = (seed >>> 0)
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296 }
}

function boxMuller(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2)
}

function monthDayToDoy(month: number, day: number): number {
  const offs = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  return offs[month - 1] + day
}

function seasonalSignalIntegral(startDoy: number, endDoy: number, amp: number, phase: number): number {
  // Integral of amp*sin(2π*(t/365 − phase)) from startDoy to endDoy
  const twoPi = 2 * Math.PI
  const a = twoPi * (startDoy / 365 - phase)
  const b = twoPi * (endDoy / 365 - phase)
  return amp * (365 / twoPi) * (Math.cos(a) - Math.cos(b))
}

const SCREENER_ALL_YEARS = Array.from({ length: 15 }, (_, i) => 2010 + i)

function computeScreenerResults(
  startMonth: number, startDay: number,
  endMonth: number, endDay: number,
  years: number[],
): ScreenerResult[] {
  const startDoy = monthDayToDoy(startMonth, startDay)
  const endDoy = monthDayToDoy(endMonth, endDay)

  return SCREENER_UNIVERSE.map((item, si) => {
    const rng = lcg(si * 7919 + 42)
    const signal = seasonalSignalIntegral(startDoy, endDoy, item.amp, item.phase)

    // Generate noise for ALL years in canonical order so results are stable
    // when years are filtered in/out
    const allYearReturns = SCREENER_ALL_YEARS.map(yr => {
      const u1 = Math.max(rng(), 1e-10), u2 = rng()
      const noise = boxMuller(u1, u2) * item.sigma
      return { year: yr, ret: +(signal + noise).toFixed(4) }
    })
    const yearReturns = allYearReturns.filter(y => years.includes(y.year))

    const rets = yearReturns.map(y => y.ret)
    const n = rets.length
    const mean = rets.reduce((a, b) => a + b, 0) / n
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
    const std = Math.sqrt(variance)
    const se = std / Math.sqrt(n)
    const t = se > 0 ? mean / se : 0
    const p = tTestPValue(t)
    const win_rate = rets.filter(v => v > 0).length / n

    return {
      id: item.id, name: item.name, group: item.group,
      mean: +mean.toFixed(4), std: +std.toFixed(4),
      t_stat: +t.toFixed(3), p_value: +p.toFixed(4),
      win_rate: +win_rate.toFixed(3), n_years: n, yearReturns,
    }
  }).sort((a, b) => Math.abs(b.t_stat) - Math.abs(a.t_stat))
}

// Inline SVG sparkline for year-by-year returns
function Sparkline({ yearReturns }: { yearReturns: { year: number; ret: number }[] }) {
  const w = 3, gap = 1, h = 28
  const rets = yearReturns.map(y => y.ret)
  const maxAbs = Math.max(...rets.map(Math.abs), 0.001)
  const totalW = rets.length * (w + gap) - gap

  return (
    <svg width={totalW} height={h} style={{ verticalAlign: 'middle', display: 'block' }}>
      <line x1={0} y1={h / 2} x2={totalW} y2={h / 2} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
      {rets.map((v, i) => {
        const barH = Math.max(1, Math.abs(v) / maxAbs * (h / 2 - 2))
        const x = i * (w + gap)
        const y = v >= 0 ? h / 2 - barH : h / 2
        return (
          <rect key={i} x={x} y={y} width={w} height={barH}
            fill={v >= 0 ? '#22c55e' : '#ef4444'} opacity={0.8} rx={0.5} />
        )
      })}
    </svg>
  )
}

type ScreenerSort = 'abs_t' | 'mean' | 'p_value' | 'win_rate'

function ScreenerSeriesDetail({ r, startMonth, startDay, endMonth, endDay }: {
  r: ScreenerResult; startMonth: number; startDay: number; endMonth: number; endDay: number
}) {
  const yrs  = r.yearReturns
  const rets = yrs.map(y => y.ret)
  const n    = rets.length

  // Cumulative equity + drawdown
  let cum = 0, peak = 0
  const eqData: { year: number; cumPnL: number; drawdown: number }[] = []
  for (const { year, ret } of yrs) {
    cum  += ret
    peak  = Math.max(peak, cum)
    eqData.push({ year, cumPnL: +cum.toFixed(4), drawdown: +(cum - peak).toFixed(4) })
  }

  const annData = yrs.map(({ year, ret }) => ({ year: String(year), ret: +ret.toFixed(4) }))

  // Metrics
  const totalRet = +rets.reduce((a, b) => a + b, 0).toFixed(4)
  const mean     = totalRet / n
  const std      = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n - 1, 1))
  const sharpe   = std > 0 ? +(mean / std).toFixed(3) : 0
  const maxDd    = Math.min(...eqData.map(d => d.drawdown))
  const winRate  = rets.filter(v => v > 0).length / n

  const metricItems = [
    { label: 'Total Return',  value: `${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(3)}`,    color: totalRet >= 0 ? '#22c55e' : '#ef4444' },
    { label: 'Avg/Year',      value: `${mean >= 0 ? '+' : ''}${mean.toFixed(3)}`,             color: mean >= 0 ? '#22c55e' : '#ef4444' },
    { label: 'Sharpe',        value: sharpe.toFixed(3),                                        color: sharpe > 0.5 ? '#22c55e' : sharpe > 0 ? '#fbbf24' : '#ef4444' },
    { label: 'Max Drawdown',  value: maxDd.toFixed(3),                                         color: '#ef4444' },
    { label: 'Win Rate',      value: `${(winRate * 100).toFixed(0)}%`,                         color: winRate >= 0.5 ? '#22c55e' : '#ef4444' },
    { label: 'Years',         value: String(n),                                                 color: '#94a3b8' },
  ]

  const ddFill  = 'rgba(239,68,68,0.15)'
  const barFmt  = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`

  return (
    <div style={{ padding: '16px 16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        {r.name} &nbsp;·&nbsp; {MONTH_NAMES[startMonth - 1]} {startDay} → {MONTH_NAMES[endMonth - 1]} {endDay}
      </div>

      {/* Metric cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 8 }}>
        {metricItems.map(m => (
          <div key={m.label} style={{ ...cardStyle, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{m.label}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: m.color, fontFamily: 'monospace' }}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* Cumulative PnL */}
      <div style={cardStyle}>
        <div style={sectionLabel}>Cumulative window PnL across years</div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={eqData} margin={{ top: 6, right: 16, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="year" tick={{ fill: '#475569', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} tickLine={false} />
            <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(2)} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.10)' }} />
            {eqData.map((d, i) => (
              <ReferenceLine key={d.year} x={d.year}
                stroke={i % 2 === 0 ? 'rgba(6,182,212,0.12)' : 'transparent'}
                strokeWidth={8} />
            ))}
            <Line type="monotone" dataKey="cumPnL" name="Cum. PnL" stroke={ACCENT} strokeWidth={2} dot={{ r: 3, fill: ACCENT }} activeDot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* Drawdown */}
        <div style={cardStyle}>
          <div style={sectionLabel}>Drawdown</div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={eqData} margin={{ top: 4, right: 16, bottom: 0, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="year" tick={{ fill: '#475569', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} tickLine={false} />
              <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(2)} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.10)' }} />
              <Area type="monotone" dataKey="drawdown" name="Drawdown" stroke="#ef4444" fill={ddFill} strokeWidth={1.5} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Annual bars */}
        <div style={cardStyle}>
          <div style={sectionLabel}>Annual PnL</div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={annData} margin={{ top: 4, right: 16, bottom: 0, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="year" tick={{ fill: '#475569', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} tickLine={false} />
              <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(2)} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} formatter={barFmt} />
              <Bar dataKey="ret" name="Return" radius={[3, 3, 0, 0]}>
                {annData.map(d => (
                  <Cell key={d.year} fill={d.ret >= 0 ? ACCENT : '#ef4444'} opacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

function SeasonalityScreener() {
  const [startMonth, setStartMonth] = useState(6)
  const [startDay,   setStartDay]   = useState(28)
  const [endMonth,   setEndMonth]   = useState(8)
  const [endDay,     setEndDay]     = useState(28)
  const [activeGroups, setActiveGroups] = useState<string[]>(SCREENER_GROUPS)
  const [sortBy, setSortBy] = useState<ScreenerSort>('abs_t')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selectedYears, setSelectedYears] = useState<number[]>(SCREENER_ALL_YEARS)

  const results = useMemo(
    () => computeScreenerResults(startMonth, startDay, endMonth, endDay, selectedYears.length > 0 ? selectedYears : SCREENER_ALL_YEARS),
    [startMonth, startDay, endMonth, endDay, selectedYears]
  )

  const filtered = useMemo(() => {
    const r = results.filter(r => activeGroups.includes(r.group))
    switch (sortBy) {
      case 'abs_t':     return [...r].sort((a, b) => Math.abs(b.t_stat) - Math.abs(a.t_stat))
      case 'mean':      return [...r].sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean))
      case 'p_value':   return [...r].sort((a, b) => a.p_value - b.p_value)
      case 'win_rate':  return [...r].sort((a, b) => Math.abs(b.win_rate - 0.5) - Math.abs(a.win_rate - 0.5))
    }
  }, [results, activeGroups, sortBy])

  const selectStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 7, padding: '4px 8px', color: '#e2e8f0', fontSize: 12,
    cursor: 'pointer', outline: 'none',
  }
  const DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

  function sigStars(p: number) {
    if (p < 0.01) return '★★★'
    if (p < 0.05) return '★★'
    if (p < 0.10) return '★'
    return ''
  }

  function ColHeader({ label, col }: { label: string; col: ScreenerSort }) {
    const active = sortBy === col
    return (
      <th onClick={() => setSortBy(col)} style={{
        padding: '6px 10px', textAlign: 'right', cursor: 'pointer',
        color: active ? ACCENT : '#475569', fontWeight: active ? 700 : 600,
        fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        userSelect: 'none', whiteSpace: 'nowrap',
      }}>
        {label}{active ? ' ▾' : ''}
      </th>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>

      {/* Window + controls */}
      <div style={{ ...cardStyle, padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Seasonal Window</span>
          <span style={{ fontSize: 11, color: '#475569' }}>From</span>
          <select value={startMonth} style={selectStyle} onChange={e => setStartMonth(+e.target.value)}>
            {MONTH_NAMES.map((n, i) => <option key={i} value={i + 1} style={{ background: '#0f172a' }}>{n}</option>)}
          </select>
          <select value={startDay} style={selectStyle} onChange={e => setStartDay(+e.target.value)}>
            {DAYS.map(d => <option key={d} value={d} style={{ background: '#0f172a' }}>{d}</option>)}
          </select>
          <span style={{ fontSize: 11, color: '#475569' }}>To</span>
          <select value={endMonth} style={selectStyle} onChange={e => setEndMonth(+e.target.value)}>
            {MONTH_NAMES.map((n, i) => <option key={i} value={i + 1} style={{ background: '#0f172a' }}>{n}</option>)}
          </select>
          <select value={endDay} style={selectStyle} onChange={e => setEndDay(+e.target.value)}>
            {DAYS.map(d => <option key={d} value={d} style={{ background: '#0f172a' }}>{d}</option>)}
          </select>
          <div style={{ marginLeft: 'auto', fontSize: 10, color: '#475569' }}>
            {filtered.length} series · Sort by:&nbsp;
            {(['abs_t', 'mean', 'p_value', 'win_rate'] as ScreenerSort[]).map(s => (
              <button key={s} onClick={() => setSortBy(s)} style={{
                background: sortBy === s ? ACCENT_DIM : 'transparent',
                border: `1px solid ${sortBy === s ? ACCENT_BORDER : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 5, padding: '2px 8px', color: sortBy === s ? ACCENT : '#64748b',
                fontSize: 10, cursor: 'pointer', marginLeft: 4,
              }}>
                {{ abs_t: '|t-stat|', mean: 'Mean', p_value: 'p-value', win_rate: 'Win Rate' }[s]}
              </button>
            ))}
          </div>
        </div>

        {/* Group filter pills */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {SCREENER_GROUPS.map(g => {
            const on = activeGroups.includes(g)
            return (
              <button key={g} onClick={() => setActiveGroups(on ? activeGroups.filter(x => x !== g) : [...activeGroups, g])} style={{
                background: on ? `${GROUP_COLORS[g]}22` : 'rgba(255,255,255,0.04)',
                border: `1px solid ${on ? GROUP_COLORS[g] + '88' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 20, padding: '3px 10px', color: on ? GROUP_COLORS[g] : '#475569',
                fontSize: 11, fontWeight: on ? 600 : 400, cursor: 'pointer',
              }}>{g}</button>
            )
          })}
        </div>
      </div>

      <YearSelector allYears={SCREENER_ALL_YEARS} selectedYears={selectedYears} onChange={setSelectedYears} />

      {/* Results table */}
      <div style={cardStyle}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#475569', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.07)', width: 28 }}>#</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#475569', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>Series</th>
              <ColHeader label="Mean Ret" col="mean" />
              <ColHeader label="|t-stat|" col="abs_t" />
              <ColHeader label="p-value" col="p_value" />
              <ColHeader label="Win Rate" col="win_rate" />
              <th style={{ padding: '6px 10px', textAlign: 'right', color: '#475569', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>Std</th>
              <th style={{ padding: '6px 10px', textAlign: 'right', color: '#475569', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>Years</th>
              <th style={{ padding: '6px 10px', textAlign: 'center', color: '#475569', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>Annual Returns</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, rank) => {
              const isOpen = expanded === r.id
              const gc = GROUP_COLORS[r.group] ?? '#64748b'
              return (
                <>
                  <tr key={r.id}
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', background: isOpen ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                  >
                    <td style={{ padding: '7px 10px', color: '#334155', fontFamily: 'monospace', fontSize: 10 }}>{rank + 1}</td>
                    <td style={{ padding: '7px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ background: gc + '22', border: `1px solid ${gc}55`, borderRadius: 10, padding: '1px 7px', color: gc, fontSize: 9, fontWeight: 700, whiteSpace: 'nowrap' }}>{r.group}</span>
                        <span style={{ color: '#cbd5e1', fontWeight: 600 }}>{r.name}</span>
                        <span style={{ color: r.mean >= 0 ? '#22c55e' : '#ef4444', fontSize: 13, lineHeight: 1 }}>{r.mean >= 0 ? '↑' : '↓'}</span>
                      </div>
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: r.mean >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                      {r.mean >= 0 ? '+' : ''}{r.mean.toFixed(3)}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: Math.abs(r.t_stat) >= 2 ? '#f1f5f9' : '#64748b', fontWeight: Math.abs(r.t_stat) >= 2 ? 700 : 400 }}>
                      {Math.abs(r.t_stat).toFixed(2)}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: sigColor(r.p_value) }}>
                      {r.p_value.toFixed(3)}&nbsp;<span style={{ fontSize: 9, letterSpacing: '-0.02em' }}>{sigStars(r.p_value)}</span>
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: r.win_rate >= 0.5 ? '#22c55e' : '#ef4444' }}>
                      {(r.win_rate * 100).toFixed(0)}%
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: '#475569' }}>
                      {r.std.toFixed(3)}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: '#475569' }}>{r.n_years}</td>
                    <td style={{ padding: '7px 14px', textAlign: 'center' }}>
                      <Sparkline yearReturns={r.yearReturns} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${r.id}-detail`} style={{ background: 'rgba(6,182,212,0.02)', borderBottom: '1px solid rgba(6,182,212,0.12)' }}>
                      <td colSpan={9}>
                        <ScreenerSeriesDetail r={r} startMonth={startMonth} startDay={startDay} endMonth={endMonth} endDay={endDay} />
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ── Charts ── */}
      {filtered.length > 0 && (() => {
        const byTStat   = [...filtered].sort((a, b) => b.t_stat - a.t_stat)
        const byWinRate = [...filtered].sort((a, b) => b.win_rate - a.win_rate)
        const barH = Math.max(300, filtered.length * 20)

        const ScatterTooltip = ({ active, payload }: { active?: boolean; payload?: { payload: ScreenerResult }[] }) => {
          if (!active || !payload?.length) return null
          const d = payload[0].payload
          return (
            <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', fontSize: 11 }}>
              <div style={{ color: GROUP_COLORS[d.group] ?? ACCENT, fontWeight: 700, marginBottom: 4 }}>{d.name}</div>
              <div style={{ color: '#94a3b8' }}>Mean: {d.mean >= 0 ? '+' : ''}{d.mean.toFixed(3)}</div>
              <div style={{ color: '#94a3b8' }}>t-stat: {d.t_stat.toFixed(3)}</div>
              <div style={{ color: sigColor(d.p_value) }}>p-value: {d.p_value.toFixed(3)}</div>
              <div style={{ color: '#94a3b8' }}>Win rate: {(d.win_rate * 100).toFixed(0)}%</div>
            </div>
          )
        }

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Signed t-stat horizontal bars */}
            <div style={cardStyle}>
              <div style={sectionLabel}>Seasonal Signal Strength — Signed t-statistic (|t| ≥ 2 = significant)</div>
              <ResponsiveContainer width="100%" height={barH}>
                <BarChart data={byTStat} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 110 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                  <XAxis type="number" domain={['auto', 'auto']} tick={{ fill: '#475569', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(1)} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} width={105} axisLine={false} tickLine={false} />
                  <ReferenceLine x={0}  stroke="rgba(255,255,255,0.18)" />
                  <ReferenceLine x={2}  stroke="rgba(34,197,94,0.35)"  strokeDasharray="4 3" label={{ value: '+2', position: 'insideTopRight', fontSize: 9, fill: '#22c55e' }} />
                  <ReferenceLine x={-2} stroke="rgba(239,68,68,0.35)"  strokeDasharray="4 3" label={{ value: '−2', position: 'insideTopLeft',  fontSize: 9, fill: '#ef4444' }} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  <Bar dataKey="t_stat" name="t-stat" radius={[0, 3, 3, 0]}>
                    {byTStat.map(r => (
                      <Cell key={r.id}
                        fill={r.t_stat >= 0 ? ACCENT : '#ef4444'}
                        opacity={Math.abs(r.t_stat) >= 2 ? 0.85 : 0.35} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 16 }}>

              {/* Scatter: mean return vs t-stat */}
              <div style={cardStyle}>
                <div style={sectionLabel}>Mean Return vs t-statistic — by asset class</div>
                <ResponsiveContainer width="100%" height={320}>
                  <ScatterChart margin={{ top: 16, right: 24, bottom: 32, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis type="number" dataKey="mean" name="Mean Return"
                      tick={{ fill: '#475569', fontSize: 10 }} tickLine={false} axisLine={false}
                      tickFormatter={v => v.toFixed(2)}
                      label={{ value: 'Mean Return', position: 'insideBottom', offset: -16, fill: '#475569', fontSize: 10 }} />
                    <YAxis type="number" dataKey="t_stat" name="t-stat"
                      tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false}
                      tickFormatter={v => v.toFixed(1)}
                      label={{ value: 't-stat', angle: -90, position: 'insideLeft', offset: 12, fill: '#475569', fontSize: 10 }} />
                    <ZAxis range={[40, 40]} />
                    <ReferenceLine y={0}  stroke="rgba(255,255,255,0.10)" />
                    <ReferenceLine x={0}  stroke="rgba(255,255,255,0.10)" />
                    <ReferenceLine y={2}  stroke="rgba(34,197,94,0.30)"  strokeDasharray="4 3" label={{ value: '+2', position: 'insideTopRight', fontSize: 9, fill: '#22c55e' }} />
                    <ReferenceLine y={-2} stroke="rgba(239,68,68,0.30)"  strokeDasharray="4 3" label={{ value: '−2', position: 'insideBottomRight', fontSize: 9, fill: '#ef4444' }} />
                    <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.15)' }} />
                    {SCREENER_GROUPS.filter(g => activeGroups.includes(g)).map(g => (
                      <Scatter key={g} name={g}
                        data={filtered.filter(r => r.group === g)}
                        fill={GROUP_COLORS[g] ?? '#64748b'} opacity={0.85} />
                    ))}
                    <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>

              {/* Win rate horizontal bars */}
              <div style={cardStyle}>
                <div style={sectionLabel}>Win Rate — % of selected years positive</div>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={byWinRate} layout="vertical" margin={{ top: 4, right: 36, bottom: 4, left: 110 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                    <XAxis type="number" domain={[0, 1]} tickFormatter={v => `${(v * 100).toFixed(0)}%`}
                      tick={{ fill: '#475569', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} width={105} axisLine={false} tickLine={false} />
                    <ReferenceLine x={0.5} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 3"
                      label={{ value: '50%', position: 'insideTopRight', fontSize: 9, fill: '#64748b' }} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} formatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
                    <Bar dataKey="win_rate" name="Win Rate" radius={[0, 3, 3, 0]}>
                      {byWinRate.map(r => (
                        <Cell key={r.id} fill={r.win_rate >= 0.5 ? '#22c55e' : '#ef4444'} opacity={0.7} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )
      })()}

      <div style={{ fontSize: 10, color: '#334155', textAlign: 'center', paddingBottom: 8 }}>
        ★ p &lt; 0.10 &nbsp;·&nbsp; ★★ p &lt; 0.05 &nbsp;·&nbsp; ★★★ p &lt; 0.01 &nbsp;·&nbsp;
        Synthetic data shown — connect Bloomberg for live results &nbsp;·&nbsp;
        t-stat bold when |t| ≥ 2
      </div>
    </div>
  )
}

// ─── Backtest results ─────────────────────────────────────────────────────────

function BacktestResults({ result }: { result: BacktestResult }) {
  const { metrics, equity_curve, annual } = result

  // Index-based data — active days only, no flat sections
  const equityData = equity_curve.strategy.map((v, i) => ({ idx: i, strategy: v, date: equity_curve.dates[i] }))
  const ddData = equity_curve.drawdown.map((v, i) => ({ idx: i, drawdown: v, date: equity_curve.dates[i] }))
  const annChart = annual.map(r => ({ year: String(r.year), strategy: r.strat_total }))

  // Build window ranges [start, end] from windowStarts indices
  const windowRanges = equity_curve.windowStarts.map((start, i) => {
    const end = i + 1 < equity_curve.windowStarts.length
      ? equity_curve.windowStarts[i + 1] - 1
      : equity_curve.dates.length - 1
    const dateStr = equity_curve.dates[start]
    const dt = dateStr ? new Date(dateStr) : null
    const endStr = equity_curve.dates[end]
    const dtEnd = endStr ? new Date(endStr) : null
    const startLabel = dt ? `${MONTH_NAMES[dt.getMonth()]} ${dt.getDate()} '${String(dt.getFullYear()).slice(2)}` : ''
    const endLabel = dtEnd ? `${MONTH_NAMES[dtEnd.getMonth()]} ${dtEnd.getDate()} '${String(dtEnd.getFullYear()).slice(2)}` : ''
    return { start, end, startLabel, endLabel, even: i % 2 === 0 }
  })

  function fmtDate(dateStr: string) {
    const dt = new Date(dateStr)
    return `${MONTH_NAMES[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`
  }

  const metricItems = [
    { label: 'Total Return',   value: `${metrics.total_return >= 0 ? '+' : ''}${metrics.total_return.toFixed(4)}`,   color: metrics.total_return >= 0 ? '#22c55e' : '#ef4444' },
    { label: 'Ann. Return',    value: `${metrics.ann_return >= 0 ? '+' : ''}${metrics.ann_return.toFixed(4)}`,       color: metrics.ann_return >= 0 ? '#22c55e' : '#ef4444' },
    { label: 'Sharpe Ratio',   value: metrics.sharpe.toFixed(3),                                                     color: metrics.sharpe > 0.5 ? '#22c55e' : metrics.sharpe > 0 ? '#fbbf24' : '#ef4444' },
    { label: 'Max Drawdown',   value: metrics.max_drawdown.toFixed(4),                                               color: '#ef4444' },
    { label: 'Win Rate',       value: `${(metrics.win_rate * 100).toFixed(1)}%`,                                     color: metrics.win_rate >= 0.5 ? '#22c55e' : '#ef4444' },
    { label: 'Days in Market', value: `${metrics.days_in_market} (${(metrics.pct_in_market * 100).toFixed(1)}%)`,   color: '#94a3b8' },
  ]

  // Custom tooltip showing actual date
  function EqTooltip({ active, payload }: { active?: boolean; payload?: { value: number; dataKey: string; payload: { date: string } }[] }) {
    if (!active || !payload?.length) return null
    const date = payload[0]?.payload?.date
    return (
      <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 12px', fontSize: 11 }}>
        {date && <div style={{ color: '#64748b', marginBottom: 4 }}>{fmtDate(date)}</div>}
        {payload.map(p => (
          <div key={p.dataKey} style={{ color: p.dataKey === 'strategy' ? ACCENT : '#ef4444' }}>
            {p.dataKey === 'strategy' ? 'Strategy' : 'Drawdown'}: {p.value >= 0 ? '+' : ''}{p.value.toFixed(4)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
        {metricItems.map(m => (
          <div key={m.label} style={{ ...cardStyle, padding: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{m.label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: m.color, fontFamily: 'monospace' }}>{m.value}</div>
          </div>
        ))}
      </div>

      <div style={cardStyle}>
        <div style={sectionLabel}>Cumulative PnL — Each window shown consecutively</div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={equityData} margin={{ top: 8, right: 8, bottom: 24, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis dataKey="idx" hide />
            <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(2)} />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
            <Tooltip content={<EqTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.10)' }} />
            {/* Shaded band per window, alternating opacity */}
            {windowRanges.map(({ start, end, even }) => (
              <ReferenceArea key={start} x1={start} x2={end}
                fill={even ? 'rgba(6,182,212,0.10)' : 'rgba(6,182,212,0.04)'}
                stroke="rgba(6,182,212,0.35)" strokeWidth={1} />
            ))}
            {/* Start-of-window label at bottom */}
            {windowRanges.map(({ start, startLabel }) => (
              <ReferenceLine key={`lbl-${start}`} x={start}
                stroke="transparent"
                label={{ value: startLabel, position: 'insideBottomLeft', fontSize: 8, fill: '#475569', angle: -55, offset: 4 }} />
            ))}
            <Line type="monotone" dataKey="strategy" stroke={ACCENT} strokeWidth={2} dot={false} activeDot={{ r: 3 }} name="Strategy" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={cardStyle}>
          <div style={sectionLabel}>Strategy Drawdown (active windows only)</div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={ddData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="idx" hide />
              <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(2)} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
              <Tooltip content={<EqTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.10)' }} />
              {windowRanges.map(({ start, end, even }) => (
                <ReferenceArea key={start} x1={start} x2={end}
                  fill={even ? 'rgba(6,182,212,0.08)' : 'rgba(6,182,212,0.03)'}
                  stroke="rgba(6,182,212,0.25)" strokeWidth={1} />
              ))}
              <Area type="monotone" dataKey="drawdown" stroke="#ef4444" fill="rgba(239,68,68,0.15)" strokeWidth={1.5} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div style={cardStyle}>
          <div style={sectionLabel}>Annual PnL</div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={annChart} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="year" tick={{ fill: '#475569', fontSize: 10 }} axisLine={{ stroke: 'rgba(255,255,255,0.08)' }} tickLine={false} />
              <YAxis tick={{ fill: '#475569', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v.toFixed(2)} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.10)' }} />
              <Bar dataKey="strategy" name="Strategy" fill={ACCENT} radius={[3,3,0,0]} opacity={0.85} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={sectionLabel}>Year-by-Year Summary</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              {['Year','Strategy PnL','Sharpe','Win Rate','# Trades'].map(h => (
                <th key={h} style={{ color: '#475569', textAlign: h === 'Year' ? 'left' : 'right', padding: '4px 10px', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {annual.map(r => (
              <tr key={r.year} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ color: '#94a3b8', padding: '4px 10px', fontWeight: 600 }}>{r.year}</td>
                <td style={{ color: r.strat_total >= 0 ? '#22c55e' : '#ef4444', padding: '4px 10px', textAlign: 'right', fontFamily: 'monospace' }}>
                  {r.strat_total >= 0 ? '+' : ''}{r.strat_total.toFixed(4)}
                </td>
                <td style={{ color: r.sharpe > 0 ? '#94a3b8' : '#ef4444', padding: '4px 10px', textAlign: 'right', fontFamily: 'monospace' }}>{r.sharpe.toFixed(3)}</td>
                <td style={{ color: r.win_rate >= 0.5 ? '#22c55e' : '#ef4444', padding: '4px 10px', textAlign: 'right', fontFamily: 'monospace' }}>{(r.win_rate * 100).toFixed(1)}%</td>
                <td style={{ color: '#64748b', padding: '4px 10px', textAlign: 'right', fontFamily: 'monospace' }}>{r.n_trades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SeasonalityBacktester() {
  const navigate = useNavigate()
  const token = localStorage.getItem('access_token')

  // Fetched Bloomberg series
  const [series, setSeries] = useState<SeriesData | null>(null)
  const [loadingData, setLoadingData] = useState(false)
  const [dataError, setDataError] = useState<string | null>(null)

  // Strategy builder
  const [rule, setRule] = useState<Rule>({ type: 'dow', bins: [0, 4], direction: 1 })
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null)
  const [activeTab, setActiveTab] = useState<'analysis' | 'backtest' | 'screener'>('analysis')
  const [backtestYears, setBacktestYears] = useState<number[]>([])

  // Derive day data + stats from fetched series (computed in browser)
  const days = useMemo(() => series ? buildDayData(series) : [], [series])
  const allYears = useMemo(() => [...new Set(days.map(d => d.date.getFullYear()))].sort(), [days])
  const [selectedYears, setSelectedYears] = useState<number[]>([])
  useEffect(() => { setSelectedYears(allYears) }, [allYears])
  useEffect(() => { setBacktestYears(allYears) }, [allYears])

  // Time window (recurring annual, MM-DD strings)
  const [windowStart, setWindowStart] = useState('01-01')
  const [windowEnd, setWindowEnd] = useState('12-31')
  useEffect(() => { setWindowStart('01-01'); setWindowEnd('12-31') }, [allYears])

  const filteredDays = useMemo(() => {
    if (!windowStart || !windowEnd) return days
    const [sm, sd] = windowStart.split('-').map(Number)
    const [em, ed] = windowEnd.split('-').map(Number)
    const sVal = sm * 100 + sd
    const eVal = em * 100 + ed
    return days.filter(d => {
      const dVal = d.month * 100 + d.dom
      return sVal <= eVal ? dVal >= sVal && dVal <= eVal : dVal >= sVal || dVal <= eVal
    })
  }, [days, windowStart, windowEnd])
  const daysByYear = useMemo(
    () => days.filter(d => selectedYears.includes(d.date.getFullYear())),
    [days, selectedYears]
  )
  const stats = useMemo(() => daysByYear.length > 0 ? computeSeasonalStats(daysByYear) : null, [daysByYear])
  const monthlyTable = useMemo(() => days.length > 0 ? computeMonthlyTable(days) : null, [days])
  const windowTable = useMemo(() => computeWindowTable(filteredDays), [filteredDays])
  const scanPatterns = useMemo(() => computeWindowScan(daysByYear), [daysByYear])

  async function handleLoad(expression: string, start: string) {
    if (!token) { navigate('/login', { replace: true }); return }
    setLoadingData(true)
    setDataError(null)
    setSeries(null)
    setBacktestResult(null)

    try {
      const params = new URLSearchParams({ expression, start })
      const res = await fetch(`/api/tools/seasonality/data?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      const data: SeriesData = await res.json()
      if (!data.dates?.length) throw new Error('No data returned for this expression.')
      setSeries(data)
    } catch (e) {
      setDataError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingData(false)
    }
  }

  const canRunBacktest = rule.type === 'custom'
    ? (rule.customLegs ?? []).some(l => l.startMonth && l.startDay && l.endMonth && l.endDay)
    : rule.bins.length > 0

  function runBacktest() {
    if (!days.length || !canRunBacktest) return
    const btDays = backtestYears.length > 0
      ? days.filter(d => backtestYears.includes(d.date.getFullYear()))
      : days
    setBacktestResult(computeBacktest(btDays, rule))
    setActiveTab('backtest')
  }

  return (
    <div style={{ background: BG, minHeight: '100vh' }}>

      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at 50% -10%, rgba(6,182,212,0.05) 0%, transparent 55%)',
      }} />

      {/* Header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 24px',
        background: 'rgba(8,13,26,0.90)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        backdropFilter: 'blur(12px)',
        flexWrap: 'wrap', gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button onClick={() => navigate('/')} style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 8, padding: '6px 14px', color: '#94a3b8', fontSize: 13, cursor: 'pointer',
          }}>← Back</button>
          <div>
            <div style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>
              Seasonality Backtester
            </div>
            <div style={{ color: '#475569', fontSize: 11, marginTop: 1 }}>
              {series
                ? `${series.expression}  ·  ${stats?.date_range[0]} → ${stats?.date_range[1]}  ·  ${stats?.n_obs.toLocaleString()} obs`
                : 'Enter a Bloomberg expression to begin'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
            {(['analysis', 'backtest', 'screener'] as const).map(tab => {
              const active = activeTab === tab
              const label = tab === 'analysis' ? 'Seasonal Analysis' : tab === 'backtest' ? 'Backtest' : 'Screener'
              return (
                <button key={tab} onClick={() => setActiveTab(tab)} style={{
                  background: active ? ACCENT_DIM : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${active ? ACCENT_BORDER : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: 7, padding: '5px 14px',
                  color: active ? ACCENT : '#64748b',
                  fontSize: 12, fontWeight: active ? 700 : 400, cursor: 'pointer',
                }}>
                  {label}
                </button>
              )
            })}
          </div>
      </header>

      <main style={{ padding: '20px 24px' }}>

        {/* Expression input always visible at top */}
        <ExpressionInput
          onLoad={handleLoad}
          onSimulate={s => { setSeries(s); setBacktestResult(null); setDataError(null) }}
          loading={loadingData}
        />

        {/* Loading state */}
        {loadingData && (
          <div style={{ textAlign: 'center', padding: 60, color: '#475569', fontSize: 13 }}>
            Fetching from Bloomberg…
          </div>
        )}

        {/* Error state */}
        {dataError && !loadingData && (
          <div style={{ ...cardStyle, marginTop: 16, borderColor: 'rgba(239,68,68,0.30)', background: 'rgba(239,68,68,0.07)' }}>
            <div style={{ color: '#ef4444', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Failed to load data</div>
            <div style={{ color: '#fca5a5', fontSize: 12, fontFamily: 'monospace' }}>{dataError}</div>
          </div>
        )}

        {/* Analysis tab */}
        {!loadingData && series && stats && monthlyTable && activeTab === 'analysis' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
            <YearSelector allYears={allYears} selectedYears={selectedYears} onChange={setSelectedYears} />
            <MonthlyReturnsTable table={monthlyTable} selectedYears={selectedYears} />
            <CumulativeYearChart days={days} selectedYears={selectedYears} />

            {/* ── Time-window section ── */}
            <WindowSelector onChange={(s, e) => { setWindowStart(s); setWindowEnd(e) }} />
            {windowStart && windowEnd && windowTable && (
              <>
                <WindowReturnsTable table={windowTable} selectedYears={selectedYears} />
                <CumulativeYearChart days={filteredDays} selectedYears={selectedYears} />
              </>
            )}
            <WindowScanSection patterns={scanPatterns} days={days} selectedYears={selectedYears} />

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
              <StatBarChart title="Avg Change by Day of Week"         data={stats.dow}   />
              <StatBarChart title="Avg Change by Month"               data={stats.month} />
              <StatBarChart title="Avg Change by Day-of-Month Bucket" data={stats.dom}   />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <StatBarChart title="Turn-of-Month Window"  data={stats.tom}         />
              <StatBarChart title="Quarter-End Window"    data={stats.quarter_end} />
            </div>

            <SignificanceTable stats={stats} />
          </div>
        )}

        {/* Backtest tab */}
        {!loadingData && series && activeTab === 'backtest' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
            <StrategyBuilder rule={rule} onChange={setRule} />
            <YearSelector allYears={allYears} selectedYears={backtestYears} onChange={setBacktestYears} />

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={runBacktest}
                disabled={!canRunBacktest || backtestYears.length === 0}
                style={{
                  background: !canRunBacktest ? 'rgba(255,255,255,0.05)' : ACCENT_DIM,
                  border: `1px solid ${!canRunBacktest ? 'rgba(255,255,255,0.08)' : ACCENT_BORDER}`,
                  borderRadius: 8, padding: '8px 24px',
                  color: !canRunBacktest ? '#475569' : ACCENT,
                  fontSize: 13, fontWeight: 700,
                  cursor: !canRunBacktest ? 'not-allowed' : 'pointer',
                }}
              >
                Run Backtest
              </button>
            </div>

            {backtestResult
              ? <BacktestResults result={backtestResult} />
              : (
                <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: 60 }}>
                  Configure a rule above and click Run Backtest.
                </div>
              )
            }
          </div>
        )}

        {/* Screener tab — always available, no series required */}
        {activeTab === 'screener' && (
          <SeasonalityScreener />
        )}

      </main>
    </div>
  )
}
