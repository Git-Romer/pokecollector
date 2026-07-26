import { describe, it, expect } from 'vitest'
import { isValidHandleFormat, normalizeHandle } from './publicHandle'

describe('publicHandle', () => {
  it('normalizes case and trims', () => {
    expect(normalizeHandle('  Ash-K ')).toBe('ash-k')
  })
  it('accepts a valid handle', () => {
    expect(isValidHandleFormat('ash-ketchum')).toBe(true)
  })
  it('rejects too short', () => {
    expect(isValidHandleFormat('ab')).toBe(false)
  })
  it('rejects bad chars and edges', () => {
    expect(isValidHandleFormat('ash_k')).toBe(false)
    expect(isValidHandleFormat('-ash')).toBe(false)
    expect(isValidHandleFormat('ash--k')).toBe(false)
  })
  it('rejects routes and reserved words', () => {
    expect(isValidHandleFormat('admin')).toBe(false)
    expect(isValidHandleFormat('settings')).toBe(false)
  })
})
