import { cardNumberMatches } from './cardNumbers'
import { normalizeSearchText, textIncludes } from './textSearch'

export function aggregateDeckCollectionItems(items = []) {
  return Object.values(items.reduce((cards, item) => {
    const card = item.card || item
    if (!card?.id) return cards
    cards[card.id] = cards[card.id]
      ? { ...cards[card.id], quantity: cards[card.id].quantity + Number(item.quantity || 0) }
      : { ...item, card, quantity: Number(item.quantity || 0) }
    return cards
  }, {})).filter(item => item.quantity > 0)
}

export function filterDeckCollectionCards(items = [], { search = '', type = '', set = '', language = '' } = {}) {
  return items.filter(item => {
    const card = item.card || item
    const setId = card.set_ref?.id || card.set_id || ''
    const cardLanguage = card.lang || item.lang || ''
    if (type && normalizeSearchText(card.supertype) !== normalizeSearchText(type)) return false
    if (set && setId !== set) return false
    if (language && cardLanguage !== language) return false
    if (!search) return true
    return textIncludes(card.name, search)
      || textIncludes(card.set_ref?.name || card.set_name || card.set?.name, search)
      || cardNumberMatches(card.number, search)
  })
}

export function deckPickerOptions(items = []) {
  const sets = new Map()
  const languages = new Set()
  items.forEach(item => {
    const card = item.card || item
    const id = card.set_ref?.id || card.set_id
    if (id) sets.set(id, card.set_ref?.name || card.set_name || id)
    if (card.lang || item.lang) languages.add(card.lang || item.lang)
  })
  return {
    sets: [...sets].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
    languages: [...languages].sort(),
  }
}
