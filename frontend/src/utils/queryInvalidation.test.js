import { describe, expect, it, vi } from 'vitest'
import { invalidateCardState, invalidateCollectionPhotoState } from './queryInvalidation'

describe('invalidateCardState', () => {

  it('refreshes species summaries after collection edits and own-photo changes', () => {
    const invalidateQueries = vi.fn(), removeQueries = vi.fn()
    const queryClient = { invalidateQueries, removeQueries }
    invalidateCardState(queryClient)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['species-duplicates'] })
    invalidateQueries.mockClear()
    invalidateCollectionPhotoState(queryClient)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['species-duplicates'] })
  })

  it('refreshes card tile views and the active set checklist without global invalidation', () => {
    const invalidateQueries = vi.fn()
    invalidateCardState({ invalidateQueries }, { setId: 'sv1_en' })
    expect(invalidateQueries).toHaveBeenCalledTimes(10)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['printing-detail-tags'] })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['set-checklist', 'sv1_en'] })
    const artistChecklistCall = invalidateQueries.mock.calls.find(
      ([filters]) => typeof filters.predicate === 'function'
        && filters.predicate({ queryKey: ['artist-checklist', 'Mitsuhiro Arita'] })
    )
    expect(artistChecklistCall).toBeTruthy()
    const artistsIndexCall = invalidateQueries.mock.calls.find(
      ([filters]) => typeof filters.predicate === 'function'
        && filters.predicate({ queryKey: ['artists-index', { lang: 'all' }] })
    )
    expect(artistsIndexCall).toBeTruthy()
    expect(artistsIndexCall[0].predicate({ queryKey: ['wishlist'] })).toBe(false)
    expect(artistChecklistCall[0].predicate({ queryKey: ['artists-index'] })).toBe(false)
  })

  it('refreshes every cached set checklist when the mutation has no set context', () => {
    const invalidateQueries = vi.fn()
    invalidateCardState({ invalidateQueries })
    expect(invalidateQueries).toHaveBeenCalledTimes(10)

    const checklistCall = invalidateQueries.mock.calls.find(
      ([filters]) => typeof filters.predicate === 'function'
        && filters.predicate({ queryKey: ['set-checklist', 'sv1_en'] })
    )
    expect(checklistCall).toBeTruthy()
    expect(checklistCall[0].predicate({ queryKey: ['card-search'] })).toBe(false)
  })
})
