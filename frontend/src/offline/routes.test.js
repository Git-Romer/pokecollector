import { describe, expect, it } from 'vitest'
import { isOfflineRoute, OFFLINE_ROUTES } from './routes.js'

describe('isOfflineRoute', () => {
  it('accepts every listed static route', () => {
    for (const path of ['/', '/dashboard', '/collection', '/wishlist', '/sets', '/binders', '/search', '/offline']) {
      expect(isOfflineRoute(path)).toBe(true)
    }
  })

  it('accepts parameterised routes with one segment', () => {
    expect(isOfflineRoute('/sets/base1')).toBe(true)
    expect(isOfflineRoute('/binders/42')).toBe(true)
    expect(isOfflineRoute('/sets/base1/extra')).toBe(false)
    expect(isOfflineRoute('/binders//')).toBe(false)
  })

  it('ignores a trailing slash', () => {
    expect(isOfflineRoute('/collection/')).toBe(true)
    expect(isOfflineRoute('/sets/base1/')).toBe(true)
    expect(isOfflineRoute('/offline/')).toBe(true)
  })

  it('rejects everything else', () => {
    for (const path of ['/analytics', '/settings', '/scans', '/collection/user/3', '/pokedex', '/collections', '', undefined]) {
      expect(isOfflineRoute(path)).toBe(false)
    }
  })

  it('lists the routes of the design document', () => {
    expect(OFFLINE_ROUTES).toHaveLength(10)
  })
})
