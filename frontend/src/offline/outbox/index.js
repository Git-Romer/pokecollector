// createOutbox — the public surface of the offline outbox
// (docs/PWA_OFFLINE_DESIGN.md §6.2.12). The app builds it in `offline/OfflineProvider.jsx`.

import { REQUIRED_SERVER_FEATURE } from '../constants.js'
import { uuidv4 } from '../uuid.js'
import { openOutboxDb } from './db.js'
import { createEvents } from './events.js'
import { createLease } from './lease.js'
import { createReachability, probe as defaultProbe } from './probe.js'
import { createReachabilityMonitor } from './monitor.js'
import { createReplayer } from './replay.js'
import { createStore, OutboxError } from './store.js'
import { collectionAdd } from './ops/collectionAdd.js'
import { scanUpload } from './ops/scanUpload.js'
import { wishlistAdd } from './ops/wishlistAdd.js'

export { OutboxError }

const DEFAULT_OPS = [scanUpload, collectionAdd, wishlistAdd]
const EMPTY_COUNTS = Object.freeze({ pending: 0, sending: 0, retryWait: 0, blocked: 0, failed: 0 })

function countStates(items) {
  const counts = { ...EMPTY_COUNTS }
  for (const item of items) {
    if (item.state === 'retry_wait') counts.retryWait += 1
    else if (item.state in counts) counts[item.state] += 1
  }
  return counts
}

function appVersion() {
  // eslint-disable-next-line no-undef
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
}

/**
 * `ctx` is `{userId, origin}` or a function returning it (or null when signed out).
 * `flags` may contain `queue:false` to make every call a no-op.
 */
