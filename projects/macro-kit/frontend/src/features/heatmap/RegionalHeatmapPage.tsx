/**
 * Regional macro heatmap. Every number comes from GET /api/tools/heatmap/{region}
 * (backend/regional_heatmap.py): this page only renders, it does no modelling.
 */
import { useEffect, useState } from 'react'
import PageTitle, { headerBar } from '../../components/PageTitle'
import { TOOL_FLAG } from '../../components/Glyph'
import { authFetch } from '../../api/client'
import { HEATMAP_REGIONS, type HeatmapRegion } from './regions'
import type { HeatmapDashboard } from './types'
import { cardStyle } from './styles'
import { C, monthLabel } from './ui'
import { FactorsSection, RegressionSection, YieldPCASection } from './sections/ModelSections'
import { FairValueSection } from './sections/FairValueSection'
import { BreakevenSection, CurveRegimeSection, ScenarioSection } from './sections/RegimeSections'
import { IndicatorTable, ZScoreLegend } from './sections/IndicatorTable'

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: HeatmapDashboard }

function sourceLabel(d: HeatmapDashboard): string {
  const s = d.data_source
  if (s.macro === 'live' && s.yields === 'live') return 'Live data'
  if (s.macro === 'simulation' && s.yields === 'simulation') return 'Simulated data'
  return `Macro: ${s.macro} · yields: ${s.yields}`
}

export default function RegionalHeatmapPage({ region }: { region: HeatmapRegion }) {
  const meta = HEATMAP_REGIONS.find(r => r.slug === region)!
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    authFetch(`/api/tools/heatmap/${region}`)
      .then(async res => {
        if (!res.ok) throw new Error(`The heatmap service returned HTTP ${res.status}.`)
        return (await res.json()) as HeatmapDashboard
      })
      .then(data => { if (live) setState({ status: 'ready', data }) })
      .catch((e: unknown) => { if (live) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }) })
    return () => { live = false }
  }, [region])

  const data = state.status === 'ready' ? state.data : null
  return (
    <div style={{ minHeight: '100vh', background: '#07090c' }}>
      <header style={{ ...headerBar, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', gap: 12 }}>
        <PageTitle category="Macro Fundamentals" categoryId="macro-fundamentals" flag={TOOL_FLAG[`${region}-heatmap`]}
          title={<>{meta.name} — Macro Heatmap</>}
          subtitle={<>Dynamic Factor Model{data ? ` · ${sourceLabel(data)}` : ''}</>} />
        {data && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(106,169,204,0.08)', border: '1px solid rgba(106,169,204,0.18)', borderRadius: 6, padding: '5px 12px' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6aa9cc', opacity: 0.8 }} />
            <span style={{ color: C.blue, fontSize: 11, fontWeight: 500 }}>{monthLabel(data.period.start)} – {monthLabel(data.period.end)}</span>
          </div>
        )}
      </header>

      <main style={{ maxWidth: 1600, margin: '0 auto', padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {state.status === 'loading' && (
          <div role="status" style={{ ...cardStyle, color: C.muted, fontSize: 12 }}>Loading {meta.name} heatmap…</div>
        )}
        {state.status === 'error' && (
          <div role="alert" style={{ ...cardStyle, color: C.red, fontSize: 12 }}>Could not load the heatmap. {state.message}</div>
        )}
        {data && (
          <>
            <FactorsSection data={data} />
            <YieldPCASection data={data} />
            <RegressionSection data={data} />
            <FairValueSection data={data} />
            <CurveRegimeSection data={data} />
            <BreakevenSection data={data} />
            <ScenarioSection data={data} />
            <div style={cardStyle}><ZScoreLegend /></div>
            <IndicatorTable data={data} />
          </>
        )}
      </main>
    </div>
  )
}
