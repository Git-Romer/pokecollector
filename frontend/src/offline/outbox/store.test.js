import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STALE_UNKNOWN_OUTCOME_MS } from '../constants.js'
import { openOutboxDb, promisify } from './db.js'
import { createStore } from './store.js'

const CTX = { userId: 1, origin: 'https://cards.example.com' }
const MIB = 1048576
const buf = (n, fill = 1) => new Uint8Array(n).fill(fill).buffer
const photo = (n = 10, name = 'p.jpg') => ({ name, type: 'image/jpeg', bytes: buf(n) })
const noDebug = () => false

let clock
let db
let store

async function setup(extra = {}) {
  db = await openOutboxDb({ indexedDB: new IDBFactory() })
  store = createStore(db, { now: () => clock, rng: () => 0.5, debug: noDebug, ...extra })
}

beforeEach(async () => {
  clock = 1_000_000
  await setup()
})
afterEach(() => {
  vi.restoreAllMocks()
  db.close()
})

const add = (overrides = {}) => store.enqueue({
  ctx: CTX, type: 'collection.add', payload: { card_id: 'sv1-1', quantity: 1 }, ...overrides,
})
const scan = (photos = [photo()], overrides = {}) => store.enqueue({
  ctx: CTX, type: 'scan.upload', payload: { individualPositions: [] }, photos, ...overrides,
})
const getAllOf = name => promisify(db.transaction(name).objectStore(name).getAll())

