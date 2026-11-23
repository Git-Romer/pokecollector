import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { OUTBOX_DB_NAME } from '../../src/offline/constants.js'

const account = { id: 1, username: 'offline-owner', role: 'user', avatar_id: null, must_change_password: false }
const artwork = fileURLToPath(new URL('../../public/cardback.jpg', import.meta.url))
const cacheName = 'pc-collection-originals-v1'

async function prepare(page, context, { count = 0, missing = [], onImage, beforeManifest, flags, enabled = true, connection = { offline: false }, onSettingsWrite, beforeSettingsWrite, onSettingsResponse } = {}) {
  page.on('pageerror', error => console.log('PAGE_ERROR', error.message))
  page.on('console', message => { if (message.type() === 'error') console.log('BROWSER_ERROR', message.text()) })
  const settings = { language: 'en', currency: 'EUR', offline_collection_revision: '0' }
  if (enabled !== null) settings.offline_collection_enabled = String(enabled)
  if (flags) await context.route(url => ['/offline', '/collection'].includes(url.pathname), async route => {
    const response = await route.fetch()
    return route.fulfill({ response, body: (await response.text()).replace('<head>', `<head><meta name="pokecollector-pwa" content="${flags}">`) })
  })
  await page.addInitScript(user => {
    localStorage.setItem('token', 'offline-test-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, account)
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (connection.offline) return route.abort('connectionfailed')
    if (path.startsWith('/api/images/card/')) {
      if (onImage && await onImage(route)) return
      return route.fulfill({ path: artwork, contentType: 'image/jpeg', headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' } }).catch(() => {})
    }
    if (path === '/api/health') return route.fulfill({ json: { status: 'ok', service: 'pokemon-tcg-collection', version: '1.57.9', api_level: 1, features: ['idempotency-v1'] } })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: account })
    if (path === '/api/settings/') {
      if (route.request().method() === 'PUT') {
        const revision = route.request().headers()['x-offline-preference-revision']
        await beforeSettingsWrite?.(route.request().postDataJSON())
        if (revision !== undefined && revision !== settings.offline_collection_revision) {
          onSettingsResponse?.(409, route.request().postDataJSON())
          return route.fulfill({ status: 409, json: { detail: 'Offline preference changed' } }).catch(() => {})
        }
        Object.assign(settings, route.request().postDataJSON())
        if (Object.hasOwn(route.request().postDataJSON(), 'offline_collection_enabled')) settings.offline_collection_revision = String(Number(settings.offline_collection_revision) + 1)
        onSettingsWrite?.(route.request().postDataJSON())
        onSettingsResponse?.(200, route.request().postDataJSON())
      }
      return route.fulfill({ json: settings })
    }
    if (path === '/api/settings/scanner') return route.fulfill({ json: { provider: 'gemini', model: '', providers: [], request_timeout_seconds: 60 } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path === '/api/collection/offline-manifest') {
      if (beforeManifest) await beforeManifest()
      return route.fulfill({ json: { version: 1, user_id: 1, items: [], image_urls: Array.from({ length: count }, (_, i) => `/api/images/card/cache-entry-${i}_en/large?v=1111111111111111`), missing_artwork_card_ids: missing } }).catch(() => {})
    }
    return route.fulfill({ json: [] })
  })
  await page.goto('/offline')
  const panel = page.getByTestId('collection-offline-download')
  if (!flags || flags === 'sw=1;queue=1') await expect(panel.getByRole('switch', { name: 'Automatic offline downloads' })).toBeVisible()
  else await expect(page.getByRole('heading', { name: 'Sync center', exact: true })).toBeVisible()
  return panel
}
async function imageCount(page) {
  return page.evaluate(async name => await caches.has(name) ? (await (await caches.open(name)).keys()).length : 0, cacheName)
}
const saved = panel => expect(panel.getByText('Saved for offline use', { exact: true })).toBeVisible({ timeout: 150000 })
const change = panel => panel.getByRole('switch', { name: 'Automatic offline downloads' })

for (const flags of ['sw=1;queue=0', 'sw=0;queue=1', 'sw=0;queue=0']) {
  test(`automatic offline storage is hidden without both flags (${flags})`, async ({ page, context }) => {
    const panel = await prepare(page, context, { flags })
    await expect(panel).toHaveCount(0)
  })
}

test('missing preference defaults off and downloads only after explicit opt-in', async ({ page, context }) => {
  let manifests = 0
  const panel = await prepare(page, context, { count: 2, enabled: null, beforeManifest: async () => { manifests++ } })
  await expect(change(panel)).not.toBeChecked()
  await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible()
  expect(await imageCount(page)).toBe(0)
  expect(manifests).toBe(0)
  await change(panel).check()
  await saved(panel)
  expect(await imageCount(page)).toBe(2)
  expect(manifests).toBeGreaterThan(0)
})

test('explicitly enabled users save metadata without pressing a download button', async ({ page, context }) => {
  const panel = await prepare(page, context, { count: 2 })
  await expect(change(panel)).toBeChecked()
  await saved(panel)
  expect(await imageCount(page)).toBe(2)
  expect(await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('pokecollector-readcache'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    try { return await new Promise(resolve => { const r = db.transaction('qc').objectStore('qc').get(`${location.origin}|1`); r.onsuccess = () => resolve(r.result?.state.queries.some(q => JSON.stringify(q.queryKey) === '["collection",{}]')) }) }
    finally { db.close() }
  })).toBe(true)
})

test('keeps running across navigation and does not re-fetch saved images after a reload', async ({ page, context }) => {
  let calls = 0
  const panel = await prepare(page, context, { count: 3, onImage: async () => { calls++; return false } })
  await saved(panel)
  await page.goto('/collection')
  await expect(page.getByRole('button', { name: 'Save collection offline', exact: true })).toHaveCount(0)
  await page.goto('/offline')
  await saved(page.getByTestId('collection-offline-download'))
  expect(calls).toBe(3)
})

test('resumes after an error and app reload without re-fetching saved originals', async ({ page, context }) => {
  let calls = 0
  let fail = true
  const panel = await prepare(page, context, { count: 5, onImage: async route => {
    calls++
    if (fail && calls === 3) { await route.fulfill({ status: 503, body: 'unavailable' }); return true }
    return false
  } })
  await expect(panel.getByText(/The download is incomplete/)).toBeVisible()
  expect(await imageCount(page)).toBe(2)
  fail = false
  await page.reload()
  await saved(page.getByTestId('collection-offline-download'))
  expect(await imageCount(page)).toBe(5)
  expect(calls).toBe(6)
})

test('deactivation confirmation keeps downloads and saved images until explicitly confirmed', async ({ page, context }) => {
  const panel = await prepare(page, context, { count: 3 })
  await saved(panel)
  let writes = 0
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/settings/' && request.method() === 'PUT') writes++ })
  const dialog = page.getByRole('dialog', { name: 'Deactivate offline downloads?' })
  await change(panel).click()
  await expect(dialog).toBeVisible()
  expect(await imageCount(page)).toBe(3)
  expect(writes).toBe(0)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(change(panel)).toBeChecked()
  expect(await imageCount(page)).toBe(3)
  expect(writes).toBe(0)
  await change(panel).click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(change(panel)).toBeChecked()
  expect(await imageCount(page)).toBe(3)
  expect(writes).toBe(0)
  await change(panel).click()
  await dialog.getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
  await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible()
  await expect(change(panel)).not.toBeChecked()
  expect(await imageCount(page)).toBe(0)
  expect(writes).toBe(1)
})

test('airplane mode deactivation finishes locally, survives reload and saves the account choice after reconnect', async ({ page, context }) => {
  test.setTimeout(60000)
  const connection = { offline: false }
  const writes = []
  const panel = await prepare(page, context, { count: 2, connection, onSettingsWrite: updates => writes.push(updates) })
  await saved(panel)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await saved(panel)
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  connection.offline = true
  await context.setOffline(true)
  await expect(page.getByRole('button', { name: 'Retry missing images', exact: true })).toBeDisabled()
  await change(panel).click()
  await page.getByRole('dialog', { name: 'Deactivate offline downloads?' }).getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
  await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible({ timeout: 10000 })
  await expect(change(panel)).not.toBeChecked()
  await expect(page.getByText('The preference could not be saved. Check your connection and try again.')).toHaveCount(0)
  expect(await imageCount(page)).toBe(0)
  expect(writes).toEqual([])
  await page.reload()
  // Chromium's reloaded offline documents can lose navigator.onLine emulation
  // (microsoft/playwright#42174). Restore the real browser network-state signal,
  // not an app event or a mocked navigator getter. Requests remain offline too.
  const network = await context.newCDPSession(page)
  await network.send('Network.overrideNetworkState', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)
  await expect(change(panel)).not.toBeChecked()
  await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible({ timeout: 10000 })
  await expect(panel.getByText(/account preference will sync/)).toBeVisible()
  expect(await imageCount(page)).toBe(0)
  connection.offline = false
  await context.setOffline(false)
  await network.send('Network.overrideNetworkState', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await expect.poll(() => writes).toEqual([{ offline_collection_enabled: 'false' }])
  await expect(panel.getByText(/account preference will sync/)).toHaveCount(0)
  await page.reload()
  await expect(change(panel)).not.toBeChecked()
  expect(await imageCount(page)).toBe(0)
})

test('airplane mode while originals are in flight still allows local deactivation', async ({ page, context }) => {
  test.setTimeout(45000)
  const connection = { offline: false }
  let requests = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const panel = await prepare(page, context, { count: 10, connection,
    onImage: async () => { requests++; if (requests > 1) await gate; return false },
  })
  try {
    await expect.poll(() => requests).toBeGreaterThan(1)
    await expect(panel).toHaveAttribute('aria-busy', 'true')
    connection.offline = true
    await context.setOffline(true)
    await change(panel).click()
    await page.getByRole('dialog', { name: 'Deactivate offline downloads?' }).getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
    await expect(change(panel)).not.toBeChecked()
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible({ timeout: 10000 })
    expect(await imageCount(page)).toBe(0)
  } finally { release() }
})

test('two tabs cannot resurrect downloads with a late older enable write', async ({ page, context }) => {
  test.setTimeout(60000)
  let release
  let delayed = false
  let released = false
  let lateStatus
  const gate = new Promise(resolve => { release = resolve })
  const writes = []
  const panel = await prepare(page, context, { enabled: false, count: 0,
    beforeSettingsWrite: async updates => {
      if (updates.offline_collection_enabled === 'true' && !delayed) { delayed = true; await gate }
    }, onSettingsWrite: updates => writes.push(updates.offline_collection_enabled),
    onSettingsResponse: (status, updates) => { if (released && updates.offline_collection_enabled === 'true') lateStatus = status },
  })
  const other = await context.newPage()
  try {
    await other.goto('/offline')
    const second = other.getByTestId('collection-offline-download')
    await expect(change(second)).toBeEnabled()
    await change(panel).check()
    await expect.poll(() => delayed).toBe(true)
    await expect(change(second)).toBeChecked()
    await change(second).click()
    await other.getByRole('dialog').getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
    await expect(change(second)).not.toBeChecked()
    // Give the newer intent time to reach its independent tab writer.
    await expect.poll(() => writes.includes('false')).toBe(true)
    released = true
    release()
    // Observe the server-side result even if the original browser request timed out.
    await expect.poll(() => lateStatus).toBe(409)
    await expect.poll(() => writes.at(-1)).toBe('false')
    await other.reload()
    await expect(change(second)).not.toBeChecked()
  } finally { release(); await other.close() }
})

test('a slow account acknowledgement cannot undo a newer local download choice', async ({ page, context }) => {
  const writes = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const panel = await prepare(page, context, { count: 2,
    beforeSettingsWrite: updates => updates.offline_collection_enabled === 'false' ? gate : undefined,
    onSettingsWrite: updates => writes.push(updates.offline_collection_enabled),
  })
  await saved(panel)
  await change(panel).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
  await expect(change(panel)).not.toBeChecked()
  await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible()
  await change(panel).check()
  await expect(change(panel)).toBeChecked()
  release()
  await expect.poll(() => writes).toEqual(['false', 'true'])
  await expect(change(panel)).toBeChecked()
  await saved(panel)
  await expect(panel.getByText(/account preference will sync/)).toHaveCount(0)
  expect(await imageCount(page)).toBe(2)
})

test('server failure with a connected browser does not roll back local deactivation', async ({ page, context }) => {
  const connection = { offline: false }
  const writes = []
  const panel = await prepare(page, context, { count: 2, connection, onSettingsWrite: updates => writes.push(updates) })
  await saved(panel)
  connection.offline = true
  expect(await page.evaluate(() => navigator.onLine)).toBe(true)
  await change(panel).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
  await expect(change(panel)).not.toBeChecked()
  await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible()
  await expect(panel.getByText(/account preference will sync/)).toBeVisible()
  expect(await imageCount(page)).toBe(0)
  connection.offline = false
  await page.evaluate(() => dispatchEvent(new Event('focus')))
  await expect.poll(() => writes).toEqual([{ offline_collection_enabled: 'false' }])
  await expect(change(panel)).not.toBeChecked()
})

test('confirmation from an old sign-in cannot deactivate another session', async ({ page, context }) => {
  const panel = await prepare(page, context, { count: 2 })
  await saved(panel)
  let writes = 0
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/settings/' && request.method() === 'PUT') writes++ })
  await change(panel).click()
  const dialog = page.getByRole('dialog', { name: 'Deactivate offline downloads?' })
  await expect(dialog).toBeVisible()
  await page.evaluate(() => localStorage.setItem('token', 'different-sign-in'))
  await dialog.getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(change(panel)).toBeChecked()
  expect(await imageCount(page)).toBe(2)
  expect(writes).toBe(0)
})

test('switching off removes metadata and artwork but retains the unsent-photo store', async ({ page, context }) => {
  const panel = await prepare(page, context, { count: 3 })
  await saved(panel)
  await page.evaluate(async name => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    try { await new Promise((resolve, reject) => { const tx = db.transaction('photos', 'readwrite'); tx.objectStore('photos').put({ itemId: 'preserve-me', index: 0, blob: new Blob(['unsent-photo']) }); tx.oncomplete = resolve; tx.onerror = reject }) }
    finally { db.close() }
  }, OUTBOX_DB_NAME)
  await change(panel).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
  await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible()
  expect(await imageCount(page)).toBe(0)
  await page.waitForTimeout(5500) // A trailing read-cache save must not recreate deleted metadata.
  const result = await page.evaluate(async name => {
    const read = async (dbName, store, key) => {
      const db = await new Promise(resolve => { const r = indexedDB.open(dbName); r.onsuccess = () => resolve(r.result) })
      try { return await new Promise(resolve => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => resolve(r.result) }) }
      finally { db.close() }
    }
    return { metadata: Boolean(await read('pokecollector-readcache', 'qc', `${location.origin}|1`)), photo: await (await read(name, 'photos', ['preserve-me', 0])).blob.text() }
  }, OUTBOX_DB_NAME)
  expect(result).toEqual({ metadata: false, photo: 'unsent-photo' })
  await page.reload()
  const reloaded = page.getByTestId('collection-offline-download')
  await expect(change(reloaded)).not.toBeChecked()
  expect(await imageCount(page)).toBe(0)
  await change(reloaded).check()
  await saved(reloaded)
  expect(await imageCount(page)).toBe(3)
})

