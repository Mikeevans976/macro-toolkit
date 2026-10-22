import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis,
} from 'recharts'
import { accent, chart, fg, line2 } from '../../theme'
import { LABOUR_GROUP_COLOR, type LabourContribution, type LabourGdpImplied, type LabourIndicator, type LabourPoint, type LabourStaffReport, type LabourSvar } from './labourTypes'
import { BG, monthLabel, num, signed } from './ui'

// Colours: the house hues in an order that passes the categorical checks on the dark
// surface. Grey is the residual / baseline slot.
const OUTTURN = '#5d6773'
const PAYROLL = '#c27f20'
const BOE = '#e4eaf1'
const GROUP_COLOR = LABOUR_GROUP_COLOR
const legend = { wrapperStyle: { fontSize: 11, color: fg[3] }, iconSize: 9 }

// ─── Underlying employment growth with its band, the LFS and payrolls ───

export function UnderlyingChart({ series, staff, from, showPayrolls, labels }: {
  series: LabourPoint[]; staff: LabourStaffReport[]; from: string; showPayrolls: boolean
  labels: { target: string; flash: string | null; staff: string }
}) {
  const boeAt: Record<string, number> = {}
  for (const r of staff) if (r.data_through && r.underlying_value != null) boeAt[r.data_through] = r.underlying_value
  const data = series.filter(p => p.month >= from).map(p => ({
    month: p.month,
    underlying: p.kind === 'projection' ? null : p.underlying,
    projection: p.kind === 'projection' || p.month === series.filter(s => s.kind === 'estimate').slice(-1)[0]?.month ? p.underlying : null,
    band: p.kind === 'pandemic' || p.lo == null || p.hi == null ? null : [p.lo, p.hi],
    lfs: p.lfs,
    payrolls: showPayrolls ? p.payrolls : null,
    boe: boeAt[p.month] ?? null,
  }))
  const every = Math.max(0, Math.ceil(data.length / 10) - 1)
  // Scale to the non-pandemic data: 2020's payroll and LFS swings would flatten everything else
  const normal = series.filter(p => p.month >= from && p.kind !== 'pandemic')
    .flatMap(p => [p.lo, p.hi, p.lfs, showPayrolls ? p.payrolls : null]).filter((v): v is number => v != null)
  const lo = Math.floor(Math.min(0, ...normal) * 4) / 4, hi = Math.ceil(Math.max(0, ...normal) * 4) / 4
  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="month" {...chart.axis} tickFormatter={m => monthLabel(String(m))} interval={every} />
        <YAxis {...chart.axis} width={40} domain={[lo, hi]} allowDataOverflow tickFormatter={v => Number(v).toFixed(1)} />
        <ReferenceLine y={0} stroke={line2} />
        <Tooltip {...chart.tooltip} labelFormatter={m => monthLabel(String(m))}
          formatter={(v: unknown, name: string) => [Array.isArray(v) ? `${num(v[0], 2)} to ${num(v[1], 2)}%` : `${signed(Number(v), 2)}%`, name]} />
        <Legend {...legend} />
        <Area dataKey="band" name="95% band" stroke="none" fill={accent} fillOpacity={0.18} isAnimationActive={false} legendType="square" />
        <Line dataKey="lfs" name={labels.target} stroke={OUTTURN} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        {showPayrolls && labels.flash && <Line dataKey="payrolls" name={labels.flash} stroke={PAYROLL} strokeWidth={1.5} dot={false} isAnimationActive={false} />}
        <Line dataKey="underlying" name="Underlying (factor model)" stroke={accent} strokeWidth={2.5} dot={false} isAnimationActive={false} />
        <Line dataKey="projection" name="Projection" stroke={accent} strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} legendType="none" />
        <Scatter dataKey="boe" name={`${labels.staff} judgement`} fill={BG} stroke={BOE} strokeWidth={1.5} shape="diamond" isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ─── Contributions by indicator group (they add up to underlying growth minus its constant) ───