describe('enqueue', () => {
  it('stores an item of the §6.2.3 shape in state pending', async () => {
    const item = await add({ display: { title: 'Pikachu' }, appVersion: '1.53.0' })
    expect(item).toMatchObject({
      schema: 1, type: 'collection.add', serverOrigin: CTX.origin, userId: 1, state: 'pending',
      attempts: 0, retryCount: 0, serverErrorCount: 0, firstSentAt: null, lastAttemptAt: null, nextAttemptAt: 0,
      maybeApplied: false, claim: null, lastError: null, photoCount: 0, photoBytes: 0, appVersion: '1.53.0', minApiLevel: 1,
      display: { title: 'Pikachu', subtitle: '', imageUrl: null },
    })
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(item.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(item.idempotencyKey).not.toBe(item.id)
    expect(await store.getItem(item.id)).toEqual(item)
  })

  it('writes item and photos in ONE transaction: a failing photo put leaves no item row', async () => {
    const realPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function put(...args) {
      if (this.name === 'photos') throw new Error('boom')
      return realPut.apply(this, args)
    })
    await expect(scan([photo(), photo()])).rejects.toThrow('boom')
    vi.restoreAllMocks()
    expect(await getAllOf('items')).toEqual([])
    expect(await getAllOf('photos')).toEqual([])
  })

  it('QuotaExceededError → rejects {code:"quota"} and persists nothing', async () => {
    const realPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function put(...args) {
      if (this.name === 'photos') throw new DOMException('full', 'QuotaExceededError')
      return realPut.apply(this, args)
    })
    await expect(scan()).rejects.toMatchObject({ code: 'quota' })
    vi.restoreAllMocks()
    expect(await getAllOf('items')).toEqual([])
    expect(await getAllOf('photos')).toEqual([])
  })

  it('the forceQuota debug flag rejects {code:"quota"}', async () => {
    store = createStore(db, { now: () => clock, debug: name => name === 'forceQuota' })
    await expect(add()).rejects.toMatchObject({ code: 'quota' })
    expect(await getAllOf('items')).toEqual([])
  })

  it('stores photos as ArrayBuffer — never Blob or File', async () => {
    await scan([photo(5, 'a.jpg'), photo(7, 'b.jpg')])
    const photos = await getAllOf('photos')
    expect(photos).toHaveLength(2)
    for (const stored of photos) {
      expect(Object.prototype.toString.call(stored.bytes)).toBe('[object ArrayBuffer]')
      expect(Object.values(stored).some(v => typeof Blob !== 'undefined' && v instanceof Blob)).toBe(false)
    }
    expect(photos.map(p => p.size).sort()).toEqual([5, 7])
    await expect(scan([{ name: 'x', type: 'image/jpeg', bytes: new Blob(['x']) }])).rejects.toMatchObject({ code: 'invalid' })
    await expect(scan([{ name: 'x', type: 'image/jpeg', bytes: new Uint8Array(3) }])).rejects.toMatchObject({ code: 'invalid' })
  })

  it('enforces item caps (photo count, photo size, grouped size, photos only for scans)', async () => {
    await expect(scan(Array.from({ length: 13 }, () => photo()))).rejects.toMatchObject({ code: 'too_many_photos' })
    await expect(scan([photo(15 * MIB + 1)])).rejects.toMatchObject({ code: 'photo_too_large' })
    await expect(scan([photo(6 * MIB), photo(5 * MIB)])).rejects.toMatchObject({ code: 'item_too_large' })
    await expect(scan([])).rejects.toMatchObject({ code: 'invalid' })
    await expect(add({ photos: [photo()] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(store.enqueue({ ctx: CTX, type: 'nope', payload: {} })).rejects.toMatchObject({ code: 'unsupported_op' })
    await expect(store.enqueue({ ctx: null, type: 'collection.add', payload: {} })).rejects.toMatchObject({ code: 'no_user' })
    expect((await scan([photo(12 * MIB)])).photoCount).toBe(1)
    expect(await getAllOf('items')).toHaveLength(1)
  })

  it('enforces the 500-item and 300 MiB caps and the free-space guard', async () => {
    const tx = db.transaction('items', 'readwrite')
    for (let i = 0; i < 500; i += 1) {
      tx.objectStore('items').put({ id: `f${i}`, serverOrigin: 'o', userId: 9, createdAt: i, state: 'pending', photoBytes: 0 })
    }
    await new Promise(resolve => { tx.oncomplete = resolve })
    await expect(add()).rejects.toMatchObject({ code: 'too_many_items' })

    await setup({ estimate: async () => ({ quota: 150 * MIB, usage: 100 * MIB }) })
    await expect(scan([photo(10 * MIB)])).rejects.toMatchObject({ code: 'quota' })
    await setup({ estimate: async () => ({ quota: 500 * MIB, usage: 100 * MIB }) })
    await expect(scan([photo(10 * MIB)])).resolves.toBeTruthy()
    await setup({ estimate: async () => { throw new Error('unsupported') } })
    await expect(scan([photo(10)])).resolves.toBeTruthy()
  })

  it('total outbox bytes are capped at 300 MiB', async () => {
    const tx = db.transaction('items', 'readwrite')
    tx.objectStore('items').put({ id: 'big', serverOrigin: 'o', userId: 9, createdAt: 1, state: 'pending', photoBytes: 295 * MIB })
    await new Promise(resolve => { tx.oncomplete = resolve })
    await expect(scan([photo(6 * MIB)])).rejects.toMatchObject({ code: 'quota' })
  })
})

describe('reads', () => {
  it('listItems returns no binary fields and is FIFO even for identical timestamps', async () => {
    const first = await scan([photo(4)])
    const second = await add()
    const third = await add()
    const items = await store.listItems(CTX)
    expect(items.map(i => i.id)).toEqual([first.id, second.id, third.id])
    const json = JSON.stringify(items)
    expect(json).not.toContain('bytes')
    for (const item of items) {
      Object.values(item).forEach(value => {
        expect(Object.prototype.toString.call(value)).not.toMatch(/ArrayBuffer|Blob|File/)
      })
    }
  })

  it('filters by userId and serverOrigin', async () => {
    const mine = await add()
    await store.enqueue({ ctx: { userId: 2, origin: CTX.origin }, type: 'collection.add', payload: {} })
    await store.enqueue({ ctx: { userId: 1, origin: 'http://192.168.1.5:3000' }, type: 'collection.add', payload: {} })
    expect((await store.listItems(CTX)).map(i => i.id)).toEqual([mine.id])
    expect(await store.countOthers(CTX)).toBe(2)
    expect(await store.claimNext({ userId: 3, origin: CTX.origin }, 'o', clock)).toBeNull()
  })

  it('readPhotos yields one ArrayBuffer at a time, in order', async () => {
    const item = await scan([photo(3, 'a.jpg'), photo(4, 'b.jpg'), photo(5, 'c.jpg')])
    const seen = []
    for await (const p of store.readPhotos(item.id)) {
      seen.push([p.index, p.name, p.bytes.byteLength])
      expect(Object.prototype.toString.call(p.bytes)).toBe('[object ArrayBuffer]')
    }
    expect(seen).toEqual([[0, 'a.jpg', 3], [1, 'b.jpg', 4], [2, 'c.jpg', 5]])
  })

  it('totals reports counts and bytes', async () => {
    await scan([photo(100)])
    await add()
    expect(await store.totals()).toMatchObject({ items: 2, photoBytes: 100 })
  })
})

describe('claimNext', () => {
  it('claims the oldest eligible item with a CAS-able claim', async () => {
    const a = await add()
    await add()
    const claimed = await store.claimNext(CTX, 'owner-1', clock)
    expect(claimed).toMatchObject({
      id: a.id, state: 'sending', attempts: 1, lastAttemptAt: clock, firstSentAt: clock,
      claim: { owner: 'owner-1', expiresAt: clock + 20000 + 15000 },
    })
  })

  it('a scan claim lasts upload timeout + grace', async () => {
    await scan([photo(10)])
    const claimed = await store.claimNext(CTX, 'o', clock)
    expect(claimed.claim.expiresAt).toBe(clock + 60000 + 15000)
  })

  it('two concurrent claimNext calls claim distinct items', async () => {
    await add(); await add(); await add()
    const [x, y] = await Promise.all([
      store.claimNext(CTX, 'a', clock),
      store.claimNext(CTX, 'b', clock),
    ])
    expect(x.id).not.toBe(y.id)
    const third = await store.claimNext(CTX, 'c', clock)
    expect(new Set([x.id, y.id, third.id]).size).toBe(3)
    expect(await store.claimNext(CTX, 'd', clock)).toBeNull()
  })

  it('from two separate connections (two tabs) never claims the same item twice', async () => {
    const factory = new IDBFactory()
    const dbA = await openOutboxDb({ indexedDB: factory })
    const dbB = await openOutboxDb({ indexedDB: factory })
    const a = createStore(dbA, { now: () => clock, debug: noDebug })
    const b = createStore(dbB, { now: () => clock, debug: noDebug })
    for (let i = 0; i < 6; i += 1) await a.enqueue({ ctx: CTX, type: 'collection.add', payload: { i } })
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).claimNext(CTX, `o${i}`, clock)))
    const ids = claims.filter(Boolean).map(c => c.id)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
    dbA.close(); dbB.close()
  })

  it('skips items waiting for nextAttemptAt, non-eligible states and unsupported minApiLevel', async () => {
    const waiting = await add()
    await store.claimNext(CTX, 'o', clock)
    await store.applyOutcome(waiting.id, 'o', { next: 'retry_wait', kind: 'network', message: 'x', delayMs: 60000, penalty: false }, clock)
    const needsNewer = await add({ minApiLevel: 2 })
    const ok = await add()
    expect((await store.claimNext(CTX, 'o', clock, { apiLevel: 1 })).id).toBe(ok.id)
    expect(await store.claimNext(CTX, 'o', clock, { apiLevel: 1 })).toBeNull()
    expect((await store.claimNext(CTX, 'o', clock, { apiLevel: 2 })).id).toBe(needsNewer.id)
    expect((await store.claimNext(CTX, 'o', clock + 60000)).id).toBe(waiting.id)
  })

  it('a newer-schema item becomes blocked(newer_schema) and is never claimed', async () => {
    const item = await add()
    const tx = db.transaction('items', 'readwrite')
    tx.objectStore('items').put({ ...item, schema: 99 })
    await new Promise(resolve => { tx.oncomplete = resolve })
    expect(await store.claimNext(CTX, 'o', clock)).toBeNull()
    expect(await store.getItem(item.id)).toMatchObject({ state: 'blocked', lastError: { code: 'newer_schema' } })
    await expect(store.retry(item.id)).rejects.toMatchObject({ code: 'newer_schema' })
  })

  it('a maybeApplied item unresolved for more than 12 days becomes failed(outcome_unknown_stale)', async () => {
    const item = await add()
    await store.claimNext(CTX, 'o', clock)
    await store.recoverStaleClaims('x', clock + 10 * 60000)
    const later = clock + STALE_UNKNOWN_OUTCOME_MS + 1
    expect(await store.claimNext(CTX, 'o', later)).toBeNull()
    expect(await store.getItem(item.id)).toMatchObject({ state: 'failed', maybeApplied: true, lastError: { code: 'outcome_unknown_stale' } })
  })
})

