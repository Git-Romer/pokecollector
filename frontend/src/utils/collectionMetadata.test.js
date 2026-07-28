import { expect, test } from 'vitest'
import { defaultPurchasePrice } from './collectionMetadata'

test('uses source-aware default cost bases', () => {
  expect(defaultPurchasePrice('pulled')).toBe(4.49)
  expect(defaultPurchasePrice('bulk_before_tracking')).toBeNull()
  expect(defaultPurchasePrice('purchased')).toBeNull()
})
