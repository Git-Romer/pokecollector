import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'
import en from '../i18n/en'

const source = readFileSync(resolve(__dirname, './CardItem.jsx'), 'utf-8')

describe('Card add modal Collection Lot language', () => {
    it('frames Card Search add flow around Collection Lot details and cost basis', () => {
        expect(source).toContain('Collection Lot details')
        expect(source).toContain('Track quantity, condition, acquisition, protection, and cost basis')
        expect(en.card.purchasePrice).toBe('Cost Basis - optional')
        expect(en.card.purchasePricePlaceholder).toContain('Cost Basis Needed')
        expect(en.collection.addAnotherVersionHelp).toContain('cost basis')
        expect(en.collection.sortPurchasePrice).toBe('Cost Basis')
    })
})
