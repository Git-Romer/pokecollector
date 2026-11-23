import { copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const ORIGIN = 'http://127.0.0.1:4175'
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist')
const admin = { id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: false }

test.afterEach(() => {
  copyFileSync(resolve(dist, 'sw.real.js'), resolve(dist, 'sw.js'))
})

async function mockApi(page, pushRequests) {
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/push/')) pushRequests.push(`${route.request().method()} ${path}`)
    if (path === '/api/health') return route.fulfill({ json: {
      status: 'ok', service: 'pokemon-tcg-collection', version: '1.57.9',
      api_level: 1, features: ['idempotency-v1'],
    } })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: admin })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/push/vapid-public-key') return route.fulfill({ json: { public_key: 'AAAA' } })
    if (path === '/api/settings/scanner') return route.fulfill({ json: { provider: 'none', providers: [], request_timeout_seconds: 60 } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    return route.fulfill({ json: {} })
  })
}

async function openNotifications(page) {
  await page.goto('/settings')
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())), { timeout: 15000 }).toBe(true)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
}

test('Settings shows the push card and asks the server for the key when enabling', async ({ page, context }) => {
  const pushRequests = []
  // Headless Chromium reports Notification.permission as 'denied' even when granted, so stub the prompt.
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' })
    Notification.requestPermission = async () => 'granted'
  })
  await mockApi(page, pushRequests)
  await openNotifications(page)

  const card = page.getByTestId('notifications-card')
  await expect(card).toBeVisible()
  await expect(card.getByText('Push notifications')).toBeVisible()
  await card.getByRole('button', { name: 'Enable on this device' }).click()
  // The mocked key is not a real P-256 point, so the browser refuses the subscription; the
  // request for the key proves the click handler ran the enable flow.
  await expect.poll(() => pushRequests).toContain('GET /api/push/vapid-public-key')
  await expect(page.getByText('Notifications could not be changed. Please try again.')).toBeVisible()
  expect(pushRequests).not.toContain('POST /api/push/subscribe')
})

test('shows the blocked hint and no buttons when notifications are denied', async ({ page, context }) => {
    await mockApi(page, [])
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'denied' })
  })
  await openNotifications(page)
  const card = page.getByTestId('notifications-card')
  await expect(card.getByText('Notifications are blocked in your device settings.')).toBeVisible()
  await expect(card.getByRole('button')).toHaveCount(0)
})

test('the built worker carries the push handlers', async ({ page }) => {
  await mockApi(page, [])
  const script = await (await page.request.get('/sw.js')).text()
  expect(script).toContain("addEventListener('push'")
  expect(script).toContain("addEventListener('notificationclick'")
})
