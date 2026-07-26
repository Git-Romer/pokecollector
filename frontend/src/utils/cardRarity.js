const SECRET_MARKERS = {
  de: ['hyperselten', 'hyper selten', 'versteckt selten'],
  en: ['secret rare', 'rainbow rare', 'hyper rare'],
  es: ['rara secreta', 'rara hiper', 'mega hiper rara', 'rara ultra variocolor'],
  fr: ['magnifique rare', 'hyper rare', 'mega hyper rare'],
  it: ['segreto rara', 'rara iper', 'mega iper raro'],
  pt: ['rare secreta', 'rara secreta', 'hiper rara', 'mega hiper raro'],
}

const RARE_MARKERS = {
  de: ['selten', 'atemberaubend', 'vollkunsttrainer'],
  en: ['rare', 'full art trainer'],
  es: ['rara', 'increibles', 'entrenador de arte completo'],
  fr: ['rare', 'magnifique', 'dresseur full art'],
  it: ['rara', 'raro', 'ultrarara', 'policrome', 'allenatore d arte completa'],
  pt: ['rara', 'raro', 'raras', 'arte completa de treinador'],
}

const normalizeText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
  .trim()

const baseLanguage = (language) => {
  const normalized = String(language || 'en').toLowerCase().replace(/_/g, '-')
  return normalized.split('-')[0] || 'en'
}

const includesMarker = (value, markers) => markers.some(marker => value.includes(marker))

export function getCardRarityEffectClass(rarity = '', language = 'en') {
  const normalizedRarity = normalizeText(rarity)
  const lang = baseLanguage(language)
  const secretMarkers = SECRET_MARKERS[lang] || SECRET_MARKERS.en
  const rareMarkers = RARE_MARKERS[lang] || RARE_MARKERS.en

  if (includesMarker(normalizedRarity, secretMarkers)) return 'card-secret'
  if (includesMarker(normalizedRarity, rareMarkers)) return 'card-holo'

  return ''
}
