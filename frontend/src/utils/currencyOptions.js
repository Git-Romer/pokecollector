export function currencyOptionsFor(currencies, currentCurrency) {
  const options = (Array.isArray(currencies) ? currencies : []).map(currency => ({
    value: currency.code,
    label: currency.name ? `${currency.code} — ${currency.name}` : currency.code,
  }))

  if (currentCurrency && !options.some(option => option.value === currentCurrency)) {
    options.push({ value: currentCurrency, label: currentCurrency })
  }

  return options
}
