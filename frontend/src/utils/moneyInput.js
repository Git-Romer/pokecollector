export function formatMoneyInputValue(value, exchangeRate = 1) {
  if (value == null || value === '') return ''
  const amount = Number(value)
  if (!Number.isFinite(amount)) return ''
  const rate = Number(exchangeRate) || 1
  const converted = amount * rate
  return converted.toFixed(2)
}

export function parseMoneyInputValue(value, exchangeRate = 1, emptyValue = undefined) {
  if (value == null || value === '') return emptyValue
  const amount = Number(value)
  if (!Number.isFinite(amount)) return emptyValue
  const rate = Number(exchangeRate) || 1
  return Math.round((amount / rate) * 10000) / 10000
}

export function isValidMoneyInputValue(value) {
  if (value == null || value === '') return false
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0
}
