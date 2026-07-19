// Shared EUR formatter for the public pages. Returns null when there is nothing to
// show (null/undefined/non-numeric) so a caller can conditionally render — a market
// value hidden by the owner arrives as null from the API and stays hidden in the UI.
export function formatEur(value) {
  if (value == null || Number.isNaN(Number(value))) return null
  return new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(Number(value))
}
