export function deckProgress(deck = {}) {
  const current = Number(deck.current_card_count ?? deck.entries?.reduce((sum, entry) => sum + Number(entry.required_quantity || 0), 0) ?? 0)
  const target = Number(deck.target_size || 0)
  return {
    current,
    target,
    remaining: Math.max(target - current, 0),
    over: Math.max(current - target, 0),
    status: current < target ? 'under' : current > target ? 'over' : 'complete',
  }
}

export function deckShortage(entries = []) {
  return entries.reduce((total, entry) => total + Math.max(Number(entry.required_quantity || 0) - Number(entry.owned_quantity || 0), 0), 0)
}

export function groupDeckEntries(entries = []) {
  const groups = { Pokemon: [], Trainer: [], Energy: [], Other: [] }
  entries.forEach(entry => {
    const supertype = entry.card?.supertype?.toLowerCase()
    const group = supertype === 'pokemon' || supertype === 'pokémon' ? 'Pokemon' : supertype === 'trainer' ? 'Trainer' : supertype === 'energy' ? 'Energy' : 'Other'
    groups[group].push(entry)
  })
  return groups
}

const CATEGORY_ORDER = ['Pokemon', 'Trainer', 'Energy', 'Other']

export const DECK_SORT_MODES = ['type', 'stage', 'rarity', 'name']

const STAGE_ORDER = ['basic', 'baby', 'stage1', 'stage2', 'mega', 'vmax', 'vstar', 'v-union', 'break', 'level-up', 'restored']
const TRAINER_TYPE_ORDER = ['supporter', 'item', 'tool', 'stadium']
const RARITY_ORDER = [
  'common', 'uncommon', 'rare', 'holo rare', 'rare holo', 'promo', 'double rare', 'holo rare v', 'holo rare vmax', 'holo rare vstar',
  'ultra rare', 'illustration rare', 'special illustration rare', 'hyper rare', 'secret rare', 'ace spec rare',
]

const normalized = value => String(value || '').trim().toLowerCase()
const rankIn = (order, value, fallback = order.length) => {
  const index = order.indexOf(normalized(value))
  return index === -1 ? fallback : index
}

/** Secondary rank inside a category: Pokémon by stage, Trainers by trainer type, Energy with basics first. */
function stageRank(entry, category) {
  const card = entry.card || {}
  if (category === 'Pokemon') return rankIn(STAGE_ORDER, card.stage)
  if (category === 'Trainer') return rankIn(TRAINER_TYPE_ORDER, card.trainer_type)
  if (category === 'Energy') {
    const subtypes = (card.subtypes || []).map(normalized)
    return subtypes.includes('special') || normalized(card.energy_type) === 'special' ? 1 : 0
  }
  return 0
}

export function deckComposition(entries = [], targetSize = 0, compositionCounts = null) {
  const groups = groupDeckEntries(entries)
  const counts = Object.fromEntries(CATEGORY_ORDER.map(category => [
    category,
    compositionCounts ? Math.max(Number(compositionCounts[category]) || 0, 0) : groups[category].reduce((total, entry) => total + Number(entry.required_quantity || 0), 0),
  ]))
  const target = Math.max(Number(targetSize) || 0, 0)
  const currentTotal = CATEGORY_ORDER.reduce((total, category) => total + counts[category], 0)
  const isBelowTarget = target > 0 && currentTotal < target
  const denominator = isBelowTarget ? target : currentTotal
  const remaining = isBelowTarget ? target - currentTotal : 0
  const segments = CATEGORY_ORDER.map(category => {
    return {
      category,
      count: counts[category],
      visibleCount: counts[category],
      widthPercent: denominator > 0 ? (counts[category] / denominator) * 100 : 0,
    }
  })
  const totalVisiblePercent = segments.reduce((total, segment) => total + segment.widthPercent, 0)
  const remainingPercent = isBelowTarget ? (remaining / target) * 100 : 0
  return { counts, segments, currentTotal, remaining, remainingPercent, totalVisiblePercent }
}

export function sortDeckEntries(entries = [], mode = 'type') {
  const categoryIndex = new Map(CATEGORY_ORDER.map((category, index) => [category, index]))
  const categoryFor = (entry) => Object.entries(groupDeckEntries([entry])).find(([, grouped]) => grouped.length)?.[0] || 'Other'
  const sortMode = DECK_SORT_MODES.includes(mode) ? mode : 'type'
  const byIdentity = (left, right) => {
    const nameDifference = (left.card?.name || '').localeCompare(right.card?.name || '')
    if (nameDifference) return nameDifference
    return `${left.card?.set_id || ''} ${left.card?.number || ''}`.localeCompare(`${right.card?.set_id || ''} ${right.card?.number || ''}`)
  }
  return [...entries].sort((left, right) => {
    if (sortMode === 'name') return byIdentity(left, right)
    if (sortMode === 'rarity') {
      // Rarest first, so the pulls Magnus-style collectors care about sit at the top; unknown rarities sink to the bottom.
      const rarityDifference = rankIn(RARITY_ORDER, right.card?.rarity, -1) - rankIn(RARITY_ORDER, left.card?.rarity, -1)
      if (rarityDifference) return rarityDifference
      return byIdentity(left, right)
    }
    const leftCategory = categoryFor(left)
    const rightCategory = categoryFor(right)
    const categoryDifference = categoryIndex.get(leftCategory) - categoryIndex.get(rightCategory)
    if (categoryDifference) return categoryDifference
    if (sortMode === 'stage') {
      const stageDifference = stageRank(left, leftCategory) - stageRank(right, rightCategory)
      if (stageDifference) return stageDifference
    }
    return byIdentity(left, right)
  })
}

export function nextDeckCardIndex(index, total) {
  return total ? (index + 1) % total : null
}

export function previousDeckCardIndex(index, total) {
  return total ? (index - 1 + total) % total : null
}
