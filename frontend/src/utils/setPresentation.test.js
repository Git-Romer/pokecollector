import { describe, expect, it } from 'vitest'
import { formatSetReleaseDate } from './setPresentation'

describe('formatSetReleaseDate', () => {
  it('formats months in the app language without changing the regional date', () => {
    expect(formatSetReleaseDate('2026-07-01', 'en')).toBe('Jul 2026')
    expect(formatSetReleaseDate('2026-07-01', 'de')).toBe('Juli 2026')
    expect(formatSetReleaseDate('2026-07-01', 'fr')).toBe('juil. 2026')
  })
  it('keeps the release month in time zones behind UTC', () => {
    const before = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try { expect(formatSetReleaseDate('2026-07-01', 'en')).toBe('Jul 2026') }
    finally {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    }
  })
  it('preserves unknown and invalid provider dates and handles missing dates', () => {
    expect(formatSetReleaseDate(null, 'en')).toBe('')
    expect(formatSetReleaseDate('', 'en')).toBe('')
    expect(formatSetReleaseDate('unknown', 'en')).toBe('unknown')
    expect(formatSetReleaseDate('2026-02-30', 'en')).toBe('2026-02-30')
  })
  it('uses English when a locale is absent or malformed', () => {
    expect(formatSetReleaseDate('2026-07-01')).toBe('Jul 2026')
    expect(formatSetReleaseDate('2026-07-01', 'not_a_locale')).toBe('Jul 2026')
  })
})
