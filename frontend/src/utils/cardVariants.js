// Single source of truth for the four canonical prints: their canonical order,
// their display code, and their pill styling. CARD_VARIANTS and VARIANT_PILL_META
// are both derived from this one list instead of repeating the variant names.
const VARIANT_DEFINITIONS = [
  { name: 'Normal',        code: 'NOR', className: 'bg-bg-elevated text-text-secondary border-border' },
  { name: 'Holo',          code: 'HOL', className: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  { name: 'Reverse Holo',  code: 'REV', className: 'bg-blue/15 text-blue border-blue/30' },
  { name: 'First Edition', code: '1ST', className: 'bg-yellow/15 text-yellow border-yellow/30' },
]

export const CARD_VARIANTS = VARIANT_DEFINITIONS.map(v => v.name)

export const VARIANT_PILL_META = Object.fromEntries(
  VARIANT_DEFINITIONS.map(({ name, code, className }) => [name, { code, className }])
)

// Alias kept for readability at call sites where "canonical ordering" is the intent
// rather than "the four allowed variants" - same array, one source of truth.
export const VARIANT_ORDER = CARD_VARIANTS

// Most premium print first. Used to pick a single deterministic variant to represent
// a stack of rows (e.g. for the HoloOverlay shimmer), independent of row/sort order.
const PRIMARY_VARIANT_PRIORITY = ['First Edition', 'Holo', 'Reverse Holo', 'Normal']

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

// Rows of the same variant differing only by condition (a NM and an LP Normal) are one
// pill: the pill answers "do I own a Normal", not "how many rows exist".
export const getOwnedVariants = (rows = []) => {
  const totals = new Map()
  for (const row of rows) {
    const variant = row?.variant || 'Normal'
    totals.set(variant, (totals.get(variant) || 0) + (row?.quantity || 0))
  }

  const ordered = VARIANT_ORDER
    .filter(variant => totals.has(variant))
    .map(variant => ({ variant, quantity: totals.get(variant) }))

  // Anything outside the four canonical prints (a hand-edited CSV import, say) still
  // gets a pill rather than vanishing.
  const unknown = [...totals.keys()]
    .filter(variant => !VARIANT_ORDER.includes(variant))
    .sort()
    .map(variant => ({ variant, quantity: totals.get(variant) }))

  return [...ordered, ...unknown]
}

// Picks the single variant that should represent a stack of rows (e.g. which holo
// shimmer to render on a stacked tile). Deterministic by print premium-ness rather
// than by row/sort order: First Edition > Holo > Reverse Holo > Normal. Falls back to
// whatever non-canonical variant is owned (alphabetically first) if none of the four
// canonical prints are present, and to null when there are no rows at all.
export const getPrimaryVariant = (rows = []) => {
  const owned = getOwnedVariants(rows)
  if (owned.length === 0) return null
  const ownedNames = new Set(owned.map(entry => entry.variant))
  const preferred = PRIMARY_VARIANT_PRIORITY.find(variant => ownedNames.has(variant))
  return preferred ?? owned[0].variant
}

// Card ids carry a language suffix (sv01-003_en), so grouping by card id keeps the
// English and German copies of a card in separate tiles.
export const groupCollectionByCard = (items = []) => {
  const groups = new Map()
  for (const item of items) {
    const cardId = item?.card_id ?? item?.card?.id
    if (!groups.has(cardId)) {
      groups.set(cardId, { cardId, card: item.card, rows: [], totalQuantity: 0 })
    }
    const group = groups.get(cardId)
    group.rows.push(item)
    group.totalQuantity += item.quantity || 0
  }
  return [...groups.values()]
}
