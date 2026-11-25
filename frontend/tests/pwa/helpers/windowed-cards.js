import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const fixtureErrors = new WeakMap()
export const cardArtwork = readFileSync(new URL('../../../public/cardback.jpg', import.meta.url))
export function expectNoCardPageErrors(page) {
  expect(fixtureErrors.get(page) ?? []).toEqual([])
}

export async function collectionFixture(page, { holo = false, readySelector = '.unified-card-caption', routePath = '/collection', extraResponses = () => ({}), artworkRoute = null } = {}) {
  const user = { id: 1, username: 'Fixture owner', role: 'admin', must_change_password: false }
  await page.addInitScript(user => {
    localStorage.setItem('token', 'window-fixture')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, user)
  const items = Array.from({ length: 2000 }, (_, n) => ({
    id: n + 1, card_id: `window-${n}_en`, quantity: 1, condition: 'NM', variant: 'Holo', lang: 'en', printing_details: [], added_at: `2026-01-01T00:00:00`,
    card: { id: `window-${n}_en`, tcg_card_id: `window-${n}`, lang: 'en', name: `Window card ${String(n).padStart(4, '0')}`, number: `${n}`, category: 'Pokemon', rarity: 'Rare Holo', images_small: 'https://example.invalid/small.webp', images_large: 'https://example.invalid/large.webp', set_id: 'window_en', set_ref: { id: 'window_en', name: 'Window set' } },
  }))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/fingerprint')) return route.fulfill({ json: { tcgCardId: path.split('/').at(-2).replace('_en', ''), language: 'en', sha256: 'a'.repeat(64) } })
    if (path.startsWith('/api/images/')) return artworkRoute ? artworkRoute(route) : route.fulfill({ body: cardArtwork, contentType: 'image/jpeg' })
    const responses = {
      '/api/health': { status: 'ok', service: 'pokemon-tcg-collection', api_level: 1, features: ['idempotency-v1'] },
      '/api/auth/mode': { multi_user: true }, '/api/auth/me': user,
      '/api/settings/': { language: 'en', currency: 'EUR', offline_collection_enabled: 'false', holo_effects_enabled: 'true' },
      '/api/settings/exchange-rate': { rate: 1 }, '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/collection/': items, '/api/wishlist/': [], '/api/sets/': [], '/api/binders/': [],
      ...extraResponses(items),
      '/api/dashboard/': { recent_additions: [], top_cards: [] }, '/api/sync/status': {},
    }
    return route.fulfill({ json: responses[path] ?? [] })
  })
  const errors = []
  fixtureErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
  // Holo stays enabled in settings, but ordinary card fixtures have no published
  // designs. Mock the cross-origin publisher too, including its CORS response.
  // The explicit Holo fixture below overrides this route with verified assets.
  await page.route('**/api/holo/list', route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { schemaVersion: 1, entries: [] },
  }))
  if (holo) {
    // Explicitly mocked publisher, real hash-verified PNG bytes and motion engine.
    const png = readFileSync(new URL('../../../public/holo-effects/textures/geometric.png', import.meta.url))
    const sha256 = createHash('sha256').update(png).digest('hex')
    const version = 'r1-00000000-0000-4000-8000-000000000001'
    const design = { cardId: 'window-0', language: 'en', finish: 'holo', foilProfile: 'swholo', baseImageSha256: 'a'.repeat(64), revision: 1, version }
    const asset = role => ({ bytes: png.length, mime: 'image/png', sha256, path: `/api/holo/versions/${version}/assets/${role}` })
    await page.route('**/api/holo/**', route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/list')) return route.fulfill({ json: { schemaVersion: 1, entries: [design] } })
      if (path.endsWith('/current')) {
        const { baseImageSha256, ...current } = design
        return route.fulfill({ json: { ...current, publishedAt: '2026-01-01T00:00:00Z', manifestUrl: `/api/holo/versions/${version}/manifest` } })
      }
      if (path.endsWith('/manifest')) return route.fulfill({ json: { ...design, schemaVersion: 1, assets: { mask: asset('mask'), foilMap: asset('foilMap') } } })
      return route.fulfill({ body: png, contentType: 'image/png' })
    })
  }
  await page.goto(routePath)
  await expect(page.locator(readySelector).first()).toBeAttached({ timeout: 30000 })
  expect(errors).toEqual([])
}
