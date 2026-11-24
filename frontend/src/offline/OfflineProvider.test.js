import { describe, expect, it, vi } from 'vitest'
import { runLogoutGuard } from './OfflineProvider.jsx'

function fakeOutbox({ items = [{ id: 'a' }], syncNow = vi.fn(), discardAllForUser = vi.fn() } = {}) {
  const state = { items }
  return {
    state,
    start: vi.fn(async () => {}),
    getSnapshot: () => ({ items: state.items }),
    syncNow: syncNow.mockImplementation(async () => { state.items = [] }),
    discardAllForUser,
  }
}

function guardWith(outbox, choices, clearCache) {
  const queue = [...choices]
  const calls = { busy: [], closed: 0 }
  const promise = runLogoutGuard({
    outbox,
    ask: async () => queue.shift(),
    setBusy: busy => calls.busy.push(busy),
    close: () => { calls.closed += 1 },
  })
  return { promise, calls }
}

describe('runLogoutGuard', () => {
  it('lets logout proceed at once when nothing is waiting', async () => {
    const outbox = fakeOutbox({ items: [] })
    const { promise } = guardWith(outbox, [])
    await expect(promise).resolves.toBe(true)
  })

  it('"Sync first" syncs with the manual trigger so it works with Automatic sync off', async () => {
    const outbox = fakeOutbox()
    const { promise, calls } = guardWith(outbox, ['sync'])
    await expect(promise).resolves.toBe(true)
    expect(outbox.syncNow).toHaveBeenCalledTimes(1)
    expect(outbox.syncNow).toHaveBeenCalledWith('manual')
    expect(calls.busy).toEqual([true])
  })

  it('asks again when items remain after syncing', async () => {
    const syncNow = vi.fn(async () => {})
    const outbox = fakeOutbox({ syncNow })
    outbox.syncNow = syncNow
    const { promise } = guardWith(outbox, ['sync', 'keep'])
    await expect(promise).resolves.toBe(true)
    expect(syncNow).toHaveBeenCalledWith('manual')
  })

  it('keeps, discards or cancels as chosen', async () => {
    const keep = fakeOutbox()
    await expect(guardWith(keep, ['keep']).promise).resolves.toBe(true)
    expect(keep.syncNow).not.toHaveBeenCalled()

    const discard = fakeOutbox()
    await expect(guardWith(discard, ['discard']).promise).resolves.toBe(true)
    expect(discard.discardAllForUser).toHaveBeenCalledTimes(1)

    const cancel = fakeOutbox()
    await expect(guardWith(cancel, ['cancel']).promise).resolves.toBe(false)
  })

  it('does not log out when discarding fails', async () => {
    const outbox = fakeOutbox({ discardAllForUser: vi.fn(async () => { throw new Error('x') }) })
    await expect(guardWith(outbox, ['discard']).promise).resolves.toBe(false)
  })

  it('proceeds when the outbox cannot start', async () => {
    const outbox = fakeOutbox()
    outbox.start = vi.fn(async () => { throw new Error('idb') })
    await expect(guardWith(outbox, []).promise).resolves.toBe(true)
  })
})
