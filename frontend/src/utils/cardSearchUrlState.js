export function isValidCardSearchPage(value) {
  const raw = String(value ?? '').trim()
  if (!/^[1-9]\d*$/.test(raw)) return false
  return Number.isSafeInteger(Number(raw))
}

export function parseCardSearchPage(value) {
  return isValidCardSearchPage(value) ? Number(value) : 1
}

export function getLastCardSearchPage(totalCount, pageSize) {
  const safeTotal = Number.isFinite(totalCount) && totalCount > 0 ? totalCount : 0
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1
  return Math.max(1, Math.ceil(safeTotal / safePageSize))
}

export function updateCardSearchParams(currentSearch, updates, { resetPage = true } = {}) {
  const next = new URLSearchParams(currentSearch)

  Object.entries(updates).forEach(([key, rawValue]) => {
    const value = String(rawValue ?? '').trim()
    if (!value || (key === 'sort_order' && value === 'asc')) next.delete(key)
    else next.set(key, value)
  })

  if (resetPage) next.delete('page')
  return next
}
