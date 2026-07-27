import { describe, expect, it } from 'vitest'
import {
  getLastCardSearchPage,
  isValidCardSearchPage,
  parseCardSearchPage,
  resetCardSearchFilters,
  updateCardSearchParams,
} from './cardSearchUrlState'

describe('card search URL state', () => {
  it.each([
    ['1', 1],
    ['2', 2],
    ['999', 999],
  ])('parses a positive integer page %s', (value, expected) => {
    expect(isValidCardSearchPage(value)).toBe(true)
    expect(parseCardSearchPage(value)).toBe(expected)
  })

  it.each(['', '0', '-1', '2x', '1.5', '01', '9007199254740992'])(
    'rejects malformed page %s',
    (value) => {
      expect(isValidCardSearchPage(value)).toBe(false)
      expect(parseCardSearchPage(value)).toBe(1)
    },
  )

  it('calculates a safe final page', () => {
    expect(getLastCardSearchPage(0, 20)).toBe(1)
    expect(getLastCardSearchPage(21, 20)).toBe(2)
    expect(getLastCardSearchPage(100, 20)).toBe(5)
  })

  it('updates URL state without mutating the original parameters', () => {
    const current = new URLSearchParams('q=Pikachu&page=3&sort_order=desc')
    const next = updateCardSearchParams(current, { q: 'Raichu', sort_order: 'asc' })

    expect(current.toString()).toBe('q=Pikachu&page=3&sort_order=desc')
    expect(next.toString()).toBe('q=Raichu')
  })

  it('can retain pagination for explicit page navigation', () => {
    const next = updateCardSearchParams('q=Pikachu&page=2', { page: 3 }, { resetPage: false })
    expect(next.toString()).toBe('q=Pikachu&page=3')
  })

  it('resets filters without clearing the search term or language', () => {
    const next = resetCardSearchFilters(
      'q=Pikachu&lang=de&rarity=Rare&artist=Ken+Sugimori&sort_by=name&sort_order=desc&page=4',
    )

    expect(next.toString()).toBe('q=Pikachu&lang=de')
  })

  it('returns an empty search when only filters were active', () => {
    const next = resetCardSearchFilters('rarity=Rare&page=2')
    expect(next.toString()).toBe('')
  })
})
