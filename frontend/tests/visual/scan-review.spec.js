import { expect, test } from '@playwright/test'

const USER = {
  id: 1,
  username: 'admin',
  role: 'admin',
  is_active: true,
  must_change_password: false,
}

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const match = (id, name, number, lang = 'en') => ({
  id: `${id}_${lang}`,
  tcg_card_id: id,
  name,
  number,
  set: 'Base Set',
  set_abbreviation: 'BS',
  rarity: 'Common',
  lang,
  image: `https://assets.tcgdex.net/${lang}/base/${id}/${number}/low.webp`,
  image_hd: `https://assets.tcgdex.net/${lang}/base/${id}/${number}/high.webp`,
})

async function installScanReviewApi(page, { failAtomic = false } = {}) {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'scan-review-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  const items = [
    {
      id: 11,
      position: 0,
      status: 'done',
      resolved: false,
      has_image: true,
      recognized: { name: 'Bill', number: '74', language: 'en' },
      matches: [match('base1-074', 'Bill', '74', 'ja'), match('base1-075', 'Professor Oak', '75')],
    },
    {
      id: 12,
      position: 1,
      status: 'done',
      resolved: false,
      has_image: true,
      recognized: { name: 'Machop', number: '52', language: 'en' },
      matches: [match('base1-052', 'Machop', '52')],
    },
    {
      id: 13,
      position: 2,
      status: 'done',
      resolved: true,
      has_image: false,
      recognized: { name: 'Potion Energy', number: '63', language: 'en' },
      matches: [match('base4-063', 'Potion Energy', '63')],
    },
    {
      id: 14,
      position: 3,
      status: 'failed',
      resolved: true,
      has_image: false,
      error: 'Provider unavailable',
      recognized: { name: 'Failed card', language: 'en' },
      matches: [],
    },
  ]
  const resolvedCards = []
  const addedPayloads = []

  const job = () => ({
    id: 7,
    total: items.length,
    processed: items.length,
    pending: 0,
    processing: 0,
    retrying: 0,
    failed: 0,
    active: 0,
    attention: items.filter(item => !item.resolved).length,
    expires_at: '2030-01-01T00:00:00Z',
    items,
  })

  await page.route('https://assets.tcgdex.net/**', route => route.fulfill({
    body: pixel,
    contentType: 'image/png',
  }))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: USER })
    if (path === '/api/settings/') return route.fulfill({ json: {
      language: 'en', currency: 'EUR', exchange_rate: 1,
      price_primary: 'trend', price_display: '["trend"]',
    } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') {
      return route.fulfill({ json: { languages: [{ code: 'en', name: 'English' }] } })
    }
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [job()] } })
    if (path === '/api/cards/recognize/jobs/7') return route.fulfill({ json: job() })
    if (/\/api\/cards\/recognize\/jobs\/7\/items\/\d+\/(image|candidates\/\d+\/image)$/.test(path)) {
      return route.fulfill({ body: pixel, contentType: 'image/png' })
    }
    const resolveMatch = path.match(/^\/api\/cards\/recognize\/jobs\/7\/items\/(\d+)\/resolve$/)
    if (resolveMatch && request.method() === 'POST') {
      const item = items.find(candidate => candidate.id === Number(resolveMatch[1]))
      if (item.resolved) return route.fulfill({ status: 409, json: { detail: 'This scan has already been handled.' } })
      item.resolved = true
      item.has_image = false
      resolvedCards.push(request.postDataJSON().card_id)
      return route.fulfill({ json: item })
    }
    const atomicMatch = path.match(/^\/api\/cards\/recognize\/jobs\/7\/items\/(\d+)\/resolve-and-add$/)
    if (atomicMatch && request.method() === 'POST') {
      if (failAtomic) return route.fulfill({ status: 503, json: { detail: 'Temporary failure' } })
      const item = items.find(candidate => candidate.id === Number(atomicMatch[1]))
      if (item.resolved) return route.fulfill({ status: 409, json: { detail: 'This scan has already been handled.' } })
      item.resolved = true
      item.has_image = false
      const payload = request.postDataJSON()
      addedPayloads.push(payload)
      resolvedCards.push(payload.confirmed_card_id)
      return route.fulfill({ json: {
        item,
        collection_item: {
          id: 99,
          card_id: payload.card_id,
          quantity: payload.quantity,
          condition: payload.condition,
          variant: payload.variant,
          lang: payload.lang,
          purchase_price: payload.purchase_price,
          has_scan_photo: true,
          card: { id: payload.card_id, images_small: 'cached' },
        },
      } })
    }
    if (path === '/api/collection/' && request.method() === 'POST') {
      return route.fulfill({ json: {
        id: 99,
        has_scan_photo: true,
        card: { id: request.postDataJSON().card_id, images_small: 'cached' },
      } })
    }
    if (path === '/api/sync/status') {
      return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    }
    return route.fulfill({ json: {} })
  })

  return { items, resolvedCards, addedPayloads }
}

