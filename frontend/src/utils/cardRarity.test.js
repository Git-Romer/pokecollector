import { describe, expect, it } from 'vitest'
import { getCardRarityEffectClass } from './cardRarity'

describe('getCardRarityEffectClass', () => {
  it.each([
    ['Rare Holo', 'en', 'card-holo'],
    ['Ultra Rare', 'en', 'card-holo'],
    ['Full Art Trainer', 'en', 'card-holo'],
    ['Illustration Rare', 'en', 'card-holo'],
    ['Hyper Rare', 'en', 'card-secret'],
    ['Secret Rare', 'en', 'card-secret'],
    ['Rainbow Rare', 'en', 'card-secret'],
    ['Selten', 'de', 'card-holo'],
    ['Atemberaubend', 'de', 'card-holo'],
    ['Vollkunsttrainer', 'de', 'card-holo'],
    ['Versteckt Selten', 'de', 'card-secret'],
    ['Magnifique rare', 'fr', 'card-secret'],
    ['Magnifique', 'fr', 'card-holo'],
    ['Dresseur Full Art', 'fr', 'card-holo'],
    ['Rare', 'fr', 'card-holo'],
    ['Rara Secreta', 'es', 'card-secret'],
    ['Entrenador de arte completo', 'es', 'card-holo'],
    ['Rara Ilustración', 'es-mx', 'card-holo'],
    ['Segreto rara', 'it', 'card-secret'],
    ["Allenatore d'arte completa", 'it', 'card-holo'],
    ['Rara illustrazione', 'it', 'card-holo'],
    ['Hiper rara', 'pt-br', 'card-secret'],
    ['Arte Completa de Treinador', 'pt', 'card-holo'],
    ['Rara Holo', 'pt', 'card-holo'],
    ['Rare', 'ja', 'card-holo'],
    ['Common', 'ko', ''],
    ['Common', 'en', ''],
    [null, 'en', ''],
  ])('maps %s (%s) to %s', (rarity, language, expected) => {
    expect(getCardRarityEffectClass(rarity, language)).toBe(expected)
  })
})
