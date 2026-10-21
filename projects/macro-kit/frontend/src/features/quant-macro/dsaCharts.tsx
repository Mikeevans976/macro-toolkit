import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { accent, chart, fg, fontNum, line2 } from '../../theme'
import type { DsaDynamicsRow, DsaFanRow, DsaFinancing, DsaInterest, DsaMarket, DsaProjectionRow, DsaScenario, DsaTracker } from './dsaTypes'
import { BG, dayLabel, lastOf, monthLabel, num, signed } from './ui'

// Colours: the house hues in orders that pass the categorical checks on the dark
// surface (adjacent pairs ΔE ≥ 15, CVD ΔE ≥ 8). Grey is always the residual slot.
const OBR = '#9aa5b1'              // the OBR's forecast: neutral ink, dashed
const OUTTURN = '#5d6773'
const ATTR_COLOR = { bank_rate: '#3b8fd0', gilts: '#c27f20', inflation: '#a07ae0', time: '#6b7480' } as const
const ATTR_LABEL = { bank_rate: 'Bank Rate path', gilts: 'Gilt yields', inflation: 'RPI inflation', time: 'Passage of time' } as const
const DYN_COLOR = { primary: '#3b8fd0', growth: '#2fa37a', interest: '#c27f20', other: '#7d8792' } as const
const DYN_LABEL = { primary: 'Primary deficit', growth: 'Nominal growth', interest: 'Interest', other: 'Other (financial transactions)' } as const
const INT_COLOR = { conventional: '#3b8fd0', floating: '#c27f20', index_linked: '#a07ae0', apf_offset: '#6b7480' } as const
const INT_LABEL = { conventional: 'Conventional gilts', floating: 'Bills, NS&I and reserves', index_linked: 'Index-linked gilts', apf_offset: 'APF gilt coupons (offset)' } as const
const PAIR = ['#3b8fd0', '#c27f20'] as const

const yearTick = (y: string) => `${y.slice(2, 4)}-${y.slice(5)}`
const legend = { wrapperStyle: { fontSize: 11, color: fg[3] }, iconSize: 9 }

// ─── Debt path: outturns, OBR, market baseline and the stochastic fan ───

