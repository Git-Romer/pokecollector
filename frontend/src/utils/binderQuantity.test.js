import { describe, expect, it } from 'vitest'
import { binderQuantityPromptKey } from './binderQuantity'

describe('binderQuantityPromptKey', () => {
  it('uses wishlist wording for wishlist binders', () => {
    expect(binderQuantityPromptKey(true)).toBe('wishlist.quantityPrompt')
  })

  it('uses neutral wording for collection binders', () => {
    expect(binderQuantityPromptKey(false)).toBe('common.quantity')
  })
})
