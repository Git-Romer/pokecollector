import { describe, expect, it } from 'vitest'
import { partitionSettledResults } from './settledResults'

describe('partitionSettledResults', () => {
  it('keeps successful picker ids separate from failures for safe retries', () => {
    const error = new Error('duplicate')
    const result = partitionSettledResults(
      [11, 12, 13],
      [
        { status: 'fulfilled', value: {} },
        { status: 'rejected', reason: error },
        { status: 'fulfilled', value: {} },
      ],
    )

    expect(result.succeededIds).toEqual([11, 13])
    expect(result.failed).toEqual([{ status: 'rejected', reason: error }])
  })
})
