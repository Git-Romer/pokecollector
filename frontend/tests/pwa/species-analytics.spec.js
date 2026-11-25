import { test, expect } from '@playwright/test'
import { collectionFixture, expectNoCardPageErrors } from './helpers/windowed-cards'

test.afterEach(({ page }) => expectNoCardPageErrors(page))

async function analyticsFixture(page, { large = false, many = false } = {}) {
  const requests = []
  page.on('request', request => {
    if (request.url().includes('/analytics/species-duplicates')) requests.push(request.url())
  })
  await collectionFixture(page, {
    routePath: '/analytics', readySelector: 'h1',
    extraResponses: items => {
      const printings = items.slice(0, many ? 2000 : large ? 1500 : 2).map((item, index) => ({
        ...item.card, card_id: item.card_id, collection_item_id: item.id,
        quantity: many ? 1 : index + 1, price: 2, total_value: (many ? 1 : index + 1) * 2,
        set_name: 'Window set', has_scan_photo: false,
      }))
      const species = many ? [25, ...Array.from({ length: 501 }, (_, n) => n + 1).filter(id => id !== 25)].map((dex_id, index) => {
        const rows = index === 0 ? printings.slice(0, 1000) : printings.slice(1000 + (index - 1) * 2, 1000 + index * 2)
        return { dex_id, name_en: `Fixture species ${dex_id}`, printing_count: rows.length,
          copies: rows.length, total_value: rows.length * 2, printings: rows }
      }) : [25, 6].map(dex_id => ({
        dex_id, name_en: dex_id === 25 ? 'Pikachu' : 'Charizard',
        name_de: dex_id === 25 ? 'Pikachu' : 'Glurak',
        printing_count: printings.length, copies: 3, total_value: 6, printings,
      }))
      return {
        '/api/analytics/species-duplicates': {
          summary: { species_with_duplicates: species.length, printings: printings.length,
            copies: many ? printings.length : 3, total_value: many ? printings.length * 2 : 6 },
          species,
        },
      }
    },
  })
  return requests
}

