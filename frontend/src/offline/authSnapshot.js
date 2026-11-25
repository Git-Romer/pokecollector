// Cached sign-in snapshot (docs/PWA_OFFLINE_DESIGN.md §6.6 A5). Display-only: the server
// re-authorises every request. Every storage access is guarded; failures read as "no snapshot".

export const SNAPSHOT_KEY = 'pc.auth.snapshot'
export const SNAPSHOT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

function getStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function writeAuthSnapshot({ multiUser, locked, user }, { storage = getStorage(), now = Date.now } = {}) {
  if (!storage || !user || typeof user.id !== 'number') return false
  try {
    storage.setItem(SNAPSHOT_KEY, JSON.stringify({
      v: 1,
      multiUser: Boolean(multiUser),
      locked: Boolean(locked),
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        avatar_id: user.avatar_id ?? null,
        must_change_password: Boolean(user.must_change_password),
      },
      savedAt: now(),
    }))
    return true
  } catch {
    return false
  }
}

/** → the snapshot, or `null` when absent or invalid (A5). `token` is `localStorage.token`. */
export function readAuthSnapshot({ token, now = Date.now, storage = getStorage() } = {}) {
  if (!storage) return null
  try {
    const raw = storage.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw)
    if (!snap || snap.v !== 1) return null
    if (!snap.user || typeof snap.user.id !== 'number') return null
    if (snap.user.must_change_password) return null
    if (typeof snap.savedAt !== 'number') return null
    const age = now() - snap.savedAt
    if (age > SNAPSHOT_MAX_AGE_MS) return null
    if (snap.multiUser && !token) return null
    return snap
  } catch {
    return null
  }
}

export function clearAuthSnapshot({ storage = getStorage() } = {}) {
  try {
    storage?.removeItem(SNAPSHOT_KEY)
  } catch {
    // storage unavailable
  }
}
