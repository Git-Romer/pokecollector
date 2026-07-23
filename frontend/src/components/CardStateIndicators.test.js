import { describe, expect, it } from 'vitest'
import { getCardState } from './CardStateIndicators'

describe('getCardState', () => {
  it('uses detailed variants instead of the generic owned fallback', () => {
    const state = getCardState({ owned: true, owned_quantity: 3, owned_variants: [{ variant: 'Normal', quantity: 2 }] })
    expect(state.variants).toEqual([{ variant: 'Normal', quantity: 2 }])
    expect(state.genericOwned).toBe(false)
  })

  it('supports generic ownership and both wishlist contract shapes independently', () => {
    expect(getCardState({ owned_quantity: 1, wishlisted: true })).toMatchObject({ genericOwned: true, wishlisted: true })
    expect(getCardState({ wishlist_count: 2 })).toMatchObject({ genericOwned: false, wishlisted: true })
  })
})
