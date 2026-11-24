// Read cache of previously viewed data (docs/PWA_OFFLINE_DESIGN.md §9.2 P8, D1, D8, D10).
// Successful, allow-listed TanStack queries are saved per user and origin in their own IndexedDB
// database (never the outbox's) and put back when the app starts degraded. Every IndexedDB access
// is guarded: a failure means the feature is off, never a crash.

import { dehydrate, hydrate } from '@tanstack/react-query'

const KIB = 1024
const MIB = 1024 * KIB
const DAY_MS = 24 * 60 * 60 * 1000

export const READ_CACHE_DB_NAME = 'pokecollector-readcache'
export const READ_CACHE_DB_VERSION = 1
export const READ_CACHE_STORE = 'qc'
export const READ_CACHE_RECORD_VERSION = 1
export const READ_CACHE_MAX_QUERY_BYTES = 5 * MIB
// Genuine 2,000-card manifests exceed the generic query budget; keep the total cap unchanged.
export const READ_CACHE_MAX_COLLECTION_BYTES = 10 * MIB
export const READ_CACHE_MAX_TOTAL_BYTES = 20 * MIB
export const READ_CACHE_MAX_AGE_MS = 30 * DAY_MS
export const READ_CACHE_THROTTLE_MS = 5000

export const READ_CACHE_ALLOW = new Set([
  'collection',
  'wishlist',
  'dashboard',
  'sets',
  'set-checklist',
  'binders',
  'binder-cards',
  'scanner-configuration',
  'printing-detail-tags',
  'investment-tracker',
])

function currentAppVersion() {
  // eslint-disable-next-line no-undef
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
}

export const recordKey = (origin, userId) => `${origin}|${userId}`

const isAllowed = query => query.state.status === 'success' && READ_CACHE_ALLOW.has(String(query.queryKey?.[0]))

function sizeOf(data) {
  try {
    return new TextEncoder().encode(JSON.stringify(data) ?? '').byteLength
  } catch {
    return Infinity
  }
}

function openDb(indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new Error('IndexedDB is not available'))
      return
    }
    let request
    try {
      request = indexedDB.open(READ_CACHE_DB_NAME, READ_CACHE_DB_VERSION)
    } catch (error) {
      reject(error)
      return
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(READ_CACHE_STORE)) request.result.createObjectStore(READ_CACHE_STORE)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = event => {
      event?.preventDefault?.()
      reject(request.error)
    }
  })
}

const promisify = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const txDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'))
  tx.onerror = () => reject(tx.error)
})

// Runs `work(store, tx)` in one transaction; resolves its result, or `fallback` on any failure.
async function withStore(indexedDB, mode, work, fallback) {
  let db = null
  try {
    db = await openDb(indexedDB)
    const tx = db.transaction(READ_CACHE_STORE, mode)
    const done = txDone(tx)
    done.catch(() => {}) // a failure surfaces through `await done` below, or is the fallback's job
    const result = await work(tx.objectStore(READ_CACHE_STORE), tx)
    if (mode === 'readwrite') await done
    return result
  } catch {
    return fallback
  } finally {
    try {
      db?.close()
    } catch {
      // already closed
    }
  }
}

const readRecord = (indexedDB, key) => withStore(indexedDB, 'readonly', store => promisify(store.get(key)), null)

/**
 * Applies the per-query and total caps to a list of dehydrated queries (oldest `dataUpdatedAt`
 * is dropped first until the total fits).
 */
export function applyCaps(queries) {
  const sized = queries
    .map(query => ({ query, bytes: sizeOf(query.state?.data) }))
    .filter(entry => entry.bytes <= (entry.query.queryKey?.[0] === 'collection'
      ? READ_CACHE_MAX_COLLECTION_BYTES : READ_CACHE_MAX_QUERY_BYTES))
  let total = sized.reduce((sum, entry) => sum + entry.bytes, 0)
  if (total > READ_CACHE_MAX_TOTAL_BYTES) {
    sized.sort((a, b) => (b.query.state.dataUpdatedAt || 0) - (a.query.state.dataUpdatedAt || 0))
    while (total > READ_CACHE_MAX_TOTAL_BYTES && sized.length > 0) total -= sized.pop().bytes
  }
  return sized.map(entry => entry.query)
}

function isUsable(record, now) {
  return Boolean(record)
    && record.v === READ_CACHE_RECORD_VERSION
    && typeof record.savedAt === 'number'
    && record.appVersion === currentAppVersion()
    && now - record.savedAt <= READ_CACHE_MAX_AGE_MS
    && Array.isArray(record.state?.queries)
}

