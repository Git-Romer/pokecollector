import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEvents } from './events.js'
import { createOutbox } from './index.js'

const CTX = { userId: 1, origin: 'https://cards.example.com' }
const HEALTH = { status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'] }
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
})

let clock
let indexedDB
let calls
let handler
let health

const fetchImpl = (url, init) => {
  if (url === '/api/health') return Promise.resolve(health())
  calls.push({ url, init })
  return Promise.resolve(handler(url, init))
}
const channels = () => createEvents({ BroadcastChannelImpl: null, storage: null, eventTarget: null })

function make(overrides = {}) {
  return createOutbox({
    ctx: CTX,
    fetchImpl,
    now: () => clock,
    rng: () => 0.5,
    sleep: async ms => { clock += ms },
    indexedDB,
    events: channels(),
    estimate: null,
    storageManager: null,
    getToken: () => 'tok',
    ...overrides,
  })
}

beforeEach(() => {
  clock = 1_000_000
  indexedDB = new IDBFactory()
  calls = []
  health = () => json(HEALTH)
  handler = () => json({ id: 1, card_id: 'sv1-1' }, 201)
})

const addInput = (cardId = 'sv1-1') => ({ type: 'collection.add', payload: { card_id: cardId, quantity: 1 }, display: { title: cardId } })

