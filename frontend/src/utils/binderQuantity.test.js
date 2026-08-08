import { describe, expect, it } from 'vitest'
import { binderQuantityPromptKey, canConvertWishlistBinder } from './binderQuantity'

describe('binderQuantityPromptKey', () => {
  it('uses wishlist wording for wishlist binders', () => {
    expect(binderQuantityPromptKey(true)).toBe('wishlist.quantityPrompt')
  })

  it('uses neutral wording for collection binders', () => {
    expect(binderQuantityPromptKey(false)).toBe('common.quantity')
  })
})

describe('canConvertWishlistBinder', () => {
  it('allows only complete, non-empty wishlist binders', () => {
    expect(canConvertWishlistBinder(true, 8, 0)).toBe(true)
    expect(canConvertWishlistBinder(true, 8, 1)).toBe(false)
    expect(canConvertWishlistBinder(true, 0, 0)).toBe(false)
    expect(canConvertWishlistBinder(false, 8, 0)).toBe(false)
  })
})
