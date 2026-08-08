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

const trades = [{
  id: 7,
  partner_name: 'Misty',
  trade_date: '2026-08-08',
  notes: 'Original trade note',
  outgoing_value: 9,
  incoming_value: 14,
  value_delta: 5,
  items: [
    {
      id: 71,
      trade_id: 7,
      direction: 'outgoing',
      card_id: collection[0].card_id,
      original_collection_item_id: collection[0].id,
      quantity: 1,
      value_per_card: 9,
      value_total: 9,
      card_name: collection[0].card.name,
      set_id: collection[0].card.set_id,
      card_number: collection[0].card.number,
      variant: collection[0].variant,
      condition: collection[0].condition,
      lang: collection[0].lang,
      notes: 'Outgoing note',
      card: collection[0].card,
    },
    {
      id: 72,
      trade_id: 7,
      direction: 'incoming',
      card_id: collection[1].card_id,
      created_collection_item_id: collection[1].id,
      quantity: 1,
      value_per_card: 14,
      value_total: 14,
      card_name: collection[1].card.name,
      set_id: collection[1].card.set_id,
      card_number: collection[1].card.number,
      variant: collection[1].variant,
      condition: collection[1].condition,
      lang: collection[1].lang,
      card: collection[1].card,
    },
  ],
}]

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
      '/api/trades/': trades,
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

test('trade history opens a prefilled edit draft and submits immutable values', async ({ page }) => {
  await page.goto('/trades')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('Misty')).toBeVisible()
  await page.getByRole('button', { name: 'Edit' }).click()

  await expect(page.locator('input[placeholder="Trade partner"]')).toHaveValue('Misty')
  await expect(page.getByText('Edit: #7')).toBeVisible()
  await expect(page.locator('input[type="number"]:disabled')).toHaveCount(2)

  // Adding the same card again must create a new row. The backend then gives
  // that row a current-value snapshot instead of extending the historical row.
  await page.getByRole('button', { name: 'Add' }).first().click()

  // The mobile review shortcut must not cover the final fields or save action.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.getByRole('button', { name: 'Review trade' })).toBeVisible()
  await page.locator('#trade-finalize').scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: 'Review trade' })).toBeHidden()

  const updateRequest = page.waitForRequest(request => (
    request.method() === 'PUT' && request.url().endsWith('/api/trades/7?price_field=price_trend')
  ))
  await page.locator('#trade-finalize').getByRole('button', { name: 'Save' }).click()
  const request = await updateRequest
  const payload = request.postDataJSON()

  expect(payload.outgoing[0]).toMatchObject({ trade_item_id: 71, quantity: 1, notes: 'Outgoing note' })
  expect(payload.outgoing[1]).toMatchObject({ collection_item_id: collection[0].id, quantity: 1 })
  expect(payload.outgoing).toHaveLength(2)
  expect(payload.incoming[0]).toMatchObject({ trade_item_id: 72, quantity: 1 })
  expect(payload.outgoing[0]).not.toHaveProperty('value_per_card')
  expect(payload.incoming[0]).not.toHaveProperty('value_per_card')
})
