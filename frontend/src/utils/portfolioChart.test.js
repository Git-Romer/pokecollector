import { describe, expect, it } from 'vitest'
import { mapPortfolioChartData, portfolioApiPeriod } from './portfolioChart'

describe('portfolio chart helpers', () => {
  it.each([
    ['1W', '1w'],
    ['1M', '1m'],
    ['1Y', '1y'],
    ['MAX', 'max'],
    ['unknown', 'max'],
  ])('maps %s to the analytics period %s', (period, expected) => {
    expect(portfolioApiPeriod(period)).toBe(expected)
  })

  it('keeps intraday snapshots distinguishable in the weekly tooltip', () => {
    const snapshots = [
      { date: '2026-08-10T08:00:00Z', value: 10, cost: 5 },
      { date: '2026-08-10T12:00:00Z', value: 12, cost: 5 },
    ]

    const result = mapPortfolioChartData(snapshots, '1W', 'Legacy')

    expect(result).toHaveLength(2)
    expect(result[0].tooltipLabel).not.toBe(result[1].tooltipLabel)
    expect(result.map(point => point.value)).toEqual([10, 12])
  })

  it('uses compact month labels for long periods and retains snapshot metadata', () => {
    const result = mapPortfolioChartData([
      { date: '2025-04-01', value: 25, cost: 20, legacy: true },
    ], '1Y', 'Imported snapshot')

    expect(result[0]).toMatchObject({
      date: 'Apr 25',
      tooltipLabel: 'Apr 25',
      value: 25,
      cost: 20,
      legacy: true,
      legacyLabel: 'Imported snapshot',
    })
  })
})
