import { expect, test } from '@playwright/test'

const admin = { id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

// `state.health`: 'down' (503) or 'up'. Everything else answers with empty data.
async function mockApi(context, state = { health: 'down' }) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') {
      return state.health === 'up' ? route.fulfill({ json: HEALTH_OK }) : route.fulfill({ status: 503, json: {} })
    }
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: state.user || admin })
    if (path === '/api/settings/') {
      state.settings ||= { language: 'en', currency: 'EUR' }
      if (route.request().method() === 'PUT') {
        const update = route.request().postDataJSON()
        Object.assign(state.settings, update)
        ;(state.settingWrites ||= []).push(update)
      }
      return route.fulfill({ json: state.settings })
    }
    if (['/api/settings/full_sync_interval_days', '/api/settings/price_sync_interval_minutes'].includes(path)) {
      const key = path.split('/').at(-1)
      state.intervals ||= { full_sync_interval_days: '5', price_sync_interval_minutes: '60' }
      if (route.request().method() === 'POST') state.intervals[key] = route.request().postDataJSON().value
      return route.fulfill({ json: { key, value: state.intervals[key] } })
    }
    if (path.startsWith('/api/sync') && route.request().method() === 'POST') {
      ;(state.syncWrites ||= []).push({ path, body: route.request().postData() ? route.request().postDataJSON() : null })
      return route.fulfill({ json: { status: 'started' } })
    }
    if (path === '/api/settings/scanner') return route.fulfill({ json: { provider: 'gemini', model: '', providers: [], request_timeout_seconds: 60 } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: Boolean(state.running), is_price_sync_running: false } })
    return route.fulfill({ json: [] })
  })
  return state
}

// Writes items straight into the outbox database the app created (waits for its stores).
async function seed(page, overrides) {
  await page.evaluate(async list => {
    const make = override => {
      const now = Date.now()
      return {
        id: crypto.randomUUID(),
        schema: 1,
        idempotencyKey: crypto.randomUUID(),
        serverOrigin: location.origin,
        userId: 1,
        type: 'wishlist.add',
        payload: { card_id: 'base1-4' },
        photoCount: 0,
        photoBytes: 0,
        state: 'pending',
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        retryCount: 0,
        serverErrorCount: 0,
        firstSentAt: null,
        lastAttemptAt: null,
        nextAttemptAt: 0,
        maybeApplied: false,
        claim: null,
        lastError: null,
        display: { title: 'Charizard', subtitle: '', imageUrl: null },
        appVersion: '',
        minApiLevel: 1,
        ...override,
      }
    }
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('pokecollector-outbox')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    let db = await open()
    for (let i = 0; i < 50 && !db.objectStoreNames.contains('items'); i += 1) {
      db.close()
      await new Promise(resolve => setTimeout(resolve, 100))
      db = await open()
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'meta'], 'readwrite')
      for (const override of list) tx.objectStore('items').put(make(override))
      // A page reloaded mid-sync leaves its 30 s lease behind; the next page would wait it out.
      tx.objectStore('meta').delete('lease')
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, Array.isArray(overrides) ? overrides : [overrides])
}

async function openApp(page) {
  await page.goto('/')
  await expect(page.getByText('Hello,')).toBeVisible()
}

const indicator = page => page.getByTestId('home-sync-button')
const failedError = { kind: 'http', status: 400, code: 'bad_request', message: 'Bad request', at: Date.now() }

// Pushes a client-side navigation without a reload (the outbox keeps its reachability state).
const navigate = (page, path) => page.evaluate(target => {
  history.pushState({}, '', target)
  dispatchEvent(new PopStateEvent('popstate'))
}, path)

