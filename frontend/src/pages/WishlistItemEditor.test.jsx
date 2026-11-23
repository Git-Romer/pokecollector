import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import SettingsContext from '../contexts/SettingsContext'
import { WishlistItemEditor, shouldSyncWishlistAlertThresholds } from './Wishlist'

const item = {
  id: 91,
  quantity: 2,
  price_alert_above: 10,
  price_alert_below: 8,
}

const settings = {
  t: key => key,
  currency: 'USD',
  currencySymbol: '$',
  exchangeRate: 1.25,
  exchangeRateReady: true,
  loaded: true,
  convertEurToDisplay: amount => Number(amount) * 1.25,
  convertDisplayToEur: amount => Number(amount) / 1.25,
}

function renderEditor() {
  return renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(
      SettingsContext.Provider,
      { value: settings },
      createElement(WishlistItemEditor, { item, onDone: () => {} }),
    ),
  ))
}

describe('shouldSyncWishlistAlertThresholds', () => {
  it('keeps a dirty draft when saved values refresh for the same item and currency', () => {
    expect(shouldSyncWishlistAlertThresholds('91:USD:1.25', '91:USD:1.25', true)).toBe(false)
  })

  it('reinitializes when the item, currency, or rate changes', () => {
    expect(shouldSyncWishlistAlertThresholds('91:USD:1.25', '91:GBP:0.8', true)).toBe(true)
  })

  it('accepts refreshed saved values when there is no dirty draft', () => {
    expect(shouldSyncWishlistAlertThresholds('91:USD:1.25', '91:USD:1.25', false)).toBe(true)
  })
})

describe('WishlistItemEditor initial thresholds', () => {
  it('renders saved EUR thresholds in the selected currency before effects run', () => {
    const markup = renderEditor()

    expect(markup).toContain('value="12.50"')
    expect(markup).toContain('value="10.00"')
    expect(markup).toContain('>$</span>')
    expect(markup).not.toContain('disabled=""')
  })
})
