import { describe, expect, it, vi } from 'vitest'
import { invalidateCardState } from './queryInvalidation'

describe('invalidateCardState', () => {
  it('refreshes card tile views and the active set checklist without global invalidation', () => {
    const invalidateQueries = vi.fn()
    invalidateCardState({ invalidateQueries }, { setId: 'sv1_en' })
    expect(invalidateQueries).toHaveBeenCalledTimes(6)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['set-checklist', 'sv1_en'] })
  })
})
