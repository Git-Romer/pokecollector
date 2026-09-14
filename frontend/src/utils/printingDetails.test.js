import { describe, expect, it } from 'vitest'
import {
  arePrintingDetailNamesSimilar,
  normalizePrintingDetailName,
  printingDetailNames,
} from './printingDetails'

describe('printing details', () => {
  it('normalizes accents, punctuation, case, and spacing for reuse', () => {
    expect(normalizePrintingDetailName('  Poké--BALL  ')).toBe('poke ball')
    expect(normalizePrintingDetailName('Poke_Ball')).toBe('poke ball')
  })

  it('deduplicates strings and API tag objects while preserving display names', () => {
    expect(printingDetailNames([
      { id: 1, name: 'Poké Ball' },
      'Poke-Ball',
      'Cosmos Holo',
    ])).toEqual(['Poké Ball', 'Cosmos Holo'])
  })

  it('warns about likely spelling mistakes but not unrelated labels', () => {
    expect(arePrintingDetailNamesSimilar('Poké Ball', 'Poke Bal')).toBe(true)
    expect(arePrintingDetailNamesSimilar('Cosmos Holo', 'Cosmos')).toBe(true)
    expect(arePrintingDetailNamesSimilar('Cosmos Holo', 'Expansion Stamp')).toBe(false)
  })
})
