// IndexedDB schema v1 and ordered migrations (docs/PWA_OFFLINE_DESIGN.md §6.2.2, §6.2.11).

import { OUTBOX_DB_NAME, OUTBOX_DB_VERSION } from '../constants.js'

export function createStores(db) {
  const items = db.createObjectStore('items', { keyPath: 'id' })
  items.createIndex('by_user_created', ['serverOrigin', 'userId', 'createdAt'])
  db.createObjectStore('photos', { keyPath: ['itemId', 'index'] })
  db.createObjectStore('meta', { keyPath: 'key' })
  const history = db.createObjectStore('history', { keyPath: 'id' })
  history.createIndex('by_completedAt', 'completedAt')
}

/** Future versions append `2: …`, `3: …`. Each step must be idempotent and pure over the data. */
export const migrations = { 1: createStores }

export const promisify = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

/** Resolves when the transaction commits; rejects when it aborts or errors. */
export const txDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'))
  tx.onerror = () => reject(tx.error)
})

/**
 * Opens (and upgrades) the database. A throwing migration aborts the upgrade
 * transaction, the database stays at its old version and the promise rejects.
 * `onVersionChange` fires after this connection closed itself because a newer
 * tab needs to upgrade (the caller shows the update banner).
 */
export function openOutboxDb({
  indexedDB = globalThis.indexedDB,
  name = OUTBOX_DB_NAME,
  version = OUTBOX_DB_VERSION,
  migrations: steps = migrations,
  onVersionChange = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new Error('IndexedDB is not available'))
      return
    }
    let request
    try {
      request = indexedDB.open(name, version)
    } catch (error) {
      reject(error)
      return
    }
    let migrationError = null
    request.onupgradeneeded = event => {
      const tx = request.transaction
      try {
        for (let v = event.oldVersion + 1; v <= (event.newVersion ?? version); v += 1) {
          if (typeof steps[v] !== 'function') throw new Error(`Missing outbox migration ${v}`)
          steps[v](request.result, tx, event.oldVersion)
        }
      } catch (error) {
        migrationError = error
        try {
          tx.abort()
        } catch {
          // already aborted
        }
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        if (onVersionChange) onVersionChange()
      }
      resolve(db)
    }
    request.onerror = event => {
      event?.preventDefault?.()
      reject(migrationError || request.error)
    }
    // `onblocked`: an old tab keeps its connection open until it handles versionchange.
  })
}
