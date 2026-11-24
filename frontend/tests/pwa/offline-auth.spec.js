import { expect, test } from '@playwright/test'

const admin = { id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: false }
const misty = { id: 3, username: 'misty', role: 'user', avatar_id: null, must_change_password: false }
const SNAPSHOT_KEY = 'pc.auth.snapshot'

// `state.offline` flips the whole API to a network failure; /api/health is always unreachable
// so the outbox never tries to send the seeded items.
async function mockApi(context, { multiUser = false, user = admin, state = { offline: false } } = {}) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.offline) return route.abort('connectionrefused')
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ status: 503, json: {} })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: multiUser, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: user })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/analytics/investment-tracker') return route.fulfill({ json: [] })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    return route.fulfill({ json: [] })
  })
  return state
}

const connectionHeading = page => page.getByRole('heading', { name: 'Cannot reach PokéCollector' })

// Raw IndexedDB helpers: the outbox database (v1) is created by the app itself on start.
async function seedItem(page, userId) {
  await page.evaluate(async ownerId => {
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
    const now = Date.now()
    await new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite')
      tx.objectStore('items').put({
        id: crypto.randomUUID(),
        schema: 1,
        idempotencyKey: crypto.randomUUID(),
        serverOrigin: location.origin,
        userId: ownerId,
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
        display: { title: 'Seeded', subtitle: '', imageUrl: null },
        appVersion: '',
        minApiLevel: 1,
      })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, userId)
}

// Logout clears the read cache before it reloads, so the page may still be on the old document
// (or between two documents) when the URL first reads /login; retry until a stable one answers.
async function expectStorageCleared(page, key) {
  await expect(async () => {
    expect(await page.evaluate(name => localStorage.getItem(name), key)).toBeNull()
  }).toPass({ timeout: 10000 })
}

// The page may still be navigating right after a logout; retry until a stable document answers.
// Logout sets window.location, and a slower logout (a server call first) can be followed by a
// second navigation. Wait until the Login page is loaded and rendered before touching the page.
async function waitForLoginPage(page) {
  await page.waitForURL('**/login')
  await page.waitForLoadState('load')
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible()
}

async function countItems(page) {
  let count
  await expect(async () => { count = await readCount(page) }).toPass({ timeout: 10000 })
  return count
}

async function readCount(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pokecollector-outbox')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (!db.objectStoreNames.contains('items')) {
      db.close()
      return 0
    }
    const count = await new Promise((resolve, reject) => {
      const request = db.transaction('items', 'readonly').objectStore('items').count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return count
  })
}

test.describe('cached sign-in (degraded mode)', () => {
  test('a signed-in single-user app reopens offline from the snapshot', async ({ page, context }) => {
    const state = await mockApi(context)
    await page.goto('/')
    await expect(page.getByText('Hello,')).toBeVisible()
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).user.id, SNAPSHOT_KEY)).toBe(1)

    state.offline = true
    await page.reload()

    await expect(page.getByText('Hello,')).toBeVisible()
    await expect(connectionHeading(page)).toHaveCount(0)
    await expect(page).toHaveURL('/')
    // single-user mode has no token
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull()
  })

  test('without a snapshot the connection screen shows as before', async ({ page, context }) => {
    await mockApi(context, { state: { offline: true } })
    await page.goto('/')
    await expect(connectionHeading(page)).toBeVisible()
    await expect(page.getByText('Hello,')).toHaveCount(0)
  })

  test('a snapshot that requires a password change is not used', async ({ page, context }) => {
    await mockApi(context, { state: { offline: true } })
    await page.addInitScript(key => {
      localStorage.setItem(key, JSON.stringify({
        v: 1,
        multiUser: false,
        locked: false,
        user: { id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: true },
        savedAt: Date.now(),
      }))
    }, SNAPSHOT_KEY)
    await page.goto('/')
    await expect(connectionHeading(page)).toBeVisible()
  })
})

test.describe('logout guard', () => {
  async function signInAsMisty(page, context) {
    await mockApi(context, { multiUser: true, user: misty })
    await page.addInitScript(user => {
      if (!sessionStorage.getItem('pc-test-seeded')) {
        sessionStorage.setItem('pc-test-seeded', '1')
        localStorage.setItem('token', 'test-token')
        localStorage.setItem('user', JSON.stringify(user))
      }
    }, misty)
    await page.goto('/')
    await expect(page.getByText('Hello,')).toBeVisible()
  }

  const logoutOnHome = page => page.getByRole('button', { name: 'Logout', exact: true })
  const dialogButtons = page => ({
    sync: page.getByRole('button', { name: 'Sync first' }),
    keep: page.getByRole('button', { name: 'Log out and keep items' }),
    discard: page.getByRole('button', { name: 'Log out and delete items' }),
    cancel: page.getByRole('button', { name: 'Cancel' }),
  })

  async function expectFourWayDialog(page) {
    const buttons = dialogButtons(page)
    await expect(page.getByText('You have items that have not reached the server yet.')).toBeVisible()
    for (const button of Object.values(buttons)) await expect(button).toBeVisible()
    return buttons
  }

  test('with items: four choices on Home; cancel keeps the session, keep leaves the item', async ({ page, context }) => {
    await signInAsMisty(page, context)
    await seedItem(page, misty.id)

    await logoutOnHome(page).click()
    const buttons = await expectFourWayDialog(page)

    await buttons.cancel.click()
    await expect(buttons.keep).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('test-token')
    await expect(page).toHaveURL('/')

    await logoutOnHome(page).click()
    await expectFourWayDialog(page)
    await dialogButtons(page).keep.click()
    await waitForLoginPage(page)
    await expectStorageCleared(page, 'token')
    await expectStorageCleared(page, SNAPSHOT_KEY)
    expect(await countItems(page)).toBe(1)
  })

  test('with items: delete removes them (logout from a sub-page)', async ({ page, context }) => {
    await signInAsMisty(page, context)
    await page.goto('/collection')
    await seedItem(page, misty.id)

    await page.getByRole('button', { name: 'Logout', exact: true }).click()
    await expectFourWayDialog(page)
    expect(await countItems(page)).toBe(1)
    await dialogButtons(page).discard.click()
    await waitForLoginPage(page)
    expect(await countItems(page)).toBe(0)
  })

  test('with items: the sub-page also offers all four choices and cancel works', async ({ page, context }) => {
    await signInAsMisty(page, context)
    await page.goto('/collection')
    await seedItem(page, misty.id)

    await page.getByRole('button', { name: 'Logout', exact: true }).click()
    const buttons = await expectFourWayDialog(page)
    await buttons.cancel.click()
    await expect(buttons.keep).toHaveCount(0)
    await expect(page).toHaveURL(/\/collection/)
    expect(await countItems(page)).toBe(1)
  })

  test('without items logout works as before', async ({ page, context }) => {
    await signInAsMisty(page, context)
    await logoutOnHome(page).click()
    await waitForLoginPage(page)
    await expect(page.getByRole('button', { name: 'Log out and keep items' })).toHaveCount(0)
    await expectStorageCleared(page, 'token')
  })
})
