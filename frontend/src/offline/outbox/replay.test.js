import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STALE_UNKNOWN_OUTCOME_MS } from '../constants.js'
import { openOutboxDb } from './db.js'
import { createLease } from './lease.js'
import { collectionAdd } from './ops/collectionAdd.js'
import { scanUpload } from './ops/scanUpload.js'
import { wishlistAdd } from './ops/wishlistAdd.js'
import { createReachability } from './probe.js'
import { createReplayer } from './replay.js'
import { createStore } from './store.js'

const CTX = { userId: 1, origin: 'https://cards.example.com' }
const HEALTH = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
const OPS = Object.fromEntries([scanUpload, collectionAdd, wishlistAdd].map(op => [op.type, op]))
const noDebug = () => false

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
})
const added = (extra = {}) => json({ id: 7, card_id: 'sv1-1', ...extra }, 201)

let clock
let db
let store
let calls
let health
let handler
let sleep
let replayer
let reachability
let dbFactory

function fetchImpl(url, init = {}) {
  if (url === '/api/health') return Promise.resolve(health())
  calls.push({ url, init })
  return Promise.resolve(handler(url, init, calls.length))
}

function makeReplayer(overrides = {}) {
  return createReplayer({
    store,
    lease: createLease(db, { owner: 'dev:tab1', now: () => clock }),
    ops: OPS,
    reachability,
    fetchImpl,
    now: () => clock,
    sleep,
    getToken: () => 'tok-123',
    debug: noDebug,
    origin: CTX.origin,
    ...overrides,
  })
}

beforeEach(async () => {
  clock = 1_000_000
  calls = []
  health = () => json(HEALTH)
  handler = () => added()
  sleep = vi.fn(async ms => { clock += ms })
  dbFactory = new IDBFactory()
  db = await openOutboxDb({ indexedDB: dbFactory })
  store = createStore(db, { now: () => clock, rng: () => 0.5, debug: noDebug })
  reachability = createReachability({ isOnLine: () => true })
  replayer = makeReplayer()
})
afterEach(() => db.close())

const add = (overrides = {}) => store.enqueue({
  ctx: CTX, type: 'collection.add', payload: { card_id: 'sv1-1', quantity: 1 }, ...overrides,
})
const run = (options = {}) => replayer.run({ ctx: CTX, ...options })
const keyOf = call => call.init.headers['Idempotency-Key']

describe('replay — success path', () => {
  it('sends with Idempotency-Key, X-Expected-User-Id, Authorization, redirect:manual, no-store', async () => {
    const item = await add()
    const result = await run()
    expect(result).toMatchObject({ ran: true, processed: 1 })
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe('/api/collection/')
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store' })
    expect(init.headers).toMatchObject({
      'Idempotency-Key': item.idempotencyKey,
      'X-Expected-User-Id': '1',
      Authorization: 'Bearer tok-123',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(init.body)).toEqual({ card_id: 'sv1-1', quantity: 1 })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(await store.getItem(item.id)).toBeNull()
    expect((await store.listHistory())[0]).toMatchObject({ id: item.id, type: 'collection.add' })
  })

  it('omits Authorization without a token and sends multipart for scans with no Content-Type', async () => {
    replayer = makeReplayer({ getToken: () => null })
    await store.enqueue({
      ctx: CTX, type: 'scan.upload', payload: { individualPositions: [1] },
      photos: [{ name: 'a.jpg', type: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]).buffer }],
    })
    handler = () => json({ id: 3 }, 200)
    await run()
    const { url, init } = calls[0]
    expect(url).toBe('/api/cards/recognize/jobs')
    expect(init.headers.Authorization).toBeUndefined()
    expect(Object.keys(init.headers).map(k => k.toLowerCase())).not.toContain('content-type')
    expect(init.body).toBeInstanceOf(FormData)
    const file = init.body.get('files')
    expect(file).toBeInstanceOf(Blob)
    expect(file.size).toBe(3)
    expect(file.type).toBe('image/jpeg')
    expect(init.body.get('individual_positions')).toBe('[1]')
  })

  it('treats an Idempotent-Replayed answer as success and runs onSynced', async () => {
    const queryClient = { invalidateQueries: vi.fn() }
    replayer = makeReplayer({ queryClient })
    await add()
    handler = () => added({ }) && json({ id: 7, card_id: 'x' }, 200, { 'Idempotent-Replayed': 'true' })
    await run()
    expect(await store.listItems(CTX)).toEqual([])
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['collection'] })
  })

  it('invalidates scan-jobs after a scan upload', async () => {
    const queryClient = { invalidateQueries: vi.fn() }
    replayer = makeReplayer({ queryClient })
    await store.enqueue({
      ctx: CTX, type: 'scan.upload', payload: {}, photos: [{ name: 'a', type: 'image/png', bytes: new ArrayBuffer(4) }],
    })
    handler = () => json({ id: 1 })
    await run()
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['scan-jobs'] })
  })

  it('a throwing onSynced does not undo a successful send', async () => {
    replayer = makeReplayer({ queryClient: { invalidateQueries: () => { throw new Error('cache') } } })
    await add()
    await run()
    expect(await store.listItems(CTX)).toEqual([])
  })

  it('stores serverInfo in meta', async () => {
    await add()
    await run()
    expect(await store.getMeta('serverInfo')).toMatchObject({ apiLevel: 1, features: ['idempotency-v1'] })
  })

  it('releases the lease afterwards', async () => {
    await add()
    await run()
    expect(await createLease(db, { owner: 'other:tab', now: () => clock }).acquire()).toBe(true)
  })
})

