import {describe, expect, it} from 'vitest'
import en from './en'

describe('first-release ownership language', () => {
    it('presents purchase_price only as a legacy Cost Basis field', () => {
        expect(en.collection.importCsvHint).toContain('purchase_price')
        expect(en.collection.importCsvHint).toContain('Cost Basis')
        expect(en.collection.csvImportBlankOptionalHint).toContain('Cost Basis')
    })

    it('uses acquisition and cost-basis language on intake surfaces', () => {
        expect(en.products.sortDate).toBe('Acquisition Date')
        expect(en.products.purchasePrice).toBe('Cost Basis')
        expect(en.scanner.purchasePriceLabel).toBe('Cost Basis (optional)')
    })
})
