import { describe, it, expect } from 'vitest'
import { formatEur } from './formatEur'

describe('formatEur', () => {
  it('returns null for null/undefined so callers can hide the value', () => {
    expect(formatEur(null)).toBeNull()
    expect(formatEur(undefined)).toBeNull()
  })
  it('formats a number as EUR', () => {
    expect(formatEur(10)).toBe('€10.00')
  })
  it('returns null for non-numeric input', () => {
    expect(formatEur('abc')).toBeNull()
  })
})