describe('createOutbox', () => {
  it('exposes the surface of design §6.2.12', () => {
    const outbox = make()
    expect(Object.keys(outbox).sort()).toEqual([
      'discard', 'discardAllForUser', 'editPending', 'enqueue', 'getSnapshot', 'noteUnreachable', 'retry', 'sendNow',
      'setAutoSync', 'start', 'stop', 'storageInfo', 'subscribe', 'syncNow',
    ])
  })

  it('persists first, then sends: enqueue + sendNow resolves {id, outcome, json}', async () => {
    const outbox = make()
    await outbox.start()
    const item = await outbox.enqueue(addInput())
    expect(outbox.getSnapshot().counts.pending).toBe(1)
    const [result] = await outbox.sendNow([item.id])
    expect(result).toMatchObject({ id: item.id, outcome: 'sent', json: { id: 1 } })
    expect(calls[0].init.headers['Idempotency-Key']).toBe(item.idempotencyKey)
    expect(outbox.getSnapshot().items).toEqual([])
    outbox.stop()
  })

  it('offline: enqueue keeps the item, sendNow leaves it retry_wait, syncNow delivers it later with the same key', async () => {
    const outbox = make()
    await outbox.start()
    const item = await outbox.enqueue(addInput())
    handler = () => { throw new TypeError('Failed to fetch') }
    const [lost] = await outbox.sendNow([item.id])
    expect(lost.outcome).toBe('retry_wait')
    expect(outbox.getSnapshot().counts).toMatchObject({ retryWait: 1, pending: 0 })
    handler = () => json({ id: 1, card_id: 'sv1-1' }, 200, { 'Idempotent-Replayed': 'true' })
    clock += 60 * 60000
    const session = await outbox.syncNow('manual')
    expect(session).toMatchObject({ ran: true, processed: 1 })
    expect(calls.map(c => c.init.headers['Idempotency-Key'])).toEqual([item.idempotencyKey, item.idempotencyKey])
    expect(outbox.getSnapshot().items).toEqual([])
    outbox.stop()
  })

  it('getSnapshot keeps its identity until something changes, and subscribe fires on change', async () => {
    const outbox = make()
    await outbox.start()
    const first = outbox.getSnapshot()
    expect(outbox.getSnapshot()).toBe(first)
    const listener = vi.fn()
    const off = outbox.subscribe(listener)
    await outbox.enqueue(addInput())
    expect(listener).toHaveBeenCalled()
    expect(outbox.getSnapshot()).not.toBe(first)
    expect(outbox.getSnapshot()).toMatchObject({
      counts: { pending: 1, sending: 0, retryWait: 0, blocked: 0, failed: 0 },
      autoSync: true,
      otherAccountCount: 0,
      engine: { running: false, pausedUntil: 0 },
    })
    off()
    outbox.stop()
  })

  it('snapshots hide other accounts and count them', async () => {
    const other = make({ ctx: { userId: 2, origin: CTX.origin } })
    await other.start()
    await other.enqueue(addInput('theirs'))
    other.stop()
    const outbox = make()
    await outbox.start()
    expect(outbox.getSnapshot()).toMatchObject({ items: [], otherAccountCount: 1 })
    outbox.stop()
  })

  it('setAutoSync is persisted and honoured by non-manual syncs', async () => {
    const outbox = make()
    await outbox.start()
    await outbox.enqueue(addInput())
    await outbox.setAutoSync(false)
    expect(outbox.getSnapshot().autoSync).toBe(false)
    expect(await outbox.syncNow('timer')).toEqual({ ran: false, skipped: 'auto_sync_off' })
    outbox.stop()
    const reopened = make()
    await reopened.start()
    expect(reopened.getSnapshot().autoSync).toBe(false)
    expect(await reopened.syncNow('manual')).toMatchObject({ ran: true, processed: 1 })
    reopened.stop()
  })

  it('refuses to enqueue when the server is known to lack idempotency-v1, and blocks existing items', async () => {
    const outbox = make()
    await outbox.start()
    const item = await outbox.enqueue(addInput())
    health = () => json({ ...HEALTH, features: [] })
    await outbox.syncNow('manual')
    expect(outbox.getSnapshot().items[0]).toMatchObject({ id: item.id, state: 'blocked', lastError: { code: 'server_old' } })
    await expect(outbox.enqueue(addInput('b'))).rejects.toMatchObject({ code: 'server_old' })
    outbox.stop()
  })

  it('rejects {code:"quota"} through the public API and persists nothing', async () => {
    const outbox = make({ estimate: async () => ({ quota: 1, usage: 1 }) })
    await outbox.start()
    await expect(outbox.enqueue({
      type: 'scan.upload', payload: {}, photos: [{ name: 'a', type: 'image/jpeg', bytes: new ArrayBuffer(10) }],
    })).rejects.toMatchObject({ code: 'quota' })
    expect(outbox.getSnapshot().items).toEqual([])
    outbox.stop()
  })

  it('retry, editPending and discard work through the API', async () => {
    const outbox = make()
    await outbox.start()
    const item = await outbox.enqueue(addInput())
    const edited = await outbox.editPending(item.id, { payload: { card_id: 'sv1-1', quantity: 4 } })
    expect(edited.payload.quantity).toBe(4)
    handler = () => json({ detail: 'Card not found' }, 404)
    await outbox.syncNow('manual')
    expect(outbox.getSnapshot().counts.failed).toBe(1)
    await outbox.retry(item.id)
    expect(outbox.getSnapshot().counts).toMatchObject({ failed: 0, pending: 1 })
    expect(await outbox.discard(item.id)).toBe(true)
    expect(outbox.getSnapshot().items).toEqual([])
    await outbox.enqueue(addInput('a'))
    await outbox.enqueue(addInput('b'))
    expect(await outbox.discardAllForUser()).toBe(2)
    outbox.stop()
  })

  it('does nothing when the queue flag is off', async () => {
    const outbox = make({ flags: { queue: false } })
    expect(await outbox.syncNow('manual')).toEqual({ ran: false, skipped: 'disabled' })
    await expect(outbox.enqueue(addInput())).rejects.toMatchObject({ code: 'disabled' })
    await expect(outbox.start()).rejects.toMatchObject({ code: 'disabled' })
  })

  it('accepts ctx as a function and follows user changes', async () => {
    let current = CTX
    const outbox = make({ ctx: () => current })
    await outbox.start()
    await outbox.enqueue(addInput())
    expect(outbox.getSnapshot().items).toHaveLength(1)
    current = { userId: 2, origin: CTX.origin }
    await outbox.syncNow('manual')
    expect(calls).toHaveLength(0)
    expect(outbox.getSnapshot()).toMatchObject({ items: [], otherAccountCount: 1 })
    current = null
    expect(await outbox.syncNow('manual')).toEqual({ ran: false, skipped: 'no_user' })
    outbox.stop()
  })

  it('a versionchange from a newer tab closes the connection, stops the outbox and reports it', async () => {
    const onVersionChange = vi.fn()
    const outbox = make({ onVersionChange })
    await outbox.start()
    const { openOutboxDb, migrations } = await import('./db.js')
    const upgraded = await openOutboxDb({ indexedDB, version: 2, migrations: { ...migrations, 2: () => {} } })
    expect(onVersionChange).toHaveBeenCalledTimes(1)
    await expect(outbox.enqueue(addInput())).rejects.toMatchObject({ code: 'stopped' })
    upgraded.close()
  })

  it('start() rejects when the schema cannot be created (outbox disables itself)', async () => {
    const outbox = make({ migrations: { 1: () => { throw new Error('migration failed') } } })
    await expect(outbox.start()).rejects.toThrow('migration failed')
  })

  it('storageInfo reports totals, usage and persistence', async () => {
    const outbox = make({
      estimate: async () => ({ usage: 5e6, quota: 5e9 }),
      storageManager: { persisted: async () => true },
    })
    await outbox.start()
    await outbox.enqueue({ type: 'scan.upload', payload: {}, photos: [{ name: 'a', type: 'image/jpeg', bytes: new ArrayBuffer(100) }] })
    expect(await outbox.storageInfo()).toMatchObject({ items: 1, photoBytes: 100, usage: 5e6, quota: 5e9, persisted: true })
    outbox.stop()
  })

  it('refreshes when another tab announces a change', async () => {
    const handlers = []
    const events = {
      publish: vi.fn(),
      subscribe: cb => { handlers.push(cb); return () => {} },
      close: vi.fn(),
    }
    const tabA = make({ events })
    await tabA.start()
    const tabB = make()
    await tabB.start()
    await tabB.enqueue(addInput())
    expect(tabA.getSnapshot().items).toHaveLength(0)
    handlers.forEach(cb => cb({ type: 'changed', tabId: 'someone-else' }))
    await vi.waitFor(() => expect(tabA.getSnapshot().items).toHaveLength(1))
    tabA.stop()
    tabB.stop()
  })
})
