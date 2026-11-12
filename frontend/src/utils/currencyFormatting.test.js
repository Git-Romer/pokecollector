import { describe, expect, it } from 'vitest'
import { currencySymbolFor, formatSelectedCurrency, rateForSelectedCurrency } from './currencyFormatting'

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

  it('does not reuse a saved quote while a new currency quote is pending', async () => {
    let resolveNewQuote
    const newQuote = new Promise(resolve => { resolveNewQuote = resolve })
    let quote = { rate: 6.8, currency: 'DKK' }
    const selectedCurrency = 'CAD'
    const formatted = () => formatSelectedCurrency(
      5,
      selectedCurrency,
      rateForSelectedCurrency(quote.rate, quote.currency, selectedCurrency),
      'en',
    )
    const applyQuote = newQuote.then(value => { quote = value })

    expect(formatted()).toBe('Unavailable (CAD)')
    resolveNewQuote({ rate: 1.25, currency: 'CAD' })
    await applyQuote
    expect(formatted()).toBe(formatSelectedCurrency(5, 'CAD', 1.25, 'en'))
  })

  it('uses a saved quote when it targets the selected currency', () => {
    expect(rateForSelectedCurrency(1.25, 'CAD', 'cad')).toBe(1.25)
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
