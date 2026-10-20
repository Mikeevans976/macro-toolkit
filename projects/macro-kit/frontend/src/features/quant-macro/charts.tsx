import { useState } from 'react'
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { accent, chart, fg, fontNum, line2 } from '../../theme'
import type { Backtest, EvolutionStep, PathPoint, QuarterRow } from './types'
import { BG, GROUP_COLOR, GROUP_ORDER, MODEL_COLOR, dayLabel, monthLabel, num, quarterLabel, signed } from './ui'

const OUTTURN = '#5d6773'      // released data: recessive graphite, the nowcast carries the accent

function niceStep(span: number): number {
  const raw = span / 5
  const mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw
}

// ─── Quarterly growth: outturns, nowcasts with 68/90% bands, central-bank estimates ───

export function QuarterChart({ quarters, cb, cbLabel }: {
  quarters: QuarterRow[]
  cb: Record<string, number>
  cbLabel: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720, H = 250, L = 44, R = 12, T = 18, B = 34
  const vals = quarters.flatMap(q => [q.actual, q.lo90, q.hi90, cb[q.quarter]]).filter((v): v is number => v != null)
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals)
  const pad = (hi - lo) * 0.12 || 0.5
  lo -= pad; hi += pad
  const step = niceStep(hi - lo)
  const ticks: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Number(t.toFixed(6)))
  const y = (v: number) => T + (hi - v) / (hi - lo) * (H - T - B)
  const colW = (W - L - R) / quarters.length
  const cx = (i: number) => L + colW * (i + 0.5)
  const hq = hover == null ? null : quarters[hover]

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Quarterly GDP growth: outturns and nowcasts" style={{ display: 'block' }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? line2 : 'rgba(150,178,205,0.07)'} strokeDasharray={t === 0 ? undefined : '2 4'} />
            <text x={L - 6} y={y(t) + 3} textAnchor="end" fill={fg[4]} fontSize={10} fontFamily={fontNum}>{t.toFixed(step < 0.1 ? 2 : 1)}</text>
          </g>
        ))}
        {quarters.map((q, i) => {
          const x = cx(i)
          const released = q.status === 'released'
          const bw = colW * 0.42
          const est = cb[q.quarter]
          return (
            <g key={q.quarter}>
              {released && q.actual != null && (
                <rect x={x - bw / 2} width={bw} y={Math.min(y(q.actual), y(0))} height={Math.max(Math.abs(y(q.actual) - y(0)), 1)}
                  rx={2} fill={OUTTURN} opacity={hover == null || hover === i ? 1 : 0.6} />
              )}
              {!released && q.lo90 != null && q.hi90 != null && q.lo68 != null && q.hi68 != null && q.nowcast != null && (
                <>
                  <rect x={x - colW * 0.09} width={colW * 0.18} y={y(q.hi90)} height={y(q.lo90) - y(q.hi90)} rx={2} fill={accent} opacity={0.18} />
                  <rect x={x - colW * 0.15} width={colW * 0.3} y={y(q.hi68)} height={y(q.lo68) - y(q.hi68)} rx={2} fill={accent} opacity={0.38} />
                  <circle cx={x} cy={y(q.nowcast)} r={5.5} fill={accent} stroke={BG} strokeWidth={2} />
                  <text x={x + colW * 0.17} y={y(q.nowcast) + 4} fill={fg[1]} fontSize={11} fontFamily={fontNum}>{signed(q.nowcast)}</text>
                </>
              )}
              {est != null && (
                <path d={`M ${x} ${y(est) - 6} L ${x + 6} ${y(est)} L ${x} ${y(est) + 6} L ${x - 6} ${y(est)} Z`}
                  fill={BG} stroke={fg[1]} strokeWidth={1.5} />
              )}
              <text x={x} y={H - B + 16} textAnchor="middle" fill={released ? fg[4] : fg[2]} fontSize={10} fontFamily={fontNum}>{quarterLabel(q.quarter)}</text>
              <text x={x} y={H - B + 28} textAnchor="middle" fill={fg[4]} fontSize={9}>{released ? '' : q.status}</text>
              <rect x={L + colW * i} width={colW} y={T} height={H - T - B} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            </g>
          )
        })}
      </svg>
      {hq && hover != null && (
        <div style={{
          ...chart.tooltip.contentStyle, position: 'absolute', top: 8, pointerEvents: 'none', padding: '8px 10px',
          left: `${Math.min(cx(hover) / W * 100, 70)}%`,
        }}>
          <div style={{ color: fg[3], marginBottom: 4 }}>{quarterLabel(hq.quarter)} · {hq.status}</div>
          {hq.actual != null && <div>Outturn {signed(hq.actual)}%</div>}
          {hq.nowcast != null && <div>Nowcast {signed(hq.nowcast)}% <span style={{ color: fg[3] }}>68% {num(hq.lo68)} to {num(hq.hi68)}</span></div>}
          {hq.bridge != null && <div style={{ color: fg[2] }}>PMI bridge {signed(hq.bridge)}%</div>}
          {cb[hq.quarter] != null && <div style={{ color: fg[2] }}>{cbLabel} {signed(cb[hq.quarter])}%</div>}
          {hq.status !== 'released' && <div style={{ color: fg[3] }}>First estimate {dayLabel(hq.release_date)}</div>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: fg[3], marginTop: 4, flexWrap: 'wrap' }}>
        <Key swatch={<span style={{ width: 10, height: 10, background: OUTTURN, borderRadius: 2 }} />} label="Outturn" />
        <Key swatch={<span style={{ width: 10, height: 10, borderRadius: '50%', background: accent }} />} label="DFM nowcast, 68% and 90% bands" />
        <Key swatch={<svg width={12} height={12}><path d="M6 1 11 6 6 11 1 6Z" fill={BG} stroke={fg[1]} strokeWidth={1.5} /></svg>} label={`${cbLabel} (latest)`} />
      </div>
    </div>
  )
}