describe('applyOutcome', () => {
  async function claimed(overrides) {
    const item = await add(overrides)
    await store.claimNext(CTX, 'me', clock)
    return item
  }

  it('is a compare-and-set on claim.owner', async () => {
    const item = await claimed()
    expect(await store.applyOutcome(item.id, 'someone-else', { next: 'sent' }, clock)).toMatchObject({ applied: false })
    expect((await store.getItem(item.id)).state).toBe('sending')
    expect(await store.applyOutcome('missing', 'me', { next: 'sent' }, clock)).toMatchObject({ applied: false })
  })

  it('sent deletes item and photos and adds a history row', async () => {
    const item = await scan([photo(5), photo(6)])
    await store.claimNext(CTX, 'me', clock)
    expect(await store.applyOutcome(item.id, 'me', { next: 'sent', summary: '2 photos' }, clock + 5)).toMatchObject({ applied: true, state: 'sent' })
    expect(await store.getItem(item.id)).toBeNull()
    expect(await getAllOf('photos')).toEqual([])
    expect(await store.listHistory()).toEqual([{ id: item.id, type: 'scan.upload', summary: '2 photos', completedAt: clock + 5 }])
    expect(await store.applyOutcome(item.id, 'me', { next: 'sent' }, clock)).toMatchObject({ applied: false })
  })

  it('retry_wait uses full-jitter backoff, counts retries and records maybeApplied', async () => {
    const item = await claimed()
    const out = await store.applyOutcome(item.id, 'me', { next: 'retry_wait', kind: 'network', message: 'Network error', maybeApplied: true }, clock)
    expect(out.item).toMatchObject({
      state: 'retry_wait', retryCount: 1, maybeApplied: true, claim: null, nextAttemptAt: clock + 2500,
      lastError: { kind: 'network', message: 'Network error', at: clock },
    })
  })

  it('retry_wait without penalty keeps retryCount', async () => {
    const item = await claimed()
    const out = await store.applyOutcome(item.id, 'me', { next: 'retry_wait', delayMs: 3000, penalty: false, code: 'idempotency_in_progress', message: 'busy' }, clock)
    expect(out.item).toMatchObject({ retryCount: 0, nextAttemptAt: clock + 3000, maybeApplied: false })
  })

  it('pending (429) releases the claim without penalty', async () => {
    const item = await claimed()
    const out = await store.applyOutcome(item.id, 'me', { next: 'pending', rateLimited: true, message: 'slow down' }, clock)
    expect(out.item).toMatchObject({ state: 'pending', claim: null, retryCount: 0, nextAttemptAt: 0 })
  })

  it('the 12th server error fails the item; a different outcome resets the count', async () => {
    const item = await add()
    for (let i = 1; i <= 12; i += 1) {
      await store.claimNext(CTX, 'me', clock + i * 1e9)
      const out = await store.applyOutcome(item.id, 'me', { next: 'retry_wait', kind: 'http', status: 500, serverError: true, message: 'boom' }, clock + i * 1e9)
      expect(out.state).toBe(i < 12 ? 'retry_wait' : 'failed')
    }
    expect((await store.getItem(item.id)).lastError.code).toBe('server_errors')

    const other = await add()
    await store.claimNext(CTX, 'me', clock + 1e12)
    await store.applyOutcome(other.id, 'me', { next: 'retry_wait', serverError: true, message: 'x' }, clock)
    await store.claimNext(CTX, 'me', clock + 2e12)
    const out = await store.applyOutcome(other.id, 'me', { next: 'retry_wait', message: 'net' }, clock)
    expect(out.item.serverErrorCount).toBe(0)
  })

  it('blocked and failed clear the claim and set lastError', async () => {
    const a = await claimed()
    const out = await store.applyOutcome(a.id, 'me', { next: 'blocked', kind: 'http', status: 401, code: 'auth', message: 'Signed out' }, clock)
    expect(out.item).toMatchObject({ state: 'blocked', claim: null, lastError: { kind: 'http', status: 401, code: 'auth', message: 'Signed out' } })
    const b = await add()
    await store.claimNext(CTX, 'me', clock)
    const failed = await store.applyOutcome(b.id, 'me', { next: 'failed', kind: 'shape', code: 'shape', message: 'odd', maybeApplied: true }, clock)
    expect(failed.item).toMatchObject({ state: 'failed', maybeApplied: true })
  })
})

