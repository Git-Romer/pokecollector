/** Format a catalogue date in the app locale without shifting its calendar month. */
export function formatSetReleaseDate(value, language = 'en') {
  if (!value) return ''
  const date = new Date(`${value}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value
  const options = { month: 'short', year: 'numeric', timeZone: 'UTC' }
  try { return date.toLocaleDateString(language || 'en', options) }
  catch { return date.toLocaleDateString('en', options) }
}
