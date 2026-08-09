import { describe, expect, it } from 'vitest'
import { buildProductDisplayRows, summarizeProductBatch } from './productBatches'

describe('buildProductDisplayRows', () => {
  const products = [
    { id: 1, batch_id: 'batch-a' },
    { id: 2, batch_id: 'batch-a' },
    { id: 3, batch_id: null },
  ]

  it('collapses products from the same batch into one row', () => {
    expect(buildProductDisplayRows(products).map(row => row.kind)).toEqual(['batch', 'product'])
  })

  it('adds independently actionable product rows when a batch is expanded', () => {
    const rows = buildProductDisplayRows(products, new Set(['batch-a']))
    expect(rows.map(row => row.kind)).toEqual(['batch', 'product', 'product', 'product'])
    expect(rows[1]).toMatchObject({ batchPosition: 1, batchSize: 2, product: { id: 1 } })
    expect(rows[2]).toMatchObject({ batchPosition: 2, batchSize: 2, product: { id: 2 } })
  })

  it('shows a remaining single product without a redundant batch wrapper', () => {
    const rows = buildProductDisplayRows([{ id: 1, batch_id: 'batch-a' }])
    expect(rows).toEqual([{ kind: 'product', key: 'product-1', product: { id: 1, batch_id: 'batch-a' } }])
  })

  it('sorts collapsed batches by their displayed aggregate price', () => {
    const rows = buildProductDisplayRows([
      { id: 1, batch_id: 'batch-a', purchase_price: 4, product_name: 'Batch' },
      { id: 2, batch_id: 'batch-a', purchase_price: 4, product_name: 'Batch' },
      { id: 3, batch_id: null, purchase_price: 5, product_name: 'Single' },
    ], new Set(), { sortBy: 'purchase_price', sortOrder: 'asc' })

    expect(rows.map(row => row.key)).toEqual(['product-3', 'batch-batch-a'])
  })
})

describe('summarizeProductBatch', () => {
  it('uses totals while retaining per-item records', () => {
    expect(summarizeProductBatch([
      { purchase_price: 4, computed_current_value: 5, pnl: 1 },
      { purchase_price: 4, computed_current_value: 6, pnl: 2 },
    ])).toEqual({ purchasePrice: 8, currentValue: 11, pnl: 3, pnlPercent: 37.5 })
  })

  it('does not invent aggregate value when one item is unvalued', () => {
    expect(summarizeProductBatch([
      { purchase_price: 4, computed_current_value: 5, pnl: 1 },
      { purchase_price: 4, computed_current_value: null, pnl: null },
    ])).toEqual({ purchasePrice: 8, currentValue: null, pnl: null, pnlPercent: null })
  })

  it('does not treat an excluded needs-review value as a complete valuation', () => {
    expect(summarizeProductBatch([
      { purchase_price: 4, computed_current_value: 5, pnl: 1, value_source: 'manual_current' },
      { purchase_price: 4, computed_current_value: 0, pnl: -4, value_source: 'needs_review' },
    ])).toEqual({ purchasePrice: 8, currentValue: null, pnl: null, pnlPercent: null })
  })
})
