import { normalizeSearchText } from './textSearch'

export const PRODUCT_CARD_TIME_RANGES = [
  { id: 'hour', milliseconds: 60 * 60 * 1000 },
  { id: 'day', milliseconds: 24 * 60 * 60 * 1000 },
  { id: 'week', milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { id: 'month', milliseconds: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', milliseconds: null },
]

export const PRODUCT_CARD_SELECTION_LIMIT = 200

export function selectVisibleProductCardCandidates(selections, visibleCandidates) {
  const next = { ...selections }
  let remaining = Math.max(PRODUCT_CARD_SELECTION_LIMIT - Object.keys(next).length, 0)

  for (const { item, available } of visibleCandidates) {
    if (next[item.id] != null) continue
    if (remaining === 0) break
    next[item.id] = Math.min(1, available)
    remaining -= 1
  }

  return next
}

export function parseCollectionAddedAt(value) {
  if (!value) return NaN
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`
  return Date.parse(normalized)
}

export function filterProductCardCandidates(candidates, { search = '', timeRange = 'all', now = Date.now() } = {}) {
  const normalizedSearch = normalizeSearchText(search)
  const range = PRODUCT_CARD_TIME_RANGES.find(option => option.id === timeRange) || PRODUCT_CARD_TIME_RANGES.at(-1)
  const cutoff = range.milliseconds == null ? null : now - range.milliseconds

  return candidates
    .filter(({ item }) => {
      if (cutoff != null) {
        const addedAt = parseCollectionAddedAt(item.added_at)
        if (!Number.isFinite(addedAt) || addedAt < cutoff) return false
      }
      if (!normalizedSearch) return true
      const card = item.card || {}
      const searchable = [
        card.name,
        card.set_ref?.name,
        card.set_id,
        card.number,
        item.variant,
        item.condition,
        item.lang,
        item.purchase_price,
      ].map(normalizeSearchText).join(' ')
      return searchable.includes(normalizedSearch)
    })
    .sort((left, right) => {
      const leftAdded = parseCollectionAddedAt(left.item.added_at) || 0
      const rightAdded = parseCollectionAddedAt(right.item.added_at) || 0
      if (leftAdded !== rightAdded) return rightAdded - leftAdded
      return String(left.item.card?.name || left.item.card_id).localeCompare(String(right.item.card?.name || right.item.card_id))
    })
}
