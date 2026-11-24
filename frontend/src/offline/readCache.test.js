import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  READ_CACHE_DB_NAME,
  READ_CACHE_MAX_AGE_MS,
  READ_CACHE_MAX_QUERY_BYTES,
  READ_CACHE_MAX_COLLECTION_BYTES,
  READ_CACHE_MAX_TOTAL_BYTES,
  applyCaps,
  persist,
  purge,
  purgeAll,
  purgeOthers,
  recordKey,
  restore,
  saveCollectionSnapshot,
} from './readCache.js'

const origin = 'https://pokes.test'
let indexedDB
let client

const openRaw = () => {
  const request = indexedDB.open(READ_CACHE_DB_NAME, 1)
  request.onupgradeneeded = () => request.result.createObjectStore('qc')
  return request
}

const getRecord = key => new Promise((resolve, reject) => {
  const open = openRaw()
  open.onsuccess = () => {
    const db = open.result
    const request = db.transaction('qc').objectStore('qc').get(key)
    request.onsuccess = () => { db.close(); resolve(request.result) }
    request.onerror = () => reject(request.error)
  }
  open.onerror = () => reject(open.error)
})

const putRaw = (key, value) => new Promise((resolve, reject) => {
  const open = openRaw()
  open.onsuccess = () => {
    const db = open.result
    const tx = db.transaction('qc', 'readwrite')
    tx.objectStore('qc').put(value, key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => reject(tx.error)
  }
})

const keysOf = () => new Promise((resolve, reject) => {
  const open = openRaw()
  open.onsuccess = () => {
    const db = open.result
    const request = db.transaction('qc').objectStore('qc').getAllKeys()
    request.onsuccess = () => { db.close(); resolve(request.result.sort()) }
    request.onerror = () => reject(request.error)
  }
})

const newClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
const seed = (queryKey, data) => client.setQueryData(queryKey, data)
const save = (userId = 1) => persist(client, { origin, userId, indexedDB, throttleMs: 5000 }).flush()
const hashes = record => record.state.queries.map(query => query.queryHash).sort()

beforeEach(() => {
  indexedDB = new IDBFactory()
  client = newClient()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('read cache', () => {
  it('accepts an unchanged snapshot retained by query structural sharing', async () => {
    client.setQueryData(['collection', {}], [])
    expect(await saveCollectionSnapshot(client, [], { origin, userId: 1, indexedDB })).toBe(true)
  })

  it('persists the requested snapshot even if an older online fetch completes during the write', async () => {
    const items = [{ id: 1, card_id: 'new-snapshot' }]
    const saving = saveCollectionSnapshot(client, items, { origin, userId: 1, indexedDB })
    client.setQueryData(['collection', {}], [{ id: 2, card_id: 'older-fetch' }])
    expect(await saving).toBe(true)
    const fresh = newClient()
    await restore(fresh, { origin, userId: 1, indexedDB })
    expect(fresh.getQueryData(['collection', {}])).toEqual(items)
  })

  it('commits an explicit full collection before reporting it saved', async () => {
    const items = Array.from({ length: 2000 }, (_, id) => ({ id, card_id: `card-${id}` }))
    expect(await saveCollectionSnapshot(client, items, { origin, userId: 1, indexedDB })).toBe(true)
    const fresh = newClient()
    await restore(fresh, { origin, userId: 1, indexedDB })
    expect(fresh.getQueryData(['collection', {}])).toEqual(items)
    const otherUser = newClient()
    expect(await restore(otherUser, { origin, userId: 2, indexedDB })).toBe(null)
  })

  it('persists 2,000 metadata-rich cards, not only minimal mocked rows', async () => {
    const items = Array.from({ length: 2000 }, (_, id) => ({
      id, card_id: `card-${id}_en`, quantity: 1,
      card: { id: `card-${id}_en`, name: `Card ${id}`, rules: ['x'.repeat(2900)] },
    }))
    // The real 2,000-card manifest exceeds the generic 5 MiB query limit.
    expect(JSON.stringify(items).length).toBeGreaterThan(5 * 1024 * 1024)
    expect(await saveCollectionSnapshot(client, items, { origin, userId: 1, indexedDB })).toBe(true)
    const fresh = newClient()
    await restore(fresh, { origin, userId: 1, indexedDB })
    expect(fresh.getQueryData(['collection', {}])).toEqual(items)
  })

  it('rejects a collection above the UTF-8 byte limit even when its character count fits', async () => {
    const items = [{ card: { name: '界'.repeat(Math.ceil(READ_CACHE_MAX_COLLECTION_BYTES / 3)) } }]
    expect(JSON.stringify(items).length).toBeLessThan(READ_CACHE_MAX_COLLECTION_BYTES)
    expect(new TextEncoder().encode(JSON.stringify(items)).byteLength).toBeGreaterThan(READ_CACHE_MAX_COLLECTION_BYTES)
    expect(await saveCollectionSnapshot(client, items, { origin, userId: 1, indexedDB })).toBe(false)
    expect(await getRecord(recordKey(origin, 1))).toBeUndefined()
  })

  it('does not report a capped or unavailable snapshot as durable', async () => {
    expect(await saveCollectionSnapshot(client, [{ x: 'x'.repeat(READ_CACHE_MAX_COLLECTION_BYTES + 1) }], { origin, userId: 1, indexedDB })).toBe(false)
    expect(await saveCollectionSnapshot(client, [], { origin, userId: 1, indexedDB: null })).toBe(false)
    expect(await saveCollectionSnapshot(client, [], { origin, userId: 1, indexedDB, isCurrentUser: () => false })).toBe(false)
  })

  it('saves only successful allow-listed queries', async () => {
    seed(['collection', { page: 1 }], [{ id: 1 }])
    seed(['wishlist'], [{ id: 2 }])
    seed(['profile'], { name: 'x' })
    seed(['users'], [{ id: 9 }])
    await client.fetchQuery({ queryKey: ['dashboard'], queryFn: () => { throw new Error('boom') }, retry: false }).catch(() => {})
    await save()
    const record = await getRecord(recordKey(origin, 1))
    expect(record.v).toBe(1)
    expect(record.state.queries.map(query => query.queryKey[0]).sort()).toEqual(['collection', 'wishlist'])
  })

  it('restores into a fresh client and returns savedAt', async () => {
    seed(['collection'], [{ id: 1 }, { id: 2 }])
    await save()
    const other = newClient()
    const savedAt = await restore(other, { origin, userId: 1, indexedDB })
    expect(typeof savedAt).toBe('number')
    expect(other.getQueryData(['collection'])).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('namespaces records by origin and user', async () => {
    seed(['collection'], ['mine'])
    await save(1)
    const other = newClient()
    expect(await restore(other, { origin, userId: 2, indexedDB })).toBeNull()
    expect(await restore(other, { origin: 'https://else.test', userId: 1, indexedDB })).toBeNull()
    expect(other.getQueryData(['collection'])).toBeUndefined()
  })

  it('drops a query over 5 MiB and keeps the rest', async () => {
    seed(['dashboard'], 'x'.repeat(READ_CACHE_MAX_QUERY_BYTES + 10))
    seed(['wishlist'], ['ok'])
    await save()
    expect(hashes(await getRecord(recordKey(origin, 1)))).toEqual(['["wishlist"]'])
  })

  it('applies the generic query cap to UTF-8 bytes too', () => {
    const query = { queryKey: ['dashboard'], state: { data: '界'.repeat(Math.ceil(READ_CACHE_MAX_QUERY_BYTES / 3)) } }
    expect(applyCaps([query])).toEqual([])
  })

  it('drops the oldest queries until the total fits in 20 MiB', () => {
    const big = 'x'.repeat(4 * 1024 * 1024)
    const queries = [1, 2, 3, 4, 5, 6].map(n => ({ queryHash: `q${n}`, state: { data: big, dataUpdatedAt: n } }))
    const kept = applyCaps(queries).map(query => query.queryHash).sort()
    expect(kept).toHaveLength(4)
    expect(kept).not.toContain('q1')
    expect(kept).not.toContain('q2')
    expect(READ_CACHE_MAX_TOTAL_BYTES).toBe(20 * 1024 * 1024)
  })

  it('keeps saved pages that were not opened this session', async () => {
    seed(['collection'], ['old'])
    await save()
    client = newClient()
    seed(['wishlist'], ['new'])
    await save()
    expect(hashes(await getRecord(recordKey(origin, 1)))).toEqual(['["collection"]', '["wishlist"]'])
  })

  it('ignores a record from another app version', async () => {
    seed(['collection'], ['x'])
    await save()
    const record = await getRecord(recordKey(origin, 1))
    await putRaw(recordKey(origin, 1), { ...record, appVersion: 'other-build' })
    expect(await restore(newClient(), { origin, userId: 1, indexedDB })).toBeNull()
  })

  it('ignores a record older than 30 days', async () => {
    seed(['collection'], ['x'])
    await save()
    const later = Date.now() + READ_CACHE_MAX_AGE_MS + 1000
    expect(await restore(newClient(), { origin, userId: 1, indexedDB, now: later })).toBeNull()
  })

  it('ignores corrupted records', async () => {
    for (const bad of ['text', 42, { v: 1 }, { v: 2, savedAt: Date.now(), appVersion: '', state: { queries: [] } }, { v: 1, savedAt: Date.now(), appVersion: '', state: {} }]) {
      await putRaw(recordKey(origin, 1), bad)
      const target = newClient()
      expect(await restore(target, { origin, userId: 1, indexedDB })).toBeNull()
      expect(target.getQueryCache().getAll()).toHaveLength(0)
    }
  })

  it('purge removes one record, purgeOthers keeps only the given user, purgeAll clears', async () => {
    seed(['collection'], ['x'])
    await save(1)
    await save(2)
    await save(3)
    await purge({ origin, userId: 1, indexedDB })
    expect(await keysOf()).toEqual([recordKey(origin, 2), recordKey(origin, 3)])
    await purgeOthers({ origin, keepUserId: 3, indexedDB })
    expect(await keysOf()).toEqual([recordKey(origin, 3)])
    await purgeAll({ indexedDB })
    expect(await keysOf()).toEqual([])
  })

  it('writes through a 5 s trailing throttle after successful results', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const persister = persist(client, { origin, userId: 1, indexedDB, throttleMs: 5000 })
    await vi.advanceTimersByTimeAsync(6000)
    expect(await getRecord(recordKey(origin, 1))).toBeUndefined() // nothing fetched yet
    client.setQueryData(['collection'], ['x'])
    await client.fetchQuery({ queryKey: ['wishlist'], queryFn: async () => ['y'] })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await getRecord(recordKey(origin, 1))).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1500)
    await vi.waitFor(async () => expect(await getRecord(recordKey(origin, 1))).toBeDefined())
    await persister.stop()
    expect(hashes(await getRecord(recordKey(origin, 1)))).toEqual(['["collection"]', '["wishlist"]'])
  })

  it('stop() cancels a pending write so a purge is not undone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const persister = persist(client, { origin, userId: 1, indexedDB, throttleMs: 5000 })
    await client.fetchQuery({ queryKey: ['collection'], queryFn: async () => ['x'] })
    await persister.stop()
    await purge({ origin, userId: 1, indexedDB })
    await vi.advanceTimersByTimeAsync(10000)
    expect(await getRecord(recordKey(origin, 1))).toBeUndefined()
  })

  it('does nothing and never throws without IndexedDB', async () => {
    seed(['collection'], ['x'])
    await expect(restore(client, { origin, userId: 1, indexedDB: null })).resolves.toBeNull()
    await expect(persist(client, { origin, userId: 1, indexedDB: null }).flush()).resolves.toBe(false)
    await expect(purge({ origin, userId: 1, indexedDB: null })).resolves.toBeUndefined()
    await expect(purgeOthers({ origin, keepUserId: 1, indexedDB: null })).resolves.toBeUndefined()
    await expect(purgeAll({ indexedDB: null })).resolves.toBeUndefined()
  })
})
