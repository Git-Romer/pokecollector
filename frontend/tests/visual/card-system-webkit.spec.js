import { expect, test } from '@playwright/test'

test('WebKit loads visible compact artwork in a large list', async ({ page, browserName }) => {
  expect(browserName).toBe('webkit')

  const cardBackResponse = await page.request.get('/cardback.jpg')
  const cardBack = await cardBackResponse.body()
  let imageRequests = 0
  await page.route('**/api/images/card/**', async route => {
    imageRequests += 1
    await route.fulfill({ status: 200, contentType: 'image/jpeg', body: cardBack })
  })

  await page.goto('/__card-system')
  await expect(page.getByTestId('card-system-gallery')).toBeVisible()
  await page.getByTestId('mount-lazy-card-stress').evaluate(button => button.click())

  const stress = page.getByTestId('lazy-card-stress')
  const firstArtwork = stress.locator('.unified-card-compact-artwork').first()
  await firstArtwork.scrollIntoViewIfNeeded()
  await expect.poll(async () => firstArtwork.locator('img').evaluate(image => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
  await expect(firstArtwork.locator('.unified-card-skeleton')).toHaveCount(0)
  expect(imageRequests).toBeLessThan(40)

  const lastArtwork = stress.locator('.unified-card-compact-artwork').last()
  await expect(lastArtwork.locator('img')).toHaveCount(0)
  await lastArtwork.scrollIntoViewIfNeeded()
  await expect.poll(async () => lastArtwork.locator('img').evaluate(image => (
    image.complete && image.naturalWidth > 0
  ))).toBe(true)
})
