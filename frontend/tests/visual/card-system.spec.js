import { expect, test } from '@playwright/test'

async function waitForGallery(page) {
  await page.goto('/__card-system')
  await expect(page.getByTestId('card-system-gallery')).toBeVisible()
  await page.getByTestId('compact-card-variants').scrollIntoViewIfNeeded()
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map(image => image.complete
      ? Promise.resolve()
      : new Promise(resolve => {
          image.addEventListener('load', resolve, { once: true })
          image.addEventListener('error', resolve, { once: true })
        })))
  })
  await expect(page.getByTestId('full-card-variants').getByRole('button', { name: /retry/i })).toBeVisible()
  await expect(page.locator('.unified-card-skeleton')).toHaveCount(0)
  await page.evaluate(() => window.scrollTo(0, 0))
}

test('shared card variants and states remain consistent', async ({ page }) => {
  await waitForGallery(page)
  await expect(page.getByTestId('card-system-gallery')).toHaveScreenshot('card-system-gallery.png')
})

test('shared card dialog remains consistent', async ({ page }) => {
  await waitForGallery(page)
  await page.getByTestId('open-card-dialog').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveScreenshot('card-system-dialog.png')
})

test('lazy compact artwork loads again after a cached view remount', async ({ page }) => {
  await waitForGallery(page)
  const compact = page.getByTestId('compact-card-variants')
  await compact.scrollIntoViewIfNeeded()

  await expect.poll(async () => compact.locator('img').evaluateAll(images => (
    images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0)
  ))).toBe(true)

  await page.getByTestId('remount-compact-cards').click({ force: true })
  await compact.scrollIntoViewIfNeeded()
  await expect.poll(async () => compact.locator('img').evaluateAll(images => (
    images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0)
  ))).toBe(true)
  await expect(compact.locator('.unified-card-skeleton')).toHaveCount(0)
})

test('compact artwork prioritizes visible rows in a large list', async ({ page }) => {
  const cardBackResponse = await page.request.get('/cardback.jpg')
  const cardBack = await cardBackResponse.body()
  let imageRequests = 0

  await page.route('**/api/images/card/**', async route => {
    imageRequests += 1
    await route.fulfill({ status: 200, contentType: 'image/jpeg', body: cardBack })
  })

  await waitForGallery(page)
  await page.getByTestId('mount-lazy-card-stress').evaluate(button => button.click())

  const stress = page.getByTestId('lazy-card-stress')
  await expect(stress).toBeAttached()
  const firstArtwork = stress.locator('.unified-card-compact-artwork').first()
  await firstArtwork.scrollIntoViewIfNeeded()
  await expect.poll(async () => firstArtwork.locator('img').evaluate(image => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
  await expect(firstArtwork.locator('.unified-card-skeleton')).toHaveCount(0)
  await expect(page.getByTestId('lazy-card-stress-hidden').locator('img')).toHaveCount(0)
  expect(imageRequests).toBeLessThan(40)

  const lastArtwork = stress.locator('.unified-card-compact-artwork').last()
  await lastArtwork.scrollIntoViewIfNeeded()
  await expect.poll(async () => lastArtwork.locator('img').evaluate(image => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
  expect(imageRequests).toBeLessThanOrEqual(80)
})

test('Safari fallback loads visible rows when IntersectionObserver stalls', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15',
    })
    window.IntersectionObserver = class StalledIntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    }
  })

  const cardBackResponse = await page.request.get('/cardback.jpg')
  const cardBack = await cardBackResponse.body()
  await page.route('**/api/images/card/**', route => route.fulfill({
    status: 200,
    contentType: 'image/jpeg',
    body: cardBack,
  }))

  await waitForGallery(page)
  await page.getByTestId('mount-lazy-card-stress').evaluate(button => button.click())

  const stress = page.getByTestId('lazy-card-stress')
  const firstArtwork = stress.locator('.unified-card-compact-artwork').first()
  await firstArtwork.scrollIntoViewIfNeeded()
  await expect.poll(async () => firstArtwork.locator('img').evaluate(image => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
  await expect(firstArtwork.locator('.unified-card-skeleton')).toHaveCount(0)
  await expect(page.getByTestId('lazy-card-stress-hidden').locator('img')).toHaveCount(0)

  const lastArtwork = stress.locator('.unified-card-compact-artwork').last()
  await expect(lastArtwork.locator('img')).toHaveCount(0)
  await lastArtwork.scrollIntoViewIfNeeded()
  await expect.poll(async () => lastArtwork.locator('img').evaluate(image => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
})
