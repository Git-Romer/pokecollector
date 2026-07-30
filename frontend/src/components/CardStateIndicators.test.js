import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import CardStateIndicators, { CardStateLegend, getCardState } from './CardStateIndicators'

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    t: key => ({
      'variants.Normal': 'Normal',
      'variants.Holo': 'Holo',
      'variants.Reverse Holo': 'Reverse Holo',
      'variants.First Edition': 'First Edition',
      'setDetail.ownedVariantUnknown': 'Owned (variant unknown)',
      'setDetail.badgeQuantity': 'Quantity owned',
      'fallback.dataBorder': 'Purple border: fallback card data',
      'fallback.priceBorder': 'Amber border: fallback price',
      'fallback.imageBorder': 'Blue border: fallback image',
      'collection.foundIn': 'Found in product',
      'common.selected': 'Selected',
      'binderTypes.progress': 'Binder progress',
      'nav.wishlist': 'Wishlist',
    })[key] || key,
  }),
}))

describe('getCardState', () => {
  it('uses detailed variants instead of the generic owned fallback', () => {
    const state = getCardState({ owned: true, owned_quantity: 3, owned_variants: [{ variant: 'Normal', quantity: 2 }] })
    expect(state.variants).toEqual([{ variant: 'Normal', quantity: 2 }])
    expect(state.genericOwned).toBe(false)
  })

  it('supports generic ownership and both wishlist contract shapes independently', () => {
    expect(getCardState({ owned_quantity: 1, wishlisted: true })).toMatchObject({ genericOwned: true, wishlisted: true })
    expect(getCardState({ wishlist_count: 2 })).toMatchObject({ genericOwned: false, wishlisted: true })
  })
})

describe('CardStateLegend', () => {
  it('explains variants, generic ownership, wishlist, and quantity', () => {
    const markup = renderToStaticMarkup(createElement(CardStateLegend))

    for (const label of [
      'Normal',
      'Holo',
      'Reverse Holo',
      'First Edition',
      'Owned (variant unknown)',
      'Wishlist',
      'Quantity owned',
      'Purple border: fallback card data',
      'Amber border: fallback price',
      'Blue border: fallback image',
      '×2',
    ]) {
      expect(markup).toContain(label)
    }
  })

  it('can show the public binder subset without private-state markers', () => {
    const markup = renderToStaticMarkup(createElement(CardStateLegend, {
      showOwnershipFallback: false,
      showWishlist: false,
    }))

    expect(markup).toContain('Reverse Holo')
    expect(markup).toContain('Quantity owned')
    expect(markup).not.toContain('Owned (variant unknown)')
    expect(markup).not.toContain('Wishlist')
  })

  it('can explain private binder variants without duplicating its separate amount badge', () => {
    const markup = renderToStaticMarkup(createElement(CardStateLegend, {
      showOwnershipFallback: false,
      showWishlist: false,
      showQuantity: false,
    }))

    for (const label of ['Normal', 'Holo', 'Reverse Holo', 'First Edition']) {
      expect(markup).toContain(label)
    }
    expect(markup).not.toContain('Quantity owned')
    expect(markup).not.toContain('×2')
  })

  it('can explain contextual product, selection, and binder progress badges', () => {
    const markup = renderToStaticMarkup(createElement(CardStateLegend, {
      showProductSource: true,
      showSelection: true,
      showBinderProgress: true,
    }))

    expect(markup).toContain('Found in product')
    expect(markup).toContain('Selected')
    expect(markup).toContain('Binder progress')
    expect(markup).toContain('2/4')
  })
})

describe('CardStateIndicators', () => {
  it('can show every grouped variant quantity, including one copy', () => {
    const markup = renderToStaticMarkup(createElement(CardStateIndicators, {
      card: {
        owned_variants: [
          { variant: 'Normal', quantity: 1 },
          { variant: 'Reverse Holo', quantity: 2 },
        ],
      },
      alwaysShowQuantity: true,
    }))

    expect(markup).toContain('Normal ×1')
    expect(markup).toContain('Reverse Holo ×2')
  })

  it('can hide quantities when a separate amount badge is present', () => {
    const markup = renderToStaticMarkup(createElement(CardStateIndicators, {
      card: { owned_variants: [{ variant: 'Normal', quantity: 3 }] },
      showQuantity: false,
    }))

    expect(markup).toContain('aria-label="Normal"')
    expect(markup).not.toContain('×3')
  })
})
