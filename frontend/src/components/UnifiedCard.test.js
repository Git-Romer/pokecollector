import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CardCaption,
  CompactCardArtwork,
  getCardFallbackKinds,
  getCardSetNumber,
  getFallbackBorderGradient,
  shouldDimUnownedCard,
  withCollectionItemState,
} from './UnifiedCard'

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    t: key => key,
  }),
}))

describe('CardCaption', () => {
  it('keeps the title and metadata in separate fixed rows with an ellipsis-ready title', () => {
    const markup = renderToStaticMarkup(createElement(CardCaption, {
      card: { name: 'A very long Pokémon card name' },
      setNumber: 'PBL 096',
      price: '€12.34',
    }))

    expect(markup).toContain('class="unified-card-caption-name"')
    expect(markup).toContain('title="A very long Pokémon card name"')
    expect(markup).toContain('PBL 096')
    expect(markup).toContain('€12.34')
  })

  it('renders caption-shaped loading placeholders while artwork is loading', () => {
    const markup = renderToStaticMarkup(createElement(CardCaption, {
      card: { name: 'Pikachu' },
      loading: true,
    }))

    expect(markup.match(/unified-card-caption-skeleton/g)).toHaveLength(2)
    expect(markup).not.toContain('Pikachu')
  })
})

describe('CompactCardArtwork', () => {
  it('uses the shared compact frame and contains the full artwork', () => {
    const markup = renderToStaticMarkup(createElement(CompactCardArtwork, {
      card: { id: 'sv8-001', name: 'Pikachu' },
      image: 'https://example.test/pikachu.webp',
      alt: 'Pikachu',
    }))

    expect(markup).toContain('unified-card-compact-artwork')
    expect(markup).toContain('unified-card-frame-thumbnail')
    expect(markup).toContain('object-contain')
  })
})

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

describe('withCollectionItemState', () => {
  it('maps the collection row quantity and variant into visible card state', () => {
    expect(withCollectionItemState(
      { id: 'sv8-001', name: 'Pikachu' },
      { quantity: 2, variant: 'Reverse Holo' },
    )).toMatchObject({
      owned: true,
      owned_quantity: 2,
      owned_variants: [{ variant: 'Reverse Holo', quantity: 2 }],
    })
  })

  it('keeps a single normal copy visible as a Normal badge', () => {
    expect(withCollectionItemState(
      { id: 'sv8-001', name: 'Pikachu' },
      { quantity: 1 },
    )).toMatchObject({
      owned: true,
      owned_quantity: 1,
      owned_variants: [{ variant: 'Normal', quantity: 1 }],
    })
  })

  it('does not invent ownership for an empty collection row', () => {
    expect(withCollectionItemState(
      { id: 'sv8-001', name: 'Pikachu' },
      { quantity: 0, variant: 'Holo' },
    )).toMatchObject({
      owned: false,
      owned_quantity: 0,
      owned_variants: [],
    })
  })
})

describe('shouldDimUnownedCard', () => {
  it('dims only missing cards in ownership-comparison views', () => {
    expect(shouldDimUnownedCard({ owned: false, owned_quantity: 0 }, true)).toBe(true)
    expect(shouldDimUnownedCard({ owned: true, owned_quantity: 1 }, true)).toBe(false)
    expect(shouldDimUnownedCard({ owned: false, owned_quantity: 2 }, true)).toBe(false)
    expect(shouldDimUnownedCard({ owned: false, owned_quantity: 0 }, false)).toBe(false)
  })
})
