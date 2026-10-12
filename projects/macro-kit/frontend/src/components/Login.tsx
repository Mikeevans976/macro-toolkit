import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import Monogram from './Monogram'
import { clearDashboardConfig } from '../hubData'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      // FastAPI OAuth2 expects application/x-www-form-urlencoded
      const params = new URLSearchParams()
      params.append('username', username)
      params.append('password', password)

      const response = await axios.post('/api/auth/login', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      localStorage.setItem('access_token', response.data.access_token)
      clearDashboardConfig()
      navigate('/', { replace: true })
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        setError('Invalid username or password.')
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] bg-ink-0">
      {/* Left: identity panel */}
      <aside className="hidden lg:flex relative flex-col justify-between p-12 border-r border-hairline hub-dotgrid overflow-hidden">
        <div className="flex items-center gap-3">
          <Monogram size={34} />
          <div className="leading-tight">
            <div className="text-[13px] font-medium text-fg-1">Analytics Hub</div>
            <div className="hub-num text-[10px] tracking-[0.14em] uppercase text-fg-3">Team Massimo Marzeglia</div>
          </div>
        </div>

        <svg viewBox="0 0 460 120" className="w-full max-w-[460px] h-auto" aria-hidden="true">
          {[0, 30, 60, 90].map((y) => (
            <line key={y} x1="0" x2="460" y1={y + 10} y2={y + 10} stroke="rgba(150,178,205,0.08)" strokeDasharray="2 4" />
          ))}
          <path
            d="M0 92 C40 88 60 70 95 72 S150 96 190 80 S250 40 290 46 S350 70 385 52 S430 24 460 28"
            fill="none" stroke="#86c0de" strokeWidth="1.3"
          />
          <path
            d="M0 70 C50 74 80 86 120 82 S190 58 230 62 S300 86 340 78 S420 60 460 64"
            fill="none" stroke="#77828f" strokeWidth="1"
          />
          <circle cx="460" cy="28" r="2.6" fill="#86c0de" />
        </svg>
      </aside>

      {/* Right: sign-in */}
      <main className="flex items-center justify-center px-5 py-16">
        <div className="w-full max-w-[340px] hub-enter">
          <div className="lg:hidden flex items-center gap-3 mb-10">
            <Monogram size={32} />
            <span className="text-[13px] font-medium text-fg-1">Analytics Hub</span>
          </div>

          <h2 className="text-[22px] font-normal tracking-[-0.02em] text-fg-1 m-0">Sign in</h2>
          <p className="mt-1.5 mb-8 text-[13px] text-fg-3">Use your Analytics Hub account.</p>

          <form onSubmit={handleSubmit} className="grid gap-5">
            {error && (
              <div className="rounded px-3.5 py-2.5 text-[13px] text-neg bg-neg/10 border border-neg/20">
                {error}
              </div>
            )}

            <label className="grid gap-1.5">
              <span className="hub-eyebrow">Username</span>
              <input
                id="login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
                className="w-full rounded bg-ink-1 border border-[rgba(150,178,205,0.17)] px-3.5 py-2.5 text-[14px] text-fg-1 outline-none transition-colors duration-150 focus:border-accent"
                style={{ outline: 'none' }}
              />
            </label>

            <label className="grid gap-1.5">
              <span className="hub-eyebrow">Password</span>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full rounded bg-ink-1 border border-[rgba(150,178,205,0.17)] px-3.5 py-2.5 text-[14px] text-fg-1 outline-none transition-colors duration-150 focus:border-accent"
                style={{ outline: 'none' }}
              />
            </label>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 w-full rounded py-2.5 text-[13px] font-medium text-ink-0 bg-accent transition-opacity duration-150 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-10 hub-num text-[10px] text-fg-4">Session expires after 8 hours.</p>
        </div>
      </main>
    </div>
  )
}
