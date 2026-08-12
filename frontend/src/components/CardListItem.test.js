import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import CardListItem, { CompactCardIdentity } from './CardListItem'

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    t: key => key,
  }),
}))

describe('CompactCardIdentity', () => {
  it('shares one contained thumbnail and metadata structure across table callers', () => {
    const markup = renderToStaticMarkup(createElement(CompactCardIdentity, {
      card: { id: 'sv8-001', name: 'Pikachu' },
      image: 'https://example.test/pikachu.webp',
      name: 'Pikachu',
      setNumber: 'SSP 057',
      languageLabel: 'EN',
    }))

    expect(markup).toContain('unified-card-compact-artwork')
    expect(markup).toContain('object-contain')
    expect(markup).toContain('SSP 057')
    expect(markup).toContain('EN')
  })

  it('shows the wider custom text badge in compact rows', () => {
    const markup = renderToStaticMarkup(createElement(CompactCardIdentity, {
      card: { id: 'custom-1', name: 'Manual Pikachu', is_custom: true },
      name: 'Manual Pikachu',
    }))

    expect(markup).toContain('badge-yellow')
    expect(markup).toContain('Custom')
  })
})

describe('CardListItem', () => {
  it('builds its row identity with the same compact primitive', () => {
    const markup = renderToStaticMarkup(createElement(CardListItem, {
      card: { id: 'sv8-001', name: 'Pikachu' },
      image: 'https://example.test/pikachu.webp',
      name: 'Pikachu',
      value: '€12.34',
    }))

    expect(markup.match(/unified-card-compact-artwork/g)).toHaveLength(1)
    expect(markup).toContain('€12.34')
  })
})
