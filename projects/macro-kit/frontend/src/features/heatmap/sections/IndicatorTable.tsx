/** Monthly z-score heatmap of every DFM input indicator, grouped as in the region's series catalogue. */
import { Fragment, type CSSProperties } from 'react'
import type { HeatmapDashboard } from '../types'
import { stickyBg, zscoreToColors } from '../styles'
import { C, Card, MONO, monthLabel } from '../ui'

const CELL_W = 46, CELL_H = 26, NAME_W = 230, SIDE_W = 84

const LEGEND = [
  { z: 2, label: '≥ +2σ' }, { z: 1, label: '+1σ' }, { z: 0.5, label: '+0.5σ' }, { z: 0, label: '0' },
  { z: -0.5, label: '−0.5σ' }, { z: -1, label: '−1σ' }, { z: -2, label: '≤ −2σ' },
]

export function ZScoreLegend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ color: C.muted, fontSize: 11, marginRight: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Z-score scale</span>
      {LEGEND.map(s => {
        const { bg, fg } = zscoreToColors(s.z)
        return (
          <div key={s.label} style={{ width: 40, height: 20, background: bg, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: fg, fontSize: 9, fontFamily: MONO, fontWeight: 600 }}>{s.label}</span>
          </div>
        )
      })}
    </div>
  )
}

export function IndicatorTable({ data }: { data: HeatmapDashboard }) {
  const { months, groups, raw_values } = data.indicators
  const count = groups.reduce((n, g) => n + g.indicators.length, 0)
  const head: CSSProperties = {
    color: '#9aa5b1', fontSize: 10, fontWeight: 600, padding: '5px 2px', background: stickyBg,
    borderBottom: `1px solid ${C.hair2}`, position: 'sticky', top: 0, zIndex: 2, whiteSpace: 'nowrap',
  }
  const nameCell: CSSProperties = {
    width: NAME_W, minWidth: NAME_W, maxWidth: NAME_W, color: C.body, fontSize: 11, padding: '0 12px', height: CELL_H,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'sticky', left: 0,
    background: stickyBg, borderRight: `1px solid ${C.hair2}`, borderBottom: `1px solid ${C.hair}`, zIndex: 1,
  }
  const side: CSSProperties = {
    width: SIDE_W, minWidth: SIDE_W, textAlign: 'center', fontSize: 10, fontFamily: MONO, background: stickyBg,
    borderLeft: '1px solid rgba(200,220,240,0.06)', borderBottom: `1px solid ${C.hair}`, color: C.muted, whiteSpace: 'nowrap',
  }
  return (
    <Card flush title="Macro Fundamentals — Z-Score Heatmap"
      subtitle={`Month-end z-scores vs the ${months.length}-month sample · ${count} indicators in ${groups.length} groups${raw_values ? '' : ' · simulated data (z-scores only; levels appear with live data)'}`}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: NAME_W + CELL_W * months.length + SIDE_W * 3 }}>
          <thead>
            <tr>
              <th style={{ ...head, ...nameCell, textAlign: 'left', textTransform: 'uppercase', letterSpacing: '0.05em', zIndex: 4, color: '#9aa5b1', fontSize: 10, fontWeight: 600 }}>Indicator</th>
              {months.map(m => <th key={m} style={{ ...head, width: CELL_W, minWidth: CELL_W, textAlign: 'center', fontFamily: MONO }}>{monthLabel(m)}</th>)}
              <th style={{ ...head, ...side }}>Units</th>
              <th style={{ ...head, ...side }}>Latest</th>
              <th style={{ ...head, ...side }}>Last obs</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <Fragment key={g.name}>
                <tr>
                  <td colSpan={months.length + 4} style={{ background: 'rgba(200,220,240,0.025)', color: C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, padding: '4px 12px', height: 22, position: 'sticky', left: 0 }}>
                    {g.name}
                  </td>
                </tr>
                {g.indicators.map(ind => (
                  <tr key={ind.id}>
                    <td style={nameCell} title={`${ind.name} · ${ind.factor} factor`}>{ind.name}</td>
                    {ind.zscores.map((z, i) => {
                      if (z === null) return <td key={i} style={{ width: CELL_W, height: CELL_H, background: stickyBg }} />
                      const { bg, fg } = zscoreToColors(z)
                      return (
                        <td key={i} style={{ width: CELL_W, height: CELL_H, textAlign: 'center', fontFamily: MONO, fontSize: 10, fontWeight: 500, color: fg, background: bg, border: '1px solid rgba(7,9,12,0.5)', padding: 0 }}>
                          {z.toFixed(1)}
                        </td>
                      )
                    })}
                    <td style={side}>{ind.units || '—'}</td>
                    <td style={{ ...side, color: ind.latest === null ? C.faint : C.text, fontWeight: 600 }}>{ind.latest === null ? '—' : ind.latest.toFixed(2)}</td>
                    <td style={side}>{ind.last_obs ?? '—'}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
