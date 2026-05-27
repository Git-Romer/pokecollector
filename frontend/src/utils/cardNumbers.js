const DIGITS_RE = /^\d+$/

export function normalizeCardNumber(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (DIGITS_RE.test(text)) return text.replace(/^0+/, '') || '0'
  return text.toLowerCase()
}

export function cardNumberMatches(cardNumber, query) {
  const stored = String(cardNumber ?? '').trim()
  const requested = String(query ?? '').trim()
  if (!stored || !requested) return false
  if (stored.toLowerCase() === requested.toLowerCase()) return true
  return normalizeCardNumber(stored) === normalizeCardNumber(requested)
}
