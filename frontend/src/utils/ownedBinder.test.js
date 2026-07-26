import { describe, expect, it } from 'vitest'
import { findOwnedBinderForSet, ownedBinderName } from './ownedBinder'

describe('ownedBinderName', () => {
  it('uses the localized set name when available', () => {
    expect(ownedBinderName('Scarlet & Violet', 'sv1_en')).toBe('Scarlet & Violet (owned)')
  })

  it('falls back to the set id when the set has no name', () => {
    expect(ownedBinderName('', 'sv1_en')).toBe('sv1_en (owned)')
  })
})

describe('findOwnedBinderForSet', () => {
  const binders = [
    { id: 1, name: 'Scarlet & Violet (owned)', binder_type: 'wishlist' },
    { id: 2, name: 'Scarlet & Violet', binder_type: 'collection' },
    { id: 3, name: 'Scarlet & Violet (owned)', binder_type: 'collection' },
  ]

  it('returns the exact matching collection binder', () => {
    expect(findOwnedBinderForSet(binders, 'Scarlet & Violet (owned)')).toEqual(binders[2])
  })

  it('treats legacy binders without a type as collection binders', () => {
    const legacy = { id: 4, name: 'Base Set (owned)', binder_type: null }
    expect(findOwnedBinderForSet([legacy], legacy.name)).toEqual(legacy)
  })

  it('does not reuse wishlist or differently named binders', () => {
    expect(findOwnedBinderForSet(binders, 'Base Set (owned)')).toBeNull()
  })
})
