import { describe, expect, it } from 'vitest'
import {
  getPokedexGeneration,
  normalizePokedexSearchParams,
  setPokedexGeneration,
  getPokedexMode,
  getPokedexFormFamily,
  setPokedexMode,
  setPokedexFormFamily,
} from './pokedexUrlState'

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

  it('normalizes malformed and duplicate generation parameters without removing unrelated state', () => {
    expect(normalizePokedexSearchParams(
      new URLSearchParams('generation=invalid&status=owned')
    ).toString()).toBe('status=owned')
    expect(normalizePokedexSearchParams(
      new URLSearchParams('generation=02&generation=3&status=owned')
    ).toString()).toBe('generation=2&status=owned')
  })

  it('writes valid generation changes and preserves unrelated search parameters', () => {
    const initial = new URLSearchParams('status=owned&search=pika')

    const johto = setPokedexGeneration(initial, 2)
    expect(johto.toString()).toBe('status=owned&search=pika&generation=2')
    expect(getPokedexGeneration(johto)).toBe(2)

    const national = setPokedexGeneration(johto, null)
    expect(national.toString()).toBe('status=owned&search=pika')
    expect(getPokedexGeneration(national)).toBeNull()
  })
})

describe('Pokédex form URL state', () => {
  it('defaults safely and removes a form filter in grouped mode', () => {
    expect(getPokedexMode(new URLSearchParams())).toBe('grouped')
    expect(getPokedexFormFamily(new URLSearchParams('form=mega'))).toBe('all')
    expect(normalizePokedexSearchParams(new URLSearchParams('mode=bad&form=mega')).toString()).toBe('')
  })

  it('round-trips separate mode and a supported form family', () => {
    const forms = setPokedexMode(new URLSearchParams('generation=1'), 'forms')
    const mega = setPokedexFormFamily(forms, 'mega')
    expect(getPokedexMode(mega)).toBe('forms')
    expect(getPokedexFormFamily(mega)).toBe('mega')
    expect(mega.toString()).toBe('generation=1&mode=forms&form=mega')
  })

  it('clears the form family when returning to grouped mode', () => {
    const grouped = setPokedexMode(new URLSearchParams('mode=forms&form=hisui'), 'grouped')
    expect(grouped.toString()).toBe('')
  })
})
