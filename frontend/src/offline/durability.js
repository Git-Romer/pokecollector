// Storage durability helpers (docs/PWA_OFFLINE_DESIGN.md D12, P6 task 1).
// Nothing here pretends data is safe: it asks the browser to protect it, notices when the
// browser removed it anyway, and tells the user how old unsynced items are.

import { OLD_ITEM_STRONG_WARN_MS, OLD_ITEM_WARN_MS } from './constants.js'
import { promisify, txDone } from './outbox/db.js'
import { uuidv4 } from './uuid.js'

export const CANARY_STORAGE_KEY = 'pc.outbox.canary'

async function readMeta(db, key) {
  const tx = db.transaction('meta', 'readonly')
  const row = await promisify(tx.objectStore('meta').get(key))
  return row ? row.value : undefined
}

async function writeMeta(db, key, value) {
  const tx = db.transaction('meta', 'readwrite')
  tx.objectStore('meta').put({ key, value })
  await txDone(tx)
}

function readMirror(storage) {
  try {
    return storage?.getItem(CANARY_STORAGE_KEY) || null
  } catch {
    return null
  }
}

function writeMirror(storage, id) {
  try {
    storage?.setItem(CANARY_STORAGE_KEY, id)
  } catch {
    // private mode: the canary then stays 'unknown'
  }
}

/**
 * Asks the browser not to evict our storage (heuristic: Safari decides on its own) and records
 * `{requestedAt, granted}` in `meta.persist`. Returns `{granted: boolean|null}`; `null` means
 * the Storage API cannot persist (or threw).
 */
export async function requestPersistence({ db, storage = globalThis.navigator?.storage, now = Date.now } = {}) {
  if (typeof storage?.persist !== 'function') return { granted: null }
  let granted = null
  try {
    granted = Boolean(await storage.persist())
  } catch {
    granted = null
  }
  if (db) {
    try {
      await writeMeta(db, 'persist', { requestedAt: now(), granted })
    } catch {
      // best effort
    }
  }
  return { granted }
}

/** `{usage, quota}` from `navigator.storage.estimate()` or `null`. */
export async function readEstimate({ storage = globalThis.navigator?.storage } = {}) {
  if (typeof storage?.estimate !== 'function') return null
  try {
    const { usage, quota } = await storage.estimate()
    return { usage: Number.isFinite(usage) ? usage : null, quota: Number.isFinite(quota) ? quota : null }
  } catch {
    return null
  }
}

/** Writes a new random id to `meta.canary` and to `localStorage`. Returns the id. */
export async function initCanary(db, { localStorage: storage = globalThis.localStorage, uuid = uuidv4 } = {}) {
  const id = uuid()
  await writeMeta(db, 'canary', id)
  writeMirror(storage, id)
  return id
}

/**
 * `'ok'` — both copies exist and match; `'evicted'` — the localStorage mirror exists but the
 * IndexedDB canary is gone (or differs); `'unknown'` — no mirror (first run, or both wiped), so
 * nothing can be concluded. Callers re-run `initCanary` after anything but `'ok'`.
 */
export async function checkCanary(db, { localStorage: storage = globalThis.localStorage } = {}) {
  const mirror = readMirror(storage)
  const stored = await readMeta(db, 'canary')
  if (stored && mirror && stored === mirror) return 'ok'
  if (mirror && !stored) return 'evicted'
  if (mirror && stored && stored !== mirror) return 'evicted'
  return 'unknown'
}

/**
 * `'none' | 'warn' | 'strong'`: only outside the installed app (the 7-day cap applies to Safari
 * tabs), and only when something is waiting (`oldestCreatedAt` is a timestamp).
 */
export function ageWarning(oldestCreatedAt, standalone, now = Date.now()) {
  if (standalone || !Number.isFinite(oldestCreatedAt)) return 'none'
  const age = now - oldestCreatedAt
  if (age >= OLD_ITEM_STRONG_WARN_MS) return 'strong'
  if (age >= OLD_ITEM_WARN_MS) return 'warn'
  return 'none'
}
