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
            <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-6 h-6">
              {/* Body */}
              <ellipse cx="32" cy="36" rx="8" ry="13" fill="#C8A84B"/>
              {/* Head */}
              <circle cx="32" cy="18" r="6" fill="#C8A84B"/>
              {/* Beak */}
              <path d="M32 22 L29 26 L35 26 Z" fill="#8B6914"/>
              {/* Left wing */}
              <path d="M24 30 C16 24 4 28 2 20 C8 18 14 22 20 26 C16 20 10 12 14 8 C18 12 20 20 24 28 C22 22 20 14 24 10 C26 16 26 24 26 32Z" fill="#C8A84B"/>
              {/* Right wing */}
              <path d="M40 30 C48 24 60 28 62 20 C56 18 50 22 44 26 C48 20 54 12 50 8 C46 12 44 20 40 28 C42 22 44 14 40 10 C38 16 38 24 38 32Z" fill="#C8A84B"/>
              {/* Tail feathers */}
              <path d="M26 48 L24 58 L28 54 L32 60 L36 54 L40 58 L38 48Z" fill="#C8A84B"/>
              {/* Left talon */}
              <path d="M27 49 L22 56 M27 49 L24 57 M27 49 L26 57" stroke="#8B6914" strokeWidth="1.5" strokeLinecap="round"/>
              {/* Right talon */}
              <path d="M37 49 L42 56 M37 49 L40 57 M37 49 L38 57" stroke="#8B6914" strokeWidth="1.5" strokeLinecap="round"/>
              {/* Eye */}
              <circle cx="30" cy="17" r="1.5" fill="#1a1a1a"/>
            </svg>
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
