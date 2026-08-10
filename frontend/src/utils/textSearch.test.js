import { describe, expect, it } from 'vitest'
import { setMatchesSearch } from './textSearch'

const set = {
  id: 'me04_de',
  tcg_set_id: 'me04',
  name: 'Wachsendes Chaos',
  abbreviation: 'CRI',
}

describe('setMatchesSearch', () => {
  it('matches a localized set name', () => {
    expect(setMatchesSearch(set, 'wachsendes')).toBe(true)
  })

  it('matches the official abbreviation case-insensitively', () => {
    expect(setMatchesSearch(set, 'cri')).toBe(true)
  })

  it('matches the TCGdex set ID and composite database ID', () => {
    expect(setMatchesSearch(set, 'me04')).toBe(true)
    expect(setMatchesSearch(set, 'me04_de')).toBe(true)
  })

  it('rejects unrelated searches', () => {
    expect(setMatchesSearch(set, 'sv01')).toBe(false)
  })
})
