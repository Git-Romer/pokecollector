import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { collectionFixture, expectNoCardPageErrors } from './helpers/windowed-cards'

test.afterEach(({ page }) => expectNoCardPageErrors(page))

test('set checklists use the same bounded responsive card window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await collectionFixture(page, {
    routePath: '/sets/window_en',
    extraResponses: items => ({ '/api/sets/window_en/checklist': {
      set: { id: 'window_en', name: 'Window set', card_count: items.length },
      cards: items.map(item => item.card), total: items.length, owned: 0,
    } }),
  })
  const grid = page.locator('[data-windowed-grid]')
  await expect(grid).toHaveCount(1)
  await expect.poll(() => grid.locator('[data-window-item]').count()).toBeLessThan(150)
  await page.evaluate(() => scrollTo(0, 18000))
  await expect.poll(() => grid.locator('[data-window-item]').first().getAttribute('aria-posinset').then(Number)).toBeGreaterThan(30)
  await expect.poll(() => grid.locator('[data-window-item]').count()).toBeGreaterThan(0)
})


const binderResponses = items => ({
  '/api/binders/1/cards': {
    binder: { id: 1, name: 'Window binder', binder_type: 'collection' },
    cards: items.map(item => ({ ...item, binder_card_id: item.id, required_quantity: 1, owned_quantity: 1 })),
  },
})

test('binder galleries keep full-data selection while bounding mounted cards', async ({ page }) => {
  await collectionFixture(page, { routePath: '/binders/1', extraResponses: binderResponses })
  const grid = page.getByTestId('card-list-gallery')
  await expect(page.locator('[data-testid="card-list-gallery"][data-windowed-grid]')).toHaveCount(1)
  await expect.poll(() => grid.locator('.unified-card-frame').count()).toBeLessThan(150)
  await page.evaluate(() => scrollTo(0, 18000))
  await expect.poll(() => grid.locator('[data-window-item]').first().getAttribute('aria-posinset').then(Number)).toBeGreaterThan(30)
})


test('owned-card pickers window all filtered entries in their own scroll container', async ({ page }) => {
  await collectionFixture(page, { routePath: '/binders/1', extraResponses: items => {
    const response = binderResponses(items)
    response['/api/binders/1/cards'].available_collection_item_quantities = Object.fromEntries(items.map(item => [item.id, 1]))
    return response
  } })
  await page.getByRole('button', { name: 'Add cards', exact: true }).click()
  const grid = page.getByTestId('card-list-picker-grid')
  await expect(page.locator('[data-testid="card-list-picker-grid"][data-windowed-grid]')).toHaveCount(1)
  await expect(grid.locator('[data-window-item]').first()).toHaveAttribute('aria-setsize', '2000')
  await grid.scrollIntoViewIfNeeded()
  const pageY = await page.evaluate(() => scrollY)
  await grid.evaluate(e => { e.parentElement.scrollTop = 18000 })
  await expect.poll(() => grid.locator('[data-window-item]').first().getAttribute('aria-posinset').then(Number)).toBeGreaterThan(30)
  await expect.poll(() => grid.locator('[data-window-item]').count()).toBeLessThan(150)
  expect(Math.abs(await page.evaluate(() => scrollY) - pageY)).toBeLessThan(2)
  await grid.evaluate(e => { e.parentElement.scrollTop = e.parentElement.scrollHeight })
  await expect(grid.locator('[aria-posinset="2000"]')).toBeVisible()
})


