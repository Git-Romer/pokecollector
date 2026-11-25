import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ageWarning, CANARY_STORAGE_KEY, checkCanary, initCanary, readEstimate, requestPersistence,
} from './durability.js'
import { openOutboxDb, promisify } from './outbox/db.js'

const DAY = 24 * 60 * 60 * 1000

function fakeStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) },
    data,
  }
}

async function freshDb(name) {
  return openOutboxDb({ name, indexedDB: new IDBFactory() })
}

async function metaRow(db, key) {
  return promisify(db.transaction('meta', 'readonly').objectStore('meta').get(key))
}

describe('requestPersistence', () => {
  let db
  beforeEach(async () => { db = await freshDb('persist') })

  it('records a granted request', async () => {
    const result = await requestPersistence({ db, storage: { persist: async () => true }, now: () => 5 })
    expect(result).toEqual({ granted: true })
    expect((await metaRow(db, 'persist')).value).toEqual({ requestedAt: 5, granted: true })
  })

  it('records a denied request', async () => {
    const result = await requestPersistence({ db, storage: { persist: async () => false }, now: () => 6 })
    expect(result).toEqual({ granted: false })
    expect((await metaRow(db, 'persist')).value).toEqual({ requestedAt: 6, granted: false })
  })

  it('does nothing when the Storage API is absent', async () => {
    expect(await requestPersistence({ db, storage: undefined })).toEqual({ granted: null })
    expect(await metaRow(db, 'persist')).toBeUndefined()
  })

  it('treats a throwing persist() as unknown', async () => {
    const result = await requestPersistence({ db, storage: { persist: async () => { throw new Error('no') } } })
    expect(result).toEqual({ granted: null })
  })
})

describe('readEstimate', () => {
  it('returns usage and quota when present', async () => {
    expect(await readEstimate({ storage: { estimate: async () => ({ usage: 10, quota: 100 }) } })).toEqual({ usage: 10, quota: 100 })
  })

  it('returns null when absent or failing', async () => {
    expect(await readEstimate({ storage: {} })).toBeNull()
    expect(await readEstimate({ storage: { estimate: async () => { throw new Error('x') } } })).toBeNull()
  })
})

describe('canary', () => {
  it('is unknown on a first run, then ok once initialised', async () => {
    const db = await freshDb('canary-1')
    const ls = fakeStorage()
    expect(await checkCanary(db, { localStorage: ls })).toBe('unknown')
    const id = await initCanary(db, { localStorage: ls, uuid: () => 'abc' })
    expect(id).toBe('abc')
    expect(ls.data[CANARY_STORAGE_KEY]).toBe('abc')
    expect(await checkCanary(db, { localStorage: ls })).toBe('ok')
  })

  it('reports eviction when only the localStorage mirror survived', async () => {
    const db = await freshDb('canary-2')
    expect(await checkCanary(db, { localStorage: fakeStorage({ [CANARY_STORAGE_KEY]: 'old' }) })).toBe('evicted')
  })

  it('reports eviction when the database was recreated with another canary', async () => {
    const db = await freshDb('canary-3')
    await initCanary(db, { localStorage: fakeStorage(), uuid: () => 'new' })
    expect(await checkCanary(db, { localStorage: fakeStorage({ [CANARY_STORAGE_KEY]: 'old' }) })).toBe('evicted')
  })

  it('is unknown when localStorage is unusable', async () => {
    const db = await freshDb('canary-4')
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(await checkCanary(db, { localStorage: broken })).toBe('unknown')
    await expect(initCanary(db, { localStorage: broken })).resolves.toBeTruthy()
  })

  it('is unknown when only the database copy exists', async () => {
    const db = await freshDb('canary-5')
    await initCanary(db, { localStorage: fakeStorage() })
    expect(await checkCanary(db, { localStorage: fakeStorage() })).toBe('unknown')
  })
})

describe('ageWarning', () => {
  const now = 100 * DAY

  it('is none inside the installed app and with no items', () => {
    expect(ageWarning(now - 10 * DAY, true, now)).toBe('none')
    expect(ageWarning(Infinity, false, now)).toBe('none')
    expect(ageWarning(undefined, false, now)).toBe('none')
  })

  it('warns from 3 days and strongly from 7 days', () => {
    expect(ageWarning(now - 2 * DAY, false, now)).toBe('none')
    expect(ageWarning(now - 3 * DAY, false, now)).toBe('warn')
    expect(ageWarning(now - 6 * DAY, false, now)).toBe('warn')
    expect(ageWarning(now - 7 * DAY, false, now)).toBe('strong')
  })
})
