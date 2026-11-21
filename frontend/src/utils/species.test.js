import { describe, expect, it } from 'vitest'
import {
  cardDexIds,
  formatDexNumber,
  formatSpeciesCounts,
  groupCollectionBySpecies,
  speciesName,
  speciesSpriteUrl,
} from './species'

const collectionItem = (id, cardId, dexIds, { quantity = 1, name = `Card ${cardId}` } = {}) => ({
  id,
  card_id: cardId,
  quantity,
  card: { id: cardId, name, dex_ids: dexIds },
})

const translations = {
  'analytics.printing': 'printing',
  'analytics.printings': 'printings',
  'analytics.copy': 'copy',
  'analytics.copies': 'copies',
}
const t = (key) => translations[key] ?? key

describe('cardDexIds', () => {
  it('keeps valid unique ids and ignores junk', () => {
    expect(cardDexIds({ card: { dex_ids: [6, '25', 6, 0, 1026, 'x', null] } })).toEqual([6, 25])
  })

  it('returns an empty list for cards without dex ids', () => {
    expect(cardDexIds({ card: { dex_ids: null } })).toEqual([])
    expect(cardDexIds({ card: {} })).toEqual([])
    expect(cardDexIds({})).toEqual([])
  })
})

describe('groupCollectionBySpecies', () => {
  it('groups rows by their first dex id with printing, copy and value totals', () => {
    const speciesByDexId = new Map([
      [4, { dex_id: 4, name_en: 'Charmander', name_de: 'Glumanda' }],
      [6, { dex_id: 6, name_en: 'Charizard', name_de: 'Glurak' }],
    ])
    const items = [
      collectionItem(1, 'sv1-1', [4], { quantity: 2 }),
      collectionItem(2, 'sv2-2', [4], { quantity: 1 }),
      collectionItem(3, 'sv2-2', [4], { quantity: 3 }),
      collectionItem(4, 'base-4', [6], { quantity: 1 }),
    ]
    const { groups, other } = groupCollectionBySpecies(items, {
      speciesByDexId,
      language: 'de',
      itemValue: (item) => item.quantity * 2,
    })

    expect(groups.map((group) => group.dexId)).toEqual([4, 6])
    expect(groups[0]).toMatchObject({
      name: 'Glumanda',
      printingCount: 2,
      copies: 6,
      totalValue: 12,
    })
    expect(groups[0].items.map((item) => item.id)).toEqual([1, 2, 3])
    expect(groups[1]).toMatchObject({ name: 'Glurak', printingCount: 1, copies: 1, totalValue: 2 })
    expect(other).toEqual({ items: [], copies: 0, totalValue: 0 })
  })

  it('groups a multi-species card once under its first id', () => {
    const items = [collectionItem(1, 'sv1-1', [6, 4])]
    const { groups } = groupCollectionBySpecies(items)
    expect(groups).toHaveLength(1)
    expect(groups[0].dexId).toBe(6)
    expect(groups[0].items).toHaveLength(1)
  })

  it('keeps cards without dex ids in the separate other bucket', () => {
    const items = [
      collectionItem(1, 'sv1-1', [25], { quantity: 2 }),
      collectionItem(2, 'sv1-2', null, { quantity: 3 }),
      collectionItem(3, 'custom-1', [], { quantity: 1 }),
    ]
    const { groups, other } = groupCollectionBySpecies(items, { itemValue: () => 5 })
    expect(groups).toHaveLength(1)
    expect(other.items.map((item) => item.id)).toEqual([2, 3])
    expect(other.copies).toBe(4)
    expect(other.totalValue).toBe(10)
  })

  it('falls back to the card name when species metadata is missing', () => {
    const items = [collectionItem(1, 'sv1-1', [999], { name: 'Mysterymon' })]
    const { groups } = groupCollectionBySpecies(items)
    expect(groups[0].name).toBe('Mysterymon')
  })
})

describe('species display helpers', () => {
  it('uses the requested language with a cross-language fallback', () => {
    expect(speciesName({ name_en: 'Bulbasaur', name_de: 'Bisasam' }, 'de')).toBe('Bisasam')
    expect(speciesName({ name_en: 'Bulbasaur' }, 'de')).toBe('Bulbasaur')
    expect(speciesName(null, 'de')).toBe('')
  })

  it('builds the cached sprite URL and dex label', () => {
    expect(speciesSpriteUrl(25)).toBe('/api/pokedex/images/sprites/25.png')
    expect(speciesSpriteUrl('x')).toBeNull()
    expect(formatDexNumber(1)).toBe('#001')
    expect(formatDexNumber(1025)).toBe('#1025')
    expect(formatDexNumber(0)).toBe('')
  })

  it('pluralises the printing and copy counts', () => {
    expect(formatSpeciesCounts(t, 1, 1)).toBe('1 printing · 1 copy')
    expect(formatSpeciesCounts(t, 3, 5)).toBe('3 printings · 5 copies')
  })
})
