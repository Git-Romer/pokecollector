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

export function sortDeckEntries(entries = []) {
  const categoryIndex = new Map(CATEGORY_ORDER.map((category, index) => [category, index]))
  const categoryFor = (entry) => Object.entries(groupDeckEntries([entry])).find(([, grouped]) => grouped.length)?.[0] || 'Other'
  return [...entries].sort((left, right) => {
    const categoryDifference = categoryIndex.get(categoryFor(left)) - categoryIndex.get(categoryFor(right))
    if (categoryDifference) return categoryDifference
    const nameDifference = (left.card?.name || '').localeCompare(right.card?.name || '')
    if (nameDifference) return nameDifference
    return `${left.card?.set_id || ''} ${left.card?.number || ''}`.localeCompare(`${right.card?.set_id || ''} ${right.card?.number || ''}`)
  })
}

export function nextDeckCardIndex(index, total) {
  return total ? (index + 1) % total : null
}

export function previousDeckCardIndex(index, total) {
  return total ? (index - 1 + total) % total : null
}