const sharedResponses = items => {
  const cards = items.map(item => ({ ...item.card, image: '/cardback.jpg', quantity: 1 }))
  const entries = items.map(item => ({ ...item, required_quantity: 1, owned_quantity: 1 }))
  const deck = { id: 1, name: 'Window deck', binder_type: 'physical_deck', format: 'Standard', target_size: 60, entries }
  return {
    ...binderResponses(items),
    '/api/cards/search': { data: cards, total_count: cards.length, page: 1, page_size: cards.length },
    '/api/collection/user/2': items,
    '/api/pokedex/1': { id: 1, dex_id: 1, name_en: 'Bulbasaur', name_de: 'Bisasam', types: [], available_printings: cards.length },
    '/api/decks/1': deck,
    '/api/public/profiles/fixture': { handle: 'fixture', display_name: 'Fixture owner', stats: {} },
    '/api/public/profiles/fixture/decks/1': deck,
    '/api/public/profiles/fixture/wishlist': { handle: 'fixture', cards, total: cards.length, page_size: cards.length, sets: [], rarities: [] },
    '/api/public/profiles/fixture/binders/1': { id: 1, name: 'Window public binder', cards },
  }
}

for (const [name, routePath] of [
  ['search results', '/search?q=Window'],
  ['other-user collections', '/collection/user/2'],
  ['Pokédex card printings', '/pokedex/1'],
  ['deck galleries', '/decks/1'],
  ['public deck galleries', '/u/fixture/deck/1'],
  ['public wishlist galleries', '/u/fixture/wishlist'],
]) test(`${name} use bounded card rows without truncating their data`, async ({ page }) => {
  await collectionFixture(page, { routePath, extraResponses: sharedResponses })
  const grid = page.locator('[data-windowed-grid]').last()
  await expect(grid).toHaveCount(1)
  await expect.poll(() => grid.locator('.unified-card-frame').count()).toBeLessThan(150)
  await expect(grid.locator('[data-window-item]').first()).toHaveAttribute('aria-setsize', '2000')
  const reserved = await grid.evaluate(e => e.getBoundingClientRect().height)
  await page.evaluate(() => scrollTo(0, 18000))
  await expect.poll(() => grid.locator('[data-window-item]').first().getAttribute('aria-posinset').then(Number)).toBeGreaterThan(20)
  expect(Math.abs(await grid.evaluate(e => e.getBoundingClientRect().height) - reserved)).toBeLessThan(3)
})


test('public binder stacks reserve room for their complete captions and extra metadata', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await collectionFixture(page, { routePath: '/u/fixture/binder/1', readySelector: 'article', extraResponses: sharedResponses })
  const grid = page.locator('[data-windowed-grid]')
  await expect(grid).toHaveCount(1)
  await expect.poll(() => grid.locator('[data-window-item]').count()).toBeLessThan(150)
  const overflow = await grid.locator('[data-window-row]').first().evaluate(row => Math.max(...[...row.children].map(item => item.getBoundingClientRect().height)) - row.getBoundingClientRect().height)
  expect(overflow).toBeLessThan(1)
  const expectedGeometry = () => grid.evaluate(grid => {
    const row = grid.querySelector('[data-window-row]')
    const columns = getComputedStyle(row).gridTemplateColumns.split(' ').length
    const count = Number(grid.querySelector('[data-window-item]').getAttribute('aria-setsize'))
    const gap = parseFloat(getComputedStyle(grid).rowGap)
    return Math.abs(grid.getBoundingClientRect().height - (Math.ceil(count / columns) * (row.getBoundingClientRect().height + gap) - gap))
  })
  await expect.poll(expectedGeometry).toBeLessThan(1)
  const reserved = await grid.evaluate(e => e.getBoundingClientRect().height)
  await page.evaluate(() => scrollTo(0, 18000))
  await expect.poll(() => grid.locator('[data-window-item]').first().getAttribute('aria-posinset').then(Number)).toBeGreaterThan(20)
  expect(Math.abs(await grid.evaluate(e => e.getBoundingClientRect().height) - reserved)).toBeLessThan(3)
  for (const width of [1440, 1500, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await expect.poll(expectedGeometry).toBeLessThan(1)
    await expect.poll(() => grid.locator('[data-window-item]').count()).toBeLessThan(150)
  }
})


