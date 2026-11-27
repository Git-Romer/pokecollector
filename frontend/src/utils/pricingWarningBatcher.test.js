import { describe, expect, it, vi } from 'vitest'
import { createPricingWarningBatcher } from './pricingWarningBatcher'

describe('pricing warning request batching', () => {
  it('combines mounted cards, deduplicates IDs and distributes their own results', async () => {
    const warnings = [{ product_id: 918849, other_cards: [{ id: 'regular' }] }]
    const fetch = vi.fn(async ids => ({ warnings: Object.fromEntries(ids.map(id => [id, id === 'rare' ? warnings : []])) }))
    const request = createPricingWarningBatcher(fetch)
    const results = await Promise.all([request('rare'), request('regular'), request('rare')])
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(['rare', 'regular'])
    expect(results).toEqual([warnings, [], warnings])
  })

  it('splits batches at the API limit without dropping any cards', async () => {
    const fetch = vi.fn(async ids => ({ warnings: Object.fromEntries(ids.map(id => [id, []])) }))
    const request = createPricingWarningBatcher(fetch)
    const results = await Promise.all(Array.from({ length: 501 }, (_, i) => request(`card-${i}`)))
    expect(results).toHaveLength(501)
    expect(fetch.mock.calls.map(([ids]) => ids.length)).toEqual([500, 1])
  })

  it('propagates failures and permits a later fresh request', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ warnings: { rare: [] } })
    const request = createPricingWarningBatcher(fetch)
    const first = await Promise.allSettled([request('rare'), request('regular')])
    expect(first.every(result => result.status === 'rejected')).toBe(true)
    await expect(request('rare')).resolves.toEqual([])
  })

  it('rejects missing results rather than pretending a card was checked', async () => {
    const request = createPricingWarningBatcher(async () => ({ warnings: {} }))
    await expect(request('rare')).rejects.toThrow('Missing pricing warning result')
  })
})
