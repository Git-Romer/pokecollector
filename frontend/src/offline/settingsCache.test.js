import { describe, expect, it } from 'vitest'
import {
  SETTINGS_CACHE_KEY,
  stageOfflineCollectionPreference,
  pendingOfflineCollectionPreference,
  acknowledgeOfflineCollectionPreference,
  clearSettingsCache,
  loadSettingsWithCache,
  readCachedRate,
  readCachedSettings,
  withRateCache,
  writeCachedRate,
  writeCachedSettings,
} from './settingsCache'

function memoryStorage() {
  const data = {}
  return {
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) },
    removeItem: key => { delete data[key] },
    data,
  }
}

const broken = {
  getItem() { throw new Error('denied') },
  setItem() { throw new Error('denied') },
  removeItem() { throw new Error('denied') },
}
const gbp = { language: 'en', currency: 'GBP', price_primary: 'avg' }
const offline = () => Promise.reject(new TypeError('Failed to fetch'))


describe('offline collection preference', () => {
  it('keeps a durable per-account choice over stale server settings until acknowledged', async () => {
    const storage = memoryStorage()
    const options = { storage }
    writeCachedSettings(1, { currency: 'GBP', offline_collection_enabled: 'true' }, options)
    expect(stageOfflineCollectionPreference(1, 'false', options)).toBe(true)
    const pending = pendingOfflineCollectionPreference(1, options)
    expect(pending.value).toBe('false')
    expect(pendingOfflineCollectionPreference(2, options)).toBeNull()
    expect(readCachedSettings(1, options).offline_collection_enabled).toBe('false')
    expect((await loadSettingsWithCache(1, async () => ({ currency: 'GBP', offline_collection_enabled: 'true' }), options)).offline_collection_enabled).toBe('false')
    expect(stageOfflineCollectionPreference(1, 'true', options)).toBe(true)
    expect(acknowledgeOfflineCollectionPreference(1, pending.revision, options)).toBe(false)
    const newer = pendingOfflineCollectionPreference(1, options)
    expect(newer.revision).not.toBe(pending.revision)
    expect(acknowledgeOfflineCollectionPreference(1, newer.revision, options)).toBe(true)
    expect(pendingOfflineCollectionPreference(1, options)).toBeNull()
    expect(readCachedSettings(1, options)).toEqual({ currency: 'GBP', offline_collection_enabled: 'true' })
    expect(stageOfflineCollectionPreference(1, 'false', { storage: broken })).toBe(false)
    expect(stageOfflineCollectionPreference(1, 'arbitrary', options)).toBe(false)
  })
})

describe('settings cache', () => {
  it('round-trips settings per user and keeps users apart', () => {
    const storage = memoryStorage()
    writeCachedSettings(1, gbp, { storage })
    writeCachedSettings(2, { currency: 'USD' }, { storage })
    expect(readCachedSettings(1, { storage })).toEqual(gbp)
    expect(readCachedSettings(2, { storage })).toEqual({ currency: 'USD' })
    expect(readCachedSettings(3, { storage })).toBeNull()
  })

  it('uses one shared slot when there is no user id', () => {
    const storage = memoryStorage()
    writeCachedSettings(null, gbp, { storage })
    expect(readCachedSettings(undefined, { storage })).toEqual(gbp)
  })

  it('caches rates per pair with the fetch time', () => {
    const storage = memoryStorage()
    writeCachedRate(1, 'EUR', 'GBP', 0.85, { storage, now: () => 42 })
    expect(readCachedRate(1, 'EUR', 'GBP', { storage })).toEqual({ rate: 0.85, at: 42 })
    expect(readCachedRate(1, 'GBP', 'EUR', { storage })).toBeNull()
    expect(writeCachedRate(1, 'EUR', 'USD', 0, { storage })).toBe(false)
  })

  it('clears everything', () => {
    const storage = memoryStorage()
    writeCachedSettings(1, gbp, { storage })
    clearSettingsCache({ storage })
    expect(storage.data[SETTINGS_CACHE_KEY]).toBeUndefined()
    expect(readCachedSettings(1, { storage })).toBeNull()
  })

  it('survives unavailable storage and corrupt data', () => {
    expect(writeCachedSettings(1, gbp, { storage: broken })).toBe(false)
    expect(readCachedSettings(1, { storage: broken })).toBeNull()
    expect(() => clearSettingsCache({ storage: broken })).not.toThrow()
    const storage = memoryStorage()
    storage.setItem(SETTINGS_CACHE_KEY, '{not json')
    expect(readCachedSettings(1, { storage })).toBeNull()
  })
})

describe('loadSettingsWithCache', () => {
  it('saves a successful load', async () => {
    const storage = memoryStorage()
    await expect(loadSettingsWithCache(1, async () => gbp, { storage })).resolves.toEqual(gbp)
    expect(readCachedSettings(1, { storage })).toEqual(gbp)
  })

  it('falls back to the cached GBP settings when the fetch rejects', async () => {
    const storage = memoryStorage()
    writeCachedSettings(1, gbp, { storage })
    await expect(loadSettingsWithCache(1, offline, { storage })).resolves.toEqual(gbp)
  })

  it('rethrows when offline with nothing cached', async () => {
    await expect(loadSettingsWithCache(1, offline, { storage: memoryStorage() })).rejects.toThrow('Failed to fetch')
  })
})

describe('withRateCache', () => {
  it('returns and caches a fresh rate', async () => {
    const storage = memoryStorage()
    await expect(withRateCache(1, 'EUR', 'GBP', async () => 0.85, { storage })).resolves.toBe(0.85)
    expect(readCachedRate(1, 'EUR', 'GBP', { storage }).rate).toBe(0.85)
  })

  it('returns the cached rate when the fetcher throws or returns null', async () => {
    const storage = memoryStorage()
    writeCachedRate(1, 'EUR', 'GBP', 0.85, { storage })
    await expect(withRateCache(1, 'EUR', 'GBP', offline, { storage })).resolves.toBe(0.85)
    await expect(withRateCache(1, 'EUR', 'GBP', async () => null, { storage })).resolves.toBe(0.85)
  })

  it('resolves null with no fresh or cached rate', async () => {
    await expect(withRateCache(1, 'EUR', 'GBP', offline, { storage: memoryStorage() })).resolves.toBeNull()
  })
})

describe('hanging requests (offline iOS)', () => {
  it('uses cached GBP settings when the fetch never settles', async () => {
    const storage = memoryStorage()
    writeCachedSettings(1, gbp, { storage })
    const hang = () => new Promise(() => {})
    await expect(loadSettingsWithCache(1, hang, { storage, timeoutMs: 20 })).resolves.toEqual(gbp)
  })

  it('uses the cached rate when the fetch never settles, and aborts it', async () => {
    const storage = memoryStorage()
    writeCachedRate(1, 'EUR', 'GBP', 0.85, { storage })
    let aborted = false
    const hang = signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true }) })
    await expect(withRateCache(1, 'EUR', 'GBP', hang, { storage, timeoutMs: 20 })).resolves.toBe(0.85)
    expect(aborted).toBe(true)
  })

  it('rethrows a timeout when nothing is cached', async () => {
    const hang = () => new Promise(() => {})
    await expect(loadSettingsWithCache(1, hang, { storage: memoryStorage(), timeoutMs: 20 })).rejects.toThrow('timed out')
  })
})
