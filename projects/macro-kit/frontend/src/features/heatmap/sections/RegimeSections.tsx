/** Curve (e.g. 2s10s/2s30s) and long-tenor breakeven regime analytics, and the scenario probabilities built on them
 *  (curve only where the region has no inflation-linked market and the payload's breakeven is null). */
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Breakeven, CurveRegimes, HeatmapDashboard, LookbackRow, ScenarioKey } from '../types'
import { C, Card, Eyebrow, LegendRow, MONO, Note, Stat, axisTick, dateAxis, td, th, tooltipStyle, zipSeries } from '../ui'

const CURVE = [
  { key: 'bull_steep', label: 'Bull steepening', color: C.green },
  { key: 'bull_flat', label: 'Bull flattening', color: C.blue },
  { key: 'bear_steep', label: 'Bear steepening', color: C.gold },
  { key: 'bear_flat', label: 'Bear flattening', color: C.red },
] as const
const BE = [
  { key: 'expansion', label: 'Expansion', sub: 'bear widening', color: C.green },
  { key: 'slowdown', label: 'Slowdown', sub: 'bull tightening', color: C.blue },
  { key: 'stagflation', label: 'Stagflation', sub: 'bull widening', color: C.red },
  { key: 'goldilocks', label: 'Goldilocks', sub: 'bear tightening', color: C.gold },
] as const
const SCENARIOS: { key: ScenarioKey; label: string; desc: string; color: string }[] = [
  { key: 'hard_landing', label: 'Hard landing', desc: 'Recessionary bull steepening / growth shock', color: C.blue },
  { key: 'soft_landing', label: 'Soft landing', desc: 'Mild disinflation, orderly flattening', color: C.green },
  { key: 'no_landing', label: 'No landing', desc: 'Resilient growth, rates range-bound', color: C.gold },
  { key: 'reacceleration', label: 'Reacceleration', desc: 'Reflation: bear flattening / expansion', color: C.red },
]
const pct = (v: number) => `${v}%`
const yPct = { domain: [0, 100] as [number, number], tickFormatter: pct, tick: axisTick, tickLine: false, axisLine: false, ticks: [0, 25, 50, 75, 100] }

function LookbackTable({ rows, regimes }: { rows: LookbackRow[]; regimes: readonly { key: string; label: string; color: string }[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
      <thead>
        <tr>
          <th style={th('left')}>Look-back</th>
          {regimes.map(r => <th key={r.key} style={{ ...th(), color: r.color }}>{r.label}</th>)}
          <th style={th()}>Dispersion</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => {
          const top = Math.max(...regimes.map(r => Number(row[r.key])))
          return (
            <tr key={row.horizon}>
              <td style={td('left', { color: C.body, fontFamily: MONO })}>{row.horizon}</td>
              {regimes.map(r => {
                const v = Number(row[r.key])
                return <td key={r.key} style={td('right', { color: v === top ? r.color : C.soft, fontWeight: v === top ? 600 : 400 })}>{pct(v)}</td>
              })}
              <td style={td('right', { color: C.muted })}>{row.dispersion.toFixed(1)}%</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function CurvePanel({ c, bond }: { c: CurveRegimes; bond: string }) {
  const directional = c.dates.map((_, i) => c.bull_steep[i] + c.bear_flat[i])
  const current = directional[directional.length - 1]
  const rows = zipSeries(c.dates, { directional, bull_steep: c.bull_steep, bull_flat: c.bull_flat, bear_steep: c.bear_steep, bear_flat: c.bear_flat, dispersion: c.dispersion })
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <p style={{ color: C.text, fontSize: 13, fontWeight: 600, margin: 0 }}>{c.name} {bond}</p>
          <Note>Bull-steepening (rally, curve steepens) + bear-flattening (sell-off, curve flattens) share; &gt;50% = macro-driven curve.</Note>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Stat label="Directional (3m)" value={pct(current)} big color={current > 55 ? C.green : current < 40 ? C.red : C.gold} />
          <Stat label="Avg dispersion" value={`${c.dispersion_avg.toFixed(1)}%`} />
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: -8 }} stackOffset="expand">
          <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
          <XAxis {...dateAxis(c.dates)} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={v => `${Math.round(Number(v) * 100)}%`} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number, k: string) => [pct(v), CURVE.find(r => r.key === k)?.label ?? k]} />
          {CURVE.map(r => <Area key={r.key} type="monotone" dataKey={r.key} stackId="1" stroke={r.color} fill={r.color} fillOpacity={0.35} isAnimationActive={false} />)}
        </AreaChart>
      </ResponsiveContainer>
      <LegendRow items={CURVE.map(r => ({ label: r.label, color: r.color }))} />
      <LookbackTable rows={c.lookbacks} regimes={CURVE} />
      <div>
        <Eyebrow>Regime dispersion — 3m rolling (low = conviction, high = mixed signals)</Eyebrow>
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
            <XAxis {...dateAxis(c.dates)} />
            <YAxis {...yPct} />
            <ReferenceLine y={c.dispersion_avg} stroke="rgba(111,194,162,0.3)" strokeDasharray="4 4" />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v.toFixed(1)}%`, 'Dispersion']} />
            <Line type="monotone" dataKey="dispersion" stroke={C.green} strokeWidth={1.4} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export function CurveRegimeSection({ data }: { data: HeatmapDashboard }) {
  return (
    <Card title={`${data.bond_name} Curve Directionality`}
      subtitle="Share of daily moves in each curve regime · 3-month (63-day) rolling window">
      <div style={{ display: 'grid', gap: 32 }}>
        {data.curve_regimes.map(c => <CurvePanel key={c.name} c={c} bond={data.bond_name} />)}
      </div>
    </Card>
  )
}

export function BreakevenSection({ data, breakeven: be }: { data: HeatmapDashboard; breakeven: Breakeven }) {
  const t = data.fv_tenor
  const rows = zipSeries(be.regime_dates, {
    orthodox: be.regime_dates.map((_, i) => be.expansion[i] + be.slowdown[i]),
    nonOrthodox: be.regime_dates.map((_, i) => be.stagflation[i] + be.goldilocks[i]),
    dispersion: be.dispersion,
  })
  const last = be.regime_dates.length - 1
  return (
    <Card title={`${t} Breakeven Dynamics`}
      subtitle={<>{t} {data.bond_name} nominal yield vs breakeven &middot; four-regime classification &middot; 3m rolling{be.source === 'simulation' ? ' · simulated breakeven (no live real-yield series configured)' : ''}</>}
      right={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Stat label={`${t} breakeven`} value={`${be.breakeven[be.breakeven.length - 1].toFixed(2)}%`} />
          <Stat label="Expansion" value={pct(be.expansion[last])} color={C.green} />
          <Stat label="Slowdown" value={pct(be.slowdown[last])} color={C.blue} />
        </div>
      }>
      <Eyebrow>Orthodox regimes (expansion + slowdown) vs non-orthodox (stagflation + goldilocks)</Eyebrow>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
          <XAxis {...dateAxis(be.regime_dates)} />
          <YAxis {...yPct} />
          <ReferenceLine y={50} stroke="rgba(200,220,240,0.10)" strokeDasharray="4 4" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number, k: string) => [pct(v), k === 'orthodox' ? 'Orthodox' : 'Non-orthodox']} />
          <Line type="monotone" dataKey="orthodox" stroke={C.green} strokeWidth={1.7} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="nonOrthodox" stroke={C.red} strokeWidth={1.2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <LegendRow items={[{ label: 'Orthodox', color: C.green }, { label: 'Non-orthodox', color: C.red, dashed: true }]} />
      <div style={{ marginTop: 20 }}><LookbackTable rows={be.lookbacks} regimes={BE} /></div>
      <div style={{ marginTop: 20 }}>
        <Eyebrow>Regime dispersion — 3m rolling</Eyebrow>
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
            <XAxis {...dateAxis(be.regime_dates)} />
            <YAxis {...yPct} />
            <ReferenceLine y={be.dispersion_avg} stroke="rgba(111,194,162,0.3)" strokeDasharray="4 4" />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v.toFixed(1)}%`, 'Dispersion']} />
            <Line type="monotone" dataKey="dispersion" stroke={C.green} strokeWidth={1.4} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <Note>Expansion: yields up, breakevens widen. Slowdown: yields down, breakevens narrow. Stagflation: yields down, breakevens widen. Goldilocks: yields up, breakevens narrow.</Note>
    </Card>
  )
}

