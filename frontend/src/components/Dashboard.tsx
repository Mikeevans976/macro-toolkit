import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { DashboardConfig } from '../types'
import CategoryCard from './CategoryCard'

export default function Dashboard() {
  const [config, setConfig] = useState<DashboardConfig | null>(null)
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const navigate = useNavigate()

  const token = localStorage.getItem('access_token')

  useEffect(() => {
    if (!token) {
      navigate('/login', { replace: true })
      return
    }

    const headers = { Authorization: `Bearer ${token}` }

    // Fetch user info and dashboard config in parallel
    Promise.all([
      axios.get('/api/me', { headers }),
      axios.get('/api/dashboard', { headers }),
    ])
      .then(([meRes, dashRes]) => {
        setUsername(meRes.data.full_name || meRes.data.username)
        setConfig(dashRes.data)
      })
      .catch((err) => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        } else {
          setError('Failed to load dashboard. Please refresh.')
        }
      })
  }, [token, navigate])

  function handleLogout() {
    localStorage.removeItem('access_token')
    navigate('/login', { replace: true })
  }

  return (
    <div
      className="min-h-screen"
      style={{ background: '#080d1a' }}
    >
      {/* Subtle gradient overlay */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 50% -10%, rgba(59,130,246,0.07) 0%, transparent 55%)',
        }}
      />

      {/* Header */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-6 py-4"
        style={{
          background: 'rgba(8,13,26,0.85)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/25">
            <span className="text-lg">🦅</span>
          </div>
          <div>
            <h1 className="text-base font-semibold text-white leading-tight">
              Analytics Hub
            </h1>
            <p className="text-xs text-slate-500 leading-tight">Pod Analytics</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {username && (
            <span className="text-sm text-slate-400 hidden sm:block">
              {username}
            </span>
          )}
          <button
            onClick={handleLogout}
            className="text-xs font-medium px-3 py-1.5 rounded-lg transition-all duration-150"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#94a3b8',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
              e.currentTarget.style.color = '#e2e8f0'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
              e.currentTarget.style.color = '#94a3b8'
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="relative px-4 sm:px-6 lg:px-8 py-8 max-w-screen-xl mx-auto">
        {error && (
          <div className="mb-6 rounded-lg px-4 py-3 text-sm text-red-300 bg-red-500/10 border border-red-500/20">
            {error}
          </div>
        )}

        {!config && !error && (
          <div className="flex items-center justify-center py-32 text-slate-500 text-sm">
            <span className="animate-pulse">Loading dashboard…</span>
          </div>
        )}

        {config && (
          <>
            <div className="mb-8">
              <h2 className="text-xl font-semibold text-white">Launchpad</h2>
              <p className="text-sm text-slate-500 mt-1">
                {config.categories.reduce((acc, c) => acc + c.tools.length, 0)}{' '}
                tools across {config.categories.length} categories
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {config.categories.map((category) => (
                <CategoryCard key={category.id} category={category} />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
