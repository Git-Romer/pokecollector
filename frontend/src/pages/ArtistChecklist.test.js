import { describe, expect, it, vi } from 'vitest'
import {
  decodeArtistParam,
  groupCardsBySet,
  isCardOwned,
  navigateBackFromArtist,
  parseArtistChecklistState,
} from './ArtistChecklist'
import { parseArtistsState } from './Artists'

describe('artist checklist back navigation', () => {
  it.each([undefined, null, {}, { idx: 0 }, { idx: 2 }, { idx: -1 }, { idx: '2' }])(
    'always goes up to the artist directory regardless of browser history (%j)',
    (historyState) => {
      const navigate = vi.fn()
      navigateBackFromArtist(navigate, historyState)
      expect(navigate).toHaveBeenCalledExactlyOnceWith('/artists')
    },
  )
})

describe('artist checklist helpers', () => {
  it('keeps decoded artist names, including ones containing a percent sign', () => {
    expect(decodeArtistParam('Mitsuhiro Arita')).toBe('Mitsuhiro Arita')
    expect(decodeArtistParam('100% Arita')).toBe('100% Arita')
    expect(decodeArtistParam('%')).toBe('%')
    expect(decodeArtistParam(undefined)).toBe('')
  })

  it('parses supported URL state', () => {
    const state = parseArtistChecklistState(
      new URLSearchParams('lang=de&ownership=owned&sort_by=price&sort_order=desc&page=3'),
    )

    expect(state).toEqual({
      lang: 'de',
      ownership: 'owned',
      sortBy: 'price',
      sortOrder: 'desc',
      page: 3,
    })
  })

  it('clamps malformed and out-of-range URL state', () => {
    expect(
      parseArtistChecklistState(
        new URLSearchParams('lang=xx&ownership=bogus&sort_by=rarity&sort_order=sideways&page=0'),
      ),
    ).toEqual({
      lang: 'all',
      ownership: '',
      sortBy: 'number',
      sortOrder: 'asc',
      page: 1,
    })

    expect(parseArtistChecklistState(new URLSearchParams('page=02')).page).toBe(1)

    const state = parseArtistChecklistState(new URLSearchParams('ownership=missing&page=400'))
    expect(state.ownership).toBe('missing')
    expect(state.page).toBe(400)
  })

  it('groups cards by set in first-appearance order', () => {
    const groups = groupCardsBySet([
      { id: 'b1', set_ref: { id: 'set-b', name: 'Set B' }, owned: true },
      { id: 'b2', set_ref: { id: 'set-b' }, owned_quantity: 1 },
      { id: 'a1', set_id: 'set-a', set_name: 'Set A' },
      { id: 'b3', set_ref: { id: 'set-b' } },
      { id: 'u1' },
    ])

    expect(groups.map((group) => group.key)).toEqual(['set-b', 'set-a', '__unknown_set__'])
    expect(groups[0]).toMatchObject({ linkId: 'set-b', setName: 'Set B', owned: 2, total: 3 })
    expect(groups[0].cards.map((card) => card.id)).toEqual(['b1', 'b2', 'b3'])
    expect(groups[1]).toMatchObject({ linkId: null, setName: 'Set A', owned: 0, total: 1 })
    expect(groups[2]).toMatchObject({ setName: '', owned: 0, total: 1 })
  })

  it('detects ownership from either flag or quantity', () => {
    expect(isCardOwned({ owned: true })).toBe(true)
    expect(isCardOwned({ owned: false, owned_quantity: 2 })).toBe(true)
    expect(isCardOwned({ owned: false, owned_quantity: 0 })).toBe(false)
    expect(isCardOwned({})).toBe(false)
    expect(isCardOwned(null)).toBe(false)
  })
})

describe('artist directory URL state', () => {
  it('parses supported values and trims the search term', () => {
    const state = parseArtistsState(
      new URLSearchParams('q= Arita &lang=ja&sort_by=progress&sort_order=desc&page=2'),
    )

    expect(state).toEqual({
      q: 'Arita',
      lang: 'ja',
      sortBy: 'progress',
      sortOrder: 'desc',
      page: 2,
    })
  })

  it('falls back to defaults for unknown values', () => {
    expect(parseArtistsState(new URLSearchParams('sort_by=rarity&page=0'))).toEqual({
      q: '',
      lang: 'all',
      sortBy: 'progress',
      sortOrder: 'desc',
      page: 1,
    })
  })
})
