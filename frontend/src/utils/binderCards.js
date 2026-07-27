const compareText = (left, right) => String(left || '').localeCompare(
  String(right || ''),
  undefined,
  { numeric: true, sensitivity: 'base' },
)

const cardQuantity = (card, isWishlist) => Number(
  isWishlist
    ? (card?.required_quantity ?? 0)
    : (card?.quantity ?? card?.owned_quantity ?? 0),
) || 0

const cardPrice = (card) => {
  const price = Number(card?.price_market)
  return Number.isFinite(price) && price > 0 ? price : null
}

const collectorOrder = (left, right) => (
  compareText(left?.set_name || left?.set_id, right?.set_name || right?.set_id)
  || compareText(left?.number, right?.number)
  || compareText(left?.variant, right?.variant)
  || compareText(left?.binder_card_id || left?.id, right?.binder_card_id || right?.id)
)

export const BINDER_SORT_OPTIONS = [
  'recent',
  'number',
  'name_asc',
  'name_desc',
  'price_desc',
  'price_asc',
  'quantity_desc',
  'variant_asc',
]

export function sortBinderCards(cards, sortBy = 'recent', { isWishlist = false } = {}) {
  const sorted = [...(cards || [])]
  if (sortBy === 'recent') return sorted

  sorted.sort((left, right) => {
    if (sortBy === 'number') return collectorOrder(left, right)

    if (sortBy === 'name_asc' || sortBy === 'name_desc') {
      const comparison = compareText(left?.name, right?.name)
      return (sortBy === 'name_desc' ? -comparison : comparison) || collectorOrder(left, right)
    }

    if (sortBy === 'price_desc' || sortBy === 'price_asc') {
      const leftPrice = cardPrice(left)
      const rightPrice = cardPrice(right)
      if (leftPrice == null && rightPrice != null) return 1
      if (leftPrice != null && rightPrice == null) return -1
      if (leftPrice == null && rightPrice == null) return collectorOrder(left, right)
      const comparison = sortBy === 'price_desc' ? rightPrice - leftPrice : leftPrice - rightPrice
      return comparison || collectorOrder(left, right)
    }

    if (sortBy === 'quantity_desc') {
      return cardQuantity(right, isWishlist) - cardQuantity(left, isWishlist)
        || collectorOrder(left, right)
    }

    if (sortBy === 'variant_asc') {
      return compareText(left?.variant || 'Normal', right?.variant || 'Normal')
        || collectorOrder(left, right)
    }

    return 0
  })

  return sorted
}
