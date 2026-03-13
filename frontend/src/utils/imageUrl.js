export const cardImageUrl = (cardId, size = 'small') =>
  cardId ? `/api/images/card/${encodeURIComponent(cardId)}/${size}` : null

export const setImageUrl = (setId, imageType) =>
  setId ? `/api/images/set/${encodeURIComponent(setId)}/${imageType}` : null

export const resolveCardImageUrl = (card, size = 'small') => {
  if (card?.id) return cardImageUrl(card.id, size)

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
