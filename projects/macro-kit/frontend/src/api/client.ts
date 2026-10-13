/**
 * Shared API plumbing: one place that attaches the bearer token and handles an
 * expired/invalid session (401 → clear token, go to /login).
 *
 * - `authFetch` is a drop-in for `fetch` that returns the Response unchanged,
 *   so callers keep their own `res.ok` / JSON handling.
 * - `installAxiosAuth` applies the same behaviour to every axios request.
 */
import type { AxiosInstance } from 'axios'

export const TOKEN_KEY = 'access_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Session is gone or invalid: drop the token and return to the login page. */
export function handleUnauthorized(): void {
  localStorage.removeItem(TOKEN_KEY)
  if (window.location.pathname !== '/login') window.location.assign('/login')
}

const isApi = (url: string) => url.startsWith('/api/') && !url.startsWith('/api/auth/')

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('Authorization')) {
    for (const [k, v] of Object.entries(authHeaders())) headers.set(k, v)
  }
  const res = await fetch(input, { ...init, headers })
  if (res.status === 401 && isApi(input)) handleUnauthorized()
  return res
}

export function installAxiosAuth(client: AxiosInstance): void {
  client.interceptors.request.use(config => {
    const token = getToken()
    if (token && !config.headers.has('Authorization')) config.headers.set('Authorization', `Bearer ${token}`)
    return config
  })
  client.interceptors.response.use(undefined, error => {
    const url: string = error?.config?.url ?? ''
    if (error?.response?.status === 401 && isApi(url)) handleUnauthorized()
    return Promise.reject(error)
  })
}
