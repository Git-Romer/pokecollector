import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import CardImage from './CardImage'

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    t: key => ({
      'card.retryImage': 'Retry loading card artwork',
      'common.retry': 'Retry',
    })[key] || key,
  }),
}))

describe('CardImage', () => {
  it('uses the real Pokémon card back when artwork is missing', () => {
    const markup = renderToStaticMarkup(createElement(CardImage, {
      src: '',
      alt: 'Pikachu',
    }))

    expect(markup).toContain('src="/cardback.jpg"')
    expect(markup).toContain('Pikachu')
    expect(markup).toContain('unified-card-skeleton')
  })

  it('keeps a valid artwork URL unchanged on the first attempt', () => {
    const markup = renderToStaticMarkup(createElement(CardImage, {
      src: 'https://example.test/pikachu.webp',
      alt: 'Pikachu',
    }))

    expect(markup).toContain('src="https://example.test/pikachu.webp"')
    expect(markup).not.toContain('retry=')
  })
})
