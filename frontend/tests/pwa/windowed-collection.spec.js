import { test, expect } from '@playwright/test'
import { collectionFixture, expectNoCardPageErrors } from './helpers/windowed-cards'

test.afterEach(({ page }) => expectNoCardPageErrors(page))

test('collection keeps a bounded moving window with cards ready ahead and behind', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await collectionFixture(page)
  const cards = page.locator('.binder-grid .unified-card-frame')
  await expect.poll(() => cards.count()).toBeLessThan(150)
  await expect(page.getByText('2,000 cards', { exact: false }).first()).toBeVisible()
  const geometryError = await page.locator('[data-window-row]').first().evaluate(row => Math.abs(row.getBoundingClientRect().height - row.parentElement.querySelector('[data-window-item] > div').getBoundingClientRect().height))
  expect(geometryError).toBeLessThan(1)
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  for (const y of [1800, 6000, 18000, 6000, 1800, 0]) {
    await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), y)
    await expect.poll(() => page.evaluate(() => {
      const grid = document.querySelector('[data-windowed-grid]')
      const rect = grid.getBoundingClientRect()
      if (rect.top >= innerHeight || rect.bottom <= 100) return true
      return [...grid.querySelectorAll('[data-window-item]')].some(element => {
        const r = element.getBoundingClientRect()
        const y = Math.max(120, r.top + 12)
        return y < Math.min(innerHeight - 60, r.bottom) && Boolean(document.elementFromPoint(r.left + r.width / 2, y)?.closest('[data-window-item]'))
      })
    })).toBe(true)
    await expect.poll(() => cards.count()).toBeLessThan(150)
    expect(Math.abs(await page.evaluate(() => document.documentElement.scrollHeight) - height)).toBeLessThan(3)
  }
})


test('full-data filtering and selection include cards outside the rendered window', async ({ page }) => {
  await collectionFixture(page)
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Select up to 500 entries')
  await page.getByRole('button', { name: 'Cancel selection', exact: true }).click()
  await page.getByPlaceholder('Search cards...').fill('Window card 19')
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await expect(page.getByText('100 entries · 100 copies selected', { exact: true })).toBeVisible()
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  await expect(page.locator('[data-window-item="2000"] .unified-card-primary-action')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Cancel selection', exact: true }).click()
  await page.getByPlaceholder('Search cards...').fill('Window card 1999')
  await expect(page.locator('[data-window-item]')).toHaveCount(1)
  await expect(page.locator('[data-window-item]')).toHaveAttribute('data-window-item', '2000')
})

test('far-down cards survive a dialog, responsive reflow and browser Back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await collectionFixture(page)
  await page.evaluate(() => scrollTo(0, 12000))
  await expect.poll(() => page.locator('[data-window-item="1"]').count()).toBe(0)
  const middle = page.locator('[data-window-item]').filter({ has: page.locator('button') })
  const id = await middle.evaluateAll(list => list.find(e => { const r=e.getBoundingClientRect();return r.top>100&&r.bottom<innerHeight-80 })?.dataset.windowItem)
  expect(id).toBeTruthy()
  const tile = page.locator(`[data-window-item="${id}"]`)
  await tile.locator('.unified-card-primary-action').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(11000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(tile).toBeAttached()
  await expect.poll(() => page.locator('.binder-grid .unified-card-frame').count()).toBeLessThan(150)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const saved = await page.evaluate(() => scrollY)
  await page.getByRole('button', { name: 'Navigation', exact: true }).dispatchEvent('click')
  await expect(page.getByText('Hello,')).toBeVisible()
  await page.goBack()
  await expect(page.locator('[data-windowed-grid]')).toBeVisible()
  await expect.poll(() => page.evaluate(y => Math.abs(scrollY-y), saved)).toBeLessThan(3)
  await expect(tile).toBeAttached()
})

test('advanced holo shine and tilt initialise again after their card leaves the window', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await collectionFixture(page, { holo: true })
  const card = page.locator('[data-window-item="1"]')
  const art = card.locator('[data-holo-artwork]')
  await expect(art.locator('.holo-effect-layer')).toBeAttached()
  async function move() {
    await card.scrollIntoViewIfNeeded()
    const box = await card.locator('[data-holo-host]').boundingBox()
    await page.mouse.move(box.x + box.width * .8, box.y + box.height * .3)
    await expect.poll(() => art.evaluate(e => parseFloat(e.style.getPropertyValue('--pointer-x')))).toBeGreaterThan(55)
    await expect.poll(() => card.locator('[data-holo-rotator]').evaluate(e => e.style.transform)).toContain('rotate')
  }
  await move()
  await page.evaluate(() => scrollTo(0, 16000))
  await expect(card).toHaveCount(0)
  await page.evaluate(() => scrollTo(0, 0))
  await expect(art.locator('.holo-effect-layer')).toBeAttached()
  await move()
})


test('same-breakpoint resizing recalculates the full reserved height', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await collectionFixture(page)
  await page.setViewportSize({ width: 1500, height: 1000 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const error = await page.locator('[data-windowed-grid]').evaluate(grid => {
    const row = grid.querySelector('[data-window-row]')
    const columns = getComputedStyle(row).gridTemplateColumns.split(' ').length
    const count = Number(grid.querySelector('[data-window-item]').getAttribute('aria-setsize'))
    const rows = Math.ceil(count / columns)
    return Math.abs(grid.getBoundingClientRect().height - (rows * (row.getBoundingClientRect().height + 8) - 8))
  })
  expect(error).toBeLessThan(1)
})

test('temporarily hidden routes retain their reserved grid geometry', async ({ page }) => {
  await collectionFixture(page)
  const grid = page.locator('[data-windowed-grid]')
  const before = await grid.evaluate(e => e.style.height)
  await grid.evaluate(e => { e.style.display = 'none' })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await grid.evaluate(e => e.style.height)).toBe(before)
  await grid.evaluate(e => { e.style.display = '' })
})
