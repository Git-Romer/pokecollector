import { expect, test } from '@playwright/test'

const admin = {
  id: 1,
  username: 'admin',
  role: 'admin',
  avatar_id: null,
  must_change_password: false,
}

async function mockAppApi(page, authHandler) {
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url())

    if (url.pathname === '/api/auth/mode' || url.pathname === '/api/auth/me') {
      return authHandler(route, url.pathname)
    }
    if (url.pathname === '/api/settings/') {
      return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    }
    if (url.pathname === '/api/settings/exchange-rate') {
      return route.fulfill({ json: { rate: 1 } })
    }
    if (url.pathname === '/api/dashboard/') {
      return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    }
    if (url.pathname === '/api/sync/status') {
      return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    }
    if (url.pathname === '/api/cards/recognize/jobs') {
      return route.fulfill({ json: { jobs: [] } })
    }
    if (url.pathname === '/api/analytics/investment-tracker') {
      return route.fulfill({ json: [] })
    }
    return route.fulfill({ json: {} })
  })
}

test('waits for a delayed single-user backend and recovers automatically', async ({ page }) => {
  let modeRequests = 0
  await mockAppApi(page, async (route, path) => {
    if (path === '/api/auth/mode') {
      modeRequests += 1
      // React StrictMode runs the initial effect twice in the development
      // server. Keep both initial requests unavailable, then allow the retry.
      if (modeRequests <= 2) {
        return route.fulfill({ status: 503, json: { detail: 'Starting' } })
      }
      return route.fulfill({ json: { multi_user: false, locked: false } })
    }
    return route.fulfill({ json: admin })
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Cannot reach PokéCollector' })).toBeVisible()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'Login' })).toHaveCount(0)

  await expect(page.getByText('Hello,')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('admin', { exact: true })).toBeVisible()
  await expect(page).toHaveURL('/')
  expect(modeRequests).toBeGreaterThanOrEqual(3)
})

test('keeps a valid stored session through a temporary current-user failure', async ({ page }) => {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'valid-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, admin)

  let userRequests = 0
  await mockAppApi(page, async (route, path) => {
    if (path === '/api/auth/mode') {
      return route.fulfill({ json: { multi_user: true, locked: false } })
    }
    userRequests += 1
    if (userRequests <= 2) {
      return route.fulfill({ status: 503, json: { detail: 'Starting' } })
    }
    return route.fulfill({ json: admin })
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Cannot reach PokéCollector' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('valid-token')

  await expect(page.getByText('Hello,')).toBeVisible({ timeout: 5_000 })
  await expect(page).toHaveURL('/')
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('valid-token')
})

test('still shows login for genuine multi-user mode', async ({ page }) => {
  await mockAppApi(page, async (route, path) => {
    if (path === '/api/auth/mode') {
      return route.fulfill({ json: { multi_user: true, locked: false } })
    }
    return route.fulfill({ status: 401, json: { detail: 'Not authenticated' } })
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible()
  await expect(page).toHaveURL('/login')
})

test('clears an expired session only after the backend confirms it', async ({ page }) => {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'expired-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, admin)

  await mockAppApi(page, async (route, path) => {
    if (path === '/api/auth/mode') {
      return route.fulfill({ json: { multi_user: true, locked: false } })
    }
    return route.fulfill({ status: 401, json: { detail: 'Not authenticated' } })
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible()
  await expect(page).toHaveURL('/login')
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('user'))).toBeNull()
})

test('connection state fits a 320px viewport and supports manual retry', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  let available = false
  await mockAppApi(page, async (route, path) => {
    if (path === '/api/auth/mode') {
      if (!available) return route.fulfill({ status: 503, json: { detail: 'Starting' } })
      return route.fulfill({ json: { multi_user: false, locked: false } })
    }
    return route.fulfill({ json: admin })
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Cannot reach PokéCollector' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  available = true
  await page.getByRole('button', { name: 'Try again' }).click()

  await expect(page.getByText('Hello,')).toBeVisible()
  await expect(page).toHaveURL('/')
})
