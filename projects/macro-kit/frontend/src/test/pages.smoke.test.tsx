/**
 * Smoke test: every page module renders without throwing, with all network
 * requests left pending. Guards the frontend refactors in docs/REFACTOR_PLAN.md
 * (Phase 4) against pages that crash on load.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ComponentType } from 'react'

const pages = import.meta.glob<{ default: ComponentType }>('../pages/*.tsx')

describe('pages render', () => {
  for (const [path, load] of Object.entries(pages)) {
    const name = path.replace('../pages/', '').replace('.tsx', '')
    it(name, async () => {
      const { default: Page } = await load()
      const { container } = render(
        <MemoryRouter initialEntries={['/tools/x/test']}>
          <Routes>
            <Route path="*" element={<Page />} />
            <Route path="/tools/:group/:agentId" element={<Page />} />
          </Routes>
        </MemoryRouter>,
      )
      expect(container.innerHTML.length).toBeGreaterThan(0)
    })
  }
})
