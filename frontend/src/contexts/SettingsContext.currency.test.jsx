import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: { id: 17 }, loading: false, multiUser: false }),
}))

import { SettingsProvider, useSettings } from './SettingsContext'

function CurrencyProbe() {
  const { currency, formatPrice, formatUsdPrice } = useSettings()
  return createElement(
    'span',
    null,
    `${currency}|${formatPrice(10)}|${formatUsdPrice(5)}`,
  )
}

describe('SettingsContext selected-currency fallback', () => {
  it('keeps the saved currency selected and never labels unconverted values as EUR or USD', () => {
    vi.stubGlobal('localStorage', {
      getItem: (key) => (key === 'app_currency' ? 'DKK' : null),
    })

    const markup = renderToStaticMarkup(createElement(
      SettingsProvider,
      null,
      createElement(CurrencyProbe),
    ))

    expect(markup).toContain('DKK')
    expect(markup.match(/Unavailable \(DKK\)/g)).toHaveLength(2)
    expect(markup).not.toContain('EUR')
    expect(markup).not.toContain('USD')
    expect(markup).not.toContain('€')
    expect(markup).not.toContain('$')
    vi.unstubAllGlobals()
  })
})
