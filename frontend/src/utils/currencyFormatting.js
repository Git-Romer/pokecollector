export function currencySymbolFor(code, locale = 'en') {
  try {
    const part = new Intl.NumberFormat(locale || 'en', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'symbol',
    })
      .formatToParts(0)
      .find((item) => item.type === 'currency')
    return part?.value || code
  } catch {
    return code
  }
}

export function formatSelectedCurrency(amount, currency, rate, locale = 'en') {
  if (amount == null || amount === '') return '-'
  const numericAmount = Number(amount)
  if (!Number.isFinite(numericAmount)) return '-'

  const code = String(currency || '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return 'Unavailable (selected currency)'
  const numericRate = Number(rate)
  if (!Number.isFinite(numericRate) || numericRate <= 0) {
    return `Unavailable (${code})`
  }

  const converted = numericAmount * numericRate
  try {
    return new Intl.NumberFormat(locale || 'en', {
      style: 'currency',
      currency: code,
    }).format(converted)
  } catch {
    return `${code} ${converted.toFixed(2)}`
  }
}
