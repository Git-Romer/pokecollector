import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import CardPriceDetails, { cardmarketPriceBreakdown, tcgplayerPriceBreakdown } from './CardPriceDetails'

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    t: key => key,
    formatPrice: value => `EUR ${Number(value).toFixed(2)}`,
    formatUsdPrice: value => `USD ${Number(value).toFixed(2)}`,
    pricePrimary: 'trend',
    pricePrimaryField: 'price_trend',
  }),
}))

const card = {
  id: 42,
  name: 'Lugia V',
  number: '138',
  set_id: 'swsh12',
  price_trend: 16.23,
  price_market: 20.43,
  price_avg1: 16.67,
  price_avg7: 16.52,
  price_avg30: 19.41,
  price_low: 7.5,
  price_trend_holo: 18.1,
  price_market_holo: 19.2,
  price_tcg_normal_market: 9.5,
  price_tcg_reverse_market: 11.25,
  price_tcg_holo_market: 14,
  cardmarket_products: [{ product_id: 12345, variant: 'Holo' }],
}

function renderPriceDetails(props = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(CardPriceDetails, { card, variant: 'Holo', ...props }),
  ))
}

describe('CardPriceDetails', () => {
  it('renders the shared Cardmarket, purchase, and TCGPlayer information', () => {
    const markup = renderPriceDetails()

    expect(markup).toContain('prices.cardmarketTitle')
    expect(markup).toContain('EUR 16.23')
    expect(markup).toContain('cardmarket.buy')
    expect(markup).toContain('TCGPlayer')
    expect(markup).toContain('USD 9.50')
    expect(markup).toContain('USD 11.25')
    expect(markup).toContain('USD 14.00')
  })

  it('keeps collection-specific content as a thin addition to the shared details', () => {
    const markup = renderPriceDetails({
      summary: createElement('div', null, 'Purchase price and collection value'),
    })

    expect(markup).toContain('Purchase price and collection value')
    expect(markup).toContain('prices.cardmarketTitle')
    expect(markup).toContain('TCGPlayer')
  })

  it('omits the primary price when only secondary Cardmarket values exist', () => {
    const secondaryOnlyCard = {
      ...card,
      price_trend: null,
      price_market: null,
      price_trend_holo: null,
      price_market_holo: null,
      price_avg1: 12.34,
      price_avg7: null,
      price_avg30: null,
      price_low: null,
    }
    const markup = renderPriceDetails({ card: secondaryOnlyCard, variant: 'Normal' })

    expect(markup).toContain('EUR 12.34')
    expect(markup).not.toContain('EUR 0.00')
  })
})

describe('price breakdowns', () => {
  it('uses reverse-holo Cardmarket values for a reverse-holo owned copy', () => {
    expect(cardmarketPriceBreakdown(card, 'Reverse Holo')).toEqual([
      { key: 'trend', val: 18.1 },
      { key: 'avg', val: 19.2 },
    ])
  })

  it('falls back to the regular Cardmarket values when reverse prices are unavailable', () => {
    const withoutReversePrices = { ...card, price_trend_holo: null, price_market_holo: null }
    expect(cardmarketPriceBreakdown(withoutReversePrices, 'Reverse Holo')).toEqual([
      { key: 'trend', val: 16.23 },
      { key: 'avg', val: 20.43 },
      { key: 'avg1', val: 16.67 },
      { key: 'avg7', val: 16.52 },
      { key: 'avg30', val: 19.41 },
      { key: 'low', val: 7.5 },
    ])
  })

  it('normalizes the three supported TCGPlayer variants', () => {
    expect(tcgplayerPriceBreakdown(card)).toEqual([
      { key: 'tcg-normal', val: 9.5, label: 'Normal' },
      { key: 'tcg-reverse', val: 11.25, label: 'Reverse' },
      { key: 'tcg-holo', val: 14, label: 'Holo' },
    ])
  })
})
