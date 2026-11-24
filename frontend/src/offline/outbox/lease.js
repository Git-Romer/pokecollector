// Single-flight lease in `meta` (docs/PWA_OFFLINE_DESIGN.md §6.2.9). It is an
// efficiency measure: per-item correctness comes from claim compare-and-set and
// the idempotency key, so a lease race cannot cause a duplicate effect.

import { LEASE_TTL_MS } from '../constants.js'
import { promisify, txDone } from './db.js'

const KEY = 'lease'

export function createLease(db, { owner, now = Date.now, ttlMs = LEASE_TTL_MS }) {
  /** One readwrite transaction on `meta`; `decide(current)` returns the new value or `undefined` to leave it. */
  async function mutate(decide) {
    const tx = db.transaction('meta', 'readwrite')
    const done = txDone(tx)
    const store = tx.objectStore('meta')
    const row = await promisify(store.get(KEY))
    const result = decide(row ? row.value : null)
    if (result.write) store.put({ key: KEY, value: result.write })
    if (result.remove) store.delete(KEY)
    await done
    return result.ok
  }

  const mine = current => current && current.owner === owner
  const live = current => current && current.expiresAt > now()

  return {
    owner,
    /** True when the lease is now ours (absent, expired, or already ours). */
    acquire() {
      return mutate(current => (!current || !live(current) || mine(current)
        ? { ok: true, write: { owner, expiresAt: now() + ttlMs } }
        : { ok: false }))
    },
    /** Extends our lease; false when we lost it (someone stole it after expiry). */
    heartbeat() {
      return mutate(current => (mine(current)
        ? { ok: true, write: { owner, expiresAt: now() + ttlMs } }
        : { ok: false }))
    },
    /** Deletes the lease if we own it. */
    release() {
      return mutate(current => (mine(current) ? { ok: true, remove: true } : { ok: false }))
    },
  }
}
