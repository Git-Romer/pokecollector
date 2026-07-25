import { describe, it, expect } from 'vitest'
import { groupCardsByPrint } from './groupCardsByPrint'

const card = (over = {}) => ({
  id: 'sv1-1', name: 'Sprigatito', image: 'a.webp', set_name: 'S&V',
  number: '1', variant: 'Normal', quantity: 1, market_value: null, ...over,
})

describe('groupCardsByPrint', () => {
  it('merges variants of the same card into one tile', () => {
    const out = groupCardsByPrint([
      card({ variant: 'Normal', quantity: 2 }),
      card({ variant: 'Reverse Holo', quantity: 1 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('sv1-1')
    expect(out[0].variantCount).toBe(2)
    expect(out[0].prints).toEqual([
      { variant: 'Normal', quantity: 2, market_value: null },
      { variant: 'Reverse Holo', quantity: 1, market_value: null },
    ])
  })

  it('keeps distinct cards as separate tiles in first-seen order', () => {
    const out = groupCardsByPrint([
      card({ id: 'sv1-2', name: 'Floragato', number: '2' }),
      card({ id: 'sv1-1', name: 'Sprigatito', number: '1' }),
    ])
    expect(out.map(t => t.id)).toEqual(['sv1-2', 'sv1-1'])
  })

  it('single-variant card has variantCount 1', () => {
    const out = groupCardsByPrint([card({ quantity: 3 })])
    expect(out[0].variantCount).toBe(1)
  })

  it('sums value across prints as market_value * quantity', () => {
    const out = groupCardsByPrint([
      card({ variant: 'Normal', quantity: 2, market_value: 5 }),
      card({ variant: 'Reverse Holo', quantity: 1, market_value: 8 }),
    ])
    expect(out[0].total_value).toBe(18) // 5*2 + 8*1
  })

  it('total_value is null when values are hidden (all market_value null)', () => {
    const out = groupCardsByPrint([
      card({ variant: 'Normal', market_value: null }),
      card({ variant: 'Reverse Holo', market_value: null }),
    ])
    expect(out[0].total_value).toBeNull()
  })

  it('returns [] for empty or missing input', () => {
    expect(groupCardsByPrint([])).toEqual([])
    expect(groupCardsByPrint(undefined)).toEqual([])
  })
})
