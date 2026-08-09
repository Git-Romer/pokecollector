export function canConvertWishlistBinder(isWishlist, totalCount, missingCount) {
  return Boolean(isWishlist && Number(totalCount) > 0 && Number(missingCount) === 0)
}

export function binderPickerItemsWithQuantities(items, quantities) {
  return items.map(item => ({
    ...item,
    quantity: Number(quantities[item.id]),
  }))
}

export function binderPickerQuantityMaximum(item) {
  if (item.maxQuantity === undefined || item.maxQuantity === null) return 99
  const maximum = Number(item.maxQuantity)
  if (!Number.isFinite(maximum)) return 99
  return Math.max(0, Math.min(99, Math.trunc(maximum)))
}

export function clampBinderPickerQuantity(value, item) {
  if (value === '') return ''
  const quantity = Number(value)
  if (!Number.isFinite(quantity)) return value
  const maximum = binderPickerQuantityMaximum(item)
  if (maximum < 1) return ''
  return Math.max(1, Math.min(maximum, Math.trunc(quantity)))
}

export function binderPickerQuantitiesAreValid(items) {
  return items.length > 0 && items.every(item => (
    Number.isInteger(item.quantity)
    && item.quantity >= 1
    && item.quantity <= binderPickerQuantityMaximum(item)
  ))
}