describe('stale claims', () => {
  it('recoverStaleClaims sets retry_wait + maybeApplied for expired claims only', async () => {
    const a = await add()
    const b = await add()
    await store.claimNext(CTX, 'dead-tab', clock)
    await store.claimNext(CTX, 'live-tab', clock + 30000)
    const recovered = await store.recoverStaleClaims('me', clock + 35001)
    expect(recovered).toBe(1)
    expect(await store.getItem(a.id)).toMatchObject({ state: 'retry_wait', maybeApplied: true, claim: null, nextAttemptAt: clock + 35001 })
    expect((await store.getItem(b.id)).state).toBe('sending')
  })
})

describe('user actions', () => {
  it('discard removes item and photos but refuses a live claim', async () => {
    const item = await scan([photo(5), photo(6)])
    await store.claimNext(CTX, 'me', clock)
    await expect(store.discard(item.id, clock + 1)).rejects.toMatchObject({ code: 'in_flight' })
    expect(await store.discard(item.id, clock + 100000)).toBe(true)
    expect(await getAllOf('items')).toEqual([])
    expect(await getAllOf('photos')).toEqual([])
    expect(await store.discard('missing')).toBe(false)
  })

  it('discardAllForUser removes only that user and skips live claims', async () => {
    await add(); await scan([photo(5)])
    const live = await add()
    await store.claimNext(CTX, 'me', clock)
    await store.claimNext(CTX, 'me', clock)
    await store.claimNext(CTX, 'me', clock)
    const other = await store.enqueue({ ctx: { userId: 2, origin: CTX.origin }, type: 'collection.add', payload: {} })
    expect(await store.discardAllForUser(CTX, clock + 1)).toBe(0)
    expect(await store.discardAllForUser(CTX, clock + 100000)).toBe(3)
    expect((await getAllOf('items')).map(i => i.id)).toEqual([other.id])
    expect(live.id).toBeTruthy()
  })

  it('retry keeps the key (failures leave no server row)', async () => {
    const item = await add()
    await store.claimNext(CTX, 'me', clock)
    await store.applyOutcome(item.id, 'me', { next: 'failed', kind: 'http', status: 404, message: 'no card' }, clock)
    const retried = await store.retry(item.id, { now: clock + 5 })
    expect(retried).toMatchObject({ state: 'pending', idempotencyKey: item.idempotencyKey, retryCount: 0, nextAttemptAt: 0 })
    await expect(store.retry(item.id)).rejects.toMatchObject({ code: 'bad_state' })
  })

  it('a stale unknown outcome needs a confirmed key rotation', async () => {
    const item = await add()
    await store.claimNext(CTX, 'me', clock)
    await store.applyOutcome(item.id, 'me', { next: 'retry_wait', maybeApplied: true, message: 'net' }, clock)
    const later = clock + STALE_UNKNOWN_OUTCOME_MS + 1
    await store.claimNext(CTX, 'me', later)
    await expect(store.retry(item.id, { now: later })).rejects.toMatchObject({ code: 'confirm_required' })
    const rotated = await store.retry(item.id, { rotateKey: true, now: later })
    expect(rotated.idempotencyKey).not.toBe(item.idempotencyKey)
    expect(rotated).toMatchObject({ state: 'pending', maybeApplied: false, firstSentAt: null, attempts: 0 })
  })

  it('rotateKey is refused when the outcome is not stale', async () => {
    const item = await add()
    await store.claimNext(CTX, 'me', clock)
    await store.applyOutcome(item.id, 'me', { next: 'failed', message: 'x' }, clock)
    await expect(store.retry(item.id, { rotateKey: true })).rejects.toMatchObject({ code: 'rotate_not_allowed' })
  })

  it('editPending edits a pending add, keeping the key (#12)', async () => {
    const item = await add()
    const edited = await store.editPending(item.id, { payload: { card_id: 'sv1-1', quantity: 3 }, display: { title: 'x3' } })
    expect(edited).toMatchObject({ state: 'pending', idempotencyKey: item.idempotencyKey, payload: { quantity: 3 }, display: { title: 'x3' } })
  })

  it('editPending on a failed, never-sent add regenerates the key and resets counters (#10)', async () => {
    const item = await add()
    await store.claimNext(CTX, 'me', clock)
    await store.applyOutcome(item.id, 'me', { next: 'failed', kind: 'http', status: 422, message: 'bad' }, clock)
    const edited = await store.editPending(item.id, { payload: { card_id: 'sv1-1', quantity: 2 } })
    expect(edited.idempotencyKey).not.toBe(item.idempotencyKey)
    expect(edited).toMatchObject({ state: 'pending', attempts: 0, retryCount: 0, lastError: null, firstSentAt: null })
  })

  it('editPending refuses maybeApplied items, scans and sending items', async () => {
    const maybe = await add()
    await store.claimNext(CTX, 'me', clock)
    await store.applyOutcome(maybe.id, 'me', { next: 'failed', maybeApplied: true, message: 'odd' }, clock)
    await expect(store.editPending(maybe.id, { payload: {} })).rejects.toMatchObject({ code: 'bad_state' })
    const s = await scan()
    await expect(store.editPending(s.id, { payload: {} })).rejects.toMatchObject({ code: 'not_editable' })
    const sending = await add()
    await store.claimByIds(CTX, [sending.id], 'me', clock)
    await expect(store.editPending(sending.id, { payload: {} })).rejects.toMatchObject({ code: 'bad_state' })
  })

  it('blockEligible / unblock move items between pending and blocked', async () => {
    const a = await add()
    const b = await add()
    expect(await store.blockEligible(CTX, 'server_old', 'old', clock)).toBe(2)
    expect((await store.getItem(a.id)).lastError.code).toBe('server_old')
    expect(await store.unblock(CTX, ['proxy'], clock)).toBe(0)
    expect(await store.unblock(CTX, ['server_old'], clock)).toBe(2)
    expect((await store.getItem(b.id)).state).toBe('pending')
  })

  it('unblock honours minAgeMs', async () => {
    const a = await add()
    await store.claimNext(CTX, 'me', clock)
    await store.applyOutcome(a.id, 'me', { next: 'blocked', code: 'proxy', message: 'x' }, clock)
    expect(await store.unblock(CTX, ['proxy'], clock + 1000, { minAgeMs: 120000 })).toBe(0)
    expect(await store.unblock(CTX, ['proxy'], clock + 120000, { minAgeMs: 120000 })).toBe(1)
  })

  it('peek counts eligible and wake-worthy blocked items', async () => {
    const a = await add()
    await add()
    await store.claimNext(CTX, 'me', clock)
    await store.applyOutcome(a.id, 'me', { next: 'blocked', code: 'proxy', message: 'x' }, clock)
    expect(await store.peek(CTX, clock)).toEqual({ eligible: 1, unblockable: 1 })
  })
})

describe('history and meta', () => {
  it('trimHistory keeps the newest 100 rows no older than 14 days', async () => {
    const day = 86400000
    for (let i = 0; i < 105; i += 1) await store.addHistory({ id: `h${i}`, type: 'x', summary: '', completedAt: clock - i * 1000 })
    await store.addHistory({ id: 'old', type: 'x', summary: '', completedAt: clock - 15 * day })
    expect(await store.trimHistory(clock)).toBe(6)
    const rows = await store.listHistory()
    expect(rows).toHaveLength(100)
    expect(rows[0].id).toBe('h0')
    expect(rows.some(row => row.id === 'old')).toBe(false)
  })

  it('meta get/set/delete', async () => {
    expect(await store.getMeta('autoSync')).toBeUndefined()
    await store.setMeta('autoSync', false)
    expect(await store.getMeta('autoSync')).toBe(false)
    await store.deleteMeta('autoSync')
    expect(await store.getMeta('autoSync')).toBeUndefined()
  })
})
