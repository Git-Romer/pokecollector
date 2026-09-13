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

async function dispatchTouchDrag(image, deltaX, deltaY) {
  return image.evaluate((node, delta) => {
    const touch = (x, y) => new Touch({
      identifier: 1,
      target: node,
      clientX: x,
      clientY: y,
    })
    const rect = node.getBoundingClientRect()
    const startX = rect.left + rect.width / 2
    const startY = rect.top + rect.height / 2
    const startTouch = touch(startX, startY)
    node.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [startTouch],
      changedTouches: [startTouch],
    }))
    const movedTouch = touch(startX + delta.x, startY + delta.y)
    const moveWasCanceled = !node.dispatchEvent(new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [movedTouch],
      changedTouches: [movedTouch],
    }))
    node.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: [movedTouch],
    }))
    node.click()
    return moveWasCanceled
  }, { x: deltaX, y: deltaY })
}

async function dispatchPinch(image) {
  await image.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const touch = (identifier, x) => new Touch({
      identifier,
      target: node,
      clientX: x,
      clientY: centerY,
    })
    const startTouches = [touch(1, centerX - 20), touch(2, centerX + 20)]
    node.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: startTouches,
      changedTouches: startTouches,
    }))
    const movedTouches = [touch(1, centerX - 40), touch(2, centerX + 40)]
    node.dispatchEvent(new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: movedTouches,
      changedTouches: movedTouches,
    }))
    node.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      changedTouches: movedTouches,
    }))
    node.click()
  })
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

test('card artwork zoom keeps interaction on the image and fits short screens', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 812, height: 375 })
  await waitForGallery(page)
  await page.getByTestId('open-card-dialog').click()

  const cardDialog = page.locator('[role="dialog"][aria-label="Cinccino ex"]')
  const zoomTrigger = cardDialog.getByRole('button', { name: /Zoom image/ })
  await expect(zoomTrigger).toHaveCSS('cursor', 'zoom-in')
  await zoomTrigger.click()

  const zoomDialog = page.getByRole('dialog', { name: 'Zoom image — Cinccino ex' })
  const image = zoomDialog.getByAltText('Cinccino ex')
  const surface = zoomDialog.getByTestId('image-zoom-surface')
  await expect(zoomDialog).toBeVisible()
  await expect(zoomDialog).toBeFocused()
  await expect(cardDialog).toHaveAttribute('aria-hidden', 'true')
  await expect(cardDialog).toHaveAttribute('inert', '')
  await expect(surface).toHaveCSS('cursor', 'default')
  await expect(image).toHaveCSS('cursor', 'zoom-in')

  const fittedBox = await image.boundingBox()
  if (!fittedBox) throw new Error('Zoom image is not rendered')
  expect(fittedBox.y).toBeGreaterThanOrEqual(0)
  expect(fittedBox.y + fittedBox.height).toBeLessThanOrEqual(375)

  await zoomDialog.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(() => image.evaluate(node => node.style.transform)).toContain('scale(1.75)')
  await zoomDialog.getByRole('button', { name: 'Reset zoom' }).click()
  await expect.poll(() => image.evaluate(node => node.style.transform)).toContain('scale(1)')

  await image.hover()
  await page.mouse.wheel(0, -120)
  await expect.poll(() => image.evaluate(node => node.style.transform)).not.toContain('scale(1)')
  await zoomDialog.getByRole('button', { name: 'Reset zoom' }).click()

  if (testInfo.project.use.hasTouch) {
    await dispatchPinch(image)
    await expect.poll(() => image.evaluate(node => node.style.transform)).toContain('scale(2)')
    await zoomDialog.getByRole('button', { name: 'Reset zoom' }).click()
  }

  if (testInfo.project.use.hasTouch) await image.tap()
  else await image.click()
  await expect.poll(() => image.evaluate(node => node.style.transform)).toContain('scale(2.5)')
  await expect(image).toHaveCSS('cursor', 'grab')

  let box = await image.boundingBox()
  if (!box) throw new Error('Zoomed image is not rendered')
  let startX = box.x + box.width / 2
  let startY = box.y + box.height / 2
  if (testInfo.project.use.hasTouch) {
    expect(await dispatchTouchDrag(image, 2, 1)).toBe(false)
  } else {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 2, startY + 1)
    await page.mouse.up()
  }
  await expect.poll(() => image.evaluate(node => node.style.transform)).toContain('scale(1)')

  if (testInfo.project.use.hasTouch) await image.tap()
  else await image.click()
  box = await image.boundingBox()
  if (!box) throw new Error('Zoomed image is not rendered')
  startX = box.x + box.width / 2
  startY = box.y + box.height / 2
  const transformBeforeDrag = await image.evaluate(node => node.style.transform)
  if (testInfo.project.use.hasTouch) {
    await dispatchTouchDrag(image, 10, 8)
    await expect.poll(() => image.evaluate(node => node.style.transform)).not.toBe(transformBeforeDrag)
    await expect.poll(() => image.evaluate(node => node.style.transform)).toContain('scale(2.5)')
    box = await image.boundingBox()
    if (!box) throw new Error('Panned image is not rendered')
    startX = box.x + box.width / 2
    startY = box.y + box.height / 2
  }
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 10, startY + 8)
  await expect(image).toHaveCSS('cursor', 'grabbing')
  await page.mouse.up()
  await expect(image).toHaveCSS('cursor', 'grab')
  await expect.poll(() => image.evaluate(node => node.style.transform)).not.toBe(transformBeforeDrag)
  await expect.poll(() => image.evaluate(node => node.style.transform)).toContain('scale(2.5)')
  await expect(zoomDialog).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(zoomDialog).toHaveCount(0)
  await expect(cardDialog).toBeVisible()
  await expect(cardDialog).not.toHaveAttribute('aria-hidden', 'true')
  await expect(cardDialog).not.toHaveAttribute('inert', '')

  await zoomTrigger.click()
  await expect(zoomDialog).toBeVisible()
  await surface.click({ position: { x: 5, y: 5 } })
  await expect(zoomDialog).toHaveCount(0)
  await expect(cardDialog).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(cardDialog).toHaveCount(0)
})

