import { useState } from 'react'
import PageTitle from '../components/PageTitle'
import MonitorView from '../features/momentum/MonitorView'
import SeriesView, { type SeriesRequest } from '../features/momentum/SeriesView'
import GuideView from '../features/momentum/GuideView'
import { ACCENT, BG, FG3, MUTED, NUM } from '../features/momentum/format'

type Tab = 'monitor' | 'series' | 'guide'
const TABS: { id: Tab; label: string }[] = [
  { id: 'monitor', label: 'CTA Monitor' },
  { id: 'series', label: 'Single Series' },
  { id: 'guide', label: 'How it works' },
]

export default function Momentum() {
  const [tab, setTab] = useState<Tab>('monitor')
  const [aumBn, setAumBn] = useState(300)
  const [aumDraft, setAumDraft] = useState('300')
  const [request, setRequest] = useState<SeriesRequest | null>(null)

  function commitAum() {
    const v = Number(aumDraft)
    if (Number.isFinite(v) && v > 0 && v <= 5000) setAumBn(v)
    else setAumDraft(String(aumBn))
  }

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#eef2f6', fontFamily: "'Geist', system-ui, sans-serif", padding: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <PageTitle category="Technicals" categoryId="technicals" title={<>Momentum</>} subtitle={<>CTA trend-following model</>} />
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, marginBottom: 20, borderBottom: '1px solid rgba(200,220,240,0.07)',
        position: 'sticky', top: 0, zIndex: 10, background: BG,
      }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 16px', fontSize: 13, fontWeight: 500,
            color: tab === t.id ? ACCENT : FG3, borderBottom: tab === t.id ? `2px solid ${ACCENT}` : '2px solid transparent',
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: MUTED,
          textTransform: 'uppercase', letterSpacing: '0.05em', paddingBottom: 4 }}
          title="Assets run by trend followers; scales every dollar figure">
          Trend AUM $bn
          <input value={aumDraft} onChange={e => setAumDraft(e.target.value)} onBlur={commitAum}
            onKeyDown={e => e.key === 'Enter' && commitAum()} style={{
              width: 64, background: 'rgba(200,220,240,0.06)', border: '1px solid rgba(200,220,240,0.12)', borderRadius: 4,
              padding: '3px 6px', color: '#eef2f6', fontSize: 12, fontFamily: NUM, outline: 'none', textAlign: 'right',
            }} />
        </label>
      </div>

      {/* Both stay mounted so switching tabs keeps their state */}
      <div style={{ display: tab === 'monitor' ? 'block' : 'none' }}>
        <MonitorView aumBn={aumBn} onOpen={row => {
          setRequest({ ticker: row.ticker, kind: row.kind, nonce: Date.now() })
          setTab('series')
        }} />
      </div>
      <div style={{ display: tab === 'series' ? 'block' : 'none' }}>
        <SeriesView aumBn={aumBn} request={request} />
      </div>
      {tab === 'guide' && <GuideView />}
    </div>
  )
}
