/**
 * Species helpers for the Collection species layout.
 *
 * A card can depict several species (`card.dex_ids`). Grouping deliberately uses
 * the first valid id only, so each card appears once. Cards without dex ids
 * (Trainers, Energy, manual cards)
 * are returned in a separate `other` bucket so they stay reachable.
 *
 * Pure functions only — the callers own rendering and translation state.
 */

export const MAX_DEX_ID = 1025

/** Valid, de-duplicated National Dex ids of a collection item's card. */
export const cardDexIds = (item) => {
  const raw = item?.card?.dex_ids ?? item?.dex_ids
  const card = item?.card ?? item
  if (!Array.isArray(raw) || card?.is_custom || (card?.supertype && !['pokemon', 'pokémon'].includes(String(card.supertype).toLowerCase()))) return []
  const ids = []
  for (const value of raw) {
    if (typeof value !== 'number' && typeof value !== 'string') continue
    const dexId = Number(value)
    if (!Number.isInteger(dexId) || dexId <= 0 || dexId > MAX_DEX_ID) continue
    if (ids.includes(dexId)) continue
    ids.push(dexId)
  }
  return ids
}

/** Locally cached sprite for one species, served by the Pokédex image cache. */
export const speciesSpriteUrl = (dexId) => {
  const value = Number(dexId)
  if (!Number.isInteger(value) || value <= 0) return null
  return `/api/pokedex/images/sprites/${value}.png`
}

/** `#001` style display number for a dex id. */
export const formatDexNumber = (dexId) => {
  const value = Number(dexId)
  if (!Number.isInteger(value) || value <= 0) return ''
  return `#${String(value).padStart(3, '0')}`
}

/**
 * Species name in the UI language (the app uses English and German species
 * metadata), falling back to the other language.
 */
export const speciesName = (entry, language = 'en') => {
  if (!entry) return ''
  const primary = language === 'de' ? entry.name_de : entry.name_en
  return primary || entry.name_en || entry.name_de || ''
}

/** "3 printings · 5 copies", with singular forms when the count is 1. */
export const formatSpeciesCounts = (t, printingCount, copies) => {
  const printings = Number(printingCount) || 0
  const totalCopies = Number(copies) || 0
  return `${printings} ${printings === 1 ? t('analytics.printing') : t('analytics.printings')} · `
    + `${totalCopies} ${totalCopies === 1 ? t('analytics.copy') : t('analytics.copies')}`
}

/**
 * Group already filtered/sorted collection rows by their first dex id.
 *
 * @returns {{ groups: Array<{dexId: number, name: string, items: Array, printingCount: number, copies: number, totalValue: number}>,
 *             other: { items: Array, copies: number, totalValue: number } }}
 */
export function groupCollectionBySpecies(items = [], { speciesByDexId = null, language = 'en', itemValue = null } = {}) {
  const groups = new Map()
  const other = { items: [], copies: 0, totalValue: 0 }

  for (const item of items) {
    const quantity = Number(item?.quantity) || 0
    const value = Number(itemValue ? itemValue(item) : 0) || 0
    const dexIds = cardDexIds(item)

    if (dexIds.length === 0) {
      other.items.push(item)
      other.copies += quantity
      other.totalValue += value
      continue
    }

    const dexId = dexIds[0]
    let group = groups.get(dexId)
    if (!group) {
      const entry = speciesByDexId?.get?.(dexId) ?? null
      group = {
        dexId,
        name: speciesName(entry, language) || item?.card?.name || formatDexNumber(dexId),
        items: [],
        printings: new Set(),
        copies: 0,
        totalValue: 0,
      }
      groups.set(dexId, group)
    }
    group.items.push(item)
    group.printings.add(item?.card_id || item?.card?.id || item?.id)
    group.copies += quantity
    group.totalValue += value
  }

  const ordered = [...groups.values()]
    .sort((left, right) => left.dexId - right.dexId)
    .map(({ printings, ...group }) => ({ ...group, printingCount: printings.size }))

  return { groups: ordered, other }
}
