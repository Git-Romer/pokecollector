import { describe, expect, it } from 'vitest'
import { formatBinderCountSummary } from './binderCounts'

const labels = {
  'binders.card': 'card',
  'binders.cards': 'cards',
  'binders.uniqueCard': 'unique card',
  'binders.uniqueCards': 'unique cards',
}
const t = key => labels[key]

describe('formatBinderCountSummary', () => {
  it('shows physical and unique counts when copies are allocated', () => {
    expect(formatBinderCountSummary(8, 3, t)).toBe('8 cards · 3 unique cards')
  })

  it('uses singular labels', () => {
    expect(formatBinderCountSummary(4, 1, t)).toBe('4 cards · 1 unique card')
  })

  it('does not repeat an identical unique count', () => {
    expect(formatBinderCountSummary(3, 3, t)).toBe('3 cards')
  })
})
