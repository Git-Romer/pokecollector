import { describe, expect, it, vi } from 'vitest'
import { gridFocusSnapshot, restoreGridFocus } from './WindowedCardGrid'

describe('measured grid focus across responsive row regrouping', () => {
  it('restores the same keyed item and control after its old row is replaced', () => {
    const oldLink = { closest: () => oldItem }
    const oldItem = { dataset: { windowItem: 'artist "quoted"' }, querySelectorAll: () => [oldLink] }
    const oldGrid = { contains: item => item === oldItem }
    const snapshot = gridFocusSnapshot(oldGrid, oldLink)
    const newLink = { focus: vi.fn() }
    const newItem = { dataset: oldItem.dataset, querySelectorAll: () => [newLink] }
    const newGrid = { querySelectorAll: () => [newItem] }
    expect(restoreGridFocus(newGrid, snapshot)).toBe(true)
    expect(newLink.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  })

  it('does not capture focus belonging to a different grid', () => {
    const item = {}
    expect(gridFocusSnapshot({ contains: () => false }, { closest: () => item })).toBeNull()
  })

  it('does not redirect focus when the captured item no longer exists', () => {
    expect(restoreGridFocus({ querySelectorAll: () => [] }, { key: 'gone', index: 0 })).toBe(false)
  })
})
