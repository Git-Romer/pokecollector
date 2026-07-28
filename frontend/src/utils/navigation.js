export const collectionItemTargetUrl = (card) => {
    const itemId = card?.collection_item_id ?? card?.item_id ?? (typeof card?.id === 'number' ? card.id : null)
    if (itemId) return `/collection?itemId=${encodeURIComponent(itemId)}`

    const cardId = card?.card_id || (typeof card?.id === 'string' ? card.id : null)
    if (cardId) return `/collection?cardId=${encodeURIComponent(cardId)}`

    return '/collection'
}
