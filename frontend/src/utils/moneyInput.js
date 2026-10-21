function normalizeExchangeRate(value) {
  if (value == null || value === '') return null
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

export function formatMoneyInputValue(value, exchangeRate = 1) {
  if (value == null || value === '') return ''
  const amount = Number(value)
  const rate = normalizeExchangeRate(exchangeRate)
  if (!Number.isFinite(amount) || rate == null) return ''
  return (amount * rate).toFixed(2)
}

export function parseMoneyInputValue(value, exchangeRate = 1, emptyValue = undefined) {
  if (value == null || value === '') return emptyValue
  const amount = Number(value)
  const rate = normalizeExchangeRate(exchangeRate)
  if (!Number.isFinite(amount) || rate == null) return emptyValue
  return Math.round((amount / rate) * 10000) / 10000
}

export function isValidMoneyInputValue(value) {
  if (value == null || value === '') return false
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0
}
