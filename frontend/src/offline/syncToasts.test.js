import { describe, expect, it, vi } from 'vitest'
import { createSyncReporter, LAST_SYNCED_KEY, readLastSynced } from './syncToasts.js'

function setup() {
  const toast = { success: vi.fn(), error: vi.fn() }
  const data = {}
  const storage = { getItem: k => data[k] ?? null, setItem: (k, v) => { data[k] = v } }
  let clock = 1000
  const report = createSyncReporter({ toast, getT: () => key => key, now: () => clock, storage })
  return { toast, storage, report, advance: ms => { clock += ms } }
}

describe('createSyncReporter', () => {
  it('coalesces synced toasts to one per minute and records the time', () => {
    const { toast, report, advance, storage } = setup()
    report({ outcomes: [{ id: 'a', next: 'sent' }] })
    advance(10000)
    report({ outcomes: [{ id: 'b', next: 'sent' }] })
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('sync.syncedToast', { id: 'sync-synced' })
    expect(readLastSynced(storage)).toBe(11000)
    advance(60000)
    report({ outcomes: [{ id: 'c', next: 'sent' }] })
    expect(toast.success).toHaveBeenCalledTimes(2)
  })

  it('shows one error toast per failed item and none for retry_wait', () => {
    const { toast, report } = setup()
    report({ outcomes: [{ id: 'a', next: 'failed' }, { id: 'b', next: 'retry_wait' }, { id: 'c', next: 'failed' }] })
    expect(toast.error).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledWith('sync.failedToast', { id: 'sync-failed-a' })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('ignores skipped runs', () => {
    const { toast, report } = setup()
    report({ ran: false, skipped: 'idle' })
    report(undefined)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reads no last-synced time from empty or broken storage', () => {
    expect(readLastSynced({ getItem: () => null })).toBeNull()
    expect(readLastSynced({ getItem: () => { throw new Error('x') } })).toBeNull()
    expect(LAST_SYNCED_KEY).toBe('pc.sync.lastSyncedAt')
  })
})
