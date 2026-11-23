import { copyFileSync, appendFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')
const admin = { id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: false }

async function mockApi(page) {
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: admin })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/analytics/investment-tracker') return route.fulfill({ json: [] })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    return route.fulfill({ json: {} })
  })
}

// The harness serves the real dist/ directory, so tests that swap dist/sw.js restore it afterwards.
test.afterEach(() => {
  copyFileSync(resolve(dist, 'sw.real.js'), resolve(dist, 'sw.js'))
})

async function waitForRegistration(page) {
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())), { timeout: 15000 }).toBe(true)
  await page.evaluate(() => navigator.serviceWorker.ready)
}

// Resolves once no registration and no pc-* cache exists at the same time. The wait is a poll
// because the kill worker and the page-side reset finish their cleanup asynchronously.
async function waitForCleanState(page) {
  await expect.poll(() => page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations()
    const names = (await caches.keys()).filter(name => name.startsWith('pc-'))
    return registrations.length === 0 && names.length === 0
  }), { timeout: 15000, intervals: [50] }).toBe(true)
}

// First load registers; after a reload the worker controls the page.
async function loadControlled(page) {
  await mockApi(page)
  await page.goto('/')
  await expect(page.getByText('Hello,')).toBeVisible()
  await waitForRegistration(page)
  await page.reload()
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  await expect(page.getByText('Hello,')).toBeVisible()
}

test('registers on first load, controls after reload and precaches every asset but no HTML', async ({ page }) => {
  await loadControlled(page)

  const cached = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith('pc-precache-'))
    const keys = await (await caches.open(names[0])).keys()
    return { names, urls: keys.map(request => new URL(request.url).pathname) }
  })
  expect(cached.names).toHaveLength(1)
  for (const file of readdirSync(resolve(dist, 'assets')).filter(name => !name.endsWith('.map'))) {
    expect(cached.urls).toContain(`/assets/${file}`)
  }
  expect(cached.urls).not.toContain('/index.html')
  expect(cached.urls).not.toContain('/robots.txt')
  expect(cached.urls).not.toContain('/')
})

test('renders the app shell offline instead of a blank page', async ({ page, context }) => {
  await loadControlled(page)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  // With the offline queue on a cached sign-in would open Home; this test is about the bare shell.
  await page.evaluate(() => localStorage.removeItem('pc.auth.snapshot'))
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Cannot reach PokéCollector' })).toBeVisible()
  await context.setOffline(false)
})

test('page API requests are not served by the service worker', async ({ page }) => {
  const apiResponses = []
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/api/')) apiResponses.push(response)
  })
  await loadControlled(page)
  expect(apiResponses.length).toBeGreaterThan(0)
  for (const response of apiResponses) expect(response.fromServiceWorker()).toBe(false)
})

test('shows the update banner and activates two consecutive workers after one reload each', async ({ page }) => {
  test.setTimeout(60000)
  await loadControlled(page)
  for (const update of [1, 2]) {
    appendFileSync(resolve(dist, 'sw.js'), `\n// byte-different update ${update}\n`)
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration()).update()
    })
    const banner = page.getByTestId('update-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('A new version is available.')

    await page.evaluate(() => { window.__beforeUpdate = true })
    await banner.getByRole('button', { name: 'Update' }).click()
    await page.waitForFunction(() => window.__beforeUpdate === undefined)
    await expect(page.getByText('Hello,')).toBeVisible()
    await expect(page.getByTestId('update-banner')).toHaveCount(0)
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      return { waiting: Boolean(registration.waiting), controlled: Boolean(navigator.serviceWorker.controller) }
    })
    expect(state).toEqual({ waiting: false, controlled: true })
  }
})

test('shows an updating screen after Update and offers a manual reload if nothing reloads', async ({ page }) => {
  await loadControlled(page)
  appendFileSync(resolve(dist, 'sw.js'), '\n// byte-different update\n')

  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration()).update()
  })
  const banner = page.getByTestId('update-banner')
  await expect(banner).toBeVisible()
  // Real layout, not class names: index.css makes #root's direct children position: relative,
  // which once overrode `fixed` and put this banner at the end of the page.
  expect(await banner.evaluate(el => getComputedStyle(el).position)).toBe('fixed')
  expect(await banner.evaluate(el => el.parentElement === document.body)).toBe(true)
  const box = await banner.boundingBox()
  expect(box.y).toBe(0)
  expect(box.y + box.height).toBeLessThan(page.viewportSize().height / 2)

  // Swallow controllerchange so the page does not reload and the updating screen stays visible.
  await page.evaluate(() => {
    const add = navigator.serviceWorker.addEventListener.bind(navigator.serviceWorker)
    navigator.serviceWorker.addEventListener = (type, ...rest) => (type === 'controllerchange' ? undefined : add(type, ...rest))
  })
  await page.clock.install()
  await banner.getByRole('button', { name: 'Update' }).click()

  const overlay = page.getByTestId('update-overlay')
  await expect(overlay).toBeVisible()
  await expect(overlay).toHaveAttribute('role', 'status')
  await expect(overlay).toHaveAttribute('aria-live', 'polite')
  // Full screen: covers the viewport whatever the page's scroll height.
  expect(await overlay.evaluate(el => getComputedStyle(el).position)).toBe('fixed')
  const cover = await overlay.boundingBox()
  expect(cover).toEqual({ x: 0, y: 0, width: page.viewportSize().width, height: page.viewportSize().height })
  await expect(overlay.locator('img.pokeball-loader')).toBeVisible()
  await expect(overlay).toContainText('Updating PokéCollector…')
  await expect(overlay).toContainText("Please don't close the app. It will reload on its own.")
  await expect(page.getByTestId('update-banner')).toHaveCount(0)
  await expect(overlay.getByRole('button', { name: 'Reload now' })).toHaveCount(0)

  await page.clock.fastForward(16000)
  await expect(overlay.getByRole('button', { name: 'Reload now' })).toBeVisible()
})

test('kill switch removes the registration and pc-* caches but leaves IndexedDB alone', async ({ page }) => {
  await loadControlled(page)
  await page.evaluate(() => new Promise((resolveDb, reject) => {
    const open = indexedDB.open('pc-test-db', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keep')
    open.onsuccess = () => { open.result.close(); resolveDb() }
    open.onerror = () => reject(open.error)
  }))

  copyFileSync(resolve(dist, 'sw.kill.js'), resolve(dist, 'sw.js'))
  // The kill worker navigates its clients after clearing caches and unregistering.
  // Subscribe before update so the IndexedDB assertion runs in the new document.
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration()).update()
    }),
  ])

  await waitForCleanState(page)
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))
  expect(databases).toContain('pc-test-db')
})

test('/?pc_sw=off unregisters the worker and strips the parameter', async ({ page }) => {
  await loadControlled(page)
  await page.goto('/?pc_sw=off')
  await page.waitForFunction(() => !location.search.includes('pc_sw'))
  await waitForCleanState(page)
  expect(new URL(page.url()).search).toBe('')
  await page.waitForTimeout(3500)
  await waitForCleanState(page)
  await page.reload()
  await waitForRegistration(page)
})
