import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCollectionQuery, debounce, RULE_TEXT_DEBOUNCE_MS } from './Collection'

afterEach(() => vi.useRealTimers())

describe('Collection Rule text query', () => {
  it('sends a non-empty Rule text value to the collection endpoint', () => {
    expect(buildCollectionQuery('Thunder Jab').params).toEqual({ rule_text: 'Thunder Jab' })
  })

  it('omits rule_text when Rule text is empty', () => {
    expect(buildCollectionQuery('').params).toEqual({})
  })

  it('changes the collection query state when Rule text changes', () => {
    expect(buildCollectionQuery('Thunder Jab').queryKey).not.toEqual(buildCollectionQuery('Solar Engine').queryKey)
  })

  it('retains previous collection data while a Rule text query is fetching', () => {
    const previousData = [{ id: 1, card_id: 'sv1-1_en' }]
    expect(buildCollectionQuery('Thunder Jab').placeholderData(previousData)).toBe(previousData)
  })

  it('debounces rapid Rule text changes into one collection query update', () => {
    vi.useFakeTimers()
    const updateQuery = vi.fn()
    const updateRuleText = debounce(updateQuery, RULE_TEXT_DEBOUNCE_MS)

    updateRuleText('T')
    updateRuleText('Th')
    updateRuleText('Thu')
    vi.advanceTimersByTime(RULE_TEXT_DEBOUNCE_MS - 1)
    expect(updateQuery).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(updateQuery).toHaveBeenCalledTimes(1)
    expect(updateQuery).toHaveBeenCalledWith('Thu')
  })

  it('removes rule_text from the collection request when Rule text is cleared', () => {
    expect(buildCollectionQuery('Thunder Jab').params).toEqual({ rule_text: 'Thunder Jab' })
    expect(buildCollectionQuery('').params).toEqual({})
  })

  it('reset input value produces an unfiltered collection query', () => {
    expect(buildCollectionQuery('').params).toEqual({})
  })
})
