import { describe, expect, it } from 'vitest'
import { nextDelayMs, parseRetryAfter } from './backoff.js'

function seeded(seed) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

describe('nextDelayMs', () => {
  it('is bounded by min(cap, base * 2^(n-1)) and by zero', () => {
    const rng = seeded(7)
    for (let n = 1; n <= 40; n += 1) {
      const ceiling = Math.min(900000, 5000 * 2 ** (n - 1))
      for (let i = 0; i < 50; i += 1) {
        const delay = nextDelayMs(n, rng)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThan(ceiling)
      }
    }
  })

  it('has a monotonically non-decreasing ceiling that stops at the cap', () => {
    const max = n => nextDelayMs(n, () => 0.999999)
    let previous = 0
    for (let n = 1; n <= 20; n += 1) {
      expect(max(n)).toBeGreaterThanOrEqual(previous)
      previous = max(n)
    }
    expect(max(9)).toBe(max(30))
    expect(max(30)).toBeLessThan(900000)
    expect(max(30)).toBeGreaterThan(899000)
  })

  it('uses the first-retry ceiling for n <= 1', () => {
    expect(nextDelayMs(1, () => 0.5)).toBe(2500)
    expect(nextDelayMs(0, () => 0.5)).toBe(2500)
  })
})

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-18T12:00:00Z')

  it('parses delta-seconds and clamps to [5 s, 900 s]', () => {
    expect(parseRetryAfter('30', now)).toBe(30000)
    expect(parseRetryAfter('1', now)).toBe(5000)
    expect(parseRetryAfter('0', now)).toBe(5000)
    expect(parseRetryAfter('99999', now)).toBe(900000)
  })

  it('parses HTTP-dates relative to now', () => {
    expect(parseRetryAfter('Sun, 18 Oct 2026 12:02:00 GMT', now)).toBe(120000)
    expect(parseRetryAfter('Sun, 18 Oct 2026 11:00:00 GMT', now)).toBe(5000)
    expect(parseRetryAfter('Mon, 19 Oct 2026 12:00:00 GMT', now)).toBe(900000)
  })

  it('returns null for garbage, negatives and absent values', () => {
    expect(parseRetryAfter('soon', now)).toBeNull()
    expect(parseRetryAfter('-5', now)).toBeNull()
    expect(parseRetryAfter('1.5', now)).toBeNull()
    expect(parseRetryAfter('', now)).toBeNull()
    expect(parseRetryAfter(null, now)).toBeNull()
    expect(parseRetryAfter(undefined, now)).toBeNull()
  })
})
