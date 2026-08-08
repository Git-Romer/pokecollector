import { describe, expect, it } from 'vitest'
import { filterProductCardCandidates, parseCollectionAddedAt } from './productCardPicker'

const NOW = Date.parse('2026-08-08T19:00:00Z')

const candidate = (id, name, addedAt, overrides = {}) => ({
  item: {
    id,
    card_id: `card-${id}`,
    added_at: addedAt,
    variant: 'Normal',
    condition: 'NM',
    lang: 'en',
    card: {
      name,
      number: String(id),
      set_id: 'sv1',
      set_ref: { name: 'Paldea Évolved' },
    },
    ...overrides,
  },
  available: 1,
})

describe('filterProductCardCandidates', () => {
  it('treats timezone-less backend timestamps as UTC', () => {
    expect(parseCollectionAddedAt('2026-08-08T18:30:00')).toBe(Date.parse('2026-08-08T18:30:00Z'))
    expect(parseCollectionAddedAt('2026-08-08T20:30:00+02:00')).toBe(Date.parse('2026-08-08T18:30:00Z'))
  })

  const candidates = [
    candidate(1, 'Pikachu', '2026-08-08T18:30:00Z'),
    candidate(2, 'Charizard', '2026-08-08T10:00:00Z'),
    candidate(3, 'Bulbasaur', '2026-08-01T10:00:00Z'),
  ]

  it('filters by recent collection additions', () => {
    expect(filterProductCardCandidates(candidates, { timeRange: 'hour', now: NOW }).map(entry => entry.item.id)).toEqual([1])
    expect(filterProductCardCandidates(candidates, { timeRange: 'day', now: NOW }).map(entry => entry.item.id)).toEqual([1, 2])
    expect(filterProductCardCandidates(candidates, { timeRange: 'all', now: NOW }).map(entry => entry.item.id)).toEqual([1, 2, 3])
  })

  it('searches names, sets, numbers, and exact collection attributes without accents', () => {
    expect(filterProductCardCandidates(candidates, { search: 'charizard' }).map(entry => entry.item.id)).toEqual([2])
    expect(filterProductCardCandidates(candidates, { search: 'paldea evolved' })).toHaveLength(3)
    expect(filterProductCardCandidates(candidates, { search: 'sv1 3' }).map(entry => entry.item.id)).toEqual([3])
  })

  it('distinguishes otherwise identical collection rows by purchase price', () => {
    const pricedCandidates = [
      candidate(4, 'Pikachu', '2026-08-08T18:30:00Z', { purchase_price: 4.5 }),
      candidate(5, 'Pikachu', '2026-08-08T18:30:00Z', { purchase_price: 12.75 }),
    ]

    expect(filterProductCardCandidates(pricedCandidates, { search: '12.75' }).map(entry => entry.item.id)).toEqual([5])
  })

  it('excludes rows without a usable timestamp from recent filters', () => {
    const missingTimestamp = candidate(4, 'Mew', null)
    expect(filterProductCardCandidates([missingTimestamp], { timeRange: 'day', now: NOW })).toEqual([])
    expect(filterProductCardCandidates([missingTimestamp], { timeRange: 'all', now: NOW })).toHaveLength(1)
  })
})
