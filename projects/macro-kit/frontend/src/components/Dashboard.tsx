import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { DashboardConfig } from '../types'
import { loadDashboardConfig } from '../hubData'
import CategoryCard from './CategoryCard'
import Glyph from './Glyph'

function greeting(d: Date): string {
  const h = d.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function stamp(d: Date): string {
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${day} · ${time}`
}

export default function Dashboard() {
  const [config, setConfig] = useState<DashboardConfig | null>(null)
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [now, setNow] = useState(() => new Date())
  const navigate = useNavigate()

  const token = localStorage.getItem('access_token')

  useEffect(() => {
    if (!token) {
      navigate('/login', { replace: true })
      return
    }

    const headers = { Authorization: `Bearer ${token}` }

    // Fetch user info and dashboard config in parallel
    Promise.all([axios.get('/api/me', { headers }), loadDashboardConfig()])
      .then(([meRes, dash]) => {
        setUsername(meRes.data.full_name || meRes.data.username)
        setConfig(dash)
      })
      .catch((err) => {
        if (axios.isAxiosError(err) && err.response?.status === 401) {
          localStorage.removeItem('access_token')
          navigate('/login', { replace: true })
        } else {
          setError('The launchpad could not load. Check that the API server is running on port 8000, then refresh.')
        }
      })
  }, [token, navigate])

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const toolCount = config?.categories.reduce((acc, c) => acc + c.tools.length, 0) ?? 0
  const liveCats = config?.categories.filter((c) => c.tools.length > 0).length ?? 0
  const agentCount = config?.categories.find((c) => c.id === 'agents')?.tools.length ?? 0
  const firstName = username.split(' ')[0]

  return (
    <div className="min-h-screen hub-dotgrid">
      <main className="relative px-5 sm:px-8 lg:px-10 pt-10 pb-16 max-w-[1320px] mx-auto">
        {error && (
          <div className="mb-6 rounded-md px-4 py-3 text-sm text-neg bg-neg/10 border border-neg/20">
            {error}
          </div>
        )}

        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-6 pb-7 mb-8 border-b border-hairline">
          <div className="min-w-0">
            <div className="hub-eyebrow mb-2.5">{stamp(now)}</div>
            <h1 className="text-[28px] leading-tight font-normal tracking-[-0.025em] text-fg-1">
              {greeting(now)}{firstName ? `, ${firstName}` : ''}
            </h1>
            <p className="mt-1.5 text-[13px] text-fg-3">Analytics Hub · Fixed Income Pod</p>
          </div>

          <div className="flex items-end gap-8">
            {config && (
              <dl className="flex gap-7">
                {[
                  [toolCount, 'Tools'],
                  [liveCats, 'Categories'],
                  [agentCount, 'Agents'],
                ].map(([v, l]) => (
                  <div key={l as string} className="grid gap-0.5">
                    <dd className="hub-num text-[22px] leading-none text-fg-1 tracking-[-0.02em] m-0">
                      {String(v).padStart(2, '0')}
                    </dd>
                    <dt className="hub-eyebrow text-[10px]">{l}</dt>
                  </div>
                ))}
              </dl>
            )}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('hub:palette'))}
              className="hidden md:flex items-center gap-2.5 min-w-[240px] rounded border border-[rgba(150,178,205,0.17)] bg-ink-1 px-3 py-2 text-[12px] text-fg-3 transition-colors duration-150 hover:text-fg-2 hover:border-[rgba(150,178,205,0.28)]"
            >
              <Glyph name="search" size={14} />
              Jump to tool
              <kbd className="ml-auto hub-num text-[10px] text-fg-2 border border-hairline rounded-[3px] px-1.5 py-px">⌘K</kbd>
            </button>
          </div>
        </header>

        {!config && !error && (
          <div className="flex items-center justify-center py-32">
            <span className="hub-eyebrow animate-pulse">Loading launchpad</span>
          </div>
        )}

        {config && (
          <div className="columns-1 md:columns-2 xl:columns-3 gap-4 [column-fill:_balance]">
            {/* Categories with tools first, empty placeholders last */}
            {[...config.categories.filter((c) => c.tools.length), ...config.categories.filter((c) => !c.tools.length)].map((category, i) => (
              <div
                key={category.id}
                className="break-inside-avoid mb-4 hub-enter"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <CategoryCard category={category} />
              </div>
            ))}
          </div>
        )}

        <footer className="mt-10 pt-5 border-t border-hairline flex flex-wrap justify-between gap-2 hub-num text-[10px] text-fg-4">
          <span>Team Massimo Marzeglia · Analytics</span>
          <span>Press ⌘K anywhere to jump between tools</span>
        </footer>
      </main>
    </div>
  )
}
