import { expect, test } from '@playwright/test'
import { collectionFixture, expectNoCardPageErrors } from './helpers/windowed-cards'

test('one Sync center retry retries failed artwork without starting a server sync', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await collectionFixture(page)
  let failing = true
  const retried = []
  const serverSync = []
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/sync') && request.method() === 'POST') serverSync.push(request.url())
  })
  await page.route('**/api/images/**', route => {
    if (failing) return route.abort('connectionfailed')
    retried.push(route.request().url())
    return route.fulfill({ status: 302, headers: { location: '/cardback.jpg' } })
  })
  await page.reload()
  await expect(page.locator('.unified-card-image-error').first()).toBeVisible()
  // The placeholder may sit behind Home but must never cover its hit target.
  const home = page.getByRole('button', { name: 'Navigation', exact: true })
  expect(await home.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
  await home.click()
  await page.getByTestId('home-sync-button').click()
  const retry = page.getByRole('button', { name: 'Retry missing images', exact: true })
  await expect(retry).toBeEnabled()
  failing = false
  await retry.click()
  await page.goBack()
  await page.goBack()
  await expect(page.locator('.unified-card-frame-interactive').first().locator('img')).toBeVisible()
  await expect(page.locator('.unified-card-frame-interactive').first().locator('.unified-card-image-error')).toHaveCount(0)
  expect(retried.some(url => new URL(url).searchParams.has('retry'))).toBe(true)
  expect(serverSync).toEqual([])
  expectNoCardPageErrors(page)
})

for (const width of [320, 390, 1280]) {
  test(`missing artwork remains compact and opens the card at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 844 })
    await collectionFixture(page)
    await page.route('**/api/images/**', route => route.abort('connectionfailed'))
    await page.reload()
    await expect(page.locator('.unified-card-caption').first()).toBeAttached({ timeout: 30000 })
    const frame = page.locator('.unified-card-frame-interactive').first()
    const error = frame.locator('.unified-card-image-error')
    await expect(error).toBeVisible()
    await context.setOffline(true)
    const banner = page.getByTestId('offline-banner')
    await expect(banner).toBeVisible()
    const warningBounds = await banner.boundingBox()
    const homeBounds = await page.getByRole('button', { name: 'Navigation', exact: true }).boundingBox()
    expect(warningBounds.y + warningBounds.height).toBeLessThan(homeBounds.y)
    await frame.scrollIntoViewIfNeeded()
    if (width === 390) await page.screenshot({ path: test.info().outputPath('missing-artwork-phone.png') })
    // Tap the actual artwork, not force-clicking the covered action underneath it.
    const bounds = await error.boundingBox()
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(error.getByRole('button')).toHaveCount(0)
    await expect(error.locator('strong')).toHaveCount(0)
    expect(await error.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await frame.locator('.unified-card-primary-action').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    expectNoCardPageErrors(page)
  })
}
