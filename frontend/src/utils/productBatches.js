function displaySortValue(products, sortBy) {
  const first = products[0]
  const totals = summarizeProductBatch(products)
  switch (sortBy) {
    case 'purchase_price': return totals.purchasePrice
    case 'product_name': return (first.product_name || '').toLowerCase()
    case 'pnl': return totals.pnl ?? -Infinity
    case 'purchase_date':
    default: return first.purchase_date || ''
  }
}

export function buildProductDisplayRows(
  products,
  expandedBatchIds = new Set(),
  { sortBy = 'purchase_date', sortOrder = 'desc' } = {},
) {
  const batches = new Map()
  for (const product of products) {
    if (!product.batch_id) continue
    const batch = batches.get(product.batch_id) || []
    batch.push(product)
    batches.set(product.batch_id, batch)
  }

  const emittedBatches = new Set()
  const blocks = []

  products.forEach((product, sourceIndex) => {
    const batch = product.batch_id ? batches.get(product.batch_id) : null
    if (!batch || batch.length < 2) {
      blocks.push({
        sourceIndex,
        sortValue: displaySortValue([product], sortBy),
        rows: [{ kind: 'product', key: `product-${product.id}`, product }],
      })
      return
    }
    if (emittedBatches.has(product.batch_id)) return

    emittedBatches.add(product.batch_id)
    const rows = [{
      kind: 'batch',
      key: `batch-${product.batch_id}`,
      batchId: product.batch_id,
      products: batch,
    }]
    if (expandedBatchIds.has(product.batch_id)) {
      batch.forEach((batchProduct, index) => {
        rows.push({
          kind: 'product',
          key: `product-${batchProduct.id}`,
          product: batchProduct,
          batchPosition: index + 1,
          batchSize: batch.length,
        })
      })
    }
    blocks.push({ sourceIndex, sortValue: displaySortValue(batch, sortBy), rows })
  })

  blocks.sort((a, b) => {
    if (a.sortValue < b.sortValue) return sortOrder === 'asc' ? -1 : 1
    if (a.sortValue > b.sortValue) return sortOrder === 'asc' ? 1 : -1
    return a.sourceIndex - b.sourceIndex
  })

  return blocks.flatMap(block => block.rows)
}

export function summarizeProductBatch(products) {
  const purchasePrice = products.reduce((total, product) => total + (product.purchase_price || 0), 0)
  const hasCompleteValue = products.every(
    product => product.value_source !== 'needs_review' && product.computed_current_value != null,
  )
  const hasCompletePnl = hasCompleteValue && products.every(product => product.pnl != null)
  const currentValue = hasCompleteValue
    ? products.reduce((total, product) => total + product.computed_current_value, 0)
    : null
  const pnl = hasCompletePnl
    ? products.reduce((total, product) => total + product.pnl, 0)
    : null
  const pnlPercent = pnl != null && purchasePrice > 0 ? (pnl / purchasePrice) * 100 : null

  return { purchasePrice, currentValue, pnl, pnlPercent }
}
