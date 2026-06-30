import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'

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
    <div className="min-h-screen flex items-center justify-center bg-[#080d1a] bg-radial-stars px-4">
      {/* Subtle star-field overlay */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 50% 0%, rgba(59,130,246,0.08) 0%, transparent 60%)',
        }}
      />

      <div className="relative w-full max-w-sm">
        {/* Logo / title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/30 mb-4">
            <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-9 h-9">
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
          <h1
            className="text-3xl font-bold tracking-tight text-white"
            style={{
              textShadow:
                '0 0 30px rgba(59,130,246,0.6), 0 0 60px rgba(59,130,246,0.2)',
            }}
          >
            Analytics Hub
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Sign in to access the dashboard
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl p-8 space-y-5"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {error && (
            <div className="rounded-lg px-4 py-3 text-sm text-red-300 bg-red-500/10 border border-red-500/20">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              placeholder="admin"
              className="w-full rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-all"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
              onFocus={(e) => {
                e.currentTarget.style.border = '1px solid rgba(59,130,246,0.5)'
                e.currentTarget.style.boxShadow =
                  '0 0 0 3px rgba(59,130,246,0.1)'
              }}
              onBlur={(e) => {
                e.currentTarget.style.border =
                  '1px solid rgba(255,255,255,0.1)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="••••••••"
              className="w-full rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-all"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
              onFocus={(e) => {
                e.currentTarget.style.border = '1px solid rgba(59,130,246,0.5)'
                e.currentTarget.style.boxShadow =
                  '0 0 0 3px rgba(59,130,246,0.1)'
              }}
              onBlur={(e) => {
                e.currentTarget.style.border =
                  '1px solid rgba(255,255,255,0.1)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-lg text-sm font-semibold text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: loading
                ? 'rgba(59,130,246,0.4)'
                : 'linear-gradient(135deg, #3b82f6, #2563eb)',
              boxShadow: loading
                ? 'none'
                : '0 0 20px rgba(59,130,246,0.3)',
            }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
