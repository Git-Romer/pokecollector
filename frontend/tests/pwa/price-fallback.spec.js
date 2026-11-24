import { test, expect } from '@playwright/test'
import { collectionFixture, expectNoCardPageErrors } from './helpers/windowed-cards'

test.afterEach(({ page }) => expectNoCardPageErrors(page))

for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
  for (const scenario of ['enabled', 'disabled', 'Cardmarket recovered']) {
    test(`German fallback ${scenario} at width ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      const enabled = scenario !== 'disabled'
      const recovered = scenario === 'Cardmarket recovered'
      await collectionFixture(page, {
        extraResponses(items) {
          const card = { ...items[0].card, id: 'window-0_de', lang: 'de', variants_normal: true,
            price_source_lang: null, tcgplayer_fallback_allowed: enabled,
            price_tcg_normal_market: 4, price_tcg_usd_to_eur: 0.9,
            price_market: recovered ? 2 : null }
          return {
            '/api/settings/': { language: 'en', currency: 'EUR', cross_language_price_fallback: String(enabled) },
            '/api/settings/tcgdex-filter-languages': ['en', 'de'],
            '/api/collection/': [{ ...items[0], card_id: card.id, lang: 'de', variant: 'Normal', quantity: 2, card }],
          }
        },
      })
      const frame = page.locator('.unified-card-frame').first()
      if (enabled && !recovered) {
        await expect(page.getByText(/€\s?7\.20/).first()).toBeVisible()
        await expect(page.getByText(/€\s?3\.60/).first()).toBeVisible()
        await expect(frame).toHaveAttribute('style', /--card-frame-gradient: var\(--pc-card-border-price/)
      } else {
        await expect(page.getByText(/€\s?3\.60/)).toHaveCount(0)
        await expect(page.getByText('Price TCGplayer (EN)', { exact: true })).toHaveCount(0)
        await expect(frame).not.toHaveAttribute('style', /--pc-card-border-price/)
        if (recovered) await expect(page.getByText(/€\s?4\.00/).first()).toBeVisible()
      }
      await page.locator('.unified-card-primary-action').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      if (enabled && !recovered) await expect(dialog.getByText('Price TCGplayer (EN)', { exact: true })).toBeVisible()
      else await expect(dialog.getByText('Price TCGplayer (EN)', { exact: true })).toHaveCount(0)
      await dialog.getByRole('tab', { name: 'Prices', exact: true }).click()
      const fallback = dialog.locator('[data-price-source="tcgplayer"]')
      if (enabled && !recovered) {
        await expect(fallback).toContainText('TCGPlayer')
        await expect(fallback).toContainText('EN')
        await expect(fallback).toContainText(/€\s?3\.60/)
      } else await expect(fallback).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  }

  test(`price fallback settings note at width ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await collectionFixture(page, { routePath: '/offline', readySelector: '[data-testid="server-sync-settings"]' })
    const note = page.getByTestId('price-fallback-market-note')
    await expect(note).toContainText('TCGplayer')
    await expect(note).toContainText('TCGdex')
    await expect(note).toContainText('Cardmarket')
    await expect(note).toContainText('German')
    await note.scrollIntoViewIfNeeded()
    await expect(note).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })

  test(`collection and price details separate editions at width ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await collectionFixture(page, {
      extraResponses(items) {
        const card = { ...items[0].card, variants_normal: true, variants_first_edition: true,
          price_tcg_normal_market: 4, price_tcg_first_edition_market: 8, price_tcg_usd_to_eur: 0.9 }
        return { '/api/collection/': [
          { ...items[0], variant: 'Normal', quantity: 2, card },
          { ...items[1], card_id: card.id, variant: 'First Edition', quantity: 3, card },
        ] }
      },
    })
    await expect(page.getByText(/€\s?28\.80/).first()).toBeVisible()
    await expect(page.getByText(/€\s?3\.60/).first()).toBeVisible()
    await expect(page.getByText(/€\s?7\.20/).first()).toBeVisible()
    const cards = page.locator('.unified-card-primary-action')
    await expect(cards).toHaveCount(2)
    await cards.last().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('tab', { name: 'Prices', exact: true }).click()
    const fallback = dialog.locator('[data-price-source="tcgplayer"]')
    await expect(fallback).toContainText('TCGPlayer')
    await expect(fallback).toContainText('First Edition')
    await expect(fallback).toContainText(/€\s?7\.20/)
    await expect(dialog.getByText('Cardmarket', { exact: true })).toHaveCount(0)
  })
}
