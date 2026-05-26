export const CARD_VARIANTS = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']

export const getAvailableVariants = (card) => [
  card?.variants_normal && 'Normal',
  card?.variants_reverse && 'Reverse Holo',
  card?.variants_holo && 'Holo',
  card?.variants_first_edition && 'First Edition',
].filter(Boolean)

export const getDefaultVariant = (card) => {
  // Normal availability means the safest default is the plain/non-holo card.
  if (card?.variants_normal) return 'Normal'
  const available = getAvailableVariants(card)
  // If there is no Normal print, default to a real advertised variant instead
  // of creating an impossible Normal collection row.
  if (available.length > 0) return available[0]
  return 'Normal'
}

export const getDefaultVariantOrNull = (card) => getDefaultVariant(card)
