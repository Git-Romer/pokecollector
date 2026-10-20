import { describe, expect, it } from 'vitest'
import { currencySymbolFor, formatSelectedCurrency } from './currencyFormatting'

describe('selected-currency formatting', () => {
  it('uses Intl formatting for each selected currency', () => {
    for (const currency of ['DKK', 'CAD', 'JPY']) {
      const result = formatSelectedCurrency(10, currency, 1.25, 'en')
      const expected = new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).format(12.5)
      expect(result).toBe(expected)
      expect(result).not.toContain('EUR')
      expect(result).not.toContain('USD')
    }
  })

  it('marks a missing conversion as unavailable in the selected currency', () => {
    expect(formatSelectedCurrency(10, 'DKK', null, 'en')).toBe('Unavailable (DKK)')
  })

  it('keeps missing amounts separate from unavailable rates', () => {
    expect(formatSelectedCurrency(null, 'DKK', null, 'en')).toBe('-')
    expect(formatSelectedCurrency('invalid', 'DKK', 1, 'en')).toBe('-')
  })

  it('derives a currency input symbol for any valid currency', () => {
    const expected = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: 'CAD',
      currencyDisplay: 'symbol',
    }).formatToParts(0).find((part) => part.type === 'currency')?.value
    expect(currencySymbolFor('CAD', 'en')).toBe(expected)
  })
})
