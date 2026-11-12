import { describe, expect, it } from 'vitest'
import { getEffectiveCardPrice } from './prices'

describe('Special variant pricing', () => {
  it('uses the ordinary Cardmarket selected field instead of Holo or Reverse pricing', () => {
    const card = {
      price_trend: 12.5,
      price_trend_holo: 25,
      price_market: 13,
      price_market_holo: 26,
    }

    expect(getEffectiveCardPrice(card, 'Special', 'price_trend')).toBe(12.5)
    expect(getEffectiveCardPrice(card, 'Reverse Holo', 'price_trend')).toBe(25)
  })
})
