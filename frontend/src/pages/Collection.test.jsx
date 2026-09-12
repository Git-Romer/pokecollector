import { describe, expect, it } from 'vitest'
import { buildCollectionQuery } from './Collection'

describe('Collection Rule text query', () => {
  it('sends a non-empty Rule text value to the collection endpoint', () => {
    expect(buildCollectionQuery('Thunder Jab').params).toEqual({ rule_text: 'Thunder Jab' })
  })

  it('omits rule_text when Rule text is empty', () => {
    expect(buildCollectionQuery('').params).toEqual({})
  })

  it('trims Rule text and omits whitespace-only values', () => {
    expect(buildCollectionQuery('  Thunder Jab  ').params).toEqual({ rule_text: 'Thunder Jab' })
    expect(buildCollectionQuery('   ').params).toEqual({})
  })

  it('changes the collection query state when Rule text changes', () => {
    expect(buildCollectionQuery('Thunder Jab').queryKey).not.toEqual(buildCollectionQuery('Solar Engine').queryKey)
  })

  it('retains previous collection data while a Rule text query is fetching', () => {
    const previousData = [{ id: 1, card_id: 'sv1-1_en' }]
    expect(buildCollectionQuery('Thunder Jab').placeholderData(previousData)).toBe(previousData)
  })

  it('removes rule_text from the collection request when Rule text is cleared', () => {
    expect(buildCollectionQuery('Thunder Jab').params).toEqual({ rule_text: 'Thunder Jab' })
    expect(buildCollectionQuery('').params).toEqual({})
  })

  it('reset input value produces an unfiltered collection query', () => {
    expect(buildCollectionQuery('').params).toEqual({})
  })
})