export function DebtPathChart({ rows, fan, measure, height = 300 }: {
  rows: DsaProjectionRow[]
  fan: DsaFanRow[]
  measure: 'psnd_pct' | 'psnfl_pct'
  height?: number
}) {
  const fanBy = Object.fromEntries(fan.map(f => [f.year, f]))
  const firstForecast = rows.find(r => r.kind !== 'outturn')?.year
  const data = rows.filter(r => Number(r.year.slice(0, 4)) >= 2005).map(r => {
    const f = fanBy[r.year]
    const fc = r.kind !== 'outturn'
    const obrKey = measure === 'psnd_pct' ? 'obr_psnd_pct' : 'obr_psnfl_pct'
    return {
      year: r.year,
      outturn: fc ? null : r[measure],
      market: fc ? r[measure] : (r.year === lastOf(rows.filter(x => x.kind === 'outturn'))?.year ? r[measure] : null),
      obr: fc ? r[obrKey] : null,
      band90: fc && f && f.p5 != null && f.p95 != null ? [f.p5, f.p95] : null,
      band50: fc && f && f.p25 != null && f.p75 != null ? [f.p25, f.p75] : null,
    }
  })
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="year" {...chart.axis} tickFormatter={yearTick} interval={2} />
        <YAxis {...chart.axis} width={40} domain={['auto', 'auto']} tickFormatter={v => `${Number(v).toFixed(0)}`} />
        <Tooltip {...chart.tooltip}
          formatter={(v: unknown, name: string) => [Array.isArray(v) ? `${num(v[0], 1)} to ${num(v[1], 1)}%` : `${num(Number(v), 1)}%`, name]} />
        <Legend {...legend} />
        {firstForecast && <ReferenceLine x={firstForecast} stroke={line2} strokeDasharray="3 3" />}
        <Area dataKey="band90" name="90% of paths" stroke="none" fill={accent} fillOpacity={0.12} isAnimationActive={false} legendType="square" />
        <Area dataKey="band50" name="50% of paths" stroke="none" fill={accent} fillOpacity={0.24} isAnimationActive={false} legendType="square" />
        <Line dataKey="outturn" name="Outturn (ONS)" stroke={OUTTURN} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="obr" name="OBR forecast" stroke={OBR} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        <Line dataKey="market" name="At today's market prices" stroke={accent} strokeWidth={2}
          dot={{ r: 3, fill: accent, stroke: BG, strokeWidth: 1.5 }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ─── Headroom against a rule since the OBR's market window ───

export function HeadroomHistoryChart({ history, obr }: { history: { date: string; value: number | null }[]; obr: number | null }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={history} margin={{ top: 8, right: 56, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="date" {...chart.axis} tickFormatter={d => dayLabel(String(d))} minTickGap={40} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(0)} />
        <Tooltip {...chart.tooltip} labelFormatter={d => dayLabel(String(d))} formatter={(v: unknown) => [`£${num(Number(v), 1)}bn`, 'Headroom']} />
        <ReferenceLine y={0} stroke={line2} />
        {obr != null && (
          <ReferenceLine y={obr} stroke={OBR} strokeDasharray="5 4"
            label={{ value: 'OBR', position: 'right', fill: fg[3], fontSize: 10 }} />
        )}
        <Line dataKey="value" name="Headroom" stroke={accent} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ─── Debt dynamics: contributions to the change in the debt ratio ───

export function DynamicsChart({ rows }: { rows: DsaDynamicsRow[] }) {
  const keys = ['primary', 'growth', 'interest', 'other'] as const
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} stackOffset="sign" barCategoryGap="18%">
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="year" {...chart.axis} tickFormatter={yearTick} interval={1} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(0)} />
        <ReferenceLine y={0} stroke={line2} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown, name: string) => [`${signed(Number(v), 2)}pp`, name]} />
        <Legend {...legend} />
        {keys.map(k => (
          <Bar key={k} dataKey={k} name={DYN_LABEL[k]} stackId="d" fill={DYN_COLOR[k]} stroke={BG} strokeWidth={1} isAnimationActive={false} />
        ))}
        <Line dataKey="change" name="Change in debt ratio" stroke={fg[1]} strokeWidth={2}
          dot={{ r: 3, fill: fg[1], stroke: BG, strokeWidth: 1.5 }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

export function RminusGChart({ rows }: { rows: DsaDynamicsRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="year" {...chart.axis} tickFormatter={yearTick} interval={2} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(0)} />
        <ReferenceLine y={0} stroke={line2} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown, name: string) => [`${num(Number(v), 2)}%`, name]} />
        <Legend {...legend} />
        <Line dataKey="effective_rate" name="Effective interest rate" stroke={PAIR[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="nominal_growth" name="Nominal GDP growth" stroke={PAIR[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ─── Debt interest ───

export function InterestChart({ interest }: { interest: DsaInterest }) {
  const hist = interest.history.filter(h => Number(h.year.slice(0, 4)) >= 2010)
    .map(h => ({ year: h.year, outturn: h.interest, obr: null, market: null }))
  const fc = interest.rows.map(r => ({ year: r.year, outturn: null, obr: r.obr, market: r.market }))
  const data = [...hist.filter(h => !fc.some(f => f.year === h.year)), ...fc]
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barCategoryGap="22%">
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="year" {...chart.axis} tickFormatter={yearTick} interval={2} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(0)} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown, name: string) => [`£${num(Number(v), 1)}bn`, name]} />
        <Legend {...legend} />
        <Bar dataKey="outturn" name="Outturn (ONS)" fill={OUTTURN} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        <Line dataKey="obr" name="OBR forecast" stroke={OBR} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        <Line dataKey="market" name="At today's market prices" stroke={accent} strokeWidth={2}
          dot={{ r: 3, fill: accent, stroke: BG, strokeWidth: 1.5 }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

export function InterestCompositionChart({ interest }: { interest: DsaInterest }) {
  const keys = ['conventional', 'floating', 'index_linked', 'apf_offset'] as const
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={interest.rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} stackOffset="sign" barCategoryGap="22%">
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="year" {...chart.axis} tickFormatter={yearTick} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(0)} />
        <ReferenceLine y={0} stroke={line2} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown, name: string) => [`£${num(Number(v), 1)}bn`, name]} />
        <Legend {...legend} />
        {keys.map(k => (
          <Bar key={k} dataKey={k} name={INT_LABEL[k]} stackId="i" fill={INT_COLOR[k]} stroke={BG} strokeWidth={1} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

// ─── Financing ───

export function MaturityChart({ financing }: { financing: DsaFinancing }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={financing.profile} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barCategoryGap="12%">
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="year" {...chart.axis} tickFormatter={y => String(y).slice(0, 4)} interval={4} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(0)} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown, name: string) => [`£${num(Number(v), 1)}bn`, name]} />
        <Legend {...legend} />
        <Bar dataKey="conventional" name="Conventional" stackId="m" fill={PAIR[0]} stroke={BG} strokeWidth={1} isAnimationActive={false} />
        <Bar dataKey="index_linked" name="Index-linked (with uplift)" stackId="m" fill={PAIR[1]} stroke={BG} strokeWidth={1} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function GrossFinancingChart({ financing }: { financing: DsaFinancing }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={financing.gross} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barCategoryGap="22%">
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="year" {...chart.axis} tickFormatter={yearTick} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(0)} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown, name: string) => [`£${num(Number(v), 1)}bn`, name]} />
        <Legend {...legend} />
        <Bar dataKey="redemptions" name="Redemptions" stackId="g" fill={PAIR[0]} stroke={BG} strokeWidth={1} isAnimationActive={false} />
        <Bar dataKey="net_need" name="Net financing need" stackId="g" fill={PAIR[1]} stroke={BG} strokeWidth={1} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ─── Scenarios: the market baseline against one scenario ───

export function ScenarioChart({ base, scenario, measure }: { base: DsaProjectionRow[]; scenario: DsaScenario; measure: 'psnd_pct' | 'psnfl_pct' }) {
  const by = Object.fromEntries(scenario.paths.map(p => [p.year, p]))
  const lastOutturn = lastOf(base.filter(r => r.kind === 'outturn'))?.year
  const data = base.filter(r => r.kind !== 'outturn' || Number(r.year.slice(0, 4)) >= 2018).map(r => {
    const fc = r.kind !== 'outturn'
    const joint = r.year === lastOutturn            // both lines start from the last outturn
    return {
      year: r.year,
      outturn: fc ? null : r[measure],
      baseline: fc || joint ? r[measure] : null,
      scenario: fc ? (by[r.year]?.[measure] ?? null) : joint ? r[measure] : null,
    }
  })
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="year" {...chart.axis} tickFormatter={yearTick} interval={1} />
        <YAxis {...chart.axis} width={40} domain={['auto', 'auto']} tickFormatter={v => Number(v).toFixed(0)} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown, name: string) => [`${num(Number(v), 1)}%`, name]} />
        <Legend {...legend} />
        <Line dataKey="outturn" name="Outturn (ONS)" stroke={OUTTURN} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="baseline" name="Market baseline" stroke={accent} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="scenario" name={scenario.name} stroke={PAIR[1]} strokeWidth={2}
          dot={{ r: 3, fill: PAIR[1], stroke: BG, strokeWidth: 1.5 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ─── Monthly borrowing ───

export function TrackerChart({ tracker }: { tracker: DsaTracker }) {
  const data = tracker.months.map(m => ({ ...m, label: monthLabel(m.month) }))
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barCategoryGap="22%" barGap={2}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="label" {...chart.axis} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(0)} />
        <ReferenceLine y={0} stroke={line2} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown, name: string) => [`£${num(Number(v), 1)}bn`, name]} />
        <Legend {...legend} />
        <Bar dataKey="previous" name="Last year" fill={OUTTURN} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="current" name="This year" fill={accent} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        <Line dataKey="obr_profile" name="OBR full year, last year's pattern" stroke={OBR} strokeWidth={2} strokeDasharray="5 4"
          dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ─── Market pricing ───

