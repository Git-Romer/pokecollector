import { describe, expect, it } from 'vitest'
import { getOwnedVariants } from './cardVariants'

const row = (over = {}) => ({
  id: 1, card_id: 'sv01-003_en', card: { id: 'sv01-003_en', name: 'Card' },
  quantity: 1, condition: 'NM', variant: 'Normal', lang: 'en', purchase_price: null,
  ...over,
})

describe('getOwnedVariants', () => {
  it('returns one entry per distinct owned variant', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal' }),
      row({ id: 2, variant: 'Reverse Holo' }),
    ])
    expect(result).toEqual([
      { variant: 'Normal', quantity: 1 },
      { variant: 'Reverse Holo', quantity: 1 },
    ])
  })

  it('sums quantity across rows of the same variant with different conditions', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', condition: 'NM', quantity: 1 }),
      row({ id: 2, variant: 'Normal', condition: 'LP', quantity: 2 }),
    ])
    expect(result).toEqual([{ variant: 'Normal', quantity: 3 }])
  })

  it('orders variants canonically regardless of row order', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'First Edition' }),
      row({ id: 2, variant: 'Holo' }),
      row({ id: 3, variant: 'Normal' }),
    ])
    expect(result.map(entry => entry.variant)).toEqual(['Normal', 'Holo', 'First Edition'])
  })

  it('treats a missing variant as Normal', () => {
    expect(getOwnedVariants([row({ variant: null })])).toEqual([{ variant: 'Normal', quantity: 1 }])
  })

  it('passes through a non-canonical variant, after the canonical ones', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Full Art' }),
      row({ id: 2, variant: 'Normal' }),
    ])
    expect(result.map(entry => entry.variant)).toEqual(['Normal', 'Full Art'])
  })

  it('omits a variant whose total quantity is zero', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', quantity: 0 }),
      row({ id: 2, variant: 'Reverse Holo', quantity: 1 }),
    ])
    expect(result).toEqual([{ variant: 'Reverse Holo', quantity: 1 }])
  })

  it('omits a variant whose quantity is null', () => {
    expect(getOwnedVariants([row({ variant: 'Normal', quantity: null })])).toEqual([])
  })

  it('keeps a variant whose rows sum above zero even if one row is zero', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', condition: 'NM', quantity: 0 }),
      row({ id: 2, variant: 'Normal', condition: 'LP', quantity: 2 }),
    ])
    expect(result).toEqual([{ variant: 'Normal', quantity: 2 }])
  })

  it('accepts numeric API strings without concatenating quantities', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', quantity: '2' }),
      row({ id: 2, variant: 'Normal', quantity: 1 }),
    ])
    expect(result).toEqual([{ variant: 'Normal', quantity: 3 }])
  })

  it('ignores negative and non-numeric quantities defensively', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', quantity: -2 }),
      row({ id: 2, variant: 'Holo', quantity: 'not-a-number' }),
    ])
    expect(result).toEqual([])
  })

  it('returns an empty array for no rows', () => {
    expect(getOwnedVariants([])).toEqual([])
  })
})

import { getCardOwnedVariants, hasGenericOwnership } from './cardVariants'

describe('card tile ownership normalization', () => {
  it('prefers owned_variants over owned_items', () => {
    expect(getCardOwnedVariants({ owned_variants: [{ variant: 'Holo', quantity: 2 }], owned_items: [row({ variant: 'Normal' })] }))
      .toEqual([{ variant: 'Holo', quantity: 2 }])
  })

  it('uses owned_items when detailed summary variants are absent', () => {
    expect(getCardOwnedVariants({ owned_items: [row({ variant: 'Reverse Holo' })] }))
      .toEqual([{ variant: 'Reverse Holo', quantity: 1 }])
  })

  it('recognizes generic owned and quantity fallbacks without inventing a variant', () => {
    expect(getCardOwnedVariants({ owned: true })).toEqual([])
    expect(hasGenericOwnership({ owned: true })).toBe(true)
    expect(hasGenericOwnership({ owned_quantity: 3 })).toBe(true)
  })
})
