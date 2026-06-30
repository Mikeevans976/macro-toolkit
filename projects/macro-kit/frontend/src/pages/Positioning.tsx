import { useNavigate } from 'react-router-dom'

const BG = '#080d1a'

export default function Positioning() {
  const navigate = useNavigate()

  return (
    <div style={{ minHeight: '100vh', background: BG, color: '#f1f5f9', fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 32 }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 8, padding: '6px 14px',
            color: '#94a3b8', fontSize: 13, cursor: 'pointer',
          }}
        >
          ← Back
        </button>
        <div>
          <div style={{ color: '#f1f5f9', fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em' }}>
            Positioning
          </div>
          <div style={{ color: '#475569', fontSize: 11, marginTop: 1 }}>
            Technicals
          </div>
        </div>
      </div>

      {/* Placeholder */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: '60vh', gap: 16,
      }}>
        <div style={{ fontSize: 48 }}>📊</div>
        <div style={{ color: '#f1f5f9', fontSize: 20, fontWeight: 700 }}>Positioning</div>
        <div style={{ color: '#475569', fontSize: 14 }}>Coming soon</div>
      </div>
    </div>
  )
}
