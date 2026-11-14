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

  it('finds digit-first and mixed set codes in the owned-card picker', () => {
    const items = [
      { quantity: 1, card: { id: '30th-001_de', name: 'Owei', number: '001', lang: 'de', set_id: '30th', set_ref: { id: '30th_de', tcg_set_id: '30th', abbreviation: '30C', name: 'Anniversary' } } },
      { quantity: 1, card: { id: 'M2a-228_ja', name: 'Lucario', number: '228', lang: 'ja', set_id: 'M2a', set_ref: { abbreviation: 'M2A' } } },
    ]
    for (const query of ['30C 001', '30c 1', ' 30C   0001 ', '30th 1']) {
      expect(filterCollectionCards(items, { search: query }).map(item => item.card.id)).toEqual(['30th-001_de'])
    }
    expect(filterCollectionCards(items, { search: 'M2a 228' }).map(item => item.card.id)).toEqual(['M2a-228_ja'])
    expect(filterCollectionCards(items, { search: '30C 2' })).toEqual([])
    expect(filterCollectionCards(items, { search: '30C 1', language: 'ja' })).toEqual([])
  })

  it('exposes deduplicated set and language filter options', () => {
    expect(cardListPickerOptions(aggregateCollectionItems(collection))).toEqual({
      sets: [{ id: 'sv2', name: 'Paldea Evolved' }, { id: 'sv1', name: 'Scarlet & Violet' }],
      languages: ['de', 'en'],
    })
  })
})