test('linked review is accessible, advances through a batch, and keeps resolved rows read-only', async ({ page }) => {
  const api = await installScanReviewApi(page)
  await page.goto('/scans/7')

  await expect(page.getByText('Bill', { exact: true }).first()).toBeVisible()
  const firstCandidate = page.getByRole('button', { name: 'Compare with your photo' }).first()
  await expect(firstCandidate.locator('..').getByText('🇯🇵 JA', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand photo' }).first().click()
  let dialog = page.getByRole('dialog', { name: 'Compare with your photo' })
  const photoOnlyImage = dialog.getByAltText('Your photo')
  const photoOnlyFrame = await photoOnlyImage.evaluate(node => {
    const frame = node.parentElement.getBoundingClientRect()
    return { width: frame.width, height: frame.height }
  })
  await photoOnlyImage.click()
  await expect.poll(() => photoOnlyImage.evaluate(node => node.style.transform)).toContain('scale(2)')
  await photoOnlyImage.click()
  await expect(dialog).toBeVisible()
  await expect.poll(() => photoOnlyImage.evaluate(node => node.style.transform)).toBe('')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)

  await page.getByRole('button', { name: 'Compare with your photo' }).first().click()

  dialog = page.getByRole('dialog', { name: 'Compare with your photo' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Bill', { exact: true })).toBeVisible()
  await expect.poll(() => dialog.evaluate(node => getComputedStyle(node).cursor)).toBe('default')
  await expect(dialog.locator('figure')).toHaveCount(2)
  const frameSizes = await dialog.locator('figure').evaluateAll(figures => figures.map(figure => {
    const frame = figure.firstElementChild.getBoundingClientRect()
    return { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
  }))
  const viewport = page.viewportSize()
  if (viewport.width < 768) {
    expect(Math.abs(frameSizes[0].x - frameSizes[1].x)).toBeLessThan(1)
    expect(frameSizes[1].y).toBeGreaterThan(frameSizes[0].y)
    expect(frameSizes[0].width).toBeGreaterThan(viewport.width * 0.45)
    const surfaceSize = await dialog.locator('figure').first().evaluate(figure => {
      const surface = figure.parentElement.parentElement
      return { clientHeight: surface.clientHeight, scrollHeight: surface.scrollHeight }
    })
    expect(surfaceSize.scrollHeight).toBeLessThanOrEqual(surfaceSize.clientHeight + 1)
  } else {
    expect(frameSizes[1].x).toBeGreaterThan(frameSizes[0].x)
    expect(Math.abs(frameSizes[0].y - frameSizes[1].y)).toBeLessThan(1)
  }
  expect(Math.abs(frameSizes[0].width - frameSizes[1].width)).toBeLessThan(1)
  expect(Math.abs(frameSizes[0].height - frameSizes[1].height)).toBeLessThan(1)
  expect(frameSizes[0].height / frameSizes[0].width).toBeCloseTo(7 / 5, 2)
  expect(photoOnlyFrame.width).toBeGreaterThan(frameSizes[0].width)
  await expect.poll(() => dialog.locator('figcaption').first().evaluate(
    node => getComputedStyle(node).fontSize,
  )).toBe('14px')
  await expect.poll(() => dialog.getByText('Base Set · Common · JA').evaluate(
    node => getComputedStyle(node).fontSize,
  )).toBe('14px')
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('dialog')

  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByText('Professor Oak', { exact: true })).toBeVisible()
  await page.keyboard.press('ArrowLeft')

  const candidateImage = dialog.getByAltText('Bill')
  await expect.poll(() => candidateImage.evaluate(node => getComputedStyle(node.parentElement).cursor)).toBe('zoom-in')
  await candidateImage.click()
  await expect.poll(() => candidateImage.evaluate(node => node.style.transform)).toContain('scale(')
  await expect.poll(() => candidateImage.evaluate(node => getComputedStyle(node.parentElement).cursor)).toBe('grab')
  const photoImage = dialog.getByAltText('Your photo')
  const originBeforeDrag = await candidateImage.evaluate(node => node.style.transformOrigin)
  const cardBox = await candidateImage.boundingBox()
  const startX = cardBox.x + cardBox.width / 2
  const startY = cardBox.y + cardBox.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  for (let offset = 1; offset <= 10; offset += 1) {
    await page.mouse.move(startX + offset, startY)
  }
  await page.mouse.up()
  await expect(dialog).toBeVisible()
  await expect.poll(() => candidateImage.evaluate(node => node.style.transform)).toContain('scale(2)')
  await expect.poll(() => candidateImage.evaluate(node => node.style.transformOrigin)).not.toBe(originBeforeDrag)
  const originAfterDrag = await candidateImage.evaluate(node => node.style.transformOrigin)
  await expect.poll(() => photoImage.evaluate(node => node.style.transformOrigin)).toBe(originAfterDrag)
  await candidateImage.click()
  await expect(dialog).toBeVisible()
  await expect.poll(() => candidateImage.evaluate(node => node.style.transform)).toBe('')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  // The queue itself is a modal and keeps the page locked after the nested
  // comparison closes; the comparison must preserve that existing lock.
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden')

  await page.getByRole('button', { name: 'Compare with your photo' }).first().click()
  await dialog.getByRole('button', { name: 'Accept match' }).click()
  const addDialog = page.getByRole('dialog', { name: 'Add to collection' })
  await expect(addDialog).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('dialog')
  await page.keyboard.press('Shift+Tab')
  expect(await addDialog.evaluate(dialogNode => dialogNode.contains(document.activeElement))).toBe(true)
  await addDialog.getByRole('button', { name: 'Add to collection' }).click()

  await expect(dialog.getByText('Machop', { exact: true })).toBeVisible()
  await expect.poll(() => api.resolvedCards).toEqual(['base1-074'])
  await expect.poll(() => api.addedPayloads[0]?.lang).toBe('ja')
  await dialog.getByRole('button', { name: 'Close' }).click()

  const resolvedBill = page.getByRole('button', { name: /Bill/ })
  await expect(resolvedBill).toBeVisible()
  await resolvedBill.click()
  const resolvedPanel = page.locator('article').filter({ hasText: 'Bill' })
  await expect(resolvedPanel.getByRole('button', { name: 'Add to collection' })).toHaveCount(0)
  await resolvedPanel.getByRole('button', { name: 'Compare with your photo' }).first().click()
  await expect(dialog.getByRole('button', { name: 'Accept match' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close' }).click()

  const failedRow = page.getByRole('button', { name: /Failed card/ })
  await failedRow.click()
  await expect(page.locator('article').filter({ hasText: 'Failed card' }).getByRole('button', { name: 'Retry' })).toHaveCount(0)

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('a failed atomic add keeps the current review open and does not advance', async ({ page }) => {
  const api = await installScanReviewApi(page, { failAtomic: true })
  await page.goto('/scans/7')

  await page.getByRole('button', { name: 'Compare with your photo' }).first().click()
  const compareDialog = page.getByRole('dialog', { name: 'Compare with your photo' })
  await compareDialog.getByRole('button', { name: 'Accept match' }).click()
  const addDialog = page.getByRole('dialog', { name: 'Add to collection' })
  await addDialog.getByRole('button', { name: 'Add to collection' }).click()

  await expect(addDialog).toBeVisible()
  await expect(addDialog.getByText('Bill', { exact: true })).toBeVisible()
  expect(api.resolvedCards).toEqual([])
  expect(api.items.find(item => item.id === 11).resolved).toBe(false)
})
