import { expect, test } from '@playwright/test'

const USER = {
  id: 1,
  username: 'Visual Reviewer',
  role: 'admin',
  is_active: true,
  must_change_password: false,
}

const card = (index, overrides = {}) => ({
  id: `visual-card-${index}`,
  card_id: `visual-card-${index}`,
  name: index === 2 ? 'Pikachu with a deliberately long aligned card name' : `Visual card ${index}`,
  number: String(index).padStart(3, '0'),
  set_id: 'visual-set_en',
  set_name: 'Visual Set',
  set_ref: { id: 'visual-set_en', name: 'Visual Set', abbreviation: 'VIS' },
  rarity: index % 2 ? 'Illustration Rare' : 'Rare Holo',
  supertype: 'Pokemon',
  types: ['Lightning'],
  price_market: 4 + index,
  price_trend: 4 + index,
  variants_normal: true,
  variants_reverse: true,
  ...overrides,
})

const collection = Array.from({ length: 8 }, (_, offset) => {
  const index = offset + 1
  const variant = index % 3 === 0 ? 'Reverse Holo' : index % 2 === 0 ? 'Holo' : 'Normal'
  return {
    id: index,
    card_id: `visual-card-${index}`,
    quantity: index % 3 + 1,
    variant,
    condition: index % 2 ? 'NM' : 'Mint',
    lang: index % 4 === 0 ? 'de' : 'en',
    purchase_price: 2 + index / 2,
    added_at: `2026-07-${String(20 + index).padStart(2, '0')}T12:00:00`,
    card: card(index, index === 1 ? {
      custom_image_url: 'https://example.test/manual-card.webp',
    } : {}),
  }
})

const duplicates = collection.map(item => ({
  ...item.card,
  id: item.card_id,
  quantity: item.quantity + 1,
  total_value: (item.card.price_market || 0) * (item.quantity + 1),
}))

async function installApiFixtures(page) {
  const cardBackResponse = await page.request.get('/cardback.jpg')
  const cardBack = await cardBackResponse.body()

  await page.addInitScript(user => {
    localStorage.setItem('token', 'visual-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname

    // The Vite source path /src/api/client.js also matches the broad glob.
    // Only mock actual backend requests.
    if (!path.startsWith('/api/')) {
      await route.continue()
      return
    }

    if (path.startsWith('/api/images/card/')) {
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: cardBack })
      return
    }

    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': USER,
      '/api/settings/': {
        language: 'en',
        price_primary: 'trend',
        price_display: '["trend","avg","avg1","avg7","avg30","low"]',
        tcgdex_sync_languages: 'en,de',
        currency: 'EUR',
      },
      '/api/settings/tcgdex-filter-languages': ['en', 'de'],
      '/api/collection/': collection,
      '/api/wishlist/': [],
      '/api/sets/': [],
      '/api/analytics/duplicates': duplicates,
      '/api/analytics/top-movers': [],
      '/api/analytics/rarity-stats': [],
      '/api/analytics/investment-tracker': [],
      '/api/analytics/trades-summary': { trade_count: 0 },
      '/api/analytics/new-sets': [],
      '/api/products/': [],
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[path] ?? {}),
    })
  })
}

async function expectVisibleArtwork(page) {
  const artwork = page.locator('.unified-card-compact-artwork:visible')
  await expect(artwork.first()).toBeVisible()
  await expect.poll(async () => artwork.locator('img').evaluateAll(images => (
    images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)
  ))).toBe(true)
  await expect(artwork.locator('.unified-card-skeleton')).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await installApiFixtures(page)
})

test('real Collection list keeps shared artwork, identity, and fallback treatment', async ({ page }) => {
  await page.goto('/collection')
  await page.getByTitle('List view').click()
  await expectVisibleArtwork(page)

  await expect(page.locator(
    '.unified-card-frame[style*="--pc-card-border-image"]:visible',
  ).first()).toBeVisible()
  await expect(page.locator('main')).toHaveScreenshot('collection-list.png')
})

test('real Analytics duplicate list stays visually aligned with Collection', async ({ page }) => {
  await page.goto('/analytics')
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible()
  await expectVisibleArtwork(page)
  await expect(page.locator('main')).toHaveScreenshot('analytics-duplicates.png')
})
