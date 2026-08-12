export const cardImageUrl = (cardId, size = 'small') =>
  cardId ? `/api/images/card/${encodeURIComponent(cardId)}/${size}` : null

export const setImageUrl = (setId, imageType) =>
  setId ? `/api/images/set/${encodeURIComponent(setId)}/${imageType}` : null

export const productImageUrl = (product) =>
  product?.image_url && product?.image_proxy_url ? product.image_proxy_url : '/cardback.jpg'

// Whether TCGdex actually has a scan of this card.
//
// Cannot be inferred from resolveCardImageUrl: that returns an /api/images URL
// for any card with an id, and the backend quietly redirects to the card back
// when it has nothing to serve. So the only honest test is on the card record,
// and callers that need to know — offering a custom image URL, or showing the
// owner's own photo instead — have to ask here.
export const hasCatalogueImage = (card) => Boolean(
  card?.images?.large || card?.images_large
  || card?.images?.small || card?.images_small
  || card?.image
)

export const resolveCardImageUrl = (card, size = 'small') => {
  // card_id is the actual card identifier (e.g. "sv1-1_de")
  // id might be a collection item integer ID, so prefer card_id or string id
  const cid = card?.card_id || (typeof card?.id === 'string' ? card.id : null)
  if (cid) return cardImageUrl(cid, size)

  if (size === 'large') {
    return card?.images?.large
      || card?.images_large
      || (card?.image ? `${card.image}/high.webp` : null)
      || card?.images?.small
      || card?.images_small
      || card?.custom_image_url
      || card?.image_url
      || null
  }

  return card?.images?.small
    || card?.images_small
    || (card?.image ? `${card.image}/low.webp` : null)
    || card?.custom_image_url
    || card?.image_url
    || null
}

export const resolveSetImageUrl = (set, imageType) => {
  if (set?.id) return setImageUrl(set.id, imageType)
  return imageType === 'logo' ? (set?.images_logo || null) : (set?.images_symbol || null)
}
