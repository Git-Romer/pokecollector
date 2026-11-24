import { describe, expect, it, vi } from 'vitest'
import { uuidv4 } from './uuid.js'

describe('uuidv4', () => {
  it('produces RFC 4122 version-4 strings', () => {
    expect(uuidv4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('produces 10 000 unique values', () => {
    const seen = new Set()
    for (let i = 0; i < 10000; i += 1) seen.add(uuidv4())
    expect(seen.size).toBe(10000)
  })

  it('works without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    try {
      expect(globalThis.crypto.randomUUID).toBeUndefined()
      expect(uuidv4()).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts a crypto implementation and sets the version/variant bits', () => {
    const ones = { getRandomValues: bytes => bytes.fill(0xff) }
    expect(uuidv4(ones)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })
})
