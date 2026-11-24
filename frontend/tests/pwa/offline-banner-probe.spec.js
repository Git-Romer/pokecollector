import { expect, test } from '@playwright/test'

// iOS home-screen apps keep `navigator.onLine === true` in Airplane Mode and let requests hang.
// These tests never call context.setOffline(): only the reachability monitor can show the banner.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

// `state.mode`: 'online' answers, 'abort' fails at once, 'hang' never answers.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.mode === 'abort') return route.abort('connectionrefused')
    if (state.mode === 'hang') return undefined
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.startsWith('/api/images/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

async function signIn(page) {
  await page.addInitScript(account => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(account))
  }, ada)
}

test.describe('offline banner without a queue', () => {
  test('appears while the app is open when requests start hanging, clears on recovery', async ({ page, context }) => {
    const state = { mode: 'online' }
    await mockApi(context, state)
    await signIn(page)
    await page.goto('/collection')
    await expect(page.getByPlaceholder('Search cards...')).toBeVisible()
    await expect(page.getByTestId('offline-banner')).toHaveCount(0)

    state.mode = 'hang'
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    // A focus event stands in for the user returning to the app; the monitor probes without a queue.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 12000 })

    state.mode = 'online'
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByTestId('offline-banner')).toHaveCount(0, { timeout: 12000 })
  })

  test('appears within seconds of an offline launch with an empty outbox', async ({ page, context }) => {
    const state = { mode: 'online' }
    await mockApi(context, state)
    await signIn(page)
    await page.goto('/collection')
    await expect(page.getByText('Starting PokéCollector')).toHaveCount(0)
    await page.waitForTimeout(1500) // let the signed-in snapshot and first probe settle
    // The signed-in start saved a snapshot; relaunch with the network dead. (Requests fail fast
    // here: WebKit under Playwright never fires XHR timeouts for held requests; the hanging case
    // is covered by the test above, whose probe uses fetch with its own abort timer.)
    state.mode = 'abort'
    await page.reload()
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 15000 })

    state.mode = 'online'
    await expect(page.getByTestId('offline-banner')).toHaveCount(0, { timeout: 25000 })
  })
})
