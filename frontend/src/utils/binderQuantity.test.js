import { describe, expect, it } from 'vitest'
import { binderPickerItemsWithQuantities, binderPickerQuantitiesAreValid, canConvertWishlistBinder } from './binderQuantity'

describe('canConvertWishlistBinder', () => {
  it('allows only complete, non-empty wishlist binders', () => {
    expect(canConvertWishlistBinder(true, 8, 0)).toBe(true)
    expect(canConvertWishlistBinder(true, 8, 1)).toBe(false)
    expect(canConvertWishlistBinder(true, 0, 0)).toBe(false)
    expect(canConvertWishlistBinder(false, 8, 0)).toBe(false)
  })
})

describe('binder picker quantities', () => {
  it('keeps a separate quantity for every selected card', () => {
    const items = binderPickerItemsWithQuantities(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      { a: '1', b: '3', c: '7' },
    )

    expect(items.map(item => item.quantity)).toEqual([1, 3, 7])
    expect(binderPickerQuantitiesAreValid(items)).toBe(true)
  })

  it('rejects empty, fractional, and out-of-range quantities', () => {
    expect(binderPickerQuantitiesAreValid([])).toBe(false)
    expect(binderPickerQuantitiesAreValid([{ id: 'a', quantity: 0 }])).toBe(false)
    expect(binderPickerQuantitiesAreValid([{ id: 'a', quantity: 1.5 }])).toBe(false)
    expect(binderPickerQuantitiesAreValid([{ id: 'a', quantity: 100 }])).toBe(false)
  })
})
