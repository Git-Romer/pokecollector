import { describe, expect, it } from 'vitest'
import { getCardVariantEffectClass, getCardVariantEffectType } from './cardVariantEffect'

describe('getCardVariantEffectType', () => {
  it.each([
    ['Normal', null],
    [null, null],
    ['Holo', 'holo'],
    ['Holo Rare', 'holo'],
    ['Reverse Holo', 'reverse'],
    ['First Edition', 'firstEdition'],
    ['1st Edition', 'firstEdition'],
    ['Alt Art', 'special'],
    ['Illustration Rare', 'special'],
    ['Special Illustration Rare', 'special'],
    ['Shiny', 'special'],
    ['Unknown Foil', 'generic'],
  ])('maps %s to %s', (variant, expected) => {
    expect(getCardVariantEffectType(variant)).toBe(expected)
  })

  it('uses one deterministic effect for grouped prints', () => {
    expect(getCardVariantEffectType([
      { variant: 'Normal', quantity: 2 },
      { variant: 'Holo', quantity: 1 },
      { variant: 'Reverse Holo', quantity: 1 },
    ])).toBe('reverse')
  })

  it.each([
    [[{ variant: 'Special Illustration Rare' }, { variant: 'Holo' }], 'special'],
    [[{ variant: 'Holo' }, { variant: 'First Edition' }], 'holo'],
    [[{ variant: 'First Edition' }, { variant: 'Unknown Foil' }], 'firstEdition'],
  ])('applies grouped priority to %j', (variants, expected) => {
    expect(getCardVariantEffectType(variants)).toBe(expected)
  })

  it('reads detailed owned variants and ignores generic ownership totals', () => {
    expect(getCardVariantEffectType({
      owned: true,
      owned_quantity: 3,
      owned_variants: [{ variant: 'Holo', quantity: 1 }],
    })).toBe('holo')
    expect(getCardVariantEffectType({ owned: true, owned_quantity: 3 })).toBe(null)
  })

  it('supports owned-items payloads', () => {
    expect(getCardVariantEffectType({
      owned_items: [{ variant: 'First Edition', quantity: 1 }],
    })).toBe('firstEdition')
  })

  it('falls back to owned variants when a payload has an empty exact variant', () => {
    expect(getCardVariantEffectType({
      variant: null,
      owned_variants: [{ variant: 'Reverse Holo', quantity: 1 }],
    })).toBe('reverse')
  })
})

describe('getCardVariantEffectClass', () => {
  it('returns both the shared base and selected variant class', () => {
    expect(getCardVariantEffectClass('Reverse Holo'))
      .toBe('card-variant-effect card-variant-reverse')
  })

  it('returns no animation class for Normal', () => {
    expect(getCardVariantEffectClass('Normal')).toBe('')
  })
})
