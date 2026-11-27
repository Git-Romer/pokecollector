import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import PricingWarningDialog from './PricingWarningDialog'

vi.mock('../../contexts/SettingsContext', () => ({ useSettings: () => ({
  t: key => key, formatPrice: value => `€${Number(value).toFixed(2)}`, pricePrimary: 'trend', pricePrimaryField: 'price_trend',
}) }))
vi.mock('../UnifiedCard', () => ({ UnifiedCardDialog: ({ price }) => createElement('p', null, price) }))
vi.mock('./CardPriceDetails', () => ({ default: () => null }))

describe('pricing warning dialog value', () => {
  it('shows the per-card quote even when opened beside a collection row total', () => {
    const markup = renderToStaticMarkup(createElement(PricingWarningDialog, {
      card: { id: 'rare', price_trend: 0.13 }, variant: 'Holo', value: '€0.39', onClose: () => {},
    }))
    expect(markup).toContain('€0.13')
    expect(markup).not.toContain('€0.39')
  })
})
