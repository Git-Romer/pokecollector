const EFFECT_CLASS = {
  holo: 'card-variant-effect card-variant-holo',
  reverse: 'card-variant-effect card-variant-reverse',
  firstEdition: 'card-variant-effect card-variant-first-edition',
}

// Grouped tiles can represent several prints but must never stack animations.
// Pick one stable representative effect while badges retain the full breakdown.
const EFFECT_PRIORITY = ['firstEdition', 'reverse', 'holo']

const normalizeVariant = (variant) => String(variant || '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
  .trim()

const getVariantName = (value) => (
  typeof value === 'string' ? value : value?.variant
)

const getVariantEffect = (variant) => {
  const normalized = normalizeVariant(variant)
  if (normalized === 'first edition') return 'firstEdition'
  if (normalized === 'reverse holo') return 'reverse'
  if (normalized === 'holo') return 'holo'
  return null
}

const getVariants = (source) => {
  if (Array.isArray(source)) return source.map(getVariantName)
  if (typeof source === 'string') return [source]
  if (!source || typeof source !== 'object') return []
  if (
    Object.prototype.hasOwnProperty.call(source, 'variant')
    && normalizeVariant(source.variant)
  ) return [source.variant]
  if (Array.isArray(source.owned_variants)) return source.owned_variants.map(getVariantName)
  if (Array.isArray(source.owned_items)) return source.owned_items.map(getVariantName)
  return []
}

export function getCardVariantEffectType(source) {
  const effects = new Set(getVariants(source).map(getVariantEffect).filter(Boolean))
  return EFFECT_PRIORITY.find(effect => effects.has(effect)) || null
}

export function getCardVariantEffectClass(source) {
  const effect = getCardVariantEffectType(source)
  return effect ? EFFECT_CLASS[effect] : ''
}
