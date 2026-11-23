import { expect, test } from '@playwright/test'

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const bob = { id: 2, username: 'bob', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
const NAMES = ['Alpha Saved Card', 'Beta Saved Card', 'Gamma Saved Card']

const card = (name, index) => ({
  id: `saved-${index}_en`,
  card_id: `saved-${index}_en`,
  name,
  number: String(index + 1).padStart(3, '0'),
  set_id: 'saved-set_en',
  set_name: 'Saved Set',
  set_ref: { id: 'saved-set_en', name: 'Saved Set', abbreviation: 'SAV' },
  rarity: 'Common',
  supertype: 'Pokemon',
  types: ['Lightning'],
  attacks: [],
  price_market: 1,
  price_trend: 1,
  variants_normal: true,
})

const collection = NAMES.map((name, index) => ({
  id: index + 1,
  card_id: `saved-${index}_en`,
  quantity: 1,
  variant: 'Normal',
  condition: 'NM',
  lang: 'en',
  added_at: '2026-09-12T12:00:00',
  card: card(name, index),
}))

// `state.offline` aborts every API request; `state.user` answers /api/auth/me.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.offline) return route.abort('connectionrefused')
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: state.user })
    if (path === '/api/collection/') return route.fulfill({ json: state.user.id === ada.id ? collection : [] })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR', offline_collection_enabled: 'true' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.startsWith('/api/images/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

async function signIn(page, user) {
  await page.addInitScript(({ account, force }) => {
    if (force || !sessionStorage.getItem('pc-test-seeded')) {
      sessionStorage.setItem('pc-test-seeded', '1')
      localStorage.setItem('token', 'test-token')
      localStorage.setItem('user', JSON.stringify(account))
    }
  }, { account: user, force: false })
}

// The saved record of `userId` in the read-cache database (null when absent).
const readRecord = (page, userId) => page.evaluate(async id => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pokecollector-readcache')
    request.onupgradeneeded = () => request.result.createObjectStore('qc')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const record = await new Promise((resolve, reject) => {
    const request = db.transaction('qc').objectStore('qc').get(`${location.origin}|${id}`)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return record ? { queries: record.state.queries.map(query => query.queryKey[0]) } : null
}, userId)

// The record is written 5 s after the first successful fetch.
async function waitForRecord(page, userId) {
  await expect(async () => {
    const record = await readRecord(page, userId)
    expect(record?.queries).toContain('collection')
  }).toPass({ timeout: 20000 })
}

async function viewCollectionOnline(page, context, user) {
  const state = { offline: false, user }
  await mockApi(context, state)
  await signIn(page, user)
  await page.goto('/collection')
  for (const name of NAMES) await expect(page.getByText(name).first()).toBeVisible()
  await waitForRecord(page, user.id)
  return state
}

test.describe('read cache', () => {
  test('a viewed collection reopens offline with the saved-data label and the banner', async ({ page, context }) => {
    const state = await viewCollectionOnline(page, context, ada)

    state.offline = true
    await page.reload()
    for (const name of NAMES) await expect(page.getByText(name).first()).toBeVisible()
    await expect(page.getByTestId('stale-data-label')).toContainText('Showing saved data from')
    await context.setOffline(true)
    await expect(page.getByTestId('offline-banner')).toBeVisible()
    await context.setOffline(false)
  })

  test('a page that is not available offline still shows OfflineUnavailable', async ({ page, context }) => {
    const state = await viewCollectionOnline(page, context, ada)
    state.offline = true
    await page.reload()
    await expect(page.getByTestId('stale-data-label')).toBeVisible()
    // Open the page while the file server still answers: its code is loaded on demand, and a
    // failed chunk load makes the app reload itself once, which would destroy the page under test.
    await page.evaluate(() => {
      history.pushState({}, '', '/trades')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page).toHaveURL(/trades$/)
    await expect(page.getByRole('heading').first()).toBeVisible()
    await context.setOffline(true)
    // The device event shows the banner at once; both checks wait for that state, not for a delay.
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('offline-unavailable')).toBeVisible()
    await context.setOffline(false)
  })

  test('logout removes the saved record', async ({ page, context }) => {
    await viewCollectionOnline(page, context, ada)
    await page.getByRole('button', { name: 'Logout', exact: true }).click()
    await page.waitForURL('**/login')
    await expect(async () => expect(await readRecord(page, ada.id)).toBeNull()).toPass({ timeout: 10000 })
  })

  test('another user on the same device never sees the first user\'s data', async ({ page, context }) => {
    const state = await viewCollectionOnline(page, context, ada)
    expect(await readRecord(page, ada.id)).not.toBeNull()

    // Same browser profile, different account: the first record is purged once bob is known.
    state.user = bob
    await page.evaluate(account => {
      localStorage.setItem('user', JSON.stringify(account))
    }, bob)
    await page.goto('/')
    await expect(page.getByText('Hello,')).toBeVisible()
    await expect(async () => expect(await readRecord(page, ada.id)).toBeNull()).toPass({ timeout: 10000 })

    state.offline = true
    await page.goto('/collection')
    for (const name of NAMES) await expect(page.getByText(name)).toHaveCount(0)
    await expect(page.getByTestId('stale-data-label')).toHaveCount(0)
  })
})
