export function binderQuantityPromptKey(isWishlist) {
  return isWishlist ? 'wishlist.quantityPrompt' : 'common.quantity'
}

export function canConvertWishlistBinder(isWishlist, totalCount, missingCount) {
  return Boolean(isWishlist && Number(totalCount) > 0 && Number(missingCount) === 0)
}