test('Reset requires confirmation and cancellation preserves offline data', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await prepare(page, context, { count: 3 })
  await saved(panel)
  await page.goto('/offline')
  await expect(page.getByTestId('offline-center')).toBeVisible()
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Reset offline app data?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Items waiting to sync, including scan photos, and your online collection will be kept.')
  expect(await imageCount(page)).toBe(3)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await imageCount(page)).toBe(3)
  await saved(panel)
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await imageCount(page)).toBe(3)
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await dialog.getByRole('button', { name: 'Reset offline data', exact: true }).click()
  await expect(page.getByText('Offline app data was reset.', { exact: true })).toBeVisible()
  const inspect = () => page.evaluate(async () => ({
    caches: (await caches.keys()).filter(name => name.startsWith('pc-')),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }))
  expect(await inspect()).toEqual({ caches: [], workers: 0 })
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.waitForTimeout(300)
  expect(await inspect()).toEqual({ caches: [], workers: 0 })
})

for (const changeSession of [false, true]) {
  test(`stale Reset confirmation cannot clear data after ${changeSession ? 'a sign-in change' : 'leaving the page'}`, async ({ page, context }) => {
    const panel = await prepare(page, context, { count: 3 })
    await saved(panel)
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Reset offline app data?' })
    await expect(dialog).toBeVisible()
    if (changeSession) await page.evaluate(() => localStorage.setItem('token', 'new-test-session'))
    else await page.evaluate(() => {
      history.pushState({}, '', '/collection')
      dispatchEvent(new PopStateEvent('popstate'))
    })
    if (!changeSession) await expect(page).toHaveURL(/\/collection$/)
    await dialog.getByRole('button', { name: 'Reset offline data', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.waitForTimeout(300)
    expect(await imageCount(page)).toBe(3)
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBeGreaterThan(0)
    await expect(page.getByText('Offline app data was reset.', { exact: true })).toHaveCount(0)
  })
}

test('switching off in another tab stops automatic storage in both tabs', async ({ page, context }) => {
  let calls = 0
  const panel = await prepare(page, context, { count: 3, onImage: async () => { calls++; return false } })
  await saved(panel)
  const second = await context.newPage()
  try {
    await second.goto('/offline')
    const other = second.getByTestId('collection-offline-download')
    await expect(change(other)).toBeChecked()
    await change(other).click()
    await second.getByRole('dialog').getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
    await expect(other.getByText(/Offline collection data has been removed/)).toBeVisible()
    await expect(change(panel)).not.toBeChecked()
    await page.bringToFront()
    expect(await imageCount(page)).toBe(0)
    expect(calls).toBe(3)
  } finally { await second.close() }
})

test('switching off during a pending manifest prevents late writes', async ({ page, context }) => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const panel = await prepare(page, context, { count: 2, beforeManifest: () => gate })
  await change(panel).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate and delete', exact: true }).click()
  release()
  await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible()
  expect(await imageCount(page)).toBe(0)
})

test('off by stored preference never starts a manifest request', async ({ page, context }) => {
  let calls = 0
  const panel = await prepare(page, context, { enabled: false, beforeManifest: async () => { calls++ } })
  await expect(change(panel)).not.toBeChecked()
  await expect(panel.getByText(/Offline collection data has been removed/)).toBeVisible()
  expect(calls).toBe(0)
})

test('retains 2000 original images beyond the opportunistic cache limit', async ({ page, context }) => {
  test.setTimeout(180000)
  const panel = await prepare(page, context, { count: 2000 })
  await saved(panel)
  expect(await imageCount(page)).toBe(2000)
})

test('reports missing artwork and low quota without claiming full completion', async ({ page, context }) => {
  await page.addInitScript(() => { navigator.storage.estimate = async () => ({ usage: 99999, quota: 100000 }) })
  const panel = await prepare(page, context, { count: 2 })
  await expect(panel.getByText(/Not enough space remains/)).toBeVisible()
  expect(await imageCount(page)).toBe(0)
})

test('reports cards without public artwork separately from saved download status', async ({ page, context }) => {
  const panel = await prepare(page, context, { missing: ['private-art_en'] })
  await saved(panel)
  await expect(panel.getByText(/Offline artwork is unavailable or private for 1 cards/)).toBeVisible()
})
