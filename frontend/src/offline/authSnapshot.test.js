import { describe, expect, it } from 'vitest'
import {
  SNAPSHOT_KEY,
  SNAPSHOT_MAX_AGE_MS,
  clearAuthSnapshot,
  readAuthSnapshot,
  writeAuthSnapshot,
} from './authSnapshot'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) },
    removeItem: key => { delete data[key] },
    data,
  }
}

const user = { id: 3, username: 'ash', role: 'user', avatar_id: 'x', must_change_password: false, extra: 'dropped' }
const NOW = 1_800_000_000_000

function seeded(overrides = {}) {
  const storage = memoryStorage()
  writeAuthSnapshot({ multiUser: true, locked: false, user }, { storage, now: () => NOW })
  const snap = JSON.parse(storage.data[SNAPSHOT_KEY])
  storage.data[SNAPSHOT_KEY] = JSON.stringify({ ...snap, ...overrides })
  return storage
}

describe('authSnapshot', () => {
  it('writes only the allowed user fields', () => {
    const storage = memoryStorage()
    expect(writeAuthSnapshot({ multiUser: true, locked: true, user }, { storage, now: () => NOW })).toBe(true)
    expect(JSON.parse(storage.data[SNAPSHOT_KEY])).toEqual({
      v: 1,
      multiUser: true,
      locked: true,
      user: { id: 3, username: 'ash', role: 'user', avatar_id: 'x', must_change_password: false },
      savedAt: NOW,
    })
  })

  it('does not write without a numeric user id', () => {
    const storage = memoryStorage()
    expect(writeAuthSnapshot({ multiUser: false, locked: false, user: null }, { storage })).toBe(false)
    expect(writeAuthSnapshot({ multiUser: false, locked: false, user: { id: '1' } }, { storage })).toBe(false)
    expect(storage.data).toEqual({})
  })

  it('returns a valid snapshot', () => {
    const snap = readAuthSnapshot({ token: 't', now: () => NOW + 1000, storage: seeded() })
    expect(snap.user.id).toBe(3)
    expect(snap.multiUser).toBe(true)
  })

  it('rejects a wrong version', () => {
    expect(readAuthSnapshot({ token: 't', now: () => NOW, storage: seeded({ v: 2 }) })).toBeNull()
  })

  it('rejects a non-numeric user id', () => {
    expect(readAuthSnapshot({ token: 't', now: () => NOW, storage: seeded({ user: { ...user, id: '3' } }) })).toBeNull()
  })

  it('rejects must_change_password', () => {
    const storage = seeded({ user: { ...user, must_change_password: true } })
    expect(readAuthSnapshot({ token: 't', now: () => NOW, storage })).toBeNull()
  })

  it('accepts a snapshot exactly 90 days old and rejects an older one', () => {
    expect(readAuthSnapshot({ token: 't', now: () => NOW + SNAPSHOT_MAX_AGE_MS, storage: seeded() })).not.toBeNull()
    expect(readAuthSnapshot({ token: 't', now: () => NOW + SNAPSHOT_MAX_AGE_MS + 1, storage: seeded() })).toBeNull()
  })

  it('rejects a missing savedAt', () => {
    expect(readAuthSnapshot({ token: 't', now: () => NOW, storage: seeded({ savedAt: undefined }) })).toBeNull()
  })

  it('requires a token in multi-user mode only', () => {
    expect(readAuthSnapshot({ token: null, now: () => NOW, storage: seeded() })).toBeNull()
    expect(readAuthSnapshot({ token: null, now: () => NOW, storage: seeded({ multiUser: false }) })).not.toBeNull()
  })

  it('treats corrupted JSON and missing data as no snapshot', () => {
    expect(readAuthSnapshot({ token: 't', storage: memoryStorage({ [SNAPSHOT_KEY]: '{nope' }) })).toBeNull()
    expect(readAuthSnapshot({ token: 't', storage: memoryStorage() })).toBeNull()
    expect(readAuthSnapshot({ token: 't', storage: memoryStorage({ [SNAPSHOT_KEY]: 'null' }) })).toBeNull()
  })

  it('never throws when storage throws', () => {
    const broken = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
      removeItem() { throw new Error('denied') },
    }
    expect(readAuthSnapshot({ token: 't', storage: broken })).toBeNull()
    expect(writeAuthSnapshot({ multiUser: false, locked: false, user }, { storage: broken })).toBe(false)
    expect(() => clearAuthSnapshot({ storage: broken })).not.toThrow()
  })

  it('clears the snapshot', () => {
    const storage = seeded()
    clearAuthSnapshot({ storage })
    expect(storage.data[SNAPSHOT_KEY]).toBeUndefined()
  })
})
