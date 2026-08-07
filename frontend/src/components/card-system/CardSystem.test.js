import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CARD_DISPLAY_VARIANTS, CardDisplay, CardIdentity, CardLegend, CardRow, CardStack } from './index'

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: key => key }),
}))

const card = { id: 'sv8-001', name: 'Pikachu', number: '057', set_id: 'ssp' }

describe('public card-system API', () => {
  it.each(CARD_DISPLAY_VARIANTS)('renders the %s CardDisplay variant', (variant) => {
    const markup = renderToStaticMarkup(createElement(CardDisplay, {
      variant,
      card,
      image: '/cardback.jpg',
      alt: card.name,
    }))

    expect(markup).toContain('unified-card-frame')
  })

  it('rejects unsupported page-specific display variants', () => {
    expect(() => renderToStaticMarkup(createElement(CardDisplay, {
      variant: 'my-special-page-card',
      card,
    }))).toThrow('Unsupported CardDisplay variant')
  })

  it('exposes shared row, identity, and legend building blocks', () => {
    const row = renderToStaticMarkup(createElement(CardRow, { card, image: '/cardback.jpg', name: card.name }))
    const identity = renderToStaticMarkup(createElement(CardIdentity, { card, image: '/cardback.jpg', name: card.name }))
    const legend = renderToStaticMarkup(createElement(CardLegend, { collapsible: false }))
    const stack = renderToStaticMarkup(createElement(CardStack, { card, image: '/cardback.jpg', layers: 2 }))

    expect(row).toContain('unified-card-compact-artwork')
    expect(identity).toContain('unified-card-compact-artwork')
    expect(legend).toContain('Normal')
    expect(stack.match(/unified-card-frame/g)).toHaveLength(3)
  })
})
