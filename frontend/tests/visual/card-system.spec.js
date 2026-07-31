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
