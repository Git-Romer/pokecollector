import { describe, expect, it, vi } from 'vitest'
import { invalidateCardState } from './queryInvalidation'

describe('invalidateCardState', () => {
  it('refreshes card tile views and the active set checklist without global invalidation', () => {
    const invalidateQueries = vi.fn()
    invalidateCardState({ invalidateQueries }, { setId: 'sv1_en' })
    expect(invalidateQueries).toHaveBeenCalledTimes(6)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['set-checklist', 'sv1_en'] })
  })

  it('refreshes every cached set checklist when the mutation has no set context', () => {
    const invalidateQueries = vi.fn()
    invalidateCardState({ invalidateQueries })
    expect(invalidateQueries).toHaveBeenCalledTimes(6)

    const checklistCall = invalidateQueries.mock.calls.find(
      ([filters]) => typeof filters.predicate === 'function'
        && filters.predicate({ queryKey: ['set-checklist', 'sv1_en'] })
    )
    expect(checklistCall).toBeTruthy()
    expect(checklistCall[0].predicate({ queryKey: ['card-search'] })).toBe(false)
  })
})
