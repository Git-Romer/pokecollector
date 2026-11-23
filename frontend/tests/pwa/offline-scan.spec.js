import { expect, test } from '@playwright/test'

const admin = { id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

// A tiny valid JPEG header is enough: the server is mocked and only sizes are checked.
const jpeg = (size, name = 'card.jpg') => ({ name, mimeType: 'image/jpeg', buffer: Buffer.alloc(size, 7) })

// `state.health`: 'down' (503) or 'up'. Records every upload to the jobs endpoint.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/health') {
      return state.health === 'up' ? route.fulfill({ json: HEALTH_OK }) : route.fulfill({ status: 503, json: {} })
    }
    if (path === '/api/cards/recognize/jobs' && request.method() === 'POST') {
      state.uploads.push({ headers: request.headers(), bytes: request.postDataBuffer()?.length ?? 0 })
      return route.fulfill({ json: { id: 41 } })
    }
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: admin })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/settings/scanner') return route.fulfill({ json: { visual_verification: 'disabled' } })
    return route.fulfill({ json: [] })
  })
}

async function openScanner(page) {
  await page.goto('/search')
  await page.getByTitle('Scan card').click()
  await expect(page.getByText('0/50 Photos')).toBeVisible()
}

const outboxItemCount = page => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('pokecollector-outbox')
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const db = open.result
    const request = db.transaction('items').objectStore('items').count()
    request.onsuccess = () => {
      db.close()
      resolve(request.result)
    }
  }
}))

test('a scan taken while the server is unreachable is saved on the device and uploaded later', async ({ page }) => {
  const state = { health: 'down', uploads: [] }
  await mockApi(page.context(), state)
  await openScanner(page)

  await page.locator('input[multiple]').setInputFiles([jpeg(2000, 'a.jpg'), jpeg(3000, 'b.jpg'), jpeg(4000, 'c.jpg')])
  await page.getByRole('button', { name: 'Start scanning' }).click()
  await expect(page.getByText('Saved on this device. It will sync automatically.')).toBeVisible()
  await expect(page.getByText('0/50 Photos')).toBeHidden()
  expect(await outboxItemCount(page)).toBe(1)
  expect(state.uploads).toHaveLength(0)

  await page.goto('/')
  await page.getByTestId('home-sync-button').click()
  const automatic = page.getByRole('switch', { name: 'Automatic sync', exact: true })
  await automatic.click()
  await expect(automatic).not.toBeChecked()
  state.health = 'up'
  await page.getByRole('button', { name: /sync now/i }).click()
  await expect.poll(() => state.uploads.length).toBe(1)
  expect(state.uploads[0].headers['idempotency-key']).toBeTruthy()
  expect(state.uploads[0].headers['x-expected-user-id']).toBe('1')
  // Playwright's WebKit does not report Blob parts in the recorded body, so only Chromium can check size.
  if (test.info().project.name === 'chromium-page') expect(state.uploads[0].bytes).toBeGreaterThanOrEqual(9000)
  await expect.poll(() => outboxItemCount(page)).toBe(0)
})


test('retry after the second photo chunk fails keeps only unsaved photos in staging', async ({ page }) => {
  await mockApi(page.context(), { health: 'down', uploads: [] })
  await openScanner(page)
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    let items = 0
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'items' && ++items === 2) throw new DOMException('Test quota', 'QuotaExceededError')
      return put.call(this, value, ...args)
    }
  })
  await page.locator('input[multiple]').setInputFiles(Array.from({ length: 13 }, (_, i) => jpeg(1000, `partial-${i}.jpg`)))
  await page.getByRole('button', { name: 'Start scanning' }).click()
  await expect(page.getByText('1/50 Photos')).toBeVisible()
  expect(await outboxItemCount(page)).toBe(1)
  await page.getByRole('button', { name: 'Start scanning' }).click()
  await expect.poll(() => outboxItemCount(page)).toBe(2)
  const names = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('pokecollector-outbox')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const request = db.transaction('photos').objectStore('photos').getAll()
      request.onsuccess = () => { db.close(); resolve(request.result.map(photo => photo.name)) }
    }
  }))
  expect(names).toHaveLength(13)
  expect(new Set(names).size).toBe(13)
})

test('a photo larger than 15 MB is refused', async ({ page }) => {
  await mockApi(page.context(), { health: 'down', uploads: [] })
  await openScanner(page)
  await page.locator('input[capture]').setInputFiles(jpeg(16 * 1024 * 1024, 'big.jpg'))
  await expect(page.getByText("This photo is larger than 15 MB and can't be uploaded.")).toBeVisible()
  await expect(page.getByText('0/50 Photos')).toBeVisible()
})

test('storage that is full keeps the staged photos', async ({ page }) => {
  await mockApi(page.context(), { health: 'down', uploads: [] })
  await page.addInitScript(() => localStorage.setItem('pc.debug.forceQuota', '1'))
  await openScanner(page)
  await page.locator('input[capture]').setInputFiles(jpeg(2000))
  await page.getByRole('button', { name: 'Start scanning' }).click()
  await expect(page.getByText(/Not enough storage/)).toBeVisible()
  await expect(page.getByText('1/50 Photos')).toBeVisible()
})