export function YieldsChart({ market }: { market: DsaMarket }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={market.series} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="date" {...chart.axis} tickFormatter={d => dayLabel(String(d))} minTickGap={50} />
        <YAxis {...chart.axis} width={40} domain={['auto', 'auto']} tickFormatter={v => Number(v).toFixed(1)} />
        <Tooltip {...chart.tooltip} labelFormatter={d => dayLabel(String(d))} formatter={(v: unknown, name: string) => [`${num(Number(v), 2)}%`, name]} />
        <Legend {...legend} />
        <Line dataKey="gilt_10y" name="10y gilt" stroke={PAIR[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="gilt_30y" name="30y gilt" stroke={PAIR[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function SpreadChart({ market }: { market: DsaMarket }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={market.series} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="date" {...chart.axis} tickFormatter={d => dayLabel(String(d))} minTickGap={50} />
        <YAxis {...chart.axis} width={40} domain={['auto', 'auto']} tickFormatter={v => Number(v).toFixed(0)} />
        <Tooltip {...chart.tooltip} labelFormatter={d => dayLabel(String(d))} formatter={(v: unknown) => [`${num(Number(v), 0)}bp`, '10y gilt − OIS']} />
        <Line dataKey="gilt_ois_10y" name="10y gilt − OIS" stroke={accent} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function CurveChart({ market }: { market: DsaMarket }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={market.curve} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="maturity" {...chart.axis} type="number" domain={[0, 40]} ticks={[1, 2, 5, 10, 20, 30, 40]} tickFormatter={m => `${m}y`} />
        <YAxis {...chart.axis} width={40} domain={['auto', 'auto']} tickFormatter={v => Number(v).toFixed(1)} />
        <Tooltip {...chart.tooltip} labelFormatter={m => `${m} years`} formatter={(v: unknown, name: string) => [`${num(Number(v), 2)}%`, name]} />
        <Legend {...legend} />
        <Line dataKey="obr_window" name="Gilts, OBR window" stroke={OBR} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        <Line dataKey="latest" name="Gilts, latest" stroke={accent} strokeWidth={2} dot={{ r: 3, fill: accent, stroke: BG, strokeWidth: 1.5 }} isAnimationActive={false} />
        <Line dataKey="ois_latest" name="OIS, latest" stroke={PAIR[1]} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ─── Attribution: OBR headroom → each driver → headroom today (a waterfall) ───

export function AttributionBars({ rule }: { rule: { obr_bn: number | null; market_bn: number | null; attribution: Record<string, number | null> } }) {
  const steps = (['time', 'bank_rate', 'gilts', 'inflation'] as const).map(k => ({ k, v: rule.attribution[k] ?? 0 }))
  const ob = rule.obr_bn ?? 0
  const levels: { label: string; from: number; to: number; color: string; total?: boolean }[] = [
    { label: 'OBR', from: 0, to: ob, color: OBR, total: true },
  ]
  let run = ob
  for (const s of steps) {
    levels.push({ label: ATTR_LABEL[s.k], from: run, to: run + s.v, color: ATTR_COLOR[s.k] })
    run += s.v
  }
  levels.push({ label: 'Today', from: 0, to: rule.market_bn ?? run, color: accent, total: true })
  const vals = levels.flatMap(l => [l.from, l.to])
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals)
  const x = (v: number) => ((v - lo) / (hi - lo || 1)) * 100
  return (
    <div role="img" aria-label="Change in headroom since the OBR forecast, by driver" style={{ display: 'grid', gap: 6 }}>
      {levels.map(l => (
        <div key={l.label} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 64px', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: fg[3] }}>{l.label}</span>
          <div style={{ position: 'relative', height: 14 }}>
            <div style={{ position: 'absolute', left: `${x(0)}%`, top: -2, bottom: -2, width: 1, background: line2 }} />
            <div style={{
              position: 'absolute', left: `${Math.min(x(l.from), x(l.to))}%`, width: `${Math.max(Math.abs(x(l.to) - x(l.from)), 0.4)}%`,
              top: 2, height: 10, borderRadius: 2, background: l.color, opacity: l.total ? 0.9 : 1,
            }} />
          </div>
          <span style={{ fontFamily: fontNum, fontSize: 11, color: fg[2], textAlign: 'right' }}>
            {l.total ? `£${num(l.to, 1)}bn` : signed(l.to - l.from, 1)}
          </span>
        </div>
      ))}
    </div>
  )
}
