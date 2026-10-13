import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authFetch, handleUnauthorized, openRunStream } from './client'

describe('authFetch', () => {
  const assign = vi.fn()
  beforeEach(() => {
    localStorage.setItem('access_token', 'tok')
    vi.stubGlobal('location', { ...window.location, pathname: '/tools/x', assign })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    assign.mockReset()
    localStorage.setItem('access_token', 'test-token')
  })

  it('adds the bearer token and returns the response untouched', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":1}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await authFetch('/api/tools/x', { headers: { 'X-A': '1' } })
    expect(await res.json()).toEqual({ ok: 1 })
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer tok')
    expect(headers.get('X-A')).toBe('1')
  })

  it('on 401 clears the token and goes to /login', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const res = await authFetch('/api/tools/x')
    expect(res.status).toBe(401)
    expect(localStorage.getItem('access_token')).toBeNull()
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it('does not redirect for a failed login attempt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    await authFetch('/api/auth/login', { method: 'POST' })
    expect(assign).not.toHaveBeenCalled()
  })

  it('handleUnauthorized is a no-op redirect when already on /login', () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/login', assign })
    handleUnauthorized()
    expect(assign).not.toHaveBeenCalled()
  })
})

describe('openRunStream', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('puts a run ticket in the stream URL, never the session token', async () => {
    localStorage.setItem('access_token', 'session-tok')
    const fetchMock = vi.fn(async () => new Response('{"ticket":"tick"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const urls: string[] = []
    vi.stubGlobal('EventSource', class { constructor(url: string) { urls.push(url) } close() {} })

    await openRunStream('run-1')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/agents/stream/run-1/ticket')
    expect(init.method).toBe('POST')
    expect(urls).toEqual(['/api/agents/stream/run-1?ticket=tick'])
    localStorage.setItem('access_token', 'test-token')
  })

  it('rejects when the ticket request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(openRunStream('nope')).rejects.toThrow('HTTP 404')
  })
})
