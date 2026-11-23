import { test, expect } from '@playwright/test'

async function fixture(page, kind) {
  const user = { id: 1, username: 'Fixture owner', role: 'admin', is_active: true, must_change_password: false }
  await page.addInitScript(user => {
    localStorage.setItem('token', 'offline-fixture')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, user)
  const card = n => ({ id: `bulk-${n}_en`, name: n === 1 ? 'First card' : 'Second card', number: `${n}`, lang: 'en', supertype: 'Pokemon', types: ['Lightning'], set_id: 'bulk_en', set_ref: { id: 'bulk_en', name: 'Fixture set' } })
  const owned = [1, 2].map(n => ({ id: n, card_id: card(n).id, card: card(n), quantity: n === 1 ? 3 : 2, variant: 'Normal', condition: 'NM', lang: 'en', printing_details: [] }))
  let rows = [1, 2].map(n => ({ ...card(n), id: 100 + n, binder_card_id: 100 + n, card_id: card(n).id, card: card(n), collection_item_id: n, required_quantity: n === 1 ? 3 : 2, quantity: n === 1 ? 3 : 2, owned_quantity: n === 1 ? 3 : 2, available_quantity: 3, missing_quantity: 0 }))
  const binder = { id: 11, name: 'Fixture binder', binder_type: kind === 'planned-binder' ? 'wishlist' : 'collection', color: '#e3000b' }
  const deck = { id: 22, name: 'Fixture deck', binder_type: kind === 'real-deck' ? 'physical_deck' : 'deck', target_size: 60, current_card_count: 5, missing_copy_count: 0, shared_missing_copy_count: 0, status: 'under', format: 'Casual', composition_counts: { Pokemon: 5 }, validation: { checks: [], errors: [], warnings: [] } }
  const control = { requests: [], fail: false, delay: false }
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (request.method() === 'POST' && path.endsWith('/bulk-delete')) {
      control.requests.push({ path, body: request.postDataJSON() })
      if (control.delay) await new Promise(resolve => { control.release = resolve })
      if (control.fail) return route.fulfill({ status: 409, json: { detail: typeof control.fail === 'object' ? control.fail : 'Release allocated copies first. Nothing was removed.' } })
      const ids = request.postDataJSON().item_ids
      if (path.startsWith('/api/collection/')) owned.splice(0, owned.length, ...owned.filter(item => !ids.includes(item.id)))
      else rows = rows.filter(item => !ids.includes(item.id))
      return route.fulfill({ json: { removed_ids: ids, removed_entries: ids.length, removed_copies: 5 } })
    }
    if (request.method() === 'POST' && path.endsWith('/release-assignments')) {
      control.requests.push({ path, body: request.postDataJSON() }); control.fail = false
      return route.fulfill({ json: { released_assignments: 1, released_copies: 2 } })
    }
    if (request.method() === 'POST' && path === '/api/products/cards/bulk-unlink') {
      const body = request.postDataJSON(); control.requests.push({ path, body })
      if (control.unlinkFailure) return route.fulfill({ status: 409, json: { detail: { code: 'product_unlink_conflict', changed: false, message: control.unlinkFailure, blockers: [{ code: 'product_history_protected', product_card_id: body.links[1]?.product_card_id }] } } })
      const removed = new Set(body.links.map(link => link.product_card_id))
      const conflicts = control.fail.conflicts.map(card => ({ ...card, products: card.products.filter(product => !removed.has(product.product_card_id)) })).filter(card => card.products.length || card.assignments.length)
      control.fail = conflicts.length ? { ...control.fail, conflicts } : false
      return route.fulfill({ json: { unlinked_ids: [...removed], unlinked_links: removed.size, unlinked_copies: body.links.reduce((sum, link) => sum + link.active_quantity, 0) } })
    }
    if (request.method() === 'DELETE' && path.startsWith('/api/products/')) {
      control.requests.push({ path, params: Object.fromEntries(new URL(request.url()).searchParams) })
      if (control.unlinkFailure) return route.fulfill({ status: 409, json: { detail: control.unlinkFailure } })
      control.fail = false
      return route.fulfill({ json: { id: 5, product_cards: [] } })
    }
    if (request.method() !== 'GET') throw Error(`Unexpected mutation: ${request.method()} ${path}`)
    const responses = {
      '/api/auth/mode': { multi_user: true }, '/api/auth/me': user,
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'EUR' },
      '/api/settings/tcgdex-filter-languages': ['en'], '/api/profile/': { feature_enabled: false },
      '/api/collection/': owned, '/api/collection/printing-detail-tags': [], '/api/wishlist/': [], '/api/sets/': [],
      '/api/binders/': [binder], '/api/decks/': [],
      '/api/binders/11/cards': { binder, cards: rows, available_collection_item_quantities: {} },
      '/api/decks/22': { ...deck, entries: rows },
    }
    await route.fulfill({ json: responses[path] ?? {} })
  })
  const collection = kind.startsWith('collection')
  await page.goto(collection ? '/collection' : kind.includes('binder') ? '/binders/11' : '/decks/22')
  if (kind === 'collection-list') await page.getByRole('button', { name: 'List view', exact: true }).click()
  return control
}

