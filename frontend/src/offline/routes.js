// Routes that still make sense without a connection (docs/PWA_OFFLINE_DESIGN.md §6.4.1).
// Everything else shows <OfflineUnavailable/> while the server is unreachable.

export const OFFLINE_ROUTES = Object.freeze([
  '/',
  '/dashboard',
  '/collection',
  '/wishlist',
  '/sets',
  '/sets/:setId',
  '/binders',
  '/binders/:binderId',
  '/search', // the scanner only; its search results still need the server
  '/offline',
])

function toRegExp(pattern) {
  const source = pattern
    .split('/')
    .map(segment => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${source}/?$`)
}

const MATCHERS = OFFLINE_ROUTES.map(toRegExp)

/** True for `/collection`, `/collection/`, `/sets/base1`; false for `/sets/base1/extra`. */
export function isOfflineRoute(pathname) {
  const path = String(pathname || '')
  return MATCHERS.some(matcher => matcher.test(path))
}
