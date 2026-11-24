import { describe, expect, it } from 'vitest'
import { canTransition, transitionRows, TRANSITIONS } from './states.js'

// One case per row of the §6.2.4 table.
const ALLOWED = [
  [1, null, 'pending', 'ui'],
  [2, 'pending', 'sending', 'replayer'],
  [2, 'retry_wait', 'sending', 'replayer'],
  [3, 'sending', 'sent', 'replayer'],
  [4, 'sending', 'retry_wait', 'replayer'],
  ['4b', 'sending', 'pending', 'replayer'],
  [5, 'sending', 'blocked', 'replayer'],
  [6, 'sending', 'failed', 'replayer'],
  [7, 'sending', 'retry_wait', 'replayer'],
  [8, 'blocked', 'pending', 'provider'],
  [8, 'blocked', 'pending', 'ui'],
  [9, 'failed', 'pending', 'ui'],
  [10, 'failed', 'pending', 'ui'],
  [11, 'pending', 'cancelled', 'ui'],
  [11, 'retry_wait', 'cancelled', 'ui'],
  [11, 'blocked', 'cancelled', 'ui'],
  [11, 'failed', 'cancelled', 'ui'],
  [11, 'sending', 'cancelled', 'ui'],
  [12, 'pending', 'pending', 'ui'],
  [13, 'pending', 'blocked', 'engine'],
  [13, 'retry_wait', 'blocked', 'engine'],
  [13, 'failed', 'blocked', 'engine'],
]

describe('state machine (design §6.2.4)', () => {
  it.each(ALLOWED)('row %s: %s -> %s by %s is allowed', (row, from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(true)
    expect(transitionRows(from, to, actor)).toContain(row)
  })

  it('covers every row of the table', () => {
    const covered = new Set(ALLOWED.map(([row]) => row))
    TRANSITIONS.forEach(row => expect(covered.has(row.id)).toBe(true))
  })

  it.each([
    ['pending', 'sent', 'replayer'],
    ['failed', 'sending', 'replayer'],
    ['blocked', 'sending', 'replayer'],
    ['pending', 'failed', 'replayer'],
    ['failed', 'pending', 'replayer'],
    ['blocked', 'pending', 'engine'],
    ['pending', 'sending', 'ui'],
    ['sending', 'pending', 'ui'],
    ['sent', 'pending', 'ui'],
    [null, 'sending', 'replayer'],
    [null, 'blocked', 'engine'],
  ])('%s -> %s by %s is refused', (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(false)
  })
})