test('scanner photo grids use the dialog scroller and retain staged files while recycling rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await collectionFixture(page, { routePath: '/search?q=Window', extraResponses: sharedResponses })
  await page.getByTitle('Scan card', { exact: true }).click()
  const dialog = page.getByRole('dialog').last()
  const png = readFileSync(new URL('../../public/holo-effects/textures/geometric.png', import.meta.url))
  await dialog.locator('input[type="file"][multiple]').setInputFiles(Array.from({ length: 50 }, (_, n) => ({ name: `photo-${n}.png`, mimeType: 'image/png', buffer: png })))
  const grid = dialog.locator('[data-windowed-grid]')
  await expect(grid).toHaveCount(1)
  await expect(grid.locator('[data-window-item]').first()).toHaveAttribute('aria-setsize', '50')
  await grid.evaluate(e => {
    let p = e.parentElement
    while (p && p.scrollHeight <= p.clientHeight + 1) p = p.parentElement
    p.scrollTop = p.scrollHeight
  })
  await expect(grid.locator('[aria-posinset="50"]')).toBeVisible()
  await grid.locator('[aria-posinset="50"]').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(grid.locator('[data-window-item]').first()).toHaveAttribute('aria-setsize', '49')
})


test('scan review candidates recycle rows without losing their original match index', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await collectionFixture(page, { routePath: '/scans/1', readySelector: 'article', extraResponses: items => ({
    '/api/cards/recognize/jobs': { jobs: [] },
    '/api/cards/recognize/jobs/1': { id: 1, total: 1, processed: 1, attention: 1, active: 0, items: [{ id: 1, position: 0, status: 'done', resolved: false, has_image: false, recognized: { name: 'Candidate fixture' }, matches: items.slice(0, 200).map(item => ({ ...item.card, image: '/cardback.jpg' })) }] },
  }) })
  const grid = page.locator('[data-windowed-grid]')
  await expect(grid).toHaveCount(1)
  await expect(grid.locator('[data-window-item]').first()).toHaveAttribute('aria-setsize', '200')
  await expect.poll(() => grid.locator('[data-window-item]').count()).toBeLessThan(150)
  await grid.evaluate(e => {
    let p = e.parentElement
    while (p && (!/(auto|scroll)/.test(getComputedStyle(p).overflowY) || p.scrollHeight <= p.clientHeight + 1)) p = p.parentElement
    if (p && p !== document.body) p.scrollTop = p.scrollHeight
    else window.scrollTo(0, document.documentElement.scrollHeight)
  })
  await expect(grid.locator('[aria-posinset="200"]')).toBeVisible()
})


test('a far-down card-owned dialog survives responsive column changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await collectionFixture(page, { routePath: '/pokedex/1', extraResponses: sharedResponses })
  await page.evaluate(() => scrollTo(0, 18000))
  const item = page.locator('[data-window-item]').filter({ has: page.locator('.unified-card-primary-action') })
  const id = await item.evaluateAll(items => items.find(e => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 70 })?.dataset.windowItem)
  expect(id).toBeTruthy()
  await page.locator(`[data-window-item="${id}"] .unified-card-primary-action`).press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.locator(`[data-window-item="${id}"]`)).toBeAttached()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})


test('keyboard focus survives responsive regrouping and pins only its own offscreen card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await collectionFixture(page, { routePath: '/pokedex/1', extraResponses: sharedResponses })
  await page.evaluate(() => scrollTo(0, 18000))
  let id
  await expect.poll(async () => {
    id = await page.locator('[data-window-item]').evaluateAll(items => items.find(e => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 70 })?.dataset.windowItem)
    return id
  }).toBeTruthy()
  const item = page.locator(`[data-window-item="${id}"]`)
  const action = item.locator('.unified-card-primary-action')
  await action.focus()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(action).toBeFocused()
  await page.evaluate(() => scrollTo(0, 50000))
  await expect(action).toBeFocused()
  await expect(item).toHaveCount(1)
  await expect.poll(() => page.locator('[data-window-item]').count()).toBeLessThan(160)
  await action.evaluate(e => e.blur())
  await expect(item).toHaveCount(0)
})
