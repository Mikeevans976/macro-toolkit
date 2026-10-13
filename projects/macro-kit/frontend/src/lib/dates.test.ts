import { describe, expect, it } from 'vitest'
import { toLocalISODate } from './dates'

describe('toLocalISODate', () => {
  it('keeps the local calendar day at local midnight', () => {
    expect(toLocalISODate(new Date(2024, 3, 1))).toBe('2024-04-01')   // BST in London
    expect(toLocalISODate(new Date(2024, 0, 1))).toBe('2024-01-01')
    expect(toLocalISODate(new Date(2024, 11, 31, 23, 59))).toBe('2024-12-31')
  })
})
