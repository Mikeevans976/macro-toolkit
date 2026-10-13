import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => cleanup())

// jsdom lacks the layout APIs Recharts' ResponsiveContainer and some pages rely on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView = () => {}
window.matchMedia = window.matchMedia ?? ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
}) as unknown as MediaQueryList)

// Network: every request stays pending, so pages render their initial/loading state.
const pending = () => new Promise<never>(() => {})
globalThis.fetch = vi.fn(pending) as unknown as typeof fetch
class EventSourceStub {
  onmessage = null; onerror = null; onopen = null
  addEventListener() {}
  close() {}
}
globalThis.EventSource = EventSourceStub as unknown as typeof EventSource

vi.mock('axios', () => {
  const instance = {
    get: vi.fn(pending), post: vi.fn(pending), put: vi.fn(pending), delete: vi.fn(pending),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  }
  return { default: { ...instance, create: () => instance, isAxiosError: () => false } }
})

// Recent Node versions expose an experimental global localStorage that shadows jsdom's; pin an in-memory one.
class MemoryStorage implements Storage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, { value: new MemoryStorage(), configurable: true })
}
localStorage.setItem('access_token', 'test-token')
