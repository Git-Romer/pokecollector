import { expect, test } from '@playwright/test'

const USER = {
  id: 1,
  username: 'Photo Reviewer',
  role: 'admin',
  is_active: true,
  must_change_password: false,
}

async function installCustomCardPhotoFixture(page, { referenceArtwork = false } = {}) {
  let hasPhoto = false
  let uploads = 0
  let deletes = 0
  let photoReads = 0
  const cardBackResponse = await page.request.get('/cardback.jpg')
  const cardBack = await cardBackResponse.body()
  const card = {
    id: 'custom-photo-review',
    card_id: 'custom-photo-review',
    name: referenceArtwork ? 'Custom card with artwork' : 'Custom card without artwork',
    number: '001',
    set_id: 'custom-review-set',
    set_name: 'Review Set',
    set_ref: { id: 'custom-review-set', name: 'Review Set', abbreviation: 'REV' },
    is_custom: true,
    images_small: referenceArtwork ? 'https://example.test/reference.webp' : null,
    images_large: referenceArtwork ? 'https://example.test/reference.webp' : null,
    image: null,
    custom_image_url: null,
    price_market: 0,
    price_trend: 0,
  }

  await page.addInitScript(user => {
    localStorage.setItem('token', 'photo-review-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname

    if (!path.startsWith('/api/')) {
      await route.continue()
      return
    }

    if (path === '/api/collection/1/photo') {
      if (request.method() === 'POST') {
        expect(request.headers()['content-type']).toContain('multipart/form-data')
        uploads += 1
        hasPhoto = true
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"collection_item_id":1,"bytes":64}',
        })
        return
      }
      if (request.method() === 'DELETE') {
        deletes += 1
        hasPhoto = false
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"message":"Photo removed"}',
        })
        return
      }
      if (request.method() === 'GET' && hasPhoto) {
        photoReads += 1
        await route.fulfill({ status: 200, contentType: 'image/jpeg', body: cardBack })
        return
      }
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{"detail":"No photo"}',
      })
      return
    }

    if (path.startsWith('/api/images/card/')) {
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: cardBack })
      return
    }

    const item = {
      id: 1,
      card_id: card.id,
      quantity: 1,
      variant: 'Normal',
      condition: 'NM',
      lang: 'en',
      purchase_price: null,
      has_scan_photo: hasPhoto,
      card,
    }
    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': USER,
      '/api/settings/': {
        language: 'en',
        price_primary: 'trend',
        price_display: '["trend"]',
        tcgdex_sync_languages: 'en',
        currency: 'EUR',
        prefer_own_card_photos: 'false',
      },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/collection/': [item],
      '/api/wishlist/': [],
      '/api/sets/': [],
      '/api/products/': [],
      '/api/binders/': [],
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[path] ?? {}),
    })
  })

  return {
    card,
    cardBack,
    uploads: () => uploads,
    deletes: () => deletes,
    photoReads: () => photoReads,
  }
}

async function openCustomCard(page, card) {
  await page.goto('/collection')
  await page.getByRole('button', { name: card.name }).click()
  await expect(page.getByText('My card photo', { exact: true })).toBeVisible()
}

test('a custom card without artwork can upload, replace, and remove a private photo', async ({ page }) => {
  const fixture = await installCustomCardPhotoFixture(page)
  await openCustomCard(page, fixture.card)

  const dialog = page.getByRole('dialog')
  const input = dialog.locator('input[type="file"][accept="image/*"]')
  await input.setInputFiles({ name: 'owner.jpg', mimeType: 'image/jpeg', buffer: fixture.cardBack })

  await expect.poll(fixture.uploads).toBe(1)
  await expect.poll(fixture.photoReads).toBeGreaterThan(0)
  await expect(dialog.locator('img').first()).toHaveAttribute('src', /^blob:/)
  await expect(dialog.getByTitle('Your own photo of this card')).toBeVisible()
  await expect(page.getByText('Replace photo')).toBeVisible()

  // The existing custom-card pencil remains the sole tile marker. The camera
  // badge belongs to catalogue-card fallbacks and must not be added beside it.
  await expect(page.locator('main').getByLabel('Custom card', { exact: true })).toBeVisible()
  await expect(page.locator('main').getByTitle('Your own photo of this card')).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Close' }).click()
  await page.getByTitle('List view').click()
  await expect(page.locator('main').getByText('📷', { exact: true })).toHaveCount(0)
  await page.locator(`main :text-is("${fixture.card.name}"):visible`).first().click()
  await expect(dialog).toBeVisible()

  await input.setInputFiles({ name: 'replacement.jpg', mimeType: 'image/jpeg', buffer: fixture.cardBack })
  await expect.poll(fixture.uploads).toBe(2)
  await expect.poll(fixture.photoReads).toBeGreaterThan(1)

  await dialog.getByRole('button', { name: 'Remove your photo' }).click()
  await expect.poll(fixture.deletes).toBe(1)
  await expect(page.getByText('Upload photo')).toBeVisible()
  await expect(dialog.getByTitle('Your own photo of this card')).toHaveCount(0)
})

test('a custom card with artwork keeps it primary and offers the private photo as an alternative', async ({ page }) => {
  const fixture = await installCustomCardPhotoFixture(page, { referenceArtwork: true })
  await openCustomCard(page, fixture.card)

  const dialog = page.getByRole('dialog')
  const input = dialog.locator('input[type="file"][accept="image/*"]')
  await input.setInputFiles({ name: 'owner.jpg', mimeType: 'image/jpeg', buffer: fixture.cardBack })

  await expect.poll(fixture.uploads).toBe(1)
  await expect.poll(fixture.photoReads).toBeGreaterThan(0)
  await expect(dialog.getByRole('button', { name: 'Catalogue' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.locator('img').first()).not.toHaveAttribute('src', /^blob:/)

  await dialog.getByRole('button', { name: 'My card' }).click()
  await expect(dialog.getByRole('button', { name: 'My card' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.locator('img').first()).toHaveAttribute('src', /^blob:/)
  await expect(dialog.getByTitle('Your own photo of this card')).toBeVisible()
})
