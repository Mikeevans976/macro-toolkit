/** Lazy-loaded routes resolve through Suspense inside the app shell. */
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import App from '../App'

describe('App routing', () => {
  it.each(['/tools/swaps-rv', '/tools/uk-heatmap', '/tools/mean-reversion'])('loads %s', async (path) => {
    window.history.pushState({}, '', path)
    const { container } = render(<App />)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 30_000 })
    expect(container.innerHTML.length).toBeGreaterThan(500)
  })

  it('redirects to /login without a token', () => {
    localStorage.removeItem('access_token')
    window.history.pushState({}, '', '/tools/swaps-rv')
    render(<App />)
    expect(window.location.pathname).toBe('/login')
    localStorage.setItem('access_token', 'test-token')
  })
})