function ProbBars({ title, probs }: { title: string; probs: Record<ScenarioKey, number> }) {
  return (
    <div style={{ flex: '1 1 300px', minWidth: 0 }}>
      <Eyebrow>{title}</Eyebrow>
      <div style={{ display: 'grid', gap: 8 }}>
        {SCENARIOS.map(s => (
          <div key={s.key} title={s.desc}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
              <span style={{ color: C.body }}>{s.label}</span>
              <span style={{ color: s.color, fontFamily: MONO, fontWeight: 600 }}>{pct(probs[s.key])}</span>
            </div>
            <div style={{ height: 6, background: 'rgba(200,220,240,0.06)', borderRadius: 3 }}>
              <div style={{ width: `${probs[s.key]}%`, height: '100%', background: s.color, borderRadius: 3, opacity: 0.8 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ScenarioSection({ data }: { data: HeatmapDashboard }) {
  const sc = data.scenarios
  const curve = data.curve_regimes[0].name
  const be = `${data.fv_tenor} breakeven`
  const series = (src: Record<ScenarioKey, number[]>) => zipSeries(sc.dates, src)
  const rolling = [{ title: 'Curve signal — rolling', src: sc.curve }]
  if (sc.breakeven) rolling.push({ title: 'Breakeven signal — rolling', src: sc.breakeven })
  return (
    <Card title="Scenario Probabilities"
      subtitle={sc.current.breakeven
        ? `Mapped from 3m regime frequencies · two independent signals: ${curve} curve and ${be}`
        : `Mapped from 3m ${curve} curve regime frequencies · curve signal only (no inflation-linked market)`}>
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: 24 }}>
        <ProbBars title={`From ${curve} curve regimes`} probs={sc.current.curve} />
        {sc.current.breakeven && <ProbBars title={`From ${be} regimes`} probs={sc.current.breakeven} />}
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {rolling.map(p => (
          <div key={p.title} style={{ flex: '1 1 420px', minWidth: 0 }}>
            <Eyebrow>{p.title}</Eyebrow>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={series(p.src)} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
                <XAxis {...dateAxis(sc.dates, 4)} />
                <YAxis {...yPct} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number, k: string) => [pct(v), SCENARIOS.find(s => s.key === k)?.label ?? k]} />
                {SCENARIOS.map(s => <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={1.4} dot={false} isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ))}
      </div>
      <LegendRow items={SCENARIOS.map(s => ({ label: s.label, color: s.color }))} />
    </Card>
  )
}
