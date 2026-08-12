import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  enableManualHistoryScrollRestoration,
  getDetailBackDelta,
  getNextDetailNavigationState,
  getSavedListScrollPosition,
  isListScrollSurfaceVisible,
  isSavedPositionForLocation,
  releaseManualHistoryScrollRestoration,
  restoreListScrollPosition,
  saveListScrollPosition,
  scheduleManualHistoryScrollRestorationRelease,
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

describe('browser history restoration', () => {
  it('temporarily disables native restoration during a detail return', () => {
    const browserHistory = { scrollRestoration: 'auto' }

    const restore = enableManualHistoryScrollRestoration(browserHistory)
    expect(browserHistory.scrollRestoration).toBe('manual')

    restore()
    expect(browserHistory.scrollRestoration).toBe('auto')
  })

  it('keeps restoration manual across repeated detail effect setup', () => {
    const browserHistory = { scrollRestoration: 'auto' }

    enableManualHistoryScrollRestoration(browserHistory)
    enableManualHistoryScrollRestoration(browserHistory)
    expect(browserHistory.scrollRestoration).toBe('manual')

    releaseManualHistoryScrollRestoration()
    expect(browserHistory.scrollRestoration).toBe('auto')
  })

  it('ignores history implementations without restoration support', () => {
    const browserHistory = {}
    expect(() => enableManualHistoryScrollRestoration(browserHistory)()).not.toThrow()
  })

  it('does not let an earlier route release a later detail session', () => {
    const browserHistory = { scrollRestoration: 'auto' }
    let scheduledCallback = null
    const browserWindow = {
      setTimeout: (callback) => {
        scheduledCallback = callback
        return 1
      },
      clearTimeout: () => { scheduledCallback = null },
    }

    scheduleManualHistoryScrollRestorationRelease(1000, browserWindow)
    enableManualHistoryScrollRestoration(browserHistory)
    scheduledCallback?.()

    expect(browserHistory.scrollRestoration).toBe('manual')
    releaseManualHistoryScrollRestoration()
  })

  it('detects only a visibly committed list surface', () => {
    const hiddenSurface = { getClientRects: () => [] }
    const visibleSurface = { getClientRects: () => [{ width: 390, height: 844 }] }
    const browserDocument = {
      querySelector: (selector) => selector === '[data-scroll-list="sets"]' ? hiddenSurface : null,
    }

    expect(isListScrollSurfaceVisible('sets', browserDocument)).toBe(false)
    browserDocument.querySelector = () => visibleSurface
    expect(isListScrollSurfaceVisible('sets', browserDocument)).toBe(true)
  })
})

describe('restoring a saved list position', () => {
  it('restores the exact offset before the list becomes interactive', () => {
    const scrollTo = (...args) => {
      fakeWindow.scrollY = args[0].top
      fakeWindow.lastScroll = args[0]
    }
    const fakeWindow = { scrollY: 0, scrollTo }
    const fakeDocument = { getElementById: () => null }

    restoreListScrollPosition({ scrollY: 640, anchorId: 'set-me04_de' }, fakeWindow, fakeDocument)

    expect(fakeWindow.lastScroll).toEqual({ top: 640, left: 0, behavior: 'auto' })
  })

  it('uses the saved anchor when the browser clamps the offset', () => {
    let anchorOptions = null
    const fakeWindow = { scrollY: 100, scrollTo: () => {} }
    const fakeDocument = {
      getElementById: (id) => id === 'set-me04_de'
        ? { scrollIntoView: options => { anchorOptions = options } }
        : null,
    }

    restoreListScrollPosition({ scrollY: 640, anchorId: 'set-me04_de' }, fakeWindow, fakeDocument)

    expect(anchorOptions).toEqual({ block: 'center', behavior: 'auto' })
  })
})
