import { expect, test } from '@playwright/test'

async function waitForGallery(page) {
  const cardBackResponse = await page.request.get('/cardback.jpg')
  const cardBack = await cardBackResponse.body()
  await page.route(/\/api\/images\/card\/(?:me04|me03|base1)-[^/]+\/(?:small|large)$/, route => route.fulfill({
    status: 200,
    contentType: 'image/jpeg',
    body: cardBack,
  }))
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
  await expect(page.getByTestId('interaction-combinations').getByRole('button', { name: /retry/i })).toBeVisible()
  await expect(page.locator('.unified-card-skeleton')).toHaveCount(0)
  await page.evaluate(() => window.scrollTo(0, 0))
}

test('shared card variants and states remain consistent', async ({ page }) => {
  await waitForGallery(page)
  await expect(page.getByTestId('binder-zero-state').locator('.unified-card-missing-overlay')).toHaveCount(1)
  await expect(page.getByTestId('binder-partial-state').locator('.unified-card-missing-overlay')).toHaveCount(0)
  await expect(page.getByTestId('carousel-state').locator('.lucide-sparkles')).toHaveCount(3)
  await expect(page.getByTestId('ranking-state').getByTestId('ranking-position')).toHaveText(['#1', '#2', '#3'])
  await expect(page.getByTestId('ranking-state').getByTestId('ranking-value')).toHaveText(['€100.48', '€24.94', '€21.42'])
  if (await page.evaluate(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches)) {
    const hoverCard = page.getByTestId('hover-add-state')
    await hoverCard.locator('.unified-card-frame').hover()
    await expect(hoverCard.locator('.unified-card-add')).toHaveCSS('opacity', '1')
  }
  await expect(page.getByTestId('card-system-gallery')).toHaveScreenshot('card-system-gallery.png')
})

test('shared card dialog remains consistent', async ({ page }) => {
  await waitForGallery(page)
  await page.getByTestId('open-card-dialog').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveScreenshot('card-system-dialog.png')
})

test('shared card keyboard and touch paths activate the intended action', async ({ page }) => {
  await waitForGallery(page)
  const card = page.getByTestId('hover-add-state')
  const frame = card.locator('.unified-card-frame')
  const add = card.locator('.unified-card-add')

  await frame.focus()
  await page.keyboard.press('Space')
  await expect(page.getByTestId('interaction-result')).toHaveText('details')

  await add.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('interaction-result')).toHaveText('add')

  if (await page.evaluate(() => matchMedia('(hover: none), (pointer: coarse)').matches)) {
    await frame.tap()
    await expect(page.getByTestId('interaction-result')).toHaveText('details')
  }
})

test('shared dialog traps focus and provides keyboard tab navigation', async ({ page }) => {
  await waitForGallery(page)
  await page.getByTestId('open-card-dialog').click()
  const dialog = page.getByRole('dialog')
  const close = dialog.getByRole('button', { name: /close/i })
  const overview = dialog.getByRole('tab', { name: 'Overview' })
  const prices = dialog.getByRole('tab', { name: 'Prices' })

  await overview.focus()
  await page.keyboard.press('ArrowRight')
  await expect(prices).toBeFocused()
  await expect(prices).toHaveAttribute('aria-selected', 'true')
  await expect(prices).toHaveAttribute('aria-controls', /tabpanel-prices$/)

  await close.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(prices).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
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

    const measurements = new WeakMap()
    const getBoundingClientRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function safariDelayedLayout() {
      if (this.classList?.contains('unified-card-image')) {
        const count = measurements.get(this) || 0
        measurements.set(this, count + 1)
        if (count < 2) return DOMRect.fromRect()
      }
      return getBoundingClientRect.call(this)
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
