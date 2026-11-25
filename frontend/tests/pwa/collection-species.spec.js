import { test, expect } from '@playwright/test'
import { collectionFixture, expectNoCardPageErrors } from './helpers/windowed-cards'

test.afterEach(({ page }) => expectNoCardPageErrors(page))

async function speciesFixture(page) {
  await collectionFixture(page, { extraResponses: items => ({
    '/api/collection/': items.map((item, n) => ({ ...item, card: {
      ...item.card, dex_ids: n === 0 ? [13, 25] : [n < 1500 ? 13 : 14 + n - 1500],
    } })),
    '/api/pokedex/species': [
      { dex_id: 13, name_en: 'Weedle', name_de: 'Hornliu' },
      { dex_id: 14, name_en: 'Kakuna', name_de: 'Kokuna' },
    ],
  }) })
  const layout = page.getByRole('button', { name: 'By Pokémon', exact: true })
  await expect(layout).toHaveText('')
  await expect(layout).toHaveAttribute('title', 'By Pokémon')
  await expect(layout.locator('[data-pikachu-silhouette]')).toHaveCSS('mask-image', /pikachu-silhouette.svg/)
  await layout.click()
  await expect(page.locator('[data-species-view] section')).toHaveCount(501)
}

test('species uses the shared bounded grid, reaches the tail and keeps editing across reflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await speciesFixture(page)
  await expect(page.locator('[data-window-item]').first()).toHaveAttribute('aria-setsize', '1500')
  await expect(page.getByLabel('This card depicts more than one species', { exact: true })).toHaveText('+1')
  await expect.poll(() => page.locator('[data-window-item]').count()).toBeLessThan(150)
  const next = page.getByRole('button', { name: /#014.*Kakuna/ })
  await next.scrollIntoViewIfNeeded()
  const tail = page.locator('[data-window-item="1500"]')
  await expect(tail).toBeAttached()
  await expect.poll(() => page.locator('[data-window-item]').count()).toBeLessThan(150)
  await tail.locator('button').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('groups start open and fold independently without moving the activated header offscreen', async ({ page }) => {
  await speciesFixture(page)
  const next = page.getByRole('button', { name: /#014.*Kakuna/ })
  await next.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(10000)
  await expect(page.locator('[data-species-view] button[aria-expanded="true"]')).toHaveCount(501)
  await next.click()
  await expect(next).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => next.evaluate(button => {
    const rect = button.getBoundingClientRect()
    // Fractional CSS borders can sit half a pixel beyond the viewport edge.
    const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return rect.top >= -1 && rect.bottom <= innerHeight + 1 && center?.closest('button') === button
  })).toBe(true)
  await expect(page.locator('[data-species-view] button[aria-expanded="true"]')).toHaveCount(500)
  await next.click()
  await expect(next).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-species-view] button[aria-expanded="true"]')).toHaveCount(501)
  await expect.poll(() => page.locator('[data-window-item]').count()).toBeLessThan(150)
})



test('all-expanded groups keep their final card reachable and folding the first preserves the rest', async ({ page }) => {
  await speciesFixture(page)
  const lastHeader = page.locator('[data-species-view] button[aria-expanded]').last()
  await lastHeader.scrollIntoViewIfNeeded()
  await expect(page.locator('[data-window-item="2000"]')).toBeVisible()
  await expect.poll(() => page.locator('[data-window-item]').count()).toBeLessThan(150)
  const firstHeader = page.locator('[data-species-view] button[aria-expanded]').first()
  await firstHeader.scrollIntoViewIfNeeded()
  await firstHeader.click()
  await expect(firstHeader).toHaveAttribute('aria-expanded', 'false')
  await expect(lastHeader).toHaveAttribute('aria-expanded', 'true')
  await lastHeader.scrollIntoViewIfNeeded()
  await expect(page.locator('[data-window-item="2000"]')).toBeVisible()
  await expect.poll(() => page.locator('[data-window-item]').count()).toBeLessThan(150)
})

test('species filtering and full-data selection keep the 500 limit and survive collapse', async ({ page }) => {
  test.setTimeout(60_000)
  await speciesFixture(page)
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Select up to 500 entries')
  await page.getByRole('button', { name: 'Cancel selection', exact: true }).click()
  await page.getByPlaceholder('Search cards...').fill('Window card 14')
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await expect(page.getByText('100 entries · 100 copies selected', { exact: true })).toBeVisible()
  await page.locator('[data-species-view] button[aria-expanded="true"]').click()
  await expect(page.locator('[data-window-item]')).toHaveCount(0)
  await expect(page.getByText('100 entries · 100 copies selected', { exact: true })).toBeVisible()
})
