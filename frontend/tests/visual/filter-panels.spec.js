import { expect, test } from '@playwright/test'

const USER = {
  id: 1,
  username: 'Filter Reviewer',
  role: 'admin',
  is_active: true,
  must_change_password: false,
}

const CARD = {
  id: 'filter-card_en',
  card_id: 'filter-card_en',
  name: 'Filter Card',
  number: '001',
  set_id: 'filter-set_en',
  set_name: 'Filter Set',
  set_ref: { id: 'filter-set_en', name: 'Filter Set', abbreviation: 'FLT' },
  rarity: 'Rare Holo',
  supertype: 'Pokemon',
  types: ['Lightning'],
  lang: 'en',
  price_trend: 10,
  variants_normal: true,
}

const COLLECTION_ITEM = {
  id: 1,
  card_id: CARD.id,
  quantity: 1,
  variant: 'Normal',
  condition: 'NM',
  lang: 'en',
  added_at: '2026-09-12T12:00:00',
  card: CARD,
}

async function installFilterApi(page) {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'filter-panel-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (!path.startsWith('/api/')) return route.continue()

    if (path.startsWith('/api/images/card/')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="14"><rect width="10" height="14" fill="#222"/></svg>',
      })
    }
    if (path === '/api/settings/' && request.method() !== 'GET') {
      return route.fulfill({ json: request.postDataJSON() || {} })
    }
    if (path === '/api/collection/user/2') {
      return route.fulfill({ json: [COLLECTION_ITEM] })
    }
    if (path === '/api/binders/1/cards') {
      return route.fulfill({
        json: {
          binder: { id: 1, name: 'Filter Binder', binder_type: 'wishlist', color: '#ef4444' },
          cards: [{
            ...CARD,
            binder_card_id: 1,
            set_name: 'Filter Set',
            required_quantity: 2,
            owned_quantity: 1,
            missing_quantity: 1,
            quantity: 1,
            price_market: 10,
            card: CARD,
          }],
          owned_count: 1,
          total_count: 2,
          total_required_count: 2,
          missing_count: 1,
          unique_count: 1,
          binder_value: 20,
          current_value: 10,
          cost_to_complete: 10,
          unavailable_collection_item_ids: [],
          available_collection_item_quantities: {},
        },
      })
    }

    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': USER,
      '/api/settings/': {
        language: 'en',
        price_primary: 'trend',
        price_display: '["trend"]',
        tcgdex_sync_languages: 'en',
        currency: 'EUR',
        set_overview_filters: '',
        hidden_set_ids: '[]',
      },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/wishlist/': [{
        id: 1,
        card_id: CARD.id,
        quantity: 1,
        price_alert_above: 12,
        created_at: '2026-09-12T12:00:00',
        card: CARD,
      }],
      '/api/products/': [{
        id: 1,
        product_name: 'Filter Booster Box',
        product_type: 'Booster Box',
        purchase_price: 100,
        current_value: 120,
        computed_current_value: 120,
        purchase_date: '2026-09-01',
        lifecycle_status: 'sealed',
        pnl: 20,
        pnl_percent: 20,
        linked_live_value: 0,
        realized_gains: 0,
        linked_cards_count: 0,
        active_linked_cards_count: 0,
        sold_linked_cards_count: 0,
        product_cards: [],
        ledger_entries: [],
      }],
      '/api/products/summary': { by_type: [] },
      '/api/collection/': [COLLECTION_ITEM],
      '/api/sets/': [
        { id: 'filter-set_en', name: 'Filter Set', series: 'Filter Series', lang: 'en', total: 100, owned_count: 10 },
        { id: 'other-set_en', name: 'Other Set', series: 'Other Series', lang: 'en', total: 100, owned_count: 0 },
      ],
      '/api/cards/custom': [],
      '/api/cards/recognize/jobs': { jobs: [] },
      '/api/binders/': [],
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
}

async function expectAppliedHistory(page, parameter, value) {
  await expect(page).toHaveURL(url => url.searchParams.get(parameter) === value)
  await page.goBack()
  await expect(page).toHaveURL(url => !url.searchParams.has(parameter))
  await page.goForward()
  await expect(page).toHaveURL(url => url.searchParams.get(parameter) === value)
}

test.beforeEach(async ({ page }) => {
  await installFilterApi(page)
})

test('Wishlist keeps panel changes in a draft until Apply', async ({ page }) => {
  await page.goto('/wishlist')
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.locator('#wishlist-filter-set').selectOption('filter-set_en')
  await expect(page).not.toHaveURL(/(?:\?|&)set=/)
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.locator('#wishlist-filter-set')).toHaveValue('')
  await page.locator('#wishlist-filter-set').selectOption('filter-set_en')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).not.toHaveURL(/(?:\?|&)set=/)
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.locator('#wishlist-filter-set').selectOption('filter-set_en')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expectAppliedHistory(page, 'set', 'filter-set_en')
})

test('Products keeps panel changes in a draft until Apply', async ({ page }) => {
  await page.goto('/products')
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.locator('#products-filter-type').selectOption('Booster Box')
  await expect(page).not.toHaveURL(/(?:\?|&)type=/)
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.locator('#products-filter-type')).toHaveValue('')
  await page.locator('#products-filter-type').selectOption('Booster Box')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.locator('#products-filter-type').selectOption('Booster Box')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expectAppliedHistory(page, 'type', 'Booster Box')
})

test('public collections keep panel changes in a draft until Apply', async ({ page }) => {
  await page.goto('/collection/user/2')
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.locator('#public-collection-filter-rarity').selectOption('Rare Holo')
  await expect(page).not.toHaveURL(/(?:\?|&)rarity=/)
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.locator('#public-collection-filter-rarity')).toHaveValue('')
  await page.locator('#public-collection-filter-rarity').selectOption('Rare Holo')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.locator('#public-collection-filter-rarity').selectOption('Rare Holo')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expectAppliedHistory(page, 'rarity', 'Rare Holo')
})

test('binder contents keep panel changes in a draft until Apply', async ({ page }) => {
  await page.goto('/binders/1')
  await page.getByLabel('All statuses').selectOption('missing')
  await expect(page).not.toHaveURL(/binder_status=/)
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.getByLabel('All statuses')).toHaveValue('')
  await page.getByLabel('All statuses').selectOption('missing')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByLabel('All statuses')).toHaveValue('')
  await page.getByLabel('All statuses').selectOption('missing')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page).toHaveURL(/binder_status=missing/)
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await page.goBack()
  await expect(page).not.toHaveURL(/binder_status=/)
  await page.goForward()
  await expect(page).toHaveURL(/binder_status=missing/)
})

test('Sets applies panel filters while quick search remains immediate', async ({ page }) => {
  await page.goto('/sets')
  const series = page.getByLabel('All Series')
  await series.selectOption('Filter Series')
  await expect(page).not.toHaveURL(/(?:\?|&)series=/)
  await expect(page.getByText('Other Set', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(series).toHaveValue('')
  await series.selectOption('Filter Series')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(series).toHaveValue('')
  await series.selectOption('Filter Series')

  await page.getByPlaceholder('Filter sets...').fill('Filter Set')
  await expect(page.getByText('Other Set', { exact: true })).toHaveCount(0)
  await expect(page).not.toHaveURL(/(?:\?|&)series=/)

  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expectAppliedHistory(page, 'series', 'Filter Series')
})
