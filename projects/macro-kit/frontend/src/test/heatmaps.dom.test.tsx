/**
 * DOM snapshots of the regional heatmap pages (deterministic synthetic data).
 * Guards the de-duplication of shared helpers: any change to rendered tables,
 * labels or numbers fails here. Refresh only for intentional changes:
 *   npx vitest run -u src/test/heatmaps.dom.test.tsx
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ComponentType } from 'react'

/** 64-bit FNV-1a over UTF-16 code units — enough to detect any DOM change. */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

const pages = import.meta.glob<{ default: ComponentType }>('../pages/*Heatmap.tsx')

describe('heatmap DOM', () => {
  // Pages show a live 'as of' clock; pin it.
  beforeAll(() => { vi.useFakeTimers({ now: new Date('2026-06-30T12:00:00Z'), toFake: ['Date'] }) })
  afterAll(() => { vi.useRealTimers() })

  for (const [path, load] of Object.entries(pages)) {
    const name = path.replace('../pages/', '').replace('.tsx', '')
    it(name, async () => {
      const { default: Page } = await load()
      const { container } = render(<MemoryRouter><Page /></MemoryRouter>)
      const html = container.innerHTML
      expect({ length: html.length, fnv1a64: fnv1a64(html) }).toMatchSnapshot()
    })
  }
})
