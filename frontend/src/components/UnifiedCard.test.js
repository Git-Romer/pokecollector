import { describe, expect, it } from 'vitest'
import { getCardFallbackKinds, getCardSetNumber, getFallbackBorderGradient } from './UnifiedCard'

describe('getCardFallbackKinds', () => {
  it('returns fallback kinds in a stable order and ignores custom images', () => {
    expect(getCardFallbackKinds({
      price_source_lang: 'en',
      image_source_lang: 'de',
      data_source_lang: 'fr',
      custom_image_url: 'https://example.test/card.webp',
    })).toEqual(['data', 'price', 'image'])
  })
})

describe('getFallbackBorderGradient', () => {
  it('uses one solid color for a single fallback', () => {
    expect(getFallbackBorderGradient(['price'])).toBe('#f0aa38')
  })

  it('splits two fallbacks with blended corner transitions', () => {
    const gradient = getFallbackBorderGradient(['data', 'image'])
    expect(gradient).toContain('conic-gradient(from 45deg')
    expect(gradient).toContain('#a56cff')
    expect(gradient).toContain('#55a7ff')
  })

  it('uses all three fixed fallback colors', () => {
    const gradient = getFallbackBorderGradient(['data', 'price', 'image'])
    expect(gradient).toContain('#a56cff')
    expect(gradient).toContain('#f0aa38')
    expect(gradient).toContain('#55a7ff')
  })
})

describe('getCardSetNumber', () => {
  it('prefers the set abbreviation and local card number', () => {
    expect(getCardSetNumber({
      set: { id: 'me05', abbreviation: 'pbl' },
      localId: '096',
    })).toBe('PBL 096')
  })

  it('collapses cleanly when catalogue metadata is incomplete', () => {
    expect(getCardSetNumber({ number: '12' })).toBe('12')
    expect(getCardSetNumber({})).toBe('')
  })
})