function Key({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{swatch}{label}</span>
}

// ─── Monthly path: outturns and the model's expectation for the missing months ───

export function MonthlyPathChart({ path, unit }: { path: PathPoint[]; unit: string }) {
  const data = path.map(p => {
    const missing = p.actual == null
    return {
      month: monthLabel(p.month),
      actual: p.actual,
      model: missing ? p.model : null,
      band90: missing && p.lo90 != null && p.hi90 != null ? [p.lo90, p.hi90] : null,
      band68: missing && p.lo68 != null && p.hi68 != null ? [p.lo68, p.hi68] : null,
    }
  })
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} barCategoryGap="22%">
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="month" {...chart.axis} interval={2} />
        <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(1)} />
        <ReferenceLine y={0} stroke={line2} />
        <Tooltip {...chart.tooltip}
          formatter={(v: unknown, name: string) => [Array.isArray(v) ? `${num(v[0])} to ${num(v[1])}` : `${signed(Number(v))} ${unit}`, name]} />
        <Area dataKey="band90" name="90% band" stroke="none" fill={accent} fillOpacity={0.12} isAnimationActive={false} />
        <Area dataKey="band68" name="68% band" stroke="none" fill={accent} fillOpacity={0.26} isAnimationActive={false} />
        <Bar dataKey="actual" name="Outturn" fill={OUTTURN} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        <Line dataKey="model" name="Model" stroke={accent} strokeWidth={2} strokeDasharray="4 3"
          dot={{ r: 4, fill: accent, stroke: BG, strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ─── Evolution of one quarter's nowcast, and the news that moved it ───

export function EvolutionCharts({ steps, quarter }: { steps: EvolutionStep[]; quarter: string }) {
  const data = steps.map((s, i) => {
    const v = s.nowcasts[quarter] ?? null
    const sd = s.sds[quarter] ?? null
    const row: Record<string, unknown> = {
      i, date: dayLabel(s.date), nowcast: v,
      band: v != null && sd != null ? [v - 0.9945 * sd, v + 0.9945 * sd] : null,
    }
    for (const g of GROUP_ORDER) row[g] = i === 0 ? null : (s.by_group[quarter]?.[g] ?? null)
    return row
  })
  const groups = GROUP_ORDER.filter(g => data.some(r => r[g] != null && r[g] !== 0))
  const tick = (i: number) => String(data[i]?.date ?? '')
  const every = Math.max(0, Math.ceil(data.length / 9) - 1)
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} syncId="evolution">
          <CartesianGrid {...chart.grid} />
          <XAxis dataKey="i" {...chart.axis} tickFormatter={tick} interval={every} />
          <YAxis {...chart.axis} width={40} domain={['auto', 'auto']} tickFormatter={v => Number(v).toFixed(2)} />
          <Tooltip {...chart.tooltip} labelFormatter={i => tick(Number(i))}
            formatter={(v: unknown, name: string) => [Array.isArray(v) ? `${num(v[0])} to ${num(v[1])}` : `${signed(Number(v))}%`, name]} />
          <Area dataKey="band" name="68% band" type="stepAfter" stroke="none" fill={accent} fillOpacity={0.2} isAnimationActive={false} />
          <Line dataKey="nowcast" name={`${quarterLabel(quarter)} nowcast`} type="stepAfter" stroke={accent} strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <ResponsiveContainer width="100%" height={170}>
        <BarChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }} stackOffset="sign" syncId="evolution" barCategoryGap="18%">
          <CartesianGrid {...chart.grid} />
          <XAxis dataKey="i" {...chart.axis} tickFormatter={tick} interval={every} />
          <YAxis {...chart.axis} width={40} tickFormatter={v => Number(v).toFixed(2)} />
          <ReferenceLine y={0} stroke={line2} />
          <Tooltip {...chart.tooltip} labelFormatter={i => tick(Number(i))}
            formatter={(v: unknown, name: string) => [`${signed(Number(v), 3)}pp`, name]} />
          <Legend wrapperStyle={{ fontSize: 11, color: fg[3] }} iconType="square" iconSize={9} />
          {groups.map(g => (
            <Bar key={g} dataKey={g} stackId="news" fill={GROUP_COLOR[g]} stroke={BG} strokeWidth={1} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Backtest: RMSE by days before the first estimate ───

const MODEL_NAME = { dfm: 'DFM', bridge: 'PMI bridge', naive: 'Last outturn' } as const

export function BacktestChart({ bt }: { bt: Backtest }) {
  const data = bt.summary.map(s => ({
    h: s.horizon, dfm: s.dfm.rmse, bridge: s.bridge.rmse, naive: s.naive.rmse,
  }))
  const keys = (['dfm', 'bridge', 'naive'] as const).filter(k => data.some(d => d[k] != null))
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 84, bottom: 4, left: 0 }}>
        <CartesianGrid {...chart.grid} />
        <XAxis dataKey="h" {...chart.axis} tickFormatter={h => `${h}d`} />
        <YAxis {...chart.axis} width={40} domain={[0, 'auto']} tickFormatter={v => Number(v).toFixed(2)} />
        <Tooltip {...chart.tooltip} labelFormatter={h => `${Math.abs(Number(h))} days before the first estimate`}
          formatter={(v: unknown, name: string) => [`${num(Number(v))}pp`, name]} />
        <Legend wrapperStyle={{ fontSize: 11, color: fg[3] }} iconType="plainline" />
        {keys.map(k => (
          <Line key={k} dataKey={k} name={MODEL_NAME[k]} stroke={MODEL_COLOR[k]} strokeWidth={2}
            dot={{ r: 4, fill: MODEL_COLOR[k], stroke: BG, strokeWidth: 2 }} connectNulls isAnimationActive={false}
            label={({ x, y, index }: { x: number; y: number; index: number }) =>
              index === data.length - 1 ? <text x={x + 8} y={y + 4} fill={fg[2]} fontSize={11}>{MODEL_NAME[k]}</text> : <g />} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
