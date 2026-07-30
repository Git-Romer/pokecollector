import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {expect, test} from 'vitest'
import {ACQUISITION_SOURCES, defaultPurchasePrice, normalizeAcquisitionSourceForUi, RAW_CONDITIONS} from './collectionMetadata'

test('uses source-aware default cost bases', () => {
    expect(defaultPurchasePrice('pulled')).toBe(4.49)
    expect(defaultPurchasePrice('bulk_before_tracking')).toBe(0)
    expect(defaultPurchasePrice('purchased')).toBeNull()
})


test('uses simplified condition and acquisition labels', () => {
    expect(RAW_CONDITIONS).toEqual(['NM', 'LP', 'MP', 'HP', 'DMG'])
    expect(ACQUISITION_SOURCES).toEqual([
        {value: 'pulled', label: 'Pulled'},
        {value: 'purchased', label: 'Purchased'},
        {value: 'gift', label: 'Gift'},
        {value: 'trade', label: 'Trade'},
        {value: 'bulk_before_tracking', label: 'Bulk / before tracking'},
        {value: 'other', label: 'Other'},
    ])
    expect(normalizeAcquisitionSourceForUi('unknown')).toBe('other')
})

test('CollectionEditModal exposes storage type and detail controls', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/Collection.jsx'), 'utf8')

    expect(source.match(/value=\{storageType\}/g)).toHaveLength(1)
    expect(source.match(/value=\{storageDetail\}/g)).toHaveLength(1)
})
