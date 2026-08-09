import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import en from '../i18n/en'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, './Products.jsx'), 'utf-8')

test('Sealed Product intake captures first-release ownership fields', () => {
    expect(source).toContain("quantity: initial.quantity || 1")
    expect(source).toContain("acquisition_source: normalizeAcquisitionSourceForUi(initial.acquisition_source) || 'purchased'")
    expect(source).toContain("collection_intent: initial.collection_intent || 'main_collection'")
    expect(source).toContain("purchase_price: parseMoneyInputValue(form.purchase_price, exchangeRate, null)")
    expect(source).toContain("<option value=\"vault\">Vault</option>")
    expect(source).toContain("<option value=\"pc\">PC</option>")
    expect(en.products.purchasePrice).toBe('Cost Basis')
    expect(en.products.acquisitionSource).toBe('Acquisition Source')
    expect(en.products.collectionIntent).toBe('Collection')
})


test('Sealed Products exclude missing cost basis from P&L and label it clearly', () => {
    expect(source).toContain('const productsWithCostBasis = periodProducts.filter(p => p.purchase_price != null)')
    expect(source).toContain('const valueWithCostBasis = productsWithCostBasis.reduce((s, p) => s + getProductValue(p), 0)')
    expect(source).toContain('const totalPnl = valueWithCostBasis - totalInvested')
    expect(source).toContain('const hasCostBasis = p.purchase_price != null')
    expect(source).toContain('Cost Basis Needed')
    expect(source).not.toContain('const totalInvested = periodProducts.reduce((s, p) => s + (p.purchase_price || 0), 0)')
    expect(source).toContain('type.cost_basis_needed > 0')
    expect(source).toContain('type.pnl_pct == null')
    expect(en.products.paidPrice).toBe('Cost Basis')
})
