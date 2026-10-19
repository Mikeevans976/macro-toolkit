// Macro Options Monitor: risk-neutral distributions, ECB outcome probabilities and open
// interest from ER Euribor options. Data: the backend's Bloomberg snapshot (live, or a past
// day's settlement), else the in-browser simulation; the tabs only see a `Market`.

import { useMemo, useState } from 'react'
import PageTitle, { headerBar } from '../../components/PageTitle'
import { fmtSnap, londonNow, snapToSession, toDateInput, toTimeInput } from './model/calendar'
import type { AxisMode } from './model/distribution'
import CrossSectionTab from './tabs/CrossSectionTab'
import type { CrossSectionState } from './tabs/CrossSectionTab'
import CrossTimeTab from './tabs/CrossTimeTab'
import type { CrossTimeState } from './tabs/CrossTimeTab'
import DistributionTab from './tabs/DistributionTab'
import HikesCutsTab from './tabs/HikesCutsTab'
import type { HikesState } from './tabs/HikesCutsTab'
import OpenInterestTab from './tabs/OpenInterestTab'
import type { OIState } from './tabs/OpenInterestTab'
import { BG, FG1, FG3, SnapshotControls, SourceBadge, card } from './ui'
import { snapshotKey, useMarket } from './useMarket'

type TabId = 'dist' | 'cross' | 'section' | 'rates' | 'oi'
const TABS: { id: TabId; label: string }[] = [
  { id: 'dist',    label: 'PDF & CDF' },
  { id: 'cross',   label: 'Cross-time comparisons' },
  { id: 'section', label: 'Cross-section' },
  { id: 'rates',   label: 'Hikes & cuts' },
  { id: 'oi',      label: 'Open interest' },
]

export default function MacroOptionsPage() {
  const initial = londonNow()
  const [tab, setTab]           = useState<TabId>('dist')
  const [snapDate, setSnapDate] = useState(toDateInput(initial))
  const [snapTime, setSnapTime] = useState(toTimeInput(initial))
  const [h, setH]               = useState(0.0625)
  const [axis, setAxis]         = useState<AxisMode>('price')
  const [contractId, setContractId] = useState<string | null>(null)   // null → 2nd contract
  const [crossTime, setCrossTime] = useState<CrossTimeState>({ contractId: null, expiryId: null, dates: null })
  const [dfrInput, setDfr]      = useState<number | null>(null)   // ECB deposit facility rate, %; null → market / 2.00
  const [offsetBp, setOffsetBp] = useState(10)     // prior for (ESTR − DFR) + (Euribor − ESTR), bp
  const [hikes, setHikes]       = useState<HikesState>({ contractId: null, expiryId: null })
  const [oi, setOi]             = useState<OIState>({ contractId: null, expiryId: null, lookback: 'All', measure: 'total', compare: '1W', dayIdx: null })
  const [crossSection, setCrossSection] = useState<CrossSectionState>({ base: null, overlays: null, centred: false, measure: 'pdf' })
  const [expiryId, setExpiryId] = useState<string | null>(null)

  const requested = useMemo(() => {
    const d = new Date(`${snapDate}T${snapTime}:00Z`)
    const now = londonNow()
    return isNaN(d.getTime()) ? now : d > now ? now : d
  }, [snapDate, snapTime])
  const simSnap = useMemo(() => snapToSession(requested), [requested])
  const { market, loading } = useMarket(snapshotKey(snapDate), simSnap)

  const header = (
    <div style={{ ...headerBar, padding: '12px 32px', display: 'flex', alignItems: 'center', gap: 16 }}>
      <PageTitle category="Futures / Swaps / Vol" categoryId="futures-swaps-vol" title="Macro Options Monitor"
        subtitle={<>ER Euribor options · risk-neutral PDF / CDF{market ? ` · ${fmtSnap(market.snap)}` : ''}</>} />
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: '6px 16px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer',
              border: `1px solid ${tab === t.id ? 'rgba(106,169,204,0.5)' : 'rgba(200,220,240,0.1)'}`,
              background: tab === t.id ? 'rgba(106,169,204,0.15)' : 'rgba(200,220,240,0.03)',
              color: tab === t.id ? '#a9d2e8' : FG3,
            }}>{t.label}</button>
          ))}
        </div>
        {market && <SourceBadge market={market} />}
      </div>
    </div>
  )

  if (!market) {
    return (
      <div style={{ minHeight: '100vh', background: BG, color: FG1, fontFamily: "'Geist', system-ui, sans-serif" }}>
        {header}
        <div style={{ padding: '24px 32px', maxWidth: 1440 }}>
          <div style={{ ...card, padding: 60, textAlign: 'center', color: FG3, fontSize: 13 }}>
            Loading Euribor futures and option chains from Bloomberg… (a past date can take ~30 s the first time)
          </div>
        </div>
      </div>
    )
  }

  const contracts = market.contracts
  // A selected contract that has expired by the snapshot falls back to the 2nd contract
  const contract  = contracts.find(c => c.id === contractId) ?? contracts[1]
  const dfr = dfrInput ?? market.dfr ?? 2.00
  const onNow = () => { const n = londonNow(); setSnapDate(toDateInput(n)); setSnapTime(toTimeInput(n)) }

  const controls = (showWidth: boolean) => (
    <SnapshotControls
      snapDate={snapDate} snapTime={snapTime}
      onDate={setSnapDate} onTime={setSnapTime} onNow={onNow}
      h={h} onWidth={setH} market={market} requested={requested} showWidth={showWidth}
    />
  )

  return (
    <div style={{ minHeight: '100vh', background: BG, color: FG1, fontFamily: "'Geist', system-ui, sans-serif" }}>
      {header}

      <div style={{ padding: '24px 32px', maxWidth: 1440, opacity: loading ? 0.6 : 1 }}>
        {market.note && market.source === 'simulation' && (
          <div style={{ ...card, padding: '8px 14px', marginBottom: 12, color: '#dd9562', fontSize: 12 }}>{market.note}</div>
        )}
        {tab === 'dist' ? (
          <DistributionTab
            market={market} contract={contract} setContract={c => { setContractId(c.id); setExpiryId(null) }}
            expiryId={expiryId} setExpiryId={setExpiryId}
            h={h} axis={axis} setAxis={setAxis} controls={controls(true)}
          />
        ) : tab === 'cross' ? (
          <CrossTimeTab market={market} h={h} axis={axis} setAxis={setAxis} controls={controls(true)}
            state={crossTime} setState={setCrossTime} />
        ) : tab === 'oi' ? (
          <OpenInterestTab market={market} controls={controls(false)} state={oi} setState={setOi} />
        ) : tab === 'rates' ? (
          <HikesCutsTab market={market} h={h} controls={controls(true)}
            dfr={dfr} setDfr={setDfr} offset={offsetBp} setOffset={setOffsetBp} state={hikes} setState={setHikes} />
        ) : (
          <CrossSectionTab market={market} h={h} axis={axis} setAxis={setAxis} controls={controls(true)}
            state={crossSection} setState={setCrossSection} />
        )}
      </div>
    </div>
  )
}
