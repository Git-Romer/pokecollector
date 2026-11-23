import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    currency: 'DKK',
    currencySymbol: 'kr.',
    t: key => key,
    formatPrice: value => `DKK ${Number(value).toFixed(2)}`,
  }),
}))

import CardSystemGallery from './CardSystemGallery'

describe('CardSystemGallery currency formatting', () => {
  it('formats synthetic sample values with the selected currency', () => {
    const markup = renderToStaticMarkup(createElement(CardSystemGallery))

    expect(markup).toContain('DKK 50.24')
    expect(markup).not.toContain('€')
  })
})
