export const CARD_VARIANTS = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']

export const getAvailableVariants = (card) => [
  card?.variants_normal && 'Normal',
  card?.variants_reverse && 'Reverse Holo',
  card?.variants_holo && 'Holo',
  card?.variants_first_edition && 'First Edition',
].filter(Boolean)

export const getDefaultVariant = (card) => {
  // Normal availability means the safest default is the plain/non-holo card.
  // Only auto-select a variant when there is no normal print and exactly one
  // special variant exists, e.g. holo-only promos.
  if (card?.variants_normal) return ''
  const available = getAvailableVariants(card)
  if (available.length === 1) return available[0]
  return ''
}

export const getDefaultVariantOrNull = (card) => getDefaultVariant(card) || null
