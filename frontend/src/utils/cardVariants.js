// Single source of truth for the four canonical prints: their canonical order,
// their display code, and their pill styling. CARD_VARIANTS and VARIANT_PILL_META
// are both derived from this one list instead of repeating the variant names.
// Backgrounds are solid rather than tinted: the pills overlay card art in the set
// grid, where a translucent fill washes out against the illustration.
const VARIANT_DEFINITIONS = [
  { name: 'Normal',        code: 'NOR', className: 'bg-zinc-700 text-white border-zinc-500' },
  { name: 'Holo',          code: 'HOL', className: 'bg-purple-600 text-white border-purple-400' },
  // blue/yellow are redefined in tailwind.config as {DEFAULT, subtle}, so their
  // numeric scale (blue-300, yellow-200) does not exist - borders use alpha instead.
  { name: 'Reverse Holo',  code: 'REV', className: 'bg-blue text-white border-white/30' },
  { name: 'First Edition', code: '1ST', className: 'bg-yellow text-black border-black/20' },
]

export const CARD_VARIANTS = VARIANT_DEFINITIONS.map(v => v.name)

export const VARIANT_PILL_META = Object.fromEntries(
  VARIANT_DEFINITIONS.map(({ name, code, className }) => [name, { code, className }])
)

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

// Which prints of a card the user owns, for the set-grid pills. Rows of the same
// variant differing only by condition (a NM and an LP Normal) collapse into one entry:
// the pill answers "do I own a Normal", not "how many rows exist".
export const getOwnedVariants = (rows = []) => {
  const totals = new Map()
  for (const row of rows) {
    const variant = row?.variant || 'Normal'
    totals.set(variant, (totals.get(variant) || 0) + (row?.quantity || 0))
  }

  // Test the summed quantity, not key presence: a row with quantity 0 or null must not
  // produce a pill claiming ownership of zero copies.
  const ordered = CARD_VARIANTS
    .filter(variant => totals.get(variant) > 0)
    .map(variant => ({ variant, quantity: totals.get(variant) }))

  // Anything outside the four canonical prints (a hand-edited CSV import, say) still
  // gets a pill rather than vanishing.
  const unknown = [...totals.keys()]
    .filter(variant => !CARD_VARIANTS.includes(variant) && totals.get(variant) > 0)
    .map(variant => ({ variant, quantity: totals.get(variant) }))

  return [...ordered, ...unknown]
}

// Tile payloads use owned_variants while collection/action payloads expose
// owned_items.  Keep their normalization in one place so both displays behave
// identically and detailed variants always take precedence over a total.
export const getCardOwnedVariants = (card = {}) => getOwnedVariants(
  Array.isArray(card.owned_variants) ? card.owned_variants : (card.owned_items || [])
)

export const hasGenericOwnership = (card = {}) => Boolean(card.owned || Number(card.owned_quantity) > 0)
