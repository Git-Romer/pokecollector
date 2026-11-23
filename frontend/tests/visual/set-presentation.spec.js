import { expect, test } from '@playwright/test'

async function installApi(page, language = 'en') {
  const user = { id: 1, username: 'Set reader', role: 'trainer', is_active: true, must_change_password: false }
  await page.addInitScript(({ user, language }) => {
    localStorage.setItem('token', 'synthetic-set-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', language)
  }, { user, language })
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path.startsWith('/api/images/set/')) return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><text x="160" y="95" text-anchor="middle" fill="#aaa" font-family="sans-serif" font-size="48">TEST SET</text></svg>',
    })
    const responses = {
      '/api/auth/mode': { multi_user: true }, '/api/auth/me': user,
      '/api/settings/': {
        language, currency: 'EUR', tcgdex_sync_languages: 'en,de,ja', hidden_set_ids: '[]',
        set_overview_filters: '{}', price_primary: 'trend', price_display: '["trend"]',
      },
      '/api/settings/tcgdex-filter-languages': ['en', 'de', 'ja'],
      '/api/sets/': [
        { id: 'shared_de', tcg_set_id: 'shared', name: 'Deutscher Name', lang: 'de', total: 100, owned_count: 5,
          release_date: '2026-07-01', images_logo: 'https://assets.example.test/shared/logo.png',
          translated_name: 'English name', translated_name_lang: 'en' },
        { id: 'exclusive_ja', tcg_set_id: 'exclusive', name: '日本語のセット', lang: 'ja', total: 50, owned_count: 0,
          release_date: '2026-08-01', translated_name: null, translated_name_lang: null },
      ],
    }
    return route.fulfill({ json: responses[path] ?? [] })
  })
}

test('set-name translation supports hover, focus, tap, Escape and outside dismissal without navigation', async ({ page }, info) => {
  await installApi(page)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/sets')
  const card = page.locator('[data-scroll-anchor="set-shared_de"]')
  const name = card.getByRole('button', { name: 'Deutscher Name', exact: true })
  const tooltip = page.getByRole('tooltip')
  await expect(name).toBeVisible()
  if (info.project.name === 'mobile') await name.tap()
  else await name.hover()
  await expect(tooltip).toHaveText('English name')
  if (info.project.name === 'mobile') {
    // Touch compatibility mouse events must not undo the deliberate tap state.
    await name.dispatchEvent('mouseout', { relatedTarget: await page.locator('h1').elementHandle() })
    await expect(tooltip).toHaveText('English name')
    await name.tap()
    await expect(tooltip).toBeHidden()
    await name.tap()
    await expect(tooltip).toBeVisible()
  }
  await expect(name).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id'))
  const bounds = await tooltip.boundingBox()
  const viewport = page.viewportSize()
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
  await page.screenshot({ path: info.outputPath('set-translation.png') })
  await expect(page).toHaveURL(/\/sets(?:\?|$)/)
  await page.keyboard.press('Escape')
  await expect(tooltip).toBeHidden()
  await name.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(name).toBeFocused()
  await expect(tooltip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tooltip).toBeHidden()
  // A click entering from outside must not undo the hover-open event.
  await page.mouse.move(0, 0)
  await name.hover()
  await expect(tooltip).toBeVisible()
  await name.click()
  await expect(tooltip).toBeVisible()
  await page.locator('h1').click()
  await expect(tooltip).toBeHidden()
  await expect(card.getByText('Jul 2026', { exact: true })).toBeVisible()
  const unavailable = page.locator('[data-scroll-anchor="set-exclusive_ja"]')
  await expect(unavailable.getByText('日本語のセット', { exact: true })).toBeVisible()
  await expect(unavailable.getByRole('button', { name: '日本語のセット' })).toHaveCount(0)
  await expect(unavailable.getByRole('tooltip')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('set cards use their own logo as a decorative background without duplicating missing-artwork fallbacks', async ({ page }) => {
  await installApi(page)
  await page.route('**/api/images/set/exclusive_ja/logo', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><text x="160" y="95" text-anchor="middle" fill="#aaa" font-size="48">Pokémon</text></svg>',
  }))
  const symbolRequests = []
  page.on('request', request => {
    if (/\/api\/images\/set\/[^/]+\/symbol$/.test(new URL(request.url()).pathname)) symbolRequests.push(request.url())
  })
  await page.goto('/sets')
  const card = page.locator('[data-scroll-anchor="set-shared_de"]')
  const logo = card.getByRole('img', { name: 'Deutscher Name', exact: true })
  await expect(logo).toBeVisible()
  await expect.poll(() => logo.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
  const backdrop = card.locator('img[aria-hidden="true"]')
  await expect(backdrop).toHaveCount(1)
  await expect(backdrop).toHaveAttribute('src', await logo.getAttribute('src'))
  await expect(backdrop).toHaveAttribute('alt', '')
  await expect(backdrop).toHaveCSS('pointer-events', 'none')
  const alignment = await backdrop.evaluate((image) => {
    const foreground = image.parentElement.querySelector('img:not([aria-hidden="true"])')
    const backgroundBox = image.getBoundingClientRect()
    const foregroundBox = foreground.getBoundingClientRect()
    const transform = new DOMMatrixReadOnly(getComputedStyle(image).transform)
    return {
      x: Math.abs(backgroundBox.x + backgroundBox.width / 2 - foregroundBox.x - foregroundBox.width / 2),
      y: Math.abs(backgroundBox.y + backgroundBox.height / 2 - foregroundBox.y - foregroundBox.height / 2),
      rotationX: transform.b, rotationY: transform.c,
    }
  })
  expect(alignment.x).toBeLessThan(1)
  expect(alignment.y).toBeLessThan(1)
  expect(alignment.rotationX).toBe(0)
  expect(alignment.rotationY).toBe(0)
  await expect(card.locator('img')).toHaveCount(2)
  const fallbackCard = page.locator('[data-scroll-anchor="set-exclusive_ja"]')
  const fallback = fallbackCard.getByRole('img', { name: '日本語のセット', exact: true })
  await fallback.scrollIntoViewIfNeeded()
  await expect.poll(() => fallback.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
  await expect(fallbackCard.locator('img')).toHaveCount(1)
  expect(symbolRequests).toEqual([])
})

test('date labels and requested name locale follow the app language, not card language', async ({ page }) => {
  await installApi(page, 'fr')
  const request = page.waitForRequest(r => new URL(r.url()).pathname === '/api/sets/')
  await page.goto('/sets')
  expect(new URL((await request).url()).searchParams.get('name_lang')).toBe('fr')
  const card = page.locator('[data-scroll-anchor="set-shared_de"]')
  await expect(card.getByText('juil. 2026', { exact: true })).toBeVisible()
  // A cached/mismatched response must never label English metadata as French.
  await expect(card.getByRole('button', { name: 'Deutscher Name' })).toHaveCount(0)
})
