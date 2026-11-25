// Per-user cache of the last good settings response and exchange rates, so an offline
// launch keeps the user's currency instead of falling back to EUR. A narrowly scoped
// pending download preference takes effect locally until the server acknowledges it.
// All other settings remain display-only offline. Every storage access is guarded.

export const SETTINGS_CACHE_KEY = 'pc.settings.cache'

// Single-user mode (or auth not resolved yet) has no usable user id.
const NO_USER = 'default'

function getStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function userKey(userId) {
  return userId == null ? NO_USER : String(userId)
}

function readAll(storage) {
  try {
    const raw = storage?.getItem(SETTINGS_CACHE_KEY)
    if (!raw) return { v: 1, users: {} }
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.v !== 1 || typeof parsed.users !== 'object' || !parsed.users) return { v: 1, users: {} }
    return parsed
  } catch {
    return { v: 1, users: {} }
  }
}

function update(userId, storage, mutate) {
  if (!storage) return false
  try {
    const all = readAll(storage)
    const key = userKey(userId)
    const entry = all.users[key] || {}
    mutate(entry)
    all.users[key] = entry
    storage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(all))
    return true
  } catch {
    return false
  }
}

/** Only this device-storage choice can be changed without a server connection. */
export function pendingOfflineCollectionPreference(userId, { storage = getStorage() } = {}) {
  const pending = readAll(storage).users[userKey(userId)]?.offlineCollectionPreference
  return pending && ['true', 'false'].includes(pending.value) && typeof pending.revision === 'string'
    ? pending : null
}

export function stageOfflineCollectionPreference(userId, value, { storage = getStorage() } = {}) {
  if (!['true', 'false'].includes(value)) return false
  return update(userId, storage, entry => {
    entry.offlineCollectionPreference = { value, revision: globalThis.crypto.randomUUID() }
    entry.settings = { ...entry.settings, offline_collection_enabled: value }
  })
}

export function acknowledgeOfflineCollectionPreference(userId, revision, { storage = getStorage() } = {}) {
  let acknowledged = false
  const saved = update(userId, storage, entry => {
    if (entry.offlineCollectionPreference?.revision !== revision) return
    entry.settings = { ...entry.settings, offline_collection_enabled: entry.offlineCollectionPreference.value }
    delete entry.offlineCollectionPreference
    acknowledged = true
  })
  return saved && acknowledged
}

/** Save the whole settings object from a successful `GET /api/settings/`. */
export function writeCachedSettings(userId, settings, { storage = getStorage(), now = Date.now } = {}) {
  if (!settings || typeof settings !== 'object') return false
  return update(userId, storage, entry => {
    entry.settings = entry.offlineCollectionPreference
      ? { ...settings, offline_collection_enabled: entry.offlineCollectionPreference.value }
      : settings
    entry.settingsAt = now()
  })
}

/** → the last cached settings object for this user, or `null`. */
export function readCachedSettings(userId, { storage = getStorage() } = {}) {
  const settings = readAll(storage).users[userKey(userId)]?.settings
  return settings && typeof settings === 'object' ? settings : null
}

export const FETCH_TIMEOUT_MS = 5_000

/**
 * Run `task(signal)` but give up after `timeoutMs` (default 5 s): offline iOS requests
 * can hang instead of rejecting. The signal is aborted on timeout so a real fetch stops too.
 */
export function withTimeout(task, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('timed out'))
    }, timeoutMs)
  })
  return Promise.race([Promise.resolve().then(() => task(controller.signal)), timeout])
    .finally(() => clearTimeout(timer))
}

function pairKey(from, to) {
  return `${from}>${to}`
}

/** Save a successful rate for the `from→to` pair, with the time it was fetched. */
export function writeCachedRate(userId, from, to, rate, { storage = getStorage(), now = Date.now } = {}) {
  if (!Number.isFinite(rate) || rate <= 0) return false
  return update(userId, storage, entry => {
    entry.rates = { ...entry.rates, [pairKey(from, to)]: { rate, at: now() } }
  })
}

/** → `{ rate, at }` for the pair, or `null`. */
export function readCachedRate(userId, from, to, { storage = getStorage() } = {}) {
  const hit = readAll(storage).users[userKey(userId)]?.rates?.[pairKey(from, to)]
  return hit && Number.isFinite(hit.rate) && hit.rate > 0 ? hit : null
}

/**
 * Wrap a rate fetcher. `fetcher(signal)` (pass `signal` to fetch) resolves to a rate number, or `null`/throws on failure.
 * Success is cached; failure returns the cached rate for the pair. Never throws:
 * resolves to a number, or `null` when there is neither a fresh nor a cached rate
 * (callers apply their own fallback, e.g. `(await withRateCache(...)) ?? fallback`).
 */
export async function withRateCache(userId, from, to, fetcher, options) {
  try {
    const rate = Number(await withTimeout(fetcher, options))
    if (Number.isFinite(rate) && rate > 0) {
      writeCachedRate(userId, from, to, rate, options)
      return rate
    }
  } catch {
    // fall through to the cached rate
  }
  return readCachedRate(userId, from, to, options)?.rate ?? null
}

export function clearSettingsCache({ storage = getStorage() } = {}) {
  try {
    storage?.removeItem(SETTINGS_CACHE_KEY)
  } catch {
    // storage unavailable
  }
}

/**
 * Run `fetchSettings(signal)` (resolves to the settings object, rejects on failure). Success is
 * cached; failure resolves to the cached copy when there is one and rethrows otherwise.
 */
export async function loadSettingsWithCache(userId, fetchSettings, options) {
  try {
    const data = await withTimeout(fetchSettings, options)
    const pending = pendingOfflineCollectionPreference(userId, options)
    const effective = pending ? { ...data, offline_collection_enabled: pending.value } : data
    writeCachedSettings(userId, effective, options)
    return effective
  } catch (err) {
    const cached = readCachedSettings(userId, options)
    if (cached) return cached
    throw err
  }
}
