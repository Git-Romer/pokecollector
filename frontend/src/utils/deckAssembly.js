import { groupDeckEntries, sortDeckEntries } from './deckProgress'

export const clampPulledQuantity = (quantity, entry) => Math.max(0, Math.min(
  Number(quantity) || 0,
  Number(entry.required_quantity) || 0,
  Number(entry.owned_quantity) || 0,
))

export function assemblyEntries(entries = [], progress = {}) {
  return sortDeckEntries(entries).map(entry => ({
    ...entry,
    pulled_quantity: clampPulledQuantity(progress[entry.id], entry),
  }))
}

export function assemblyProgress(entries = []) {
  const required = entries.reduce((total, entry) => total + Number(entry.required_quantity || 0), 0)
  const pulled = entries.reduce((total, entry) => total + Number(entry.pulled_quantity || 0), 0)
  const missing = entries.reduce((total, entry) => total + Math.max(Number(entry.required_quantity || 0) - Number(entry.owned_quantity || 0), 0), 0)
  const remainingToPull = entries.reduce((total, entry) => total + Math.max(clampPulledQuantity(entry.owned_quantity, entry) - Number(entry.pulled_quantity || 0), 0), 0)
  return { required, pulled, missing, remainingToPull, percent: required ? pulled / required * 100 : 0 }
}

export function missingDeckCards(entries = []) {
  return entries.filter(entry => Number(entry.shortage || 0) > 0).map(entry => ({
    ...entry,
    missing_quantity: Math.max(Number(entry.required_quantity || 0) - Number(entry.owned_quantity || 0), 0),
  }))
}

export function deckAssemblyText(deck, entries = [], missingOnly = false) {
  const selected = missingOnly ? missingDeckCards(entries).map(entry => ({ ...entry, required_quantity: entry.missing_quantity })) : entries
  if (missingOnly) return selected.map(entry => `${entry.required_quantity}x ${entry.card?.name || entry.card_id}`).join('\n')
  const groups = groupDeckEntries(selected)
  return [deck.name, `Target: ${deck.current_card_count || selected.reduce((sum, entry) => sum + entry.required_quantity, 0)}`, '', ...Object.entries(groups).flatMap(([category, categoryEntries]) => (
    categoryEntries.length ? [category, ...categoryEntries.map(entry => `☐ ${entry.required_quantity}x ${entry.card?.name || entry.card_id}`), ''] : []
  ))].join('\n').trim()
}

const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`

export function deckAssemblyCsv(entries = []) {
  return [
    ['card_name', 'set', 'number', 'required', 'owned', 'missing', 'pulled'],
    ...entries.map(entry => [entry.card?.name || entry.card_id, entry.card?.set_ref?.name || entry.card?.set_id || '', entry.card?.number || '', entry.required_quantity, entry.owned_quantity, Math.max(entry.required_quantity - entry.owned_quantity, 0), entry.pulled_quantity]),
  ].map(row => row.map(csvCell).join(',')).join('\n')
}