test.describe('sync center', () => {
  test('server image cache deletion requires confirmation and preserves device image caches', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    let requests = 0
    await context.route('**/api/backup/clear-image-cache', route => {
      requests += 1
      return route.fulfill({ json: { message: 'Server image cache deleted', deleted_count: 3 } })
    })
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Data', exact: true }).click()
    const button = page.getByRole('button', { name: 'Delete server image cache', exact: false })
    await expect(button).toBeVisible()
    await page.evaluate(async () => {
      const cache = await caches.open('pc-collection-originals-v1')
      await cache.put('/cache-preservation-test.png', new Response('saved-device-artwork'))
    })
    await button.click()
    let dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('all users')
    await expect(dialog).toContainText('Offline downloads and original uploads are not deleted.')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(requests).toBe(0)
    await button.click()
    dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Delete server image cache', exact: true }).click()
    await expect.poll(() => requests).toBe(1)
    await expect(page.getByText('Server image cache deleted', { exact: true })).toBeVisible()
    expect(await page.evaluate(async () => (await (await caches.open('pc-collection-originals-v1')).match('/cache-preservation-test.png'))?.text())).toBe('saved-device-artwork')
  })

  for (const width of [390, 1280]) {
    test(`storage separates queued photos from total site usage at ${width}px`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.addInitScript(() => {
        Object.defineProperty(navigator.storage, 'estimate', {
          configurable: true,
          value: async () => ({ usage: 128 * 1024 * 1024, quota: 40 * 1024 * 1024 * 1024 }),
        })
      })
      await mockApi(context, { health: 'down' })
      await page.goto('/offline')
      await expect(page.getByTestId('offline-center')).toBeVisible()
      await expect(page.getByText('Storage', { exact: true })).toHaveCount(1)
      await expect(page.getByText('Photos waiting to upload: 0.0 MB', { exact: true })).toBeVisible()
      await expect(page.getByText('Total local storage used: 128.0 MB', { exact: true })).toBeVisible()
      await expect(page.getByText('Browser storage allowance: 40.0 GB', { exact: true })).toBeVisible()
      await expect(page.getByText("This is the browser's storage limit for this site, not your device's free space.", { exact: true })).toBeVisible()
      await seed(page, { type: 'scan.upload', photoCount: 1, photoBytes: 1024 * 1024 })
      await page.reload()
      await expect(page.getByText('Photos waiting to upload: 1.0 MB', { exact: true })).toBeVisible()
      await expect(page.getByText('Total local storage used: 128.0 MB', { exact: true })).toBeVisible()
    })
  }

  test('Back from a set detail restores the list offset instead of resetting it', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockApi(context, { health: 'up' })
    const sets = Array.from({ length: 40 }, (_, i) => ({
      id: `scroll-fixture-${i}_en`, name: `Scroll fixture ${i}`, lang: 'en',
      total: 10, owned_count: 0, progress: 0, release_date: '2020-01-01', series: 'Scroll fixtures',
    }))
    await context.route(url => url.pathname === '/api/sets/', route => route.fulfill({ json: sets }))
    await context.route(url => /^\/api\/sets\/scroll-fixture-\d+_en\/checklist$/.test(url.pathname), route => {
      const set = sets.find(s => route.request().url().includes(s.id + '/'))
      return route.fulfill({ json: { set, cards: [], owned_count: 0, total_count: 10, progress: 0 } })
    })
    await page.goto('/sets')
    const card = page.locator('[data-scroll-anchor]').nth(15)
    await expect(card).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await card.click()
    await expect(page).toHaveURL(/\/sets\/scroll-fixture-\d+_en$/)
    const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pokecollector:list-scroll:sets')).scrollY)
    expect(before).toBeGreaterThan(500)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    await page.goBack()
    await expect(page.locator('[data-scroll-list="sets"]')).toBeVisible()
    await expect.poll(() => page.evaluate(saved => Math.abs(window.scrollY - saved), before)).toBeLessThan(3)
  })

  test('fresh navigation resets scroll across pages without resetting local tabs', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockApi(context, { health: 'up' })
    await openApp(page)
    // Keep every destination tall enough that browser clamping cannot hide a missing reset.
    await page.evaluate(() => { document.body.style.minHeight = '3000px' })
    await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'instant' }))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700)
    await indicator(page).dispatchEvent('click')
    await expect(page).toHaveURL(/\/offline$/)
    await expect(page.getByTestId('offline-center')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    for (const destination of ['Settings', 'Card Search']) {
      await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'instant' }))
      await page.getByRole('button', { name: 'Navigation', exact: true }).click()
      await expect(page).toHaveURL(/\/$/)
      await expect(page.getByText('Hello,')).toBeVisible()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      await page.getByRole('button', { name: destination, exact: true }).dispatchEvent('click')
      await expect(page).toHaveURL(destination === 'Settings' ? /\/settings$/ : /\/search$/)
      await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      if (destination === 'Settings') {
        await page.evaluate(() => window.scrollTo({ top: 700, behavior: 'instant' }))
        await page.evaluate(() => {
          window.__tabScrollCalls = []
          const original = window.scrollTo.bind(window)
          window.scrollTo = (...args) => { window.__tabScrollCalls.push(args); original(...args) }
        })
        await page.getByRole('button', { name: 'Data', exact: true }).dispatchEvent('click')
        await expect(page.getByRole('button', { name: 'Backup', exact: true })).toBeVisible()
        expect(await page.evaluate(() => window.__tabScrollCalls)).toEqual([])
      }
    }
  })

  test('entering Settings from a scrolled Home page starts at the top', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockApi(context, { health: 'up' })
    await openApp(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('only the original red Home sync button opens the center without starting a job', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    const writes = []
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/sync') && request.method() === 'POST') writes.push(request.url())
    })
    await openApp(page)
    await expect(page.getByTestId('sync-indicator')).toHaveCount(0)
    const homeSync = page.getByTestId('home-sync-button')
    await expect(homeSync).toHaveCount(1)
    await expect(homeSync).toHaveCSS('color', 'rgb(227, 0, 11)')
    await homeSync.click()
    await expect(page).toHaveURL(/\/offline$/)
    await expect(page.getByTestId('offline-center')).toBeVisible()
    await expect(page.getByTestId('home-sync-button')).toHaveCount(0)
    expect(writes).toEqual([])
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await expect(page.getByTestId('home-sync-button')).toHaveCount(0)
    await expect(page.getByTestId('sync-indicator')).toHaveCount(0)
    await expect(page.locator('a[href="/offline"]')).toHaveCount(0)
  })

  test('the consolidated center fits a phone viewport', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockApi(context, { health: 'up' })
    await page.goto('/offline')
    await expect(page.getByTestId('collection-offline-download')).toBeVisible()
    await expect(page.getByTestId('server-sync-settings')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByTestId('server-sync-settings').getByRole('combobox', { name: 'Interval', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('moved admin controls use the existing sync and interval endpoints', async ({ page, context }) => {
    const state = await mockApi(context, { health: 'up' })
    await page.goto('/offline')
    const server = page.getByTestId('server-sync-settings')
    await server.getByRole('button', { name: 'Sync Sets & Cards', exact: true }).click({ timeout: 5000 })
    await expect.poll(() => state.syncWrites).toEqual([{ path: '/api/sync/', body: null }])
    await server.getByRole('button', { name: 'Sync Prices Only', exact: true }).click()
    await expect.poll(() => state.syncWrites?.length).toBe(2)
    expect(state.syncWrites[1]).toEqual({ path: '/api/sync/prices/all', body: null })
    await server.getByRole('combobox', { name: 'Interval', exact: true }).selectOption('7')
    await server.getByRole('combobox', { name: 'Automatic Small Sync Interval', exact: true }).selectOption('120')
    await expect.poll(() => state.intervals).toEqual({ full_sync_interval_days: '7', price_sync_interval_minutes: '120' })
    await expect.poll(() => state.syncWrites?.length).toBe(4)
    expect(state.syncWrites.slice(2)).toEqual([
      { path: '/api/sync/reschedule-full', body: { interval_days: 7 } },
      { path: '/api/sync/reschedule-prices', body: { interval_minutes: 120 } },
    ])
  })

  test('personal downloads remain available without exposing admin controls or requests', async ({ page, context }) => {
    await mockApi(context, { health: 'up', user: { ...admin, role: 'user' } })
    const administrativeReads = []
    page.on('request', request => {
      if (/\/api\/(settings\/(full_sync_interval_days|price_sync_interval_minutes)|cards\/custom-matches)/.test(request.url())) administrativeReads.push(request.url())
    })
    await openApp(page)
    await indicator(page).click()
    await expect(page.getByTestId('collection-offline-download')).toBeVisible()
    await expect(page.getByTestId('collection-offline-download').getByRole('switch')).not.toBeChecked()
    await expect(page.getByTestId('server-sync-settings')).toHaveCount(0)
    expect(administrativeReads).toEqual([])
  })

  test('running server jobs do not prevent opening the center', async ({ page, context }) => {
    await mockApi(context, { health: 'up', running: true })
    await openApp(page)
    await indicator(page).click()
    await expect(page.getByTestId('offline-center')).toBeVisible()
    const server = page.getByTestId('server-sync-settings')
    await expect(server.getByRole('button', { name: 'Sync Sets & Cards', exact: true })).toBeDisabled()
    await expect(server.getByRole('button', { name: 'Sync Prices Only', exact: true })).toBeDisabled()
  })

  test('server sync remains accessible when offline features are disabled', async ({ page, context }) => {
    await context.route(url => url.pathname === '/offline' || url.pathname === '/', async route => {
      const response = await route.fetch()
      return route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="pokecollector-pwa" content="sw=0;queue=0">') })
    })
    await mockApi(context, { health: 'up' })
    await openApp(page)
    await indicator(page).click()
    await expect(page.getByTestId('server-sync-settings')).toBeVisible()
    await expect(page.getByTestId('collection-offline-download')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Changes waiting on this device' })).toHaveCount(0)
  })

  test('offline downloads and shared sync controls move out of Settings without moving backups', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await expect(page.getByTestId('collection-offline-download')).toHaveCount(0)
    await page.getByRole('button', { name: 'Data', exact: true }).click()
    await expect(page.getByText('Download Backup', { exact: true })).toBeVisible()
    await expect(page.getByText('Export CSV', { exact: true })).toBeVisible()
    await expect(page.getByText('Sync Sets & Cards', { exact: true })).toHaveCount(0)
    await openApp(page)
    await indicator(page).click()
    await expect(page.getByTestId('collection-offline-download')).toBeVisible()
    await expect(page.getByTestId('server-sync-settings')).toBeVisible()
    await expect(page.getByText('Sync Sets & Cards', { exact: true })).toBeVisible()
    await expect(page.getByText('Sync Prices Only', { exact: true })).toBeVisible()
    await expect(page.getByText('Download Backup', { exact: true })).toHaveCount(0)
  })

  test('Home opens the center without starting a server sync', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    const writes = []
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/sync') && request.method() === 'POST') writes.push(request.url())
    })
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await openApp(page)
    await indicator(page).click({ timeout: 5000 })
    await expect(page).toHaveURL(/\/offline$/)
    await expect(page.getByTestId('offline-center')).toBeVisible()
    expect(writes).toEqual([])
  })

  test('the center remains discoverable with an empty queue and a reachable server', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await openApp(page)
    await expect(indicator(page)).toBeVisible()
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Sync')
    await expect(page.getByTestId('offline-banner')).toHaveCount(0)
  })

  test('failed queued changes are shown inside the center without another button', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await openApp(page)
    await seed(page, { state: 'failed', lastError: failedError })
    await page.reload()
    await expect(page.getByTestId('sync-indicator')).toHaveCount(0)
    await indicator(page).click()
    await expect(page.getByTestId('sync-item')).toHaveAttribute('data-state', 'failed')
    await expect(page.getByTestId('sync-item')).toContainText('Bad request')
  })

  test('center: Retry moves failed to pending, Discard asks first and removes', async ({ page, context }) => {
    await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, { state: 'failed', lastError: failedError })
    await page.reload()
    await indicator(page).click()

    const sheet = page.getByTestId('offline-center')
    const item = sheet.getByTestId('sync-item')
    await expect(item).toHaveAttribute('data-state', 'failed')
    await expect(item).toContainText('Bad request')
    await item.getByRole('button', { name: 'Retry' }).click()
    await expect(item).toHaveAttribute('data-state', 'pending')

    await item.getByRole('button', { name: 'Discard' }).click()
    const confirm = page.getByRole('dialog').filter({ hasText: 'cannot be recovered' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(item).toHaveCount(1)

    await item.getByRole('button', { name: 'Discard' }).click()
    await confirm.getByRole('button', { name: 'Discard' }).click()
    await expect(sheet.getByText('Everything is synced.')).toBeVisible()
  })

  test('banner appears after two failed probes and clears after one success', async ({ page, context }) => {
    const state = await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, { state: 'pending' })
    await page.reload()
    // The reachability monitor probes on its own, so the banner may already be up.
    await indicator(page).click()
    const syncNow = page.getByTestId('offline-center').getByRole('button', { name: 'Sync now' })
    // A click while the startup sync is still running is skipped, so retry until the second failed probe lands.
    await expect(async () => {
      await syncNow.click()
      await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 15000 })
    await expect(page.getByTestId('offline-banner')).toHaveAttribute('role', 'status')

    state.health = 'up'
    await syncNow.click()
    await expect(page.getByTestId('offline-banner')).toHaveCount(0)
  })

  test('pages that need the server show OfflineUnavailable while offline', async ({ page, context }) => {
    await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, { state: 'pending' })
    await page.reload()
    await indicator(page).click()
    const syncNow = page.getByTestId('offline-center').getByRole('button', { name: 'Sync now' })
    await expect(async () => {
      await syncNow.click()
      await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 15000 })
    await page.keyboard.press('Escape')

    await navigate(page, '/analytics')
    await expect(page.getByTestId('offline-unavailable')).toBeVisible()
    await expect(page.getByText('This page isn\'t available offline.')).toBeVisible()
    await navigate(page, '/collection')
    await expect(page.getByTestId('offline-unavailable')).toHaveCount(0)
    await navigate(page, '/offline')
    await expect(page.getByTestId('offline-center')).toBeVisible()
  })

  test('a device reporting offline shows the banner without waiting for probes', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await openApp(page)
    await seed(page, { state: 'pending' })
    await page.reload()
    await expect(indicator(page)).toBeVisible()
    await context.setOffline(true)
    await expect(page.getByTestId('offline-banner')).toBeVisible()
    await context.setOffline(false)
    await expect(page.getByTestId('offline-banner')).toHaveCount(0)
  })

  test('the Home server-status spinner respects prefers-reduced-motion', async ({ page, context }) => {
    await mockApi(context, { health: 'up', running: true })
    await openApp(page)
    await seed(page, { state: 'sending', claim: { owner: 'other:tab', expiresAt: Date.now() + 3600000 } })
    await page.reload()
    const animation = () => indicator(page).locator('svg').evaluate(node => getComputedStyle(node).animationName)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await animation()).toBe('spin')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await animation()).toBe('none')
  })

  test('keyboard navigation opens the center and discard confirmation traps focus', async ({ page, context }) => {
    await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, { state: 'failed', lastError: failedError })
    await page.reload()
    await indicator(page).focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/offline$/)
    const center = page.getByTestId('offline-center')
    await expect(center).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await center.getByTestId('sync-item').getByRole('button', { name: 'Discard' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button').first().focus()
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(center.getByTestId('sync-item')).toHaveCount(1)
    await page.goBack()
    await expect(page.getByText('Hello,')).toBeVisible()
  })

  test('items of another account are only counted', async ({ page, context }) => {
    await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, [{ state: 'pending' }, { userId: 99, state: 'pending', display: { title: 'Secret card' } }])
    await page.reload()
    await indicator(page).click()
    const sheet = page.getByTestId('offline-center')
    await expect(sheet.getByTestId('sync-item')).toHaveCount(1)
    await expect(sheet).not.toContainText('Secret card')
    await expect(sheet).toContainText('Items for other accounts are waiting on this device: 1')
  })

  test('/offline shows the connection and a reset button', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await page.goto('/offline')
    await expect(page.getByTestId('offline-center')).toBeVisible()
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'reachable')
    await expect(page.getByText('Server version: 1.51.6 (API 1)')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible()
  })
})