/** Builds the record to store: this session's allow-listed queries merged over the saved ones. */
export function buildRecord(queryClient, previous, { now = Date.now() } = {}) {
  const fresh = dehydrate(queryClient, { shouldDehydrateQuery: isAllowed })
  const byHash = new Map()
  // Pages not opened this session keep their saved data, until they are 30 days old.
  if (isUsable(previous, now)) {
    for (const query of previous.state.queries) {
      if (query?.state && now - (query.state.dataUpdatedAt || 0) <= READ_CACHE_MAX_AGE_MS) byHash.set(query.queryHash, query)
    }
  }
  for (const query of fresh.queries) byHash.set(query.queryHash, query)
  return {
    v: READ_CACHE_RECORD_VERSION,
    savedAt: now,
    appVersion: currentAppVersion(),
    state: { mutations: [], queries: applyCaps([...byHash.values()]) },
  }
}

/**
 * Saves the allow-listed query results of `queryClient` for `{origin, userId}`, through a 5 s
 * trailing throttle driven by successful fetches. → `{flush, stop}`; `stop()` cancels a pending
 * write, forbids new ones and resolves once a write already started has finished.
 */
export function persist(queryClient, { origin, userId, indexedDB = globalThis.indexedDB, throttleMs = READ_CACHE_THROTTLE_MS } = {}) {
  const key = recordKey(origin, userId)
  let timer = null
  let stopped = false
  let inFlight = Promise.resolve()

  const write = () => {
    timer = null
    if (stopped) return inFlight
    inFlight = inFlight.then(() => withStore(indexedDB, 'readwrite', async store => {
      if (stopped) return false
      const previous = await promisify(store.get(key))
      store.put(buildRecord(queryClient, previous), key)
      return true
    }, false))
    return inFlight
  }

  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (stopped || event.type !== 'updated' || event.action?.type !== 'success') return
    if (!READ_CACHE_ALLOW.has(String(event.query.queryKey?.[0]))) return
    if (timer === null) timer = setTimeout(write, throttleMs)
  })

  return {
    flush: () => {
      if (timer !== null) clearTimeout(timer)
      return write()
    },
    stop: () => {
      stopped = true
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
      timer = null
      return inFlight
    },
  }
}

/** Puts the saved queries of `{origin, userId}` back; → `savedAt` (ms) or `null`. */
export async function restore(queryClient, { origin, userId, indexedDB = globalThis.indexedDB, now = Date.now() } = {}) {
  try {
    const record = await readRecord(indexedDB, recordKey(origin, userId))
    if (!isUsable(record, now)) return null
    hydrate(queryClient, record.state)
    return record.savedAt
  } catch {
    return null
  }
}

/** Explicit downloads await the transaction and reject snapshots that caps would omit. */
export async function saveCollectionSnapshot(queryClient, items, {
  origin, userId, indexedDB = globalThis.indexedDB, isCurrentUser = () => true,
} = {}) {
  if (!isCurrentUser() || !Number.isInteger(userId) || !Array.isArray(items)
    || sizeOf(items) > READ_CACHE_MAX_COLLECTION_BYTES) return false
  queryClient.setQueryData(['collection', {}], items)
  const isSnapshot = query => JSON.stringify(query.queryKey) === '["collection",{}]'
  const snapshot = dehydrate(queryClient, { shouldDehydrateQuery: isSnapshot }).queries[0]
  return withStore(indexedDB, 'readwrite', async store => {
    const previous = await promisify(store.get(recordKey(origin, userId)))
    if (!isCurrentUser()) return false
    const record = buildRecord(queryClient, previous)
    record.state.queries = applyCaps([...record.state.queries.filter(query => !isSnapshot(query)), snapshot])
    const saved = record.state.queries.find(isSnapshot)
    if (!saved || saved.state.data !== snapshot.state.data) return false
    store.put(record, recordKey(origin, userId))
    return true
  }, false)
}

export async function purge({ origin, userId, indexedDB = globalThis.indexedDB, strict = false } = {}) {
  const removed = await withStore(indexedDB, 'readwrite', store => { store.delete(recordKey(origin, userId)); return true }, false)
  return strict ? removed : undefined
}

/** Deletes every record except the one of `keepUserId`. */
export async function purgeOthers({ origin, keepUserId, indexedDB = globalThis.indexedDB } = {}) {
  const keep = recordKey(origin, keepUserId)
  return withStore(indexedDB, 'readwrite', async store => {
    const keys = await promisify(store.getAllKeys())
    for (const key of keys) if (key !== keep) store.delete(key)
  }, undefined)
}

export async function purgeAll({ indexedDB = globalThis.indexedDB } = {}) {
  return withStore(indexedDB, 'readwrite', store => { store.clear() }, undefined)
}
