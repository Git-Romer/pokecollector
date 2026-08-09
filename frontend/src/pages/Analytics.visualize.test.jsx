import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

const source = readFileSync(resolve(__dirname, './Analytics.jsx'), 'utf-8')

describe('Trends & Insights Visualize tab', () => {
    it('focuses Visualize on recent additions and total collection growth', () => {
        expect(source).toContain("{key: 'visualize', label: 'Visualize'")
        expect(source).toContain('Collection growth')
        expect(source).toContain('Total cards over time')
        expect(source).toContain('Recent additions')
        expect(source).toContain('Latest Collection Lots')
        expect(source).toContain('getDashboard({price_field: pricePrimaryField})')
    })

    it('does not use duplicate analysis as the Visualize body', () => {
        const visualizeStart = source.indexOf("{activeTab === 'visualize'")
        const discoverStart = source.indexOf("{activeTab === 'discover'")
        const visualizeBody = source.slice(visualizeStart, discoverStart)

        expect(visualizeBody).not.toContain('duplicates.map')
        expect(visualizeBody).not.toContain('duplicatesDesc')
    })

    it('states the Portfolio Performance scope and cost-basis treatment', () => {
        expect(source).toContain("{key: 'portfolio', label: 'Portfolio Performance'")
        expect(source).toContain('Vault, PC, and the highest-value 10% of Main Collection by market value.')
        expect(source).toContain('Sealed product is included when it is marked Vault or PC.')
        expect(source).toContain('Cost Basis Needed:')
        expect(source).toContain('Included in market value; excluded from profit/loss.')
        expect(source).toContain('formatPortfolioCounts(segment)')
    })

    it('does not treat sealed products with missing cost basis as zero-cost profit', () => {
        expect(source).toContain('const soldProductsWithCostBasis = soldProducts.filter(p => p.purchase_price != null)')
        expect(source).toContain('const unsoldProductsWithCostBasis = unsoldProducts.filter(p => p.purchase_price != null)')
        expect(source).toContain('const totalSoldRevenueWithCostBasis = soldProductsWithCostBasis.reduce')
        expect(source).toContain('const realizedPnl = totalSoldRevenueWithCostBasis - totalSoldCost + productCardRealizedGains')
        expect(source).toContain('const hasCostBasis = p.purchase_price != null')
        expect(source).toContain('Cost Basis Needed')
        expect(source).not.toContain('const pnl = isSold ? (p.sold_price - p.purchase_price) : (currentValue - p.purchase_price)')
    })

})
