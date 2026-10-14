/** 10y macro fair value (PCA inversion of the macro-fitted PCs) and the curve fair-value table. */
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { HeatmapDashboard } from '../types'
import { C, Card, Eyebrow, LegendRow, MONO, Stat, axisTick, dateAxis, signed, tooltipStyle, zipSeries } from '../ui'

export function FairValueSection({ data }: { data: HeatmapDashboard }) {
  const fv = data.fair_value
  const n = fv.dates.length - 1
  const rc = fv.rich_cheap_bps[n]
  const bond = `10y ${data.bond_name}`
  const rows = zipSeries(fv.dates, { actual: fv.actual, pcaFitted: fv.pca_fitted, fairValue: fv.macro_fair_value, richCheap: fv.rich_cheap_bps })
  const gradId = `rc-${data.region}`
  return (
    <Card title={`${bond} — Macro Fair Value`}
      subtitle="PCA inversion: ŷ = μ + L₁·PĈ₁ + L₂·PĈ₂ with the PCs fitted from the macro factors"
      right={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Stat label="Actual" value={`${fv.actual[n].toFixed(2)}%`} color={C.gold} />
          <Stat label="PCA (PC1+PC2)" value={`${fv.pca_fitted[n].toFixed(2)}%`} color={C.green} />
          <Stat label="Macro fair value" value={`${fv.macro_fair_value[n].toFixed(2)}%`} />
          <Stat label={rc < 0 ? 'Rich' : 'Cheap'} value={`${Math.abs(rc).toFixed(1)} bp`} color={rc > 5 ? C.green : rc < -5 ? C.red : C.soft} />
        </div>
      }>
      <Eyebrow>Actual vs macro fair value (%)</Eyebrow>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
          <XAxis {...dateAxis(fv.dates)} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} domain={['auto', 'auto']} tickFormatter={v => `${Number(v).toFixed(2)}%`} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number, k: string) => [`${v.toFixed(3)}%`, k === 'actual' ? bond : k === 'pcaFitted' ? 'PCA (PC1+PC2)' : 'Macro fair value']} />
          <Line type="monotone" dataKey="actual" stroke={C.gold} strokeWidth={1.8} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="pcaFitted" stroke={C.green} strokeWidth={1.3} strokeDasharray="3 2" dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="fairValue" stroke={C.soft} strokeWidth={1.3} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      <LegendRow items={[{ label: bond, color: C.gold }, { label: 'PCA reconstruction', color: C.green, dashed: true }, { label: 'Macro fair value', color: C.soft, dashed: true }]} />

      <Eyebrow style={{ marginTop: 20 }}>Rich / cheap vs fair value (bp) — positive = cheap</Eyebrow>
      <ResponsiveContainer width="100%" height={140}>
        <AreaChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={rc >= 0 ? C.green : C.red} stopOpacity={0.25} />
              <stop offset="95%" stopColor={rc >= 0 ? C.green : C.red} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
          <XAxis {...dateAxis(fv.dates)} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={v => `${v > 0 ? '+' : ''}${v}bp`} />
          <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${signed(v, 1)} bp`, v >= 0 ? 'Cheap' : 'Rich']} />
          <Area type="monotone" dataKey="richCheap" stroke={C.soft} strokeWidth={1.4} fill={`url(#${gradId})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>

      <div style={{ marginTop: 28 }}>
        <Eyebrow>Curve macro fair value</Eyebrow>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>{['', 'Current', 'Fair value', 'Resid (bp)', 'StdDev (bp)', 'Z-score'].map((h, i) => (
              <th key={h} style={{ textAlign: i ? 'right' : 'left', color: C.muted, fontWeight: 600, fontSize: 10, padding: '4px 10px 6px', borderBottom: `1px solid ${C.hair2}` }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {fv.curve_table.map(r => {
              const fmt = (v: number) => (r.is_spread ? `${v.toFixed(1)} bp` : `${v.toFixed(2)}%`)
              const strong = Math.abs(r.zscore) >= 1.5
              const cell = { textAlign: 'right' as const, padding: '6px 10px', borderBottom: `1px solid ${C.hair}`, fontFamily: MONO }
              return (
                <tr key={r.label} style={{ background: strong ? (r.zscore > 0 ? 'rgba(111,194,162,0.12)' : 'rgba(226,130,111,0.12)') : 'transparent' }}>
                  <td style={{ ...cell, textAlign: 'left', color: C.body, fontWeight: 600 }}>{r.label}</td>
                  <td style={{ ...cell, color: C.text }}>{fmt(r.current)}</td>
                  <td style={{ ...cell, color: C.soft }}>{fmt(r.fair_value)}</td>
                  <td style={{ ...cell, color: r.resid_bp > 0 ? C.green : C.red }}>{signed(r.resid_bp, 1)}</td>
                  <td style={{ ...cell, color: C.muted }}>{r.std_bp.toFixed(1)}</td>
                  <td style={{ ...cell, fontWeight: 600, color: r.zscore > 0.5 ? C.green : r.zscore < -0.5 ? C.red : C.soft }}>{signed(r.zscore)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