describe('replay — lost response and retries', () => {
  it('a network error after the server applied the add retries with the SAME key', async () => {
    const item = await add()
    let applied = 0
    handler = () => {
      applied += 1
      if (applied === 1) throw new TypeError('Failed to fetch') // server applied, client never saw it
      return json({ id: 7, card_id: 'sv1-1' }, 200, { 'Idempotent-Replayed': 'true' })
    }
    await run()
    expect(await store.getItem(item.id)).toMatchObject({ state: 'retry_wait', maybeApplied: true, retryCount: 1 })
    clock += 10 * 60000
    await run()
    expect(calls.map(keyOf)).toEqual([item.idempotencyKey, item.idempotencyKey])
    expect(await store.getItem(item.id)).toBeNull()
  })

  it('the forceLostResponse debug flag discards the answer and keeps the key', async () => {
    const item = await add()
    let lost = true
    replayer = makeReplayer({ debug: name => name === 'forceLostResponse' && lost })
    await run()
    expect(calls).toHaveLength(1)
    expect(await store.getItem(item.id)).toMatchObject({ state: 'retry_wait', maybeApplied: true, lastError: { kind: 'network' } })
    lost = false
    clock += 10 * 60000
    await run()
    expect(calls.map(keyOf)).toEqual([item.idempotencyKey, item.idempotencyKey])
    expect(await store.getItem(item.id)).toBeNull()
  })

  it('a request that exceeds its timeout is aborted and retried later', async () => {
    const item = await add()
    replayer = makeReplayer({ attemptTimeout: () => 25 })
    handler = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    await run()
    expect(await store.getItem(item.id)).toMatchObject({ state: 'retry_wait', maybeApplied: true, lastError: { message: 'Request timed out' } })
  })

  it('12 consecutive 500s end in failed', async () => {
    const item = await add()
    handler = () => json({ detail: 'boom' }, 500)
    for (let i = 1; i <= 12; i += 1) {
      clock += 24 * 3600 * 1000
      await run()
      expect((await store.getItem(item.id)).state).toBe(i < 12 ? 'retry_wait' : 'failed')
    }
    expect(calls).toHaveLength(12)
    expect((await store.getItem(item.id)).lastError.code).toBe('server_errors')
  })

  it('409 idempotency_in_progress waits about 3 s without penalty', async () => {
    const item = await add()
    handler = () => json({ detail: { code: 'idempotency_in_progress' } }, 409, { 'Retry-After': '2' })
    await run()
    expect(await store.getItem(item.id)).toMatchObject({ state: 'retry_wait', retryCount: 0, nextAttemptAt: clock + 3000 - 0 })
  })
})

