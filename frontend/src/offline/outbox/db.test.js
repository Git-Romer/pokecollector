import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { createStores, migrations, openOutboxDb, promisify, txDone } from './db.js'

const getAll = (db, store) => promisify(db.transaction(store).objectStore(store).getAll())

async function buildV1(indexedDB, name) {
  const db = await openOutboxDb({ indexedDB, name, version: 1 })
  const tx = db.transaction(['items', 'photos'], 'readwrite')
  tx.objectStore('items').put({
    id: 'i1', serverOrigin: 'https://x.test', userId: 1, createdAt: 1, state: 'pending', photoCount: 1,
  })
  tx.objectStore('photos').put({ itemId: 'i1', index: 0, name: 'a.jpg', type: 'image/jpeg', size: 3, bytes: new Uint8Array([1, 2, 3]).buffer })
  await txDone(tx)
  db.close()
}

describe('outbox database', () => {
  it('creates the four stores and the indexes of design §6.2.2', async () => {
    const db = await openOutboxDb({ indexedDB: new IDBFactory() })
    expect(db.name).toBe('pokecollector-outbox')
    expect(db.version).toBe(1)
    expect([...db.objectStoreNames].sort()).toEqual(['history', 'items', 'meta', 'photos'])
    const tx = db.transaction(['items', 'photos', 'meta', 'history'])
    expect(tx.objectStore('items').keyPath).toBe('id')
    expect(tx.objectStore('items').index('by_user_created').keyPath).toEqual(['serverOrigin', 'userId', 'createdAt'])
    expect(tx.objectStore('photos').keyPath).toEqual(['itemId', 'index'])
    expect(tx.objectStore('meta').keyPath).toBe('key')
    expect(tx.objectStore('history').index('by_completedAt').keyPath).toBe('completedAt')
    db.close()
  })

  it('exports migrations = {1: createStores}', () => {
    expect(migrations).toEqual({ 1: createStores })
  })

  it('upgrades a synthetic v1 database through a v2 step without losing items or photos', async () => {
    const indexedDB = new IDBFactory()
    await buildV1(indexedDB, 'upgrade-ok')
    const v2 = vi.fn((db, tx) => {
      tx.objectStore('items').createIndex('by_state', 'state')
    })
    const db = await openOutboxDb({ indexedDB, name: 'upgrade-ok', version: 2, migrations: { ...migrations, 2: v2 } })
    expect(v2).toHaveBeenCalledTimes(1)
    expect(db.version).toBe(2)
    expect((await getAll(db, 'items')).map(item => item.id)).toEqual(['i1'])
    const photos = await getAll(db, 'photos')
    expect(photos).toHaveLength(1)
    expect(new Uint8Array(photos[0].bytes)).toEqual(new Uint8Array([1, 2, 3]))
    expect(db.transaction('items').objectStore('items').indexNames.contains('by_state')).toBe(true)
    db.close()
  })

  it('runs every migration between the old and the new version, in order', async () => {
    const indexedDB = new IDBFactory()
    const order = []
    const db = await openOutboxDb({
      indexedDB,
      name: 'upgrade-order',
      version: 3,
      migrations: { 1: d => { order.push(1); createStores(d) }, 2: () => order.push(2), 3: () => order.push(3) },
    })
    expect(order).toEqual([1, 2, 3])
    db.close()
  })

  it('an aborting migration leaves v1 intact and rejects the open', async () => {
    const indexedDB = new IDBFactory()
    await buildV1(indexedDB, 'upgrade-abort')
    await expect(openOutboxDb({
      indexedDB,
      name: 'upgrade-abort',
      version: 2,
      migrations: { ...migrations, 2: () => { throw new Error('migration exploded') } },
    })).rejects.toThrow('migration exploded')
    const db = await openOutboxDb({ indexedDB, name: 'upgrade-abort', version: 1 })
    expect(db.version).toBe(1)
    expect(await getAll(db, 'items')).toHaveLength(1)
    expect(await getAll(db, 'photos')).toHaveLength(1)
    db.close()
  })

  it('rejects when a needed migration is missing', async () => {
    await expect(openOutboxDb({
      indexedDB: new IDBFactory(), name: 'missing', version: 2, migrations: { 1: createStores },
    })).rejects.toThrow(/Missing outbox migration 2/)
  })

  it('versionchange closes the connection so a newer tab can upgrade', async () => {
    const indexedDB = new IDBFactory()
    const onVersionChange = vi.fn()
    const old = await openOutboxDb({ indexedDB, name: 'vc', version: 1, onVersionChange })
    const upgraded = await openOutboxDb({
      indexedDB, name: 'vc', version: 2, migrations: { ...migrations, 2: () => {} },
    })
    expect(onVersionChange).toHaveBeenCalledTimes(1)
    expect(upgraded.version).toBe(2)
    expect(() => old.transaction('items')).toThrow()
    upgraded.close()
  })

  it('rejects without IndexedDB', async () => {
    await expect(openOutboxDb({ indexedDB: null })).rejects.toThrow(/not available/)
  })
})
