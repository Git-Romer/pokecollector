export const PRINTING_DETAIL_MAX_TAGS = 10

export function normalizePrintingDetailName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function printingDetailNames(details) {
  const seen = new Set()
  return (details || [])
    .map(detail => typeof detail === 'string' ? detail : detail?.name)
    .filter(Boolean)
    .filter((name) => {
      const key = normalizePrintingDetailName(name)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function arePrintingDetailNamesSimilar(left, right) {
  const a = normalizePrintingDetailName(left)
  const b = normalizePrintingDetailName(right)
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 2) return false

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[b.length] <= 2
}