export function createOutbox({
  ctx,
  flags = { queue: true },
  fetchImpl,
  now = Date.now,
  rng = Math.random,
  sleep,
  queryClient = null,
  indexedDB = globalThis.indexedDB,
  migrations,
  onVersionChange = null,
  onlineManager = null,
  probeImpl = defaultProbe,
  getToken,
  events = createEvents(),
  estimate = globalThis.navigator?.storage?.estimate
    ? () => globalThis.navigator.storage.estimate()
    : null,
  storageManager = globalThis.navigator?.storage ?? null,
} = {}) {
  const enabled = () => flags?.queue !== false
  const getCtx = typeof ctx === 'function' ? ctx : () => ctx
  const tabId = uuidv4()
  const listeners = new Set()
  const reachability = createReachability({ onlineManager })

  const monitor = createReachabilityMonitor({
    reachability,
    probe: options => probeImpl({ fetchImpl: fetchImpl || globalThis.fetch?.bind(globalThis), now, ...options }),
    isEnabled: () => enabled(),
    isReplayRunning: () => Boolean(replayer?.getEngineState().running),
    notify: () => { refresh().catch(() => {}) },
    now,
  })

  let db = null
  let store = null
  let replayer = null
  let owner = null
  let starting = null
  let stopped = false
  let autoSync = true
  let unsubscribeEvents = null
  let snapshot = {
    items: [],
    counts: EMPTY_COUNTS,
    reachability: reachability.snapshot(),
    engine: { running: false, pausedUntil: 0 },
    autoSync,
    otherAccountCount: 0,
  }


  function emitLocal() {
    listeners.forEach(cb => {
      try {
        cb()
      } catch {
        // listener errors must not break the outbox
      }
    })
  }

  async function refresh() {
    if (!store) return snapshot
    const current = getCtx()
    const [items, otherAccountCount] = current?.userId !== undefined && current?.userId !== null && current?.origin
      ? await Promise.all([store.listItems(current), store.countOthers(current)])
      : [[], 0]
    const engine = replayer.getEngineState()
    snapshot = {
      items,
      counts: countStates(items),
      reachability: reachability.snapshot(),
      engine: { running: engine.running, pausedUntil: engine.pausedUntil },
      autoSync,
      otherAccountCount,
    }
    emitLocal()
    return snapshot
  }

  /** Local change: refresh our snapshot and tell the other tabs. */
  function changed() {
    events.publish({ type: 'changed', tabId })
    return refresh().catch(() => snapshot)
  }

  async function ready() {
    if (stopped) throw new OutboxError('stopped', 'The outbox was stopped')
    if (!enabled()) throw new OutboxError('disabled', 'The offline queue is turned off')
    if (!starting) {
      starting = (async () => {
        db = await openOutboxDb({
          indexedDB,
          ...(migrations ? { migrations } : {}),
          onVersionChange: () => {
            db = null
            stopped = true
            onVersionChange?.()
          },
        })
        store = createStore(db, { now, rng, estimate })
        let deviceId = await store.getMeta('deviceId')
        if (!deviceId) {
          deviceId = uuidv4()
          await store.setMeta('deviceId', deviceId)
        }
        owner = `${deviceId}:${tabId}`
        const storedAutoSync = await store.getMeta('autoSync')
        if (typeof storedAutoSync === 'boolean') autoSync = storedAutoSync
        const lease = createLease(db, { owner, now })
        replayer = createReplayer({
          store,
          lease,
          ops: Object.fromEntries(DEFAULT_OPS.map(op => [op.type, op])),
          reachability,
          fetchImpl: fetchImpl || globalThis.fetch?.bind(globalThis),
          now,
          ...(sleep ? { sleep } : {}),
          queryClient,
          ...(getToken ? { getToken } : {}),
          probeImpl: monitor.wrapProbe(probeImpl),
          origin: getCtx()?.origin,
          notify: () => { changed() },
        })
        await store.recoverStaleClaims(owner, now())
        unsubscribeEvents = events.subscribe(message => {
          if (message?.tabId !== tabId) refresh().catch(() => {})
        })
      })()
      starting.catch(() => { starting = null })
    }
    await starting
    return store
  }

  async function serverInfo() {
    return (await store.getMeta('serverInfo')) || null
  }

  return {
    /** Opens the database and loads the first snapshot. Rejects if IndexedDB/migrations fail. */
    async start() {
      stopped = false
      await ready()
      await refresh()
      monitor.start()
    },

    stop() {
      stopped = true
      monitor.stop()
      replayer?.stop()
      unsubscribeEvents?.()
      events.close()
      try {
        db?.close()
      } catch {
        // already closed
      }
      db = null
      store = null
      starting = null
    },

    /** The caller already knows the server is unreachable (auth startup gave up). */
    noteUnreachable() {
      monitor.assumeUnreachable()
    },

    /** Persist-then-send entry point for every operation (§6.2.12). */
    async enqueue({ type, payload, photos = [], display } = {}) {
      await ready()
      const current = getCtx()
      const info = await serverInfo()
      if (info && !info.features?.includes(REQUIRED_SERVER_FEATURE)) {
        throw new OutboxError('server_old', 'The server is too old to accept queued items')
      }
      const item = await store.enqueue({
        ctx: current, type, payload, photos, display, appVersion: appVersion(),
      })
      await changed()
      return item
    },

    /** Claims exactly these items and sends them now; resolves one `{id, outcome, json}` each. */
    async sendNow(itemIds) {
      await ready()
      const results = await replayer.sendNow(getCtx(), itemIds, owner)
      await changed()
      return results
    },

    async retry(id, options) {
      await ready()
      const item = await store.retry(id, options)
      await changed()
      return item
    },

    async editPending(id, patch) {
      await ready()
      const item = await store.editPending(id, patch)
      await changed()
      return item
    },

    async discard(id) {
      await ready()
      const removed = await store.discard(id, now())
      await changed()
      return removed
    },

    async discardAllForUser() {
      await ready()
      const count = await store.discardAllForUser(getCtx(), now())
      await changed()
      return count
    },

    /** One replay session (§6.2.6). `trigger`: `manual` bypasses Automatic-sync-off and probe backoff. */
    async syncNow(trigger = 'manual') {
      if (!enabled()) return { ran: false, skipped: 'disabled' }
      await ready()
      const result = await replayer.run({ ctx: getCtx(), trigger, autoSync })
      await changed()
      return result
    },

    async setAutoSync(value) {
      await ready()
      autoSync = Boolean(value)
      await store.setMeta('autoSync', autoSync)
      await changed()
    },

    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    /** Stable object identity until something changes (for `useSyncExternalStore`). */
    getSnapshot: () => snapshot,

    /** Usage/quota (when the browser reports it), persistence, and what the outbox holds. */
    async storageInfo() {
      await ready()
      const totals = await store.totals()
      let estimateInfo = null
      let persisted = null
      try {
        estimateInfo = estimate ? await estimate() : null
      } catch {
        estimateInfo = null
      }
      try {
        persisted = storageManager?.persisted ? await storageManager.persisted() : null
      } catch {
        persisted = null
      }
      return { ...totals, usage: estimateInfo?.usage ?? null, quota: estimateInfo?.quota ?? null, persisted }
    },
  }
}
