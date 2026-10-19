/** Block 1 (DFM factors) and Block 2 (yield PCA, PC regressions) sections. */
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { HeatmapDashboard } from '../types'
import { C, Card, Eyebrow, LegendRow, MONO, axisTick, dateAxis, signed, td, th, tooltipStyle, zipSeries } from '../ui'

export const FACTOR_COLORS: Record<string, string> = {
  'Global Macro': C.soft, Growth: C.green, Inflation: C.red, Employment: C.blue, Wages: C.violet,
  External: C.gold, Credit: '#6fc0cb',
}
const PCS = [
  { key: 'PC1', label: 'PC1 — Level', color: C.gold },
  { key: 'PC2', label: 'PC2 — Slope', color: C.green },
  { key: 'PC3', label: 'PC3 — Curvature', color: C.violet },
]

export function FactorsSection({ data }: { data: HeatmapDashboard }) {
  const { dates, factors, summary } = data.factors
  const names = Object.keys(factors)
  const rows = zipSeries(dates, factors)
  const tone = (v: number, cut: number) => (v > cut ? C.red : v < -cut ? C.blue : C.soft)
  return (
    <Card title="Macro Factors — DFM Synthesis"
      subtitle={`${names.length} factors from a mixed-frequency Dynamic Factor Model (Kalman smoother) on ${data.display_name} macro data`}>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
              <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
              <XAxis {...dateAxis(dates)} />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={v => Number(v).toFixed(1)} />
              <ReferenceLine y={0} stroke={C.zero} strokeDasharray="4 4" />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={l => String(l)} formatter={(v: number, n: string) => [v.toFixed(2), n]} />
              {names.map(n => <Line key={n} type="monotone" dataKey={n} stroke={FACTOR_COLORS[n] ?? C.soft} strokeWidth={1.6} dot={false} isAnimationActive={false} />)}
            </LineChart>
          </ResponsiveContainer>
          <LegendRow items={names.map(n => ({ label: n, color: FACTOR_COLORS[n] ?? C.soft }))} />
        </div>
        <div style={{ flex: '0 0 300px' }}>
          <Eyebrow>Factor summary</Eyebrow>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead><tr>{['Factor', 'Level', 'Δ1m', 'Δ3m', 'Δ12m', 'Z'].map((h, i) => <th key={h} style={th(i ? 'right' : 'left')}>{h}</th>)}</tr></thead>
            <tbody>
              {names.map(n => {
                const s = summary[n]
                const delta = (d: number | null) => (d === null ? '—' : signed(d))
                return (
                  <tr key={n}>
                    <td style={td('left')}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: FACTOR_COLORS[n] ?? C.soft, marginRight: 6 }} />
                      <span style={{ color: C.body }}>{n}</span>
                    </td>
                    <td style={td('right', { color: tone(s.current, 0.3), fontWeight: 600 })}>{signed(s.current)}</td>
                    {[s.d1m, s.d3m, s.d12m].map((d, i) => <td key={i} style={td('right', { color: d === null ? C.muted : tone(d, 0.05) })}>{delta(d)}</td>)}
                    <td style={td('right', { color: tone(s.zscore, 0.5), fontWeight: 600 })}>{signed(s.zscore)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p style={{ color: C.muted, fontSize: 10, lineHeight: 1.5, marginTop: 12 }}>
            Global Macro loads on every series; the others on their catalogue group. Δ over 21/63/252 business days; Z vs the sample.
          </p>
        </div>
      </div>
    </Card>
  )
}

export function YieldPCASection({ data }: { data: HeatmapDashboard }) {
  const { dates, pc_scores, loadings, explained_var, tenor_names } = data.yield_pca
  return (
    <Card title={`${data.bond_name} Yield Curve — Principal Components`}
      subtitle={`PCA on ${tenor_names.join('/')} ${data.bond_name} yields`}
      right={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PCS.map(pc => (
            <div key={pc.key} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(200,220,240,0.04)', border: '1px solid rgba(200,220,240,0.08)', borderRadius: 6, padding: '4px 10px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: pc.color }} />
              <span style={{ color: C.soft, fontSize: 11 }}>{pc.label}</span>
              <span style={{ color: pc.color, fontSize: 11, fontFamily: MONO, fontWeight: 600 }}>{(explained_var[pc.key] * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      }>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={zipSeries(dates, pc_scores)} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
          <XAxis {...dateAxis(dates)} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={v => Number(v).toFixed(2)} />
          <ReferenceLine y={0} stroke={C.zero} strokeDasharray="4 4" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [v.toFixed(3), PCS.find(p => p.key === n)?.label ?? n]} />
          {PCS.map(pc => <Line key={pc.key} type="monotone" dataKey={pc.key} stroke={pc.color} strokeWidth={1.6} dot={false} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
      <div style={{ marginTop: 20 }}>
        <Eyebrow>Factor loadings (eigenvectors)</Eyebrow>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead><tr><th style={th('left')}>Factor</th>{tenor_names.map(t => <th key={t} style={th()}>{t}</th>)}</tr></thead>
          <tbody>
            {PCS.map(pc => (
              <tr key={pc.key}>
                <td style={td('left', { color: C.body })}>{pc.label}</td>
                {loadings[pc.key].map((l, j) => (
                  <td key={j} style={td('right', { fontSize: 10, color: l > 0.05 ? C.green : l < -0.05 ? C.red : C.muted })}>{signed(l, 3)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

const tStatColor = (t: number) => {
  const a = Math.abs(t)
  return a >= 2.58 ? C.green : a >= 1.96 ? '#dfbb78' : a >= 1.65 ? C.soft : C.muted
}
const stars = (t: number) => (Math.abs(t) >= 2.58 ? '***' : Math.abs(t) >= 1.96 ? '**' : Math.abs(t) >= 1.65 ? '*' : '—')

export function RegressionSection({ data }: { data: HeatmapDashboard }) {
  const { factor_names, pc1, pc2 } = data.regressions
  const { dates, pc_scores } = data.yield_pca
  const panels = [
    { label: 'PC1 — Level', reg: pc1, actual: pc_scores.PC1, color: C.gold },
    { label: 'PC2 — Slope', reg: pc2, actual: pc_scores.PC2, color: C.green },
  ]
  return (
    <Card title="Rates–Macro Linkage — PC Regressions"
      subtitle={<>OLS (no intercept): PC1 &amp; PC2 of the {data.bond_name} curve on the macro factors &middot; *** p&lt;1% ** p&lt;5% * p&lt;10%</>}>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 24 }}>
        {panels.map(p => (
          <div key={p.label} style={{ flex: '1 1 400px', minWidth: 0 }}>
            <p style={{ color: '#9aa5b1', fontSize: 11, margin: '0 0 8px', fontWeight: 600 }}>{p.label}</p>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={zipSeries(dates, { actual: p.actual, fitted: p.reg.fitted })} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke={C.grid} strokeDasharray="3 3" />
                <XAxis {...dateAxis(dates, 4)} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={v => Number(v).toFixed(2)} />
                <ReferenceLine y={0} stroke={C.zero} strokeDasharray="4 4" />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [v.toFixed(3), n === 'actual' ? 'Actual' : 'Fitted']} />
                <Line type="monotone" dataKey="actual" stroke={p.color} strokeWidth={1.6} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="fitted" stroke="rgba(200,220,240,0.45)" strokeWidth={1.2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <LegendRow items={[{ label: 'Actual', color: p.color }, { label: 'Fitted', color: 'rgba(200,220,240,0.45)', dashed: true }]} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
        {panels.map(p => (
          <div key={p.label} style={{ flex: '1 1 280px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <span style={{ color: C.soft, fontSize: 13, fontWeight: 600 }}>{p.label}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: '#eef2f6' }}>R² = {p.reg.r2.toFixed(3)}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.soft }}>adj. R² = {p.reg.adj_r2.toFixed(3)}</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead><tr>{['Factor', 'Coeff.', 't-stat', 'Sig.'].map((h, i) => <th key={h} style={th(i ? 'right' : 'left')}>{h}</th>)}</tr></thead>
              <tbody>
                {factor_names.map((f, k) => (
                  <tr key={f}>
                    <td style={td('left', { color: C.body })}>{f}</td>
                    <td style={td('right', { color: p.reg.beta[k] >= 0 ? C.green : C.red, fontWeight: 600 })}>{signed(p.reg.beta[k], 4)}</td>
                    <td style={td('right', { color: tStatColor(p.reg.tstat[k]) })}>{signed(p.reg.tstat[k])}</td>
                    <td style={td('right', { color: tStatColor(p.reg.tstat[k]), fontWeight: 600 })}>{stars(p.reg.tstat[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Card>
  )
}

