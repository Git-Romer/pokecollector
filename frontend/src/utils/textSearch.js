const COMBINING_MARKS_RE = /[\u0300-\u036f]/g

export function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS_RE, '')
    .toLowerCase()
    .trim()
}

export function textIncludes(value, query) {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return true
  return normalizeSearchText(value).includes(normalizedQuery)
}