export function ContributionsChart({ rows, indicators }: { rows: LabourContribution[]; indicators: LabourIndicator[] }) {
  const group = Object.fromEntries(indicators.map(i => [i.id, i.group]))
  const groups = Object.keys(GROUP_COLOR).filter(g => indicators.some(i => i.in_model && i.group === g))
  const data = rows.map(r => {
    const out: Record<string, unknown> = { month: r.month, total: r.total != null && r.constant != null ? r.total - r.constant : null }
    for (const g of groups) out[g] = 0
    for (const [id, v] of Object.entries(r.contributions)) out[group[id]] = (out[group[id]] as number) + (v ?? 0)
    return out
  })
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} stackOffset="sign" barCategoryGap="18%">
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="month" {...chart.axis} tickFormatter={m => monthLabel(String(m))} interval={3} />
        <YAxis {...chart.axis} width={44} tickFormatter={v => Number(v).toFixed(2)} />
        <ReferenceLine y={0} stroke={line2} />
        <Tooltip {...chart.tooltip} labelFormatter={m => monthLabel(String(m))} formatter={(v: unknown, name: string) => [`${signed(Number(v), 3)}pp`, name]} />
        <Legend {...legend} />
        {groups.map(g => <Bar key={g} dataKey={g} stackId="c" fill={GROUP_COLOR[g]} stroke={BG} strokeWidth={1} isAnimationActive={false} />)}
        <Line dataKey="total" name="Deviation from average growth" stroke={fg[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ─── Bank of England companion charts ───

export function GdpImpliedChart({ g }: { g: LabourGdpImplied }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={g.rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="quarter" {...chart.axis} interval={3} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(1)} />
        <ReferenceLine y={0} stroke={line2} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown, name: string) => [`${signed(Number(v), 2)}%`, name]} />
        <Legend {...legend} />
        <Line dataKey="underlying" name="Underlying employment growth" stroke={accent} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="implied" name="Implied by GDP growth" stroke={PAYROLL} strokeWidth={2} dot={{ r: 3, fill: PAYROLL, stroke: BG, strokeWidth: 1.5 }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

export function SvarChart({ svar }: { svar: LabourSvar }) {
  const data = svar.rows.map(r => ({ month: r.month, demand: r.demand, supply: r.supply, deviation: r.employment - r.baseline }))
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} stackOffset="sign" barCategoryGap="15%">
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="month" {...chart.axis} tickFormatter={m => monthLabel(String(m))} interval={5} />
        <YAxis {...chart.axis} width={44} tickFormatter={v => Number(v).toFixed(2)} />
        <ReferenceLine y={0} stroke={line2} />
        <Tooltip {...chart.tooltip} labelFormatter={m => monthLabel(String(m))} formatter={(v: unknown, name: string) => [`${signed(Number(v), 3)}pp`, name]} />
        <Legend {...legend} />
        <Bar dataKey="demand" name="Labour demand" stackId="s" fill="#3b8fd0" stroke={BG} strokeWidth={1} isAnimationActive={false} />
        <Bar dataKey="supply" name="Labour supply" stackId="s" fill="#c27f20" stroke={BG} strokeWidth={1} isAnimationActive={false} />
        <Line dataKey="deviation" name="Employment growth vs no-shock path" stroke={fg[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

export function LoadingsChart({ indicators }: { indicators: LabourIndicator[] }) {
  const data = indicators.filter(i => i.in_model).map(i => ({ name: i.short, loading: i.loading, color: GROUP_COLOR[i.group] }))
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, 30 * data.length)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
        <CartesianGrid {...chart.grid} horizontal={false} vertical />
        <XAxis type="number" {...chart.axis} tickFormatter={v => Number(v).toFixed(1)} />
        <YAxis type="category" dataKey="name" {...chart.axis} width={110} />
        <Tooltip {...chart.tooltip} formatter={(v: unknown) => [num(Number(v), 2), 'Loading']} />
        <Bar dataKey="loading" isAnimationActive={false} radius={[0, 2, 2, 0]}
          shape={(props: unknown) => {
            const p = props as { x: number; y: number; width: number; height: number; payload: { color: string } }
            return <rect x={p.width < 0 ? p.x + p.width : p.x} y={p.y + 3} width={Math.abs(p.width)} height={Math.max(p.height - 6, 2)} rx={2} fill={p.payload.color} />
          }} />
      </BarChart>
    </ResponsiveContainer>
  )
}
