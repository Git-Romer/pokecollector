import { describe, expect, it } from 'vitest'
import { currencyOptionsFor } from './currencyOptions'

describe('offline currency options', () => {
  it('preserves the selected currency without inventing EUR/USD choices when uncached', () => {
    expect(currencyOptionsFor([], 'DKK')).toEqual([
      { value: 'DKK', label: 'DKK' },
    ])
  })

  it('lists all cached currencies and appends a saved selection missing from stale metadata', () => {
    expect(currencyOptionsFor([
      { code: 'CAD', name: 'Canadian Dollar' },
      { code: 'DKK', name: 'Danish Krone' },
    ], 'CHF')).toEqual([
      { value: 'CAD', label: 'CAD — Canadian Dollar' },
      { value: 'DKK', label: 'DKK — Danish Krone' },
      { value: 'CHF', label: 'CHF' },
    ])
  })
})
