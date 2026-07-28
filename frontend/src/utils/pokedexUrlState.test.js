import { describe, expect, it } from 'vitest'
import { getPokedexGeneration } from './pokedexUrlState'

describe('Pokédex URL state', () => {
  it('follows generation changes from browser history', () => {
    const johtoUrl = new URLSearchParams('generation=2')
    const hoennUrl = new URLSearchParams('generation=3')

    expect(getPokedexGeneration(johtoUrl)).toBe(2)
    expect(getPokedexGeneration(hoennUrl)).toBe(3)
    expect(getPokedexGeneration(johtoUrl)).toBe(2)
  })

  it('uses the national Pokédex for missing or invalid generations', () => {
    expect(getPokedexGeneration(new URLSearchParams())).toBeNull()
    expect(getPokedexGeneration(new URLSearchParams('generation=0'))).toBeNull()
    expect(getPokedexGeneration(new URLSearchParams('generation=10'))).toBeNull()
    expect(getPokedexGeneration(new URLSearchParams('generation=2x'))).toBeNull()
  })
})
