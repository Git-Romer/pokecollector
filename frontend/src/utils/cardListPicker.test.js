import { describe, expect, it } from 'vitest'
import { aggregateCollectionItems, cardListPickerOptions, filterCollectionCards } from './cardListPicker'

const collection = [
  { quantity: 2, lang: 'en', card: { id: 'pika', name: 'Pikachu', number: '025', supertype: 'Pokemon', lang: 'en', set_ref: { id: 'sv1', name: 'Scarlet & Violet' } } },
  { quantity: 1, lang: 'en', card: { id: 'pika', name: 'Pikachu', number: '025', supertype: 'Pokemon', lang: 'en', set_ref: { id: 'sv1', name: 'Scarlet & Violet' } } },
  { quantity: 1, lang: 'de', card: { id: 'ball', name: 'Ultra Ball', number: '196', supertype: 'Trainer', lang: 'de', set_ref: { id: 'sv2', name: 'Paldea Evolved' } } },
  { quantity: 1, lang: 'en', card: { id: 'energy', name: 'Fire Energy', number: '2', supertype: 'Energy', lang: 'en', set_ref: { id: 'sv1', name: 'Scarlet & Violet' } } },
]

describe('card list picker utilities', () => {
  it('aggregates localized collection rows by card identity', () => {
    expect(aggregateCollectionItems(collection).find(item => item.card.id === 'pika').quantity).toBe(3)
  })

  it('aggregates the quantity available to physical Card Lists separately from total ownership', () => {
    const items = collection.map((item, index) => ({ ...item, available_quantity: index === 0 ? 0 : item.quantity }))
    expect(aggregateCollectionItems(items, 'available_quantity').find(item => item.card.id === 'pika')).toMatchObject({
      quantity: 3,
      maxQuantity: 1,
    })
  })

  it('filters by text, normalized card number, supertype, set, and language', () => {
    const items = aggregateCollectionItems(collection)
    expect(filterCollectionCards(items, { search: 'pika' }).map(item => item.card.id)).toEqual(['pika'])
    expect(filterCollectionCards(items, { search: '25' }).map(item => item.card.id)).toEqual(['pika'])
    expect(filterCollectionCards(items, { type: 'Trainer' }).map(item => item.card.id)).toEqual(['ball'])
    expect(filterCollectionCards(items, { set: 'sv1', language: 'en' }).map(item => item.card.id)).toEqual(['pika', 'energy'])
  })

  it('exposes deduplicated set and language filter options', () => {
    expect(cardListPickerOptions(aggregateCollectionItems(collection))).toEqual({
      sets: [{ id: 'sv2', name: 'Paldea Evolved' }, { id: 'sv1', name: 'Scarlet & Violet' }],
      languages: ['de', 'en'],
    })
  })
})
