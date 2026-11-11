// Public catalogue adapter. Uses the app's normalization/number semantics,
// never its authenticated search endpoint or private collection metadata.
import { normalizeSearchText, textIncludes } from './textSearch'
import { cardNumberMatches } from './cardNumbers'
const BASE = 'https://api.tcgdex.net/v2'
const cache = new Map()
async function read(path, signal) {
  if (cache.has(path)) return cache.get(path)
  const response = await fetch(BASE + path, { signal })
  if (response.status === 404) return null
  if (!response.ok) throw Error('Public catalogue unavailable')
  const data = await response.json()
  cache.set(path, data)
  return data
}
export async function searchPublicCards(query, language, { signal } = {}) {
  if (!['en', 'de'].includes(language)) throw Error('Unsupported card language')
  const text = String(query || '').trim()
  if (!text) return []
  const prefix = '/' + language
  const codeNumber = text.match(/^([A-Za-z0-9]+)\s+(\d+)$/)
  if (codeNumber) {
    const code = codeNumber[1].toLowerCase()
    const [direct, official] = await Promise.all([
      read(prefix + '/sets/' + encodeURIComponent(code), signal),
      read(prefix + '/sets?abbreviation.official=' + encodeURIComponent('eq:' + code.toUpperCase()), signal),
    ])
    const ids = [...new Set([...(direct?.id ? [direct.id] : []), ...(Array.isArray(official) ? official.map(s => s.id) : [])])]
    if (ids.length) {
      const sets = await Promise.all(ids.map(id => read(prefix + '/sets/' + encodeURIComponent(id), signal)))
      return sets.flatMap(set => (set?.cards || []).filter(card => cardNumberMatches(card.localId, codeNumber[2]))
        .map(card => ({ ...card, set: { id: set.id, name: set.name }, matchingSetCode: codeNumber[1].toUpperCase() })))
        .sort((a, b) => a.id.localeCompare(b.id))
    }
    // The code resolves to no public set, so it is not a set reference. Fall
    // through to the name search below, which keeps card names that look
    // like a code-number pair reachable.
  }
  // Keep explicit TCGdex IDs, but don't misclassify hyphenated Pokémon names
  // (Ho-Oh, Porygon-Z) as IDs. Their numeric suffix distinguishes catalogue IDs.
  if (/^[a-z0-9][a-z0-9._-]*-[a-z]*\d+[a-z]*$/i.test(text)) {
    const card = await read(prefix + '/cards/' + encodeURIComponent(text), signal)
    if (card?.id) return [card]
  }
  // Filtering an upstream name query loses accent variants. Download its public
  // brief index once per language, then use the exact app text normalizer.
  const cards = await read(prefix + '/cards', signal)
  if (!Array.isArray(cards)) throw Error('Invalid public card index')
  return cards.filter(card => textIncludes(card.name, text))
    .sort((a, b) => normalizeSearchText(a.name).localeCompare(normalizeSearchText(b.name)) || a.id.localeCompare(b.id))
}
export { normalizeSearchText, textIncludes }