test('failed dialog artwork keeps Retry valid and withholds zoom until recovery', async ({ page }) => {
  await waitForGallery(page)
  const cardBackResponse = await page.request.get('/cardback.jpg')
  const cardBack = await cardBackResponse.body()
  await page.route('**/__card-system-dialog-image.jpg*', (route) => {
    const requestUrl = new URL(route.request().url())
    return requestUrl.searchParams.has('retry')
      ? route.fulfill({ status: 200, contentType: 'image/jpeg', body: cardBack })
      : route.abort()
  })
  await page.getByTestId('open-card-dialog-error').evaluate(button => button.click())

  const cardDialog = page.getByRole('dialog', { name: 'Cinccino ex', exact: true })
  const retry = cardDialog.getByRole('button', { name: /Retry.*artwork/i })
  await expect(retry).toBeVisible()
  await expect(cardDialog.getByRole('button', { name: /Zoom image/ })).toHaveCount(0)

  await retry.click()
  const zoomTrigger = cardDialog.getByRole('button', { name: /Zoom image/ })
  await expect(zoomTrigger).toBeVisible()
  await zoomTrigger.click()

  const zoomDialog = page.getByRole('dialog', { name: /Zoom image.*Cinccino ex/i })
  const zoomedImage = zoomDialog.getByRole('img', { name: 'Cinccino ex' })
  await expect(zoomedImage).toBeVisible()
  await expect(zoomedImage).toHaveAttribute('src', /[?&]retry=1/)
  await expect.poll(() => zoomedImage.evaluate(image => image.naturalWidth)).toBeGreaterThan(0)
})

test('shared card keyboard and touch paths activate the intended action', async ({ page }, testInfo) => {
  await waitForGallery(page)
  const card = page.getByTestId('hover-add-state')
  const frame = card.locator('.unified-card-primary-action')
  const add = card.locator('.unified-card-add')

  await frame.focus()
  await page.keyboard.press('Space')
  await expect(page.getByTestId('interaction-result')).toHaveText('details')

  await add.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('interaction-result')).toHaveText('add')

  if (testInfo.project.use.hasTouch) {
    await frame.tap()
    await expect(page.getByTestId('interaction-result')).toHaveText('details')
  }
})

test('retry and selected markers preserve their intended pointer targets', async ({ page }, testInfo) => {
  await waitForGallery(page)
  const retry = page.getByTestId('image-error-state').getByRole('button', { name: /retry/i })
  await retry.click()
  await expect(page.getByTestId('interaction-result')).toHaveCount(0)

  const selectedCard = page.getByTestId('selected-card-state')
  const marker = selectedCard.locator('.unified-card-selection')
  const box = await marker.boundingBox()
  if (!box) throw new Error('Selected marker is not rendered')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const primary = selectedCard.locator('.unified-card-primary-action')
  const primaryBox = await primary.boundingBox()
  if (!primaryBox) throw new Error('Selected card action is not rendered')
  const position = { x: x - primaryBox.x, y: y - primaryBox.y }
  if (testInfo.project.use.hasTouch) {
    await primary.tap({ position })
  } else {
    await primary.click({ position })
  }
  await expect(page.getByTestId('interaction-result')).toHaveText('selected')
})

test('shared dialog traps focus and provides keyboard tab navigation', async ({ page }) => {
  await waitForGallery(page)
  await page.getByTestId('open-card-dialog').click()
  const dialog = page.getByRole('dialog')
  const close = dialog.getByRole('button', { name: /close/i })
  const overview = dialog.getByRole('tab', { name: 'Overview' })
  const prices = dialog.getByRole('tab', { name: 'Prices' })
  const panel = dialog.getByRole('tabpanel')

  await expect(overview).toHaveAttribute('aria-selected', 'true')
  const panelId = await panel.getAttribute('id')
  await expect(overview).toHaveAttribute('aria-controls', panelId)
  await expect(prices).toHaveAttribute('aria-controls', panelId)

  await panel.evaluate((element) => {
    const visible = document.createElement('button')
    visible.type = 'button'
    visible.dataset.testid = 'visible-dialog-action'
    visible.textContent = 'Visible action'
    element.appendChild(visible)

    const hiddenPane = document.createElement('div')
    hiddenPane.setAttribute('aria-hidden', 'true')
    hiddenPane.setAttribute('inert', '')
    hiddenPane.style.opacity = '0'
    hiddenPane.style.pointerEvents = 'none'
    const hidden = document.createElement('button')
    hidden.type = 'button'
    hidden.dataset.testid = 'hidden-dialog-action'
    hidden.textContent = 'Hidden action'
    hiddenPane.appendChild(hidden)
    element.appendChild(hiddenPane)
  })

  const visibleAction = dialog.getByTestId('visible-dialog-action')
  await close.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(visibleAction).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()

  await overview.focus()
  await page.keyboard.press('ArrowRight')
  await expect(prices).toBeFocused()
  await expect(prices).toHaveAttribute('aria-selected', 'true')
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
