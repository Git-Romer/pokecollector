import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { PricingWarningDetails, PricingWarningPrice, pricingWarningQueryKey } from './PricingWarning'

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: key => key === 'pricingWarning.sharedProduct' ? 'Also linked to product {productId}' : key, pricePrimaryField: 'price_trend' }),
}))

const card = { lang: 'en', id: 'rare', name: 'Raikou ex', number: '136', price_trend: 0.13, cardmarket_products: [{ product_id: 918849, variant: 'Holo' }] }
const warnings = [{ code: 'shared_cardmarket_product', product_id: 918849, other_cards: [{ id: 'regular', name: 'Raikou ex', number: '033', rarity: 'Double Rare' }] }]
function render(Component, data = warnings, overrides = {}) {
  const client = new QueryClient()
  const current = { ...card, ...overrides }
  client.setQueryData(pricingWarningQueryKey(current), data)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Component, { card: current, value: '€0.13' })))
}

describe('pricing warning presentation', () => {
  it('keeps the displayed price and exposes an accessible, separate dialog action', () => {
    const markup = render(PricingWarningPrice)
    expect(markup).toContain('€0.13')
    expect(markup).toContain('pricingWarning.title')
    expect(markup).toContain('aria-haspopup="dialog"')
    expect(markup).toContain('type="button"')
    expect(markup).toContain('data-pricing-warning')
  })
  it('does not add a warning to an unaffected price', () => {
    const markup = render(PricingWarningPrice, [])
    expect(markup).toBe('€0.13')
  })
  it('identifies the other card and every shared product without claiming an error', () => {
    const markup = render(PricingWarningDetails)
    expect(markup).toContain('pricingWarning.explanation')
    expect(markup).toContain('pricingWarning.caution')
    expect(markup).toContain('918849')
    expect(markup).toContain('Raikou ex')
    expect(markup).toContain('033')
    expect(markup).toContain('Double Rare')
  })
  it('does not flag a converted TCGPlayer fallback as a Cardmarket price', () => {
    const markup = render(PricingWarningPrice, warnings, { price_trend: null, price_tcg_normal_market: 2, price_tcg_usd_to_eur: 0.9 })
    expect(markup).not.toContain('data-pricing-warning')
  })
  it('omits empty details', () => expect(render(PricingWarningDetails, [])).toBe(''))
})
