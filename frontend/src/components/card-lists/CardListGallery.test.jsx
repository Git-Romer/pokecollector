import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import CardListGallery from './CardListGallery'

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: key => key }),
}))

vi.mock('../CollectionCardImage', () => ({
  CollectionCardDisplay: () => createElement('div', { 'data-private-collection-display': true }),
}))

vi.mock('../card-system', () => ({
  CardDisplay: ({ card, price, languageLabel, captionAccessory, captionDetail }) => createElement('div', { 'data-public-card-display': true }, JSON.stringify(card), price, languageLabel, captionAccessory, captionDetail),
  CardRequirementProgress: () => null,
  withCollectionItemState: card => card,
}))

describe('CardListGallery public mode', () => {
  it('uses the catalogue card display without owner collection state', () => {
    const markup = renderToStaticMarkup(createElement(CardListGallery, {
      mode: 'public',
      entries: [{
        card_id: 'sv1-1_en',
        required_quantity: 3,
        owned_quantity: 99,
        collection_item_id: 42,
        date_added: '2026-09-15',
        card: { id: 'sv1-1_en', name: 'Sprigatito', image: '/api/images/card/sv1-1_en/small', set_id: 'sv1', set_name: 'Scarlet & Violet', rarity: 'Common', lang: 'en', market_value: 5 },
      }],
      t: key => key,
      formatPrice: value => `€${value}`,
      publicQuantityLabel: value => `Wanted: ${value}`,
      publicDetailLabel: entry => `Added ${entry.date_added}`,
    }))

    expect(markup).toContain('data-public-card-display')
    expect(markup).toContain('Wanted: 3')
    expect(markup).toContain('Added 2026-09-15')
    expect(markup).toContain('Scarlet &amp; Violet · Common')
    expect(markup).toContain('EN')
    expect(markup).toContain('€5')
    expect(markup).not.toContain('data-private-collection-display')
    expect(markup).not.toContain('99')
    expect(markup).not.toContain('42')
  })
})
