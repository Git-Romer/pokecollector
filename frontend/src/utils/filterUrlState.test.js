import { describe, expect, it } from 'vitest'
import {
  clearFilterUrlState,
  cloneFilterState,
  hasFilterUrlState,
  readFilterUrlState,
  writeFilterUrlState,
} from './filterUrlState'

const definitions = {
  rarity: { param: 'rarity', default: '' },
  categories: { param: 'category', default: [], type: 'list' },
  alerts: { param: 'alerts', default: false, type: 'boolean' },
}

describe('filter URL state', () => {
  it('reads strings, repeated lists, and booleans', () => {
    expect(readFilterUrlState('?rarity=Rare&category=Trainer&category=Pok%C3%A9mon&alerts=1', definitions)).toEqual({
      rarity: 'Rare',
      categories: ['Trainer', 'Pokémon'],
      alerts: true,
    })
  })

  it('writes filters while preserving unrelated URL state', () => {
    const result = writeFilterUrlState('?itemId=7&rarity=Old', definitions, {
      rarity: ' Rare ',
      categories: ['Trainer', 'Trainer', 'Pokémon'],
      alerts: true,
    })
    expect(result.get('itemId')).toBe('7')
    expect(result.get('rarity')).toBe('Rare')
    expect(result.getAll('category')).toEqual(['Trainer', 'Pokémon'])
    expect(result.get('alerts')).toBe('1')
  })

  it('clears only declared filters and clones list values', () => {
    const state = { rarity: '', categories: ['Trainer'], alerts: false }
    const clone = cloneFilterState(state)
    clone.categories.push('Energy')
    expect(state.categories).toEqual(['Trainer'])

    const result = clearFilterUrlState('?cardId=x&rarity=Rare&category=Trainer', definitions)
    expect(result.toString()).toBe('cardId=x')
    expect(hasFilterUrlState(result, definitions)).toBe(false)
  })
})