describe('replay — blocking and pausing', () => {
  it('401 → blocked(auth) and the loop stops (later items untouched)', async () => {
    const first = await add()
    const second = await add()
    handler = () => json({ detail: 'Not authenticated' }, 401)
    const result = await run()
    expect(result.stoppedBy).toBe('blocked_auth')
    expect(calls).toHaveLength(1)
    expect(await store.getItem(first.id)).toMatchObject({ state: 'blocked', lastError: { code: 'auth' } })
    expect((await store.getItem(second.id)).state).toBe('pending')
  })

  it('a login trigger resumes auth-blocked items', async () => {
    const item = await add()
    handler = () => json({ detail: 'Not authenticated' }, 401)
    await run()
    handler = () => added()
    await run({ trigger: 'login' })
    expect(await store.getItem(item.id)).toBeNull()
  })

  it('a login page answered with 200 HTML → blocked(proxy), loop stops', async () => {
    await add()
    await add()
    handler = () => new Response('<html>sso</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    const result = await run()
    expect(result.stoppedBy).toBe('blocked_proxy')
    expect(calls).toHaveLength(1)
    expect((await store.listItems(CTX)).map(i => i.state)).toEqual(['blocked', 'pending'])
  })

  it('proxy-blocked items are retried only after the probe backoff has passed', async () => {
    const item = await add()
    handler = () => new Response('<html>sso</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    await run()
    handler = () => added()
    clock += 30000
    await run()
    expect((await store.getItem(item.id)).state).toBe('blocked')
    clock += 120000
    await run()
    expect(await store.getItem(item.id)).toBeNull()
  })

  it('429 without Retry-After pauses 60 s, keeps the item pending, and doubles on consecutive 429s', async () => {
    const item = await add()
    handler = () => json({ error: 'Rate limit exceeded' }, 429)
    const first = await run()
    expect(first.stoppedBy).toBe('rate_limited')
    expect(replayer.getEngineState().pausedUntil).toBe(clock + 60000)
    expect(await store.getItem(item.id)).toMatchObject({ state: 'pending', retryCount: 0 })
    expect(await run()).toEqual({ ran: false, skipped: 'paused' })
    clock += 60000
    await run()
    expect(replayer.getEngineState().pausedUntil).toBe(clock + 120000)
    clock += 120000
    handler = () => added()
    await run()
    expect(await store.getItem(item.id)).toBeNull()
    handler = () => json({ error: 'Rate limit exceeded' }, 429)
    await add()
    await run()
    expect(replayer.getEngineState().pausedUntil).toBe(clock + 60000) // success reset the doubling
  })

  it('429 honours Retry-After (clamped)', async () => {
    await add()
    handler = () => json({}, 429, { 'Retry-After': '90' })
    await run()
    expect(replayer.getEngineState().pausedUntil).toBe(clock + 90000)
  })

  it('the pause is capped at 900 s', async () => {
    await add()
    handler = () => json({}, 429)
    for (let i = 0; i < 8; i += 1) {
      clock = replayer.getEngineState().pausedUntil
      await run()
    }
    expect(replayer.getEngineState().pausedUntil - clock).toBe(900000)
  })

  it('autoSync off skips every trigger except manual', async () => {
    await add()
    expect(await run({ autoSync: false, trigger: 'timer' })).toEqual({ ran: false, skipped: 'auto_sync_off' })
    expect(calls).toHaveLength(0)
    expect(await run({ autoSync: false, trigger: 'manual' })).toMatchObject({ ran: true, processed: 1 })
  })

  it('does nothing without a user', async () => {
    await add()
    expect(await replayer.run({ ctx: null })).toEqual({ ran: false, skipped: 'no_user' })
    expect(calls).toHaveLength(0)
  })
})

describe('replay — circuit breaker and poison items', () => {
  it('three identical failures end the session; remaining items stay pending', async () => {
    for (let i = 0; i < 5; i += 1) await add()
    handler = () => json({ detail: 'Scanner provider is not configured' }, 400)
    const result = await run()
    expect(result.stoppedBy).toBe('circuit_breaker')
    expect(result.circuitBreaker).toMatchObject({ type: 'collection.add', status: 400 })
    expect(calls).toHaveLength(3)
    expect((await store.listItems(CTX)).map(i => i.state)).toEqual(['failed', 'failed', 'failed', 'pending', 'pending'])
  })

  it('failures with different details do not trip the breaker', async () => {
    for (let i = 0; i < 4; i += 1) await add()
    handler = (url, init, n) => json({ detail: `bad ${n}` }, 400)
    const result = await run()
    expect(result.circuitBreaker).toBeNull()
    expect(calls).toHaveLength(4)
  })

  it('a poison item does not block later items', async () => {
    const poison = await add({ payload: { card_id: 'bad' } })
    const good = await add({ payload: { card_id: 'good' } })
    handler = (url, init) => (JSON.parse(init.body).card_id === 'bad' ? json({ detail: 'Card not found' }, 404) : added())
    await run()
    expect(await store.getItem(poison.id)).toMatchObject({ state: 'failed', lastError: { status: 404, message: 'Card not found' } })
    expect(await store.getItem(good.id)).toBeNull()
  })

  it('an intervening success resets the breaker streak', async () => {
    for (let i = 0; i < 5; i += 1) await add({ payload: { card_id: `c${i}` } })
    handler = (url, init) => (['c2'].includes(JSON.parse(init.body).card_id) ? added() : json({ detail: 'nope' }, 404))
    const result = await run()
    expect(result.circuitBreaker).toBeNull()
    expect(calls).toHaveLength(5)
  })
})

describe('replay — identity, order, pacing', () => {
  it('skips other users and other origins entirely', async () => {
    const mine = await add()
    const otherUser = await store.enqueue({ ctx: { userId: 2, origin: CTX.origin }, type: 'collection.add', payload: { card_id: 'x' } })
    const otherOrigin = await store.enqueue({ ctx: { userId: 1, origin: 'http://192.168.1.5:3000' }, type: 'collection.add', payload: { card_id: 'y' } })
    await run()
    expect(calls).toHaveLength(1)
    expect(await store.getItem(mine.id)).toBeNull()
    expect((await store.getItem(otherUser.id)).state).toBe('pending')
    expect((await store.getItem(otherOrigin.id)).state).toBe('pending')
  })

  it('defence in depth: releases a claim whose origin differs from the page origin', async () => {
    replayer = makeReplayer({ origin: 'https://elsewhere.test' })
    const item = await add()
    const result = await run()
    expect(result.stoppedBy).toBe('identity_mismatch')
    expect(calls).toHaveLength(0)
    expect((await store.getItem(item.id)).state).toBe('pending')
  })

  it('sends oldest first (FIFO)', async () => {
    const ids = []
    for (let i = 0; i < 4; i += 1) ids.push((await add({ payload: { card_id: `c${i}` } })).idempotencyKey)
    await run()
    expect(calls.map(keyOf)).toEqual(ids)
  })

  it('paces with sleep(PACE_MS) between items, not after the last one', async () => {
    for (let i = 0; i < 3; i += 1) await add()
    await run()
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls.map(c => c[0])).toEqual([2000, 2000])
  })

  it('items still backing off are skipped while later ones go through', async () => {
    const first = await add({ payload: { card_id: 'a' } })
    const second = await add({ payload: { card_id: 'b' } })
    handler = (url, init) => {
      if (JSON.parse(init.body).card_id === 'a') throw new TypeError('Failed to fetch')
      return added()
    }
    await run()
    expect((await store.getItem(first.id)).state).toBe('retry_wait')
    expect(await store.getItem(second.id)).toBeNull()
  })

  it('two consecutive network errors end the session and schedule the next probe', async () => {
    for (let i = 0; i < 3; i += 1) await add()
    handler = () => { throw new TypeError('Failed to fetch') }
    const result = await run()
    expect(result.stoppedBy).toBe('unreachable')
    expect(calls).toHaveLength(2)
    expect(await run({ trigger: 'timer' })).toEqual({ ran: false, skipped: 'probe_backoff' })
  })
})

describe('replay — unreachable server and old servers', () => {
  it('an unreachable probe sends nothing and backs off per PROBE_BACKOFF_MS', async () => {
    await add()
    health = () => { throw new TypeError('Failed to fetch') }
    expect(await run()).toEqual({ ran: false, skipped: 'unreachable' })
    expect(calls).toHaveLength(0)
    expect(await run({ trigger: 'timer' })).toEqual({ ran: false, skipped: 'probe_backoff' })
    clock += 15000
    expect(await run({ trigger: 'timer' })).toEqual({ ran: false, skipped: 'unreachable' })
    clock += 15000
    expect(await run({ trigger: 'timer' })).toEqual({ ran: false, skipped: 'probe_backoff' }) // now 30 s
    expect(reachability.snapshot().bannerVisible).toBe(true)
    health = () => json(HEALTH)
    expect(await run({ trigger: 'manual' })).toMatchObject({ ran: true, processed: 1 })
    expect(reachability.snapshot()).toMatchObject({ state: 'reachable', bannerVisible: false })
  })

  it('a captive portal is not reachable', async () => {
    await add()
    health = () => new Response('<html>wifi login</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    expect(await run()).toEqual({ ran: false, skipped: 'captive' })
    expect(calls).toHaveLength(0)
  })

  it('does not probe when nothing is eligible', async () => {
    health = () => { throw new Error('must not be called') }
    expect(await run()).toEqual({ ran: false, skipped: 'idle' })
  })

  it('a server without idempotency-v1 blocks eligible items as server_old; an upgrade resumes them', async () => {
    const item = await add()
    health = () => json({ ...HEALTH, features: [] })
    expect(await run()).toEqual({ ran: false, skipped: 'server_old' })
    expect(calls).toHaveLength(0)
    expect(await store.getItem(item.id)).toMatchObject({ state: 'blocked', lastError: { code: 'server_old' } })
    health = () => json(HEALTH)
    await run()
    expect(await store.getItem(item.id)).toBeNull()
  })
})

describe('replay — stale outcomes and recovery', () => {
  it('maybeApplied older than 12 days → failed(outcome_unknown_stale), never sent', async () => {
    const item = await add()
    handler = () => { throw new TypeError('Failed to fetch') }
    await run()
    calls = []
    clock += STALE_UNKNOWN_OUTCOME_MS + 1000
    handler = () => added()
    await run()
    expect(calls).toHaveLength(0)
    expect(await store.getItem(item.id)).toMatchObject({ state: 'failed', lastError: { code: 'outcome_unknown_stale' } })
  })

  it('recovers a claim left by a killed tab (maybeApplied) and re-sends with the same key at once', async () => {
    const item = await add()
    await store.claimNext(CTX, 'dead:tab', clock)
    clock += 36000
    handler = () => json({ id: 7, card_id: 'sv1-1' }, 200, { 'Idempotent-Replayed': 'true' })
    await run()
    expect(calls.map(keyOf)).toEqual([item.idempotencyKey])
    expect(await store.getItem(item.id)).toBeNull()
  })

  it('a claim that is still live (another tab sending) is left alone', async () => {
    const item = await add()
    await store.claimNext(CTX, 'live:tab', clock)
    clock += 1000
    await run()
    expect(calls).toHaveLength(0)
    expect((await store.getItem(item.id)).state).toBe('sending')
  })

  it('a malformed 2xx body fails the item with maybeApplied', async () => {
    const item = await add()
    handler = () => json({ ok: true })
    await run()
    expect(await store.getItem(item.id)).toMatchObject({ state: 'failed', maybeApplied: true, lastError: { kind: 'shape' } })
  })

  it('a stored scan whose photo vanished fails as corrupted instead of looping', async () => {
    const item = await store.enqueue({
      ctx: CTX, type: 'scan.upload', payload: {}, photos: [{ name: 'a', type: 'image/png', bytes: new ArrayBuffer(4) }],
    })
    const tx = db.transaction('photos', 'readwrite')
    tx.objectStore('photos').clear()
    await new Promise(resolve => { tx.oncomplete = resolve })
    await run()
    expect(calls).toHaveLength(0)
    expect(await store.getItem(item.id)).toMatchObject({ state: 'failed', lastError: { code: 'corrupted' } })
  })
})

describe('replay — single flight', () => {
  it('two engines on one database: only one runs', async () => {
    await add()
    let release
    const gate = new Promise(resolve => { release = resolve })
    handler = async () => { await gate; return added() }
    const second = makeReplayer({ lease: createLease(db, { owner: 'dev:tab2', now: () => clock }) })
    const firstRun = run()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(await second.run({ ctx: CTX })).toEqual({ ran: false, skipped: 'lease' })
    release()
    expect(await firstRun).toMatchObject({ ran: true, processed: 1 })
    expect(calls).toHaveLength(1)
  })

  it('refuses a second concurrent run in the same tab', async () => {
    await add()
    let release
    const gate = new Promise(resolve => { release = resolve })
    handler = async () => { await gate; return added() }
    const firstRun = run()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(await run()).toEqual({ ran: false, skipped: 'running' })
    release()
    await firstRun
  })
})

describe('sendNow (persist-then-send)', () => {
  it('sends exactly the given items without pacing, probing or the lease', async () => {
    health = () => { throw new Error('probe must not run') }
    const a = await add({ payload: { card_id: 'a' } })
    const b = await add({ payload: { card_id: 'b' } })
    const untouched = await add({ payload: { card_id: 'c' } })
    handler = (url, init) => added({ card_id: JSON.parse(init.body).card_id })
    const results = await replayer.sendNow(CTX, [a.id, b.id], 'dev:tab1')
    expect(results.map(r => [r.id, r.outcome])).toEqual([[a.id, 'sent'], [b.id, 'sent']])
    expect(results[0].json).toMatchObject({ card_id: 'a' })
    expect(sleep).not.toHaveBeenCalled()
    expect((await store.getItem(untouched.id)).state).toBe('pending')
  })

  it('offline: the item is kept as retry_wait with its key', async () => {
    const item = await add()
    handler = () => { throw new TypeError('Failed to fetch') }
    const [result] = await replayer.sendNow(CTX, [item.id], 'dev:tab1')
    expect(result).toMatchObject({ id: item.id, outcome: 'retry_wait' })
    expect(await store.getItem(item.id)).toMatchObject({ state: 'retry_wait', idempotencyKey: item.idempotencyKey })
  })

  it('skips unknown, foreign and already-sending items', async () => {
    const foreign = await store.enqueue({ ctx: { userId: 2, origin: CTX.origin }, type: 'collection.add', payload: {} })
    const results = await replayer.sendNow(CTX, ['nope', foreign.id], 'dev:tab1')
    expect(results.map(r => r.outcome)).toEqual(['skipped', 'skipped'])
    expect(calls).toHaveLength(0)
  })

  it('a 429 pauses the engine', async () => {
    const item = await add()
    handler = () => json({}, 429)
    const [result] = await replayer.sendNow(CTX, [item.id], 'dev:tab1')
    expect(result.outcome).toBe('pending')
    expect(replayer.getEngineState().pausedUntil).toBe(clock + 60000)
  })
})

describe('stop', () => {
  it('a stopped replayer does nothing until resumed', async () => {
    await add()
    replayer.stop()
    expect(await run()).toEqual({ ran: false, skipped: 'stopped' })
    replayer.resume()
    expect(await run()).toMatchObject({ ran: true })
  })
})
