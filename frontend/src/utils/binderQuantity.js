export function canConvertWishlistBinder(isWishlist, totalCount, missingCount) {
  return Boolean(isWishlist && Number(totalCount) > 0 && Number(missingCount) === 0)
}

export function binderPickerItemsWithQuantities(items, quantities) {
  return items.map(item => ({
    ...item,
    quantity: Number(quantities[item.id]),
  }))
}

export function binderPickerQuantitiesAreValid(items) {
  return items.length > 0 && items.every(item => (
    Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 99
  ))
}
