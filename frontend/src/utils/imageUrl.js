export const cardImageUrl = (cardId, size = 'small') =>
  cardId ? `/api/images/card/${encodeURIComponent(cardId)}/${size}` : null

export const setImageUrl = (setId, imageType) =>
  setId ? `/api/images/set/${encodeURIComponent(setId)}/${imageType}` : null

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
      || card?.image_url
      || null
  }

  return card?.images?.small
    || card?.images_small
    || card?.image_url
    || (card?.image ? `${card.image}/low.webp` : null)
    || null
}

export const resolveSetImageUrl = (set, imageType) => {
  if (set?.id) return setImageUrl(set.id, imageType)
  return imageType === 'logo' ? (set?.images_logo || null) : (set?.images_symbol || null)
}
