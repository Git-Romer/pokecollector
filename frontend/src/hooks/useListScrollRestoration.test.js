import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getDetailBackDelta,
  getNextDetailNavigationState,
  getSavedListScrollPosition,
  isSavedPositionForLocation,
  saveListScrollPosition,
} from './useListScrollRestoration'

const createSessionStorage = () => {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  }
}

describe('list scroll restoration state', () => {
  beforeEach(() => {
    globalThis.sessionStorage = createSessionStorage()
  })

  afterEach(() => {
    delete globalThis.sessionStorage
  })

  it('stores list filters with the originating history entry', () => {
    const saved = {
      scrollY: 640,
      anchorId: 'pokemon-25',
      pathname: '/pokedex',
      search: '?generation=1',
      locationKey: 'list-entry',
      listState: { status: 'owned', search: 'pika' },
    }

    saveListScrollPosition('pokedex', saved)

    expect(getSavedListScrollPosition('pokedex')).toEqual(saved)
    expect(isSavedPositionForLocation(saved, {
      pathname: '/pokedex',
      search: '?generation=1',
      key: 'list-entry',
    })).toBe(true)
  })

  it('does not restore state into a different URL or history entry', () => {
    const saved = {
      scrollY: 200,
      anchorId: 'set-base1',
      pathname: '/sets',
      search: '',
      locationKey: 'sets-entry',
    }

    expect(isSavedPositionForLocation(saved, {
      pathname: '/sets',
      search: '?lang=de',
      key: 'sets-entry',
    })).toBe(false)
    expect(isSavedPositionForLocation(saved, {
      pathname: '/sets',
      search: '',
      key: 'new-entry',
    })).toBe(false)
  })

  it('ignores malformed or incomplete stored positions', () => {
    sessionStorage.setItem('pokecollector:list-scroll:pokedex', '{invalid')
    expect(getSavedListScrollPosition('pokedex')).toBeNull()

    sessionStorage.setItem('pokecollector:list-scroll:pokedex', JSON.stringify({
      scrollY: '640',
      anchorId: 'pokemon-25',
    }))
    expect(getSavedListScrollPosition('pokedex')).toBeNull()
  })
})

describe('detail navigation history', () => {
  const sourceState = {
    fromList: 'pokedex',
    returnPath: '/pokedex?generation=1',
    anchorId: 'pokemon-25',
    detailHistoryDepth: 0,
  }

  it('returns to the source list after traversing multiple detail entries', () => {
    const secondDetail = getNextDetailNavigationState(sourceState, 'pokedex')
    const thirdDetail = getNextDetailNavigationState(secondDetail, 'pokedex')

    expect(secondDetail.detailHistoryDepth).toBe(1)
    expect(thirdDetail.detailHistoryDepth).toBe(2)
    expect(getDetailBackDelta(thirdDetail, 'pokedex')).toBe(-3)
  })

  it('uses a single history step for malformed depth and ignores unrelated lists', () => {
    expect(getDetailBackDelta({ ...sourceState, detailHistoryDepth: -4 }, 'pokedex')).toBe(-1)
    expect(getDetailBackDelta(sourceState, 'sets')).toBeNull()
    expect(getNextDetailNavigationState(sourceState, 'sets')).toBeUndefined()
  })
})
