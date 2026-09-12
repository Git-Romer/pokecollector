import { describe, expect, it } from 'vitest'
import { assemblyEntries, assemblyProgress, clampPulledQuantity, deckAssemblyCsv, deckAssemblyText, missingDeckCards } from './deckAssembly'

const entries = [
  { id: 1, required_quantity: 4, owned_quantity: 3, shortage: 1, card: { name: "Professor's Research", supertype: 'Trainer' } },
  { id: 2, required_quantity: 2, owned_quantity: 2, shortage: 0, card: { name: 'Virizion', supertype: 'Pokemon' } },
]

describe('deck assembly utilities', () => {
  it('generates per-copy progress clamped to ownership and required quantity', () => {
    expect(assemblyEntries(entries, { 1: 7, 2: 1 }).map(entry => entry.pulled_quantity)).toEqual([1, 3])
    expect(clampPulledQuantity(-1, entries[0])).toBe(0)
  })

  it('calculates physical progress, shortages, and remaining owned copies', () => {
    const result = assemblyProgress(assemblyEntries(entries, { 1: 3, 2: 1 }))
    expect(result).toMatchObject({ required: 6, pulled: 4, missing: 1, remainingToPull: 1 })
  })

  it('lists shortages and exports only missing cards', () => {
    expect(missingDeckCards(entries).map(entry => [entry.card.name, entry.missing_quantity])).toEqual([["Professor's Research", 1]])
    expect(deckAssemblyText({ name: 'Practice' }, entries, true)).toBe("1x Professor's Research")
  })

  it('exports a checklist and escaped CSV values', () => {
    expect(deckAssemblyText({ name: 'Practice', current_card_count: 6 }, entries)).toContain('☐ 2x Virizion')
    expect(deckAssemblyCsv(assemblyEntries(entries, { 1: 3 }))).toContain('"Professor\'s Research"')
  })
})
