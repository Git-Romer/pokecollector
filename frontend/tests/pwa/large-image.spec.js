import { expect, test } from '@playwright/test'

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const card = {
  id: 'big-0_en',
  card_id: 'big-0_en',
  name: 'Largeimage Probe',
  number: '001',
  set_id: 'big-set_en',
  set_name: 'Big Set',
  set_ref: { id: 'big-set_en', name: 'Big Set', abbreviation: 'BIG' },
  rarity: 'Common',
  supertype: 'Pokemon',
  types: ['Lightning'],
  attacks: [],
  price_market: 1,
  price_trend: 1,
  variants_normal: true,
}
const collection = [{
  id: 1, card_id: card.id, quantity: 1, variant: 'Normal', condition: 'NM', lang: 'en',
  added_at: '2026-09-12T12:00:00', card,
}]

// Only the small image exists on the "server": the large one has never been opened online.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.offline) return route.abort('connectionfailed')
    const path = new URL(route.request().url()).pathname
    if (path === '/api/images/card/big-0_en/small') {
      return route.fulfill({ status: 200, body: PNG, headers: { 'Content-Type': 'image/png' } })
    }
    if (path.startsWith('/api/images/')) return route.fulfill({ status: 404, json: {} })
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/collection/') return route.fulfill({ json: collection })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR', offline_collection_enabled: 'true' } })
    if (path === '/api/collection/offline-manifest') return route.fulfill({ json: { version: 1, user_id: 1, items: collection, image_urls: [], missing_artwork_card_ids: [] } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    return route.fulfill({ json: [] })
  })
}

test('offline, the card detail shows the cached small image instead of a broken one', async ({ page, context }) => {
  const state = { offline: false }
  await mockApi(context, state)
  await page.addInitScript(account => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(account))
  }, ada)
  await page.goto('/collection')
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())), { timeout: 15000 }).toBe(true)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const grid = page.locator('img[src*="/api/images/card/big-0_en/small"]').first()
  await expect(grid).toBeVisible()
  await expect.poll(() => grid.evaluate(img => img.naturalWidth)).toBeGreaterThan(0)
  // The worker stores the small copy asynchronously.
  await expect.poll(() => page.evaluate(async () => {
    const hit = await (await caches.open('pc-images-v1')).match('/api/images/card/big-0_en/small')
    return Boolean(hit)
  })).toBe(true)

  state.offline = true
  await page.getByRole('button', { name: 'Largeimage Probe' }).click()

  const detail = page.locator('img[src*="/api/images/card/big-0_en/large"]').first()
  await expect(detail).toBeVisible()
  await expect.poll(() => detail.evaluate(img => img.complete && img.naturalWidth)).toBeGreaterThan(0)
})