test('species analytics loads on demand and keeps independent folding and card details', async ({ page }) => {
  const requests = await analyticsFixture(page)
  expect(requests).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Species duplicates', exact: true })).toHaveCount(0)
  const views = page.getByRole('group', { name: 'Duplicate view', exact: true })
  await expect(views.getByRole('button', { name: 'By card', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(views.getByRole('button', { name: 'By Pokémon', exact: true })).toHaveText('')
  await page.getByRole('group', { name: 'Duplicate view', exact: true }).getByRole('button', { name: 'By Pokémon', exact: true }).click()
  await expect(page.getByText('Species with duplicates', { exact: true })).toBeVisible()
  expect(requests).toHaveLength(1)
  expect(new URL(requests[0]).searchParams.get('price_field')).toBe('price_trend')
  const first = page.getByRole('button', { name: /#025.*Pikachu/ })
  const second = page.getByRole('button', { name: /#006.*Charizard/ })
  await expect(first).toHaveAttribute('aria-expanded', 'true')
  await expect(second).toHaveAttribute('aria-expanded', 'true')
  await second.click()
  await expect(second).toHaveAttribute('aria-expanded', 'false')
  await expect(first).toHaveAttribute('aria-expanded', 'true')
  await second.click()
  await expect(second).toHaveAttribute('aria-expanded', 'true')
  await expect(first).toHaveAttribute('aria-expanded', 'true')
  await first.click()
  await expect(first).toHaveAttribute('aria-expanded', 'false')
  await expect(second).toHaveAttribute('aria-expanded', 'true')
  await page.getByText('Window card 0000', { exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Top Movers', exact: true }).click()
  await expect(views).toHaveCount(0)
  await page.getByRole('button', { name: 'Duplicates', exact: true }).click()
  await expect(views.getByRole('button', { name: 'By Pokémon', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(first).toHaveAttribute('aria-expanded', 'false')
  await expect(second).toHaveAttribute('aria-expanded', 'true')
  await views.getByRole('button', { name: 'By card', exact: true }).click()
  await expect(page.getByText('No duplicates in your collection', { exact: true })).toBeVisible()
  await views.getByRole('button', { name: 'By Pokémon', exact: true }).click()
  await expect(second).toHaveAttribute('aria-expanded', 'true')
  expect(requests).toHaveLength(1)
})

test('large species printing lists stay bounded and their final card opens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await analyticsFixture(page, { large: true })
  await page.getByRole('group', { name: 'Duplicate view', exact: true }).getByRole('button', { name: 'By Pokémon', exact: true }).click()
  await expect(page.locator('[data-window-item]')).not.toHaveCount(0)
  await expect.poll(() => page.locator('[data-window-item]').count()).toBeLessThan(100)
  await expect(page.locator('button[aria-expanded="true"]')).toHaveCount(2)
  await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
  const tail = page.locator('#card-group-panel-species-6').getByText('Window card 1499', { exact: true })
  await expect(tail).toBeVisible()
  await tail.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('hundreds of expanded species share one bounded row budget and remain interactive', async ({ page }) => {
  // This includes five scroll positions, folding, a dialog and responsive reflow;
  // measure interaction latency separately from the total automation runtime.
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await analyticsFixture(page, { many: true })
  await page.bringToFront()
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
  await page.evaluate(() => {
    window.analyticsPerformance = { longTasks: [], foldCommitMs: null }
    const scrollListeners = new Set()
    const add = window.addEventListener.bind(window)
    const remove = window.removeEventListener.bind(window)
    window.addEventListener = (type, listener, ...options) => {
      if (type === 'scroll') scrollListeners.add(listener)
      return add(type, listener, ...options)
    }
    window.removeEventListener = (type, listener, ...options) => {
      if (type === 'scroll') scrollListeners.delete(listener)
      return remove(type, listener, ...options)
    }
    Object.defineProperty(window.analyticsPerformance, 'activeScrollListeners', { enumerable: true, get: () => scrollListeners.size })
    new PerformanceObserver(list => window.analyticsPerformance.longTasks.push(...list.getEntries().map(x => x.duration)))
      .observe({ type: 'longtask', buffered: false })
  })
  await page.getByRole('group', { name: 'Duplicate view', exact: true }).getByRole('button', { name: 'By Pokémon', exact: true }).click()
  const headers = page.locator('button[aria-expanded]')
  await expect(headers).toHaveCount(501)
  await expect(page.locator('button[aria-expanded="true"]')).toHaveCount(501)
  await expect.poll(() => page.evaluate(() => window.analyticsPerformance.activeScrollListeners)).toBeLessThan(12)
  const samples = []
  for (const fraction of [0, .25, .5, .75, 1]) {
    await page.evaluate(f => scrollTo({ top: document.documentElement.scrollHeight * f, behavior: 'instant' }), fraction)
    samples.push(await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      mounted: document.querySelectorAll('[data-window-item]').length,
      nodes: document.querySelectorAll('*').length,
    }))))))
    await expect.poll(() => page.locator('[data-window-item]').count()).toBeLessThan(100)
  }
  await headers.last().scrollIntoViewIfNeeded()
  await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
  await expect(page.getByText('Window card 1999', { exact: true })).toBeVisible()
  await headers.first().scrollIntoViewIfNeeded()
  await headers.first().evaluate(button => {
    button.addEventListener('click', () => {
      const start = performance.now()
      const observer = new MutationObserver(() => {
        if (button.getAttribute('aria-expanded') === 'false') {
          window.analyticsPerformance.foldCommitMs = performance.now() - start
          observer.disconnect()
        }
      })
      observer.observe(button, { attributes: true, attributeFilter: ['aria-expanded'] })
    }, { once: true, capture: true })
  })
  await headers.first().click()
  await expect(headers.first()).toHaveAttribute('aria-expanded', 'false')
  await expect(headers.last()).toHaveAttribute('aria-expanded', 'true')
  await headers.last().scrollIntoViewIfNeeded()
  await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
  await page.getByText('Window card 1999', { exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.getByRole('dialog')).toBeVisible()
  console.log('ANALYTICS_PERFORMANCE', JSON.stringify({ samples, ...await page.evaluate(() => window.analyticsPerformance) }))
})
