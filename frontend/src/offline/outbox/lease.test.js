import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { openOutboxDb } from './db.js'
import { createLease } from './lease.js'

let db
let clock
const now = () => clock

beforeEach(async () => {
  clock = 1_000_000
  db = await openOutboxDb({ indexedDB: new IDBFactory() })
})

const readLease = async () => new Promise(resolve => {
  const req = db.transaction('meta').objectStore('meta').get('lease')
  req.onsuccess = () => resolve(req.result?.value ?? null)
})

describe('lease', () => {
  it('acquires an absent lease and renews its own', async () => {
    const lease = createLease(db, { owner: 'a:1', now })
    expect(await lease.acquire()).toBe(true)
    expect(await readLease()).toEqual({ owner: 'a:1', expiresAt: clock + 30000 })
    clock += 10000
    expect(await lease.heartbeat()).toBe(true)
    expect((await readLease()).expiresAt).toBe(clock + 30000)
    expect(await lease.acquire()).toBe(true)
  })

  it('two engines: only one holds the lease', async () => {
    const a = createLease(db, { owner: 'a:1', now })
    const b = createLease(db, { owner: 'b:2', now })
    const [first, second] = await Promise.all([a.acquire(), b.acquire()])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    const loser = first ? b : a
    expect(await loser.acquire()).toBe(false)
    expect(await loser.heartbeat()).toBe(false)
  })

  it('can be stolen only after it expired', async () => {
    const a = createLease(db, { owner: 'a:1', now })
    const b = createLease(db, { owner: 'b:2', now })
    await a.acquire()
    clock += 29999
    expect(await b.acquire()).toBe(false)
    clock += 1
    expect(await b.acquire()).toBe(true)
    expect((await readLease()).owner).toBe('b:2')
    expect(await a.heartbeat()).toBe(false)
  })

  it('release deletes only our own lease', async () => {
    const a = createLease(db, { owner: 'a:1', now })
    const b = createLease(db, { owner: 'b:2', now })
    await a.acquire()
    expect(await b.release()).toBe(false)
    expect(await readLease()).not.toBeNull()
    expect(await a.release()).toBe(true)
    expect(await readLease()).toBeNull()
    expect(await b.acquire()).toBe(true)
  })
})