for (const kind of ['collection-grid', 'collection-list', 'physical-binder', 'planned-binder', 'planned-deck', 'real-deck']) {
  test(`${kind} selects and removes only inside its own view after confirmation`, async ({ page }) => {
    const control = await fixture(page, kind)
    await page.getByRole('button', { name: 'Select cards', exact: true }).click()
    const actions = page.getByRole('region', { name: 'Selection actions' })
    expect(await actions.evaluate(element => Boolean(element.closest('header')))).toBe(true)
    await expect(actions).not.toContainText('All copies in each selected entry')
    await expect(page.getByRole('button', { name: 'Remove selected', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Select visible', exact: true }).click()
    await expect(page.getByText('2 entries · 5 copies selected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('2 entries containing 5 copies')
    await expect(dialog).toContainText(kind.startsWith('collection') ? 'collection' : kind.includes('binder') ? 'binder' : 'deck')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(control.requests).toEqual([])
    await expect(page.getByText('2 entries · 5 copies selected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
    await dialog.getByRole('button', { name: 'Remove selected', exact: true }).click()
    await expect.poll(() => control.requests.length).toBe(1)
    expect(control.requests[0]).toEqual({
      path: kind.startsWith('collection') ? '/api/collection/bulk-delete' : kind.includes('binder') ? '/api/binders/11/entries/bulk-delete' : '/api/decks/22/entries/bulk-delete',
      body: { item_ids: kind.startsWith('collection') ? [1, 2] : [101, 102] },
    })
    await expect(page.getByRole('button', { name: 'Remove selected', exact: true })).toHaveCount(0)
  })
}

test('conflict dialog names cards and lists and separates release from collection deletion', async ({ page }) => {
  const control = await fixture(page, 'collection-grid')
  control.fail = { code: 'collection_assignment_conflict', message: 'Nothing was removed.', conflicts: [{
    item_id: 1, name: 'First card', variant: 'Normal', condition: 'NM', lang: 'en', quantity: 3,
    assignments: [{ assignment_id: 301, list_id: 11, item_id: 1, quantity: 2, list_name: 'Fixture binder', list_type: 'collection' }], products: [],
  }] }
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Selection actions' })).toBeVisible()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove selected', exact: true }).click()
  const popup = page.getByRole('dialog', { name: 'These cards are still assigned' })
  await expect(popup).toContainText('First card')
  await expect(popup.getByRole('link', { name: 'Fixture binder' })).toHaveAttribute('href', '/binders/11')
  await expect(popup).toContainText('2 copies')
  await popup.getByRole('button', { name: 'Remove listed assignments', exact: true }).click()
  expect(control.requests).toHaveLength(1)
  await popup.getByRole('button', { name: 'Confirm removal of assignments', exact: true }).click()
  await expect(popup).toContainText('Your collection has not been deleted')
  expect(control.requests).toHaveLength(2)
  expect(control.requests[1].body).toEqual({ item_ids: [1, 2], assignments: [{ assignment_id: 301, list_id: 11, item_id: 1, quantity: 2 }] })
  await popup.getByRole('button', { name: 'Retry collection removal', exact: true }).click()
  expect(control.requests).toHaveLength(2)
  await page.getByRole('dialog').getByRole('button', { name: 'Remove selected', exact: true }).click()
  await expect.poll(() => control.requests.length).toBe(3)
})

test('product unlink requires confirmation and preserves ownership until a separate retry', async ({ page }) => {
  const control = await fixture(page, 'collection-grid')
  control.fail = { code: 'collection_product_link_conflict', conflicts: [{ item_id: 1, name: 'First card', quantity: 3,
    assignments: [], products: [{ product_id: 5, product_card_id: 9, product_name: 'Protected box', active_quantity: 2 }] }] }
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove selected', exact: true }).click()
  const popup = page.getByRole('dialog', { name: 'These cards are still assigned' })
  await expect(popup.getByRole('link', { name: 'Protected box' })).toHaveAttribute('href', '/products')
  await expect(popup.getByRole('button', { name: 'Remove listed assignments', exact: true })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'Retry collection removal', exact: true })).toBeDisabled()
  await popup.getByRole('button', { name: 'Unlink from product', exact: true }).click()
  await expect(popup).toContainText('Unlink 2 copies of First card from Protected box?')
  expect(control.requests).toHaveLength(1)
  await popup.getByRole('button', { name: 'Cancel unlink', exact: true }).click()
  expect(control.requests).toHaveLength(1)
  await popup.getByRole('button', { name: 'Unlink from product', exact: true }).click()
  await popup.getByRole('button', { name: 'Confirm unlink', exact: true }).click()
  await expect(popup).toContainText('Your collection has not been deleted')
  expect(control.requests[1]).toEqual({ path: '/api/products/5/cards/9', params: { expected_collection_item_id: '1', expected_active_quantity: '2' } })
  await expect(popup.getByRole('button', { name: 'Retry collection removal', exact: true })).toBeEnabled()
  await popup.getByRole('button', { name: 'Retry collection removal', exact: true }).click()
  expect(control.requests).toHaveLength(2)
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('2 entries · 5 copies selected', { exact: true })).toBeVisible()
})

test('failed product unlink keeps its blocker and cannot bypass history protection', async ({ page }) => {
  const control = await fixture(page, 'collection-grid')
  control.unlinkFailure = 'Cannot unlink a card that has sale or trade history'
  control.fail = { code: 'collection_product_link_conflict', conflicts: [{ item_id: 1, name: 'First card', quantity: 3,
    assignments: [], products: [{ product_id: 5, product_card_id: 9, product_name: 'Historical box', active_quantity: 2 }] }] }
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove selected', exact: true }).click()
  const popup = page.getByRole('dialog', { name: 'These cards are still assigned' })
  await popup.getByRole('button', { name: 'Unlink from product', exact: true }).click()
  await popup.getByRole('button', { name: 'Confirm unlink', exact: true }).click()
  await expect(popup.getByRole('alert')).toContainText(control.unlinkFailure)
  await expect(popup.getByRole('link', { name: 'Historical box' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Retry collection removal', exact: true })).toBeDisabled()
  expect(control.requests).toHaveLength(2)
})

test('unlinking one product does not dismiss another product blocker', async ({ page }) => {
  const control = await fixture(page, 'collection-grid')
  control.fail = { code: 'collection_product_link_conflict', conflicts: [{ item_id: 1, name: 'First card', quantity: 3,
    assignments: [], products: [{ product_id: 5, product_card_id: 9, product_name: 'First box', active_quantity: 2 }, { product_id: 6, product_card_id: 10, product_name: 'Second box', active_quantity: 1 }] }] }
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove selected', exact: true }).click()
  const popup = page.getByRole('dialog', { name: 'These cards are still assigned' })
  await popup.getByRole('button', { name: 'Unlink from product', exact: true }).first().click()
  await popup.getByRole('button', { name: 'Confirm unlink', exact: true }).click()
  await expect(popup.getByRole('link', { name: 'First box', exact: true })).toHaveCount(0)
  await expect(popup.getByRole('link', { name: 'Second box', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Retry collection removal', exact: true })).toBeDisabled()
})

test('bulk product unlink keeps every blocker on failure and retries as one confirmed request', async ({ page }) => {
  const control = await fixture(page, 'collection-grid')
  control.unlinkFailure = 'Some product links cannot be unlinked. Nothing was changed.'
  control.fail = { code: 'collection_product_link_conflict', conflicts: [
    { item_id: 1, name: 'First card', quantity: 3, assignments: [], products: [{ product_id: 5, product_card_id: 9, product_name: 'First box', active_quantity: 2 }] },
    { item_id: 2, name: 'Second card', quantity: 2, assignments: [], products: [{ product_id: 6, product_card_id: 10, product_name: 'Second box', active_quantity: 2 }] },
  ] }
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove selected', exact: true }).click()
  const popup = page.getByRole('dialog', { name: 'These cards are still assigned' })
  await popup.getByRole('button', { name: 'Unlink listed products', exact: true }).click()
  await expect(popup).toContainText('Unlink 2 product links covering 4 copies?')
  expect(control.requests).toHaveLength(1)
  await popup.getByRole('button', { name: 'Confirm unlink of products', exact: true }).click()
  await expect(popup.getByRole('alert')).toContainText(control.unlinkFailure)
  await expect(popup.getByRole('link', { name: 'First box', exact: true })).toBeVisible()
  await expect(popup.getByRole('link', { name: 'Second box', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Retry collection removal', exact: true })).toBeDisabled()
  expect(control.requests[1]).toEqual({ path: '/api/products/cards/bulk-unlink', body: { links: [
    { product_id: 5, product_card_id: 9, collection_item_id: 1, active_quantity: 2 },
    { product_id: 6, product_card_id: 10, collection_item_id: 2, active_quantity: 2 },
  ] } })
  control.unlinkFailure = null
  await popup.getByRole('button', { name: 'Confirm unlink of products', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Retry collection removal', exact: true })).toBeEnabled()
  await expect(popup.getByRole('link', { name: 'First box', exact: true })).toHaveCount(0)
  await expect(popup.getByRole('link', { name: 'Second box', exact: true })).toHaveCount(0)
  expect(control.requests).toHaveLength(3)
  await popup.getByRole('button', { name: 'Retry collection removal', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByText('2 entries · 5 copies selected', { exact: true })).toBeVisible()
})

test('mobile selection bar stays above navigation without covering the last card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 })
  await fixture(page, 'collection-grid')
  const toggle = page.getByRole('button', { name: 'Select cards', exact: true })
  await toggle.click()
  const bar = page.getByRole('region', { name: 'Selection actions' })
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const barBox = await bar.boundingBox()
  const cardBox = await page.locator('button.unified-card-primary-action').last().boundingBox()
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(522)
  expect(cardBox.y + cardBox.height).toBeLessThan(barBox.y)
  await expect(bar.getByRole('button', { name: 'Cancel selection', exact: true })).toBeInViewport()
})

test('collection failure keeps entries and selection for correction or retry', async ({ page }) => {
  const control = await fixture(page, 'collection-grid')
  control.fail = true
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove selected', exact: true }).click()
  await expect(page.getByText('Release allocated copies first. Nothing was removed.', { exact: true })).toBeVisible()
  await expect(page.getByText('2 entries · 5 copies selected', { exact: true })).toBeVisible()
  expect(control.requests).toHaveLength(1)
})

test('selection clears when leaving selection mode', async ({ page }) => {
  await fixture(page, 'collection-grid')
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel selection', exact: true }).click()
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await expect(page.getByText('0 entries · 0 copies selected', { exact: true })).toBeVisible()
})


test('grid selection supports keyboard toggles without opening an editor', async ({ page }) => {
  await fixture(page, 'collection-grid')
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  const cards = page.locator('button.unified-card-primary-action')
  await cards.nth(0).press('Space')
  await expect(cards.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('1 entries · 3 copies selected', { exact: true })).toBeVisible()
  await cards.nth(1).press('Enter')
  await expect(page.getByText('2 entries · 5 copies selected', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await cards.nth(0).press('Space')
  await expect(cards.nth(0)).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('1 entries · 2 copies selected', { exact: true })).toBeVisible()
})

test('filtering drops hidden selections instead of deleting hidden entries', async ({ page }) => {
  const control = await fixture(page, 'collection-grid')
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await page.getByPlaceholder('Search cards...', { exact: true }).fill('First card')
  await expect(page.getByText('1 entries · 3 copies selected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove selected', exact: true }).click()
  await expect.poll(() => control.requests.length).toBe(1)
  expect(control.requests[0].body).toEqual({ item_ids: [1] })
})

test('a pending removal locks selection and cannot be submitted twice', async ({ page }) => {
  const control = await fixture(page, 'planned-deck')
  control.delay = true
  await page.getByRole('button', { name: 'Select cards', exact: true }).click()
  await page.getByRole('button', { name: 'Select visible', exact: true }).click()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove selected', exact: true }).click()
  try {
    await expect.poll(() => Boolean(control.release)).toBe(true)
    await expect(page.getByRole('button', { name: 'Remove selected', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Cancel selection', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Remove selected', exact: true }).evaluate(button => { button.click(); button.click() })
    expect(control.requests).toHaveLength(1)
  } finally {
    control.release?.()
  }
  await expect(page.getByRole('button', { name: 'Remove selected', exact: true })).toHaveCount(0)
})
