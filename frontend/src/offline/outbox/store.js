// Outbox persistence (docs/PWA_OFFLINE_DESIGN.md §6.2.2–§6.2.5). Every write is a
// single IndexedDB transaction; every state change is a compare-and-set on
// `state` / `claim.owner`, so two tabs can never claim or finish the same item.

import {
  HISTORY_MAX,
  HISTORY_MAX_AGE_MS,
  ITEM_TYPES,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS_PER_ITEM,
  MAX_SERVER_ERRORS_PER_ITEM,
  OUTBOX_MAX_BYTES,
  OUTBOX_MAX_ITEMS,
  OUTBOX_MIN_FREE_BYTES,
  CLAIM_GRACE_MS,
  STALE_UNKNOWN_OUTCOME_MS,
  SUPPORTED_ITEM_SCHEMA,
  TARGET_ITEM_BYTES,
  attemptTimeoutMs,
} from '../constants.js'
import { debugFlag } from '../debug.js'
import { uuidv4 } from '../uuid.js'
import { nextDelayMs } from './backoff.js'
import { promisify, txDone } from './db.js'

export class OutboxError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'OutboxError'
    this.code = code
  }
}

const KNOWN_TYPES = new Set(Object.values(ITEM_TYPES))
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER

const isArrayBuffer = value => Object.prototype.toString.call(value) === '[object ArrayBuffer]'

function isQuotaError(error) {
  return error?.name === 'QuotaExceededError' || error?.code === 22
}

function toOutboxError(error) {
  if (error instanceof OutboxError) return error
  if (isQuotaError(error)) return new OutboxError('quota', 'Not enough storage to keep this item')
  return error
}

const clone = value => (value === undefined ? value : structuredClone(value))

export function createStore(db, {
  now: nowFn = Date.now,
  rng = Math.random,
  uuid = uuidv4,
  estimate = null,
  debug = debugFlag,
  keyRange = globalThis.IDBKeyRange,
} = {}) {
  let lastCreatedAt = 0

  const userRange = ctx => keyRange.bound(
    [ctx.origin, ctx.userId, 0],
    [ctx.origin, ctx.userId, MAX_TIMESTAMP],
  )

  async function allItems() {
    const tx = db.transaction('items', 'readonly')
    return promisify(tx.objectStore('items').getAll())
  }

  async function userItems(tx, ctx) {
    const rows = await promisify(tx.objectStore('items').index('by_user_created').getAll(userRange(ctx)))
    return rows.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Runs `fn(tx)` in one readwrite transaction over `stores`; aborts on any error. */
  async function write(stores, fn) {
    const tx = db.transaction(stores, 'readwrite')
    const done = txDone(tx)
    done.catch(() => {})
    try {
      const result = await fn(tx)
      await done
      return result
    } catch (error) {
      try {
        tx.abort()
      } catch {
        // already finished
      }
      throw error
    }
  }

  function deletePhotos(tx, itemId) {
    tx.objectStore('photos').delete(keyRange.bound([itemId, 0], [itemId, MAX_TIMESTAMP]))
  }

  function recordError(kind, fields, at) {
    return {
      kind,
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.code !== undefined ? { code: fields.code } : {}),
      message: fields.message || '',
      at,
    }
  }

  // ----- enqueue ---------------------------------------------------------------

  async function enqueue({
    ctx,
    type,
    payload,
    photos = [],
    display = null,
    appVersion = '',
    minApiLevel = 1,
  }) {
    if (!ctx || ctx.userId === undefined || ctx.userId === null || !ctx.origin) {
      throw new OutboxError('no_user', 'No signed-in user')
    }
    if (!KNOWN_TYPES.has(type)) throw new OutboxError('unsupported_op', `Unsupported operation: ${type}`)
    if (type === ITEM_TYPES.SCAN_UPLOAD ? photos.length < 1 : photos.length > 0) {
      throw new OutboxError('invalid', 'Photos are required for scan uploads and only allowed there')
    }
    if (photos.length > MAX_PHOTOS_PER_ITEM) {
      throw new OutboxError('too_many_photos', `At most ${MAX_PHOTOS_PER_ITEM} photos per item`)
    }
    let photoBytes = 0
    for (const photo of photos) {
      if (!isArrayBuffer(photo?.bytes)) throw new OutboxError('invalid', 'Photo bytes must be an ArrayBuffer')
      if (photo.bytes.byteLength > MAX_PHOTO_BYTES) throw new OutboxError('photo_too_large', 'Photo is too large')
      photoBytes += photo.bytes.byteLength
    }
    // A single large photo may exceed the 10 MiB item target; a group of photos may not.
    if (photos.length > 1 && photoBytes > TARGET_ITEM_BYTES) {
      throw new OutboxError('item_too_large', 'Photos in one item exceed the size limit')
    }

    if (debug('forceQuota')) throw new OutboxError('quota', 'Simulated storage quota error')

    const existing = await allItems()
    if (existing.length >= OUTBOX_MAX_ITEMS) throw new OutboxError('too_many_items', 'The offline queue is full')
    const usedBytes = existing.reduce((sum, item) => sum + (item.photoBytes || 0), 0)
    if (usedBytes + photoBytes > OUTBOX_MAX_BYTES) throw new OutboxError('quota', 'The offline queue is full')
    if (estimate) {
      let info = null
      try {
        info = await estimate()
      } catch {
        info = null
      }
      if (info && Number.isFinite(info.quota) && Number.isFinite(info.usage)
        && info.quota - info.usage < photoBytes + OUTBOX_MIN_FREE_BYTES) {
        throw new OutboxError('quota', 'Not enough free storage')
      }
    }

    const at = nowFn()
    lastCreatedAt = Math.max(at, lastCreatedAt + 1)
    const item = {
      id: uuid(),
      schema: SUPPORTED_ITEM_SCHEMA,
      idempotencyKey: uuid(),
      serverOrigin: ctx.origin,
      userId: ctx.userId,
      type,
      payload: clone(payload ?? {}),
      photoCount: photos.length,
      photoBytes,
      state: 'pending',
      createdAt: lastCreatedAt,
      updatedAt: at,
      attempts: 0,
      retryCount: 0,
      serverErrorCount: 0,
      firstSentAt: null,
      lastAttemptAt: null,
      nextAttemptAt: 0,
      maybeApplied: false,
      claim: null,
      lastError: null,
      display: { title: '', subtitle: '', imageUrl: null, ...(display || {}) },
      appVersion,
      minApiLevel,
    }

    try {
      await write(['items', 'photos'], tx => {
        tx.objectStore('items').put(item)
        const photoStore = tx.objectStore('photos')
        photos.forEach((photo, index) => {
          photoStore.put({
            itemId: item.id,
            index,
            name: String(photo.name || `photo-${index + 1}`),
            type: String(photo.type || ''),
            size: photo.bytes.byteLength,
            bytes: photo.bytes,
          })
        })
      })
    } catch (error) {
      throw toOutboxError(error)
    }
    return item
  }

  // ----- reads -----------------------------------------------------------------

  async function listItems(ctx) {
    const tx = db.transaction('items', 'readonly')
    return userItems(tx, ctx)
  }

  async function getItem(id) {
    const tx = db.transaction('items', 'readonly')
    return (await promisify(tx.objectStore('items').get(id))) || null
  }

  /** Items of other accounts / servers on this device (the UI only shows a count). */
  async function countOthers(ctx) {
    const items = await allItems()
    return items.filter(item => item.userId !== ctx.userId || item.serverOrigin !== ctx.origin).length
  }

  async function totals() {
    const items = await allItems()
    return {
      items: items.length,
      photoBytes: items.reduce((sum, item) => sum + (item.photoBytes || 0), 0),
      oldestCreatedAt: items.reduce((min, item) => Math.min(min, item.createdAt), Infinity),
    }
  }

  /** Photos of one item, one `ArrayBuffer` in memory at a time (own transaction per read). */
  async function* readPhotos(id) {
    const item = await getItem(id)
    const count = item ? item.photoCount : 0
    for (let index = 0; index < count; index += 1) {
      const tx = db.transaction('photos', 'readonly')
      const photo = await promisify(tx.objectStore('photos').get([id, index]))
      if (!photo) throw new OutboxError('photo_missing', `Photo ${index} of item ${id} is missing`)
      yield photo
    }
  }

  // ----- claiming ----------------------------------------------------------------

  function claimable(item, nowMs, apiLevel) {
    if (item.state !== 'pending' && item.state !== 'retry_wait') return false
    if (item.nextAttemptAt > nowMs) return false
    if (apiLevel !== undefined && apiLevel !== null && item.minApiLevel > apiLevel) return false
    return true
  }

  /**
   * Oldest eligible item of `ctx`, claimed for `owner` (state `sending`). Items that can
   * never be sent by this build are settled on the way (#13 newer schema, stale unknown outcome).
   */
  async function claimNext(ctx, owner, nowMs = nowFn(), { apiLevel } = {}) {
    return write('items', async tx => {
      const store = tx.objectStore('items')
      for (const item of await userItems(tx, ctx)) {
        if (item.schema > SUPPORTED_ITEM_SCHEMA) {
          if (item.state !== 'blocked' || item.lastError?.code !== 'newer_schema') {
            store.put({
              ...item,
              state: 'blocked',
              claim: null,
              lastError: recordError('local', { code: 'newer_schema', message: 'Created by a newer version of the app' }, nowMs),
              updatedAt: nowMs,
            })
          }
          continue
        }
        if (!claimable(item, nowMs, apiLevel)) continue
        if (item.maybeApplied && item.firstSentAt && nowMs - item.firstSentAt > STALE_UNKNOWN_OUTCOME_MS) {
          store.put({
            ...item,
            state: 'failed',
            claim: null,
            lastError: recordError('local', {
              code: 'outcome_unknown_stale',
              message: 'May already be applied — verify, then Retry or Discard',
            }, nowMs),
            updatedAt: nowMs,
          })
          continue
        }
        const claimed = {
          ...item,
          state: 'sending',
          claim: { owner, expiresAt: nowMs + attemptTimeoutMs(item) + CLAIM_GRACE_MS },
          attempts: item.attempts + 1,
          lastAttemptAt: nowMs,
          firstSentAt: item.firstSentAt ?? nowMs,
          updatedAt: nowMs,
        }
        store.put(claimed)
        return claimed
      }
      return null
    })
  }

  /** Claims exactly these ids (persist-then-send); explicit, so `nextAttemptAt` is ignored. */
  async function claimByIds(ctx, ids, owner, nowMs = nowFn()) {
    return write('items', async tx => {
      const store = tx.objectStore('items')
      const claimed = []
      for (const id of ids) {
        const item = await promisify(store.get(id))
        if (!item || item.userId !== ctx.userId || item.serverOrigin !== ctx.origin) continue
        if (item.schema > SUPPORTED_ITEM_SCHEMA) continue
        if (item.state !== 'pending' && item.state !== 'retry_wait') continue
        const next = {
          ...item,
          state: 'sending',
          claim: { owner, expiresAt: nowMs + attemptTimeoutMs(item) + CLAIM_GRACE_MS },
          attempts: item.attempts + 1,
          lastAttemptAt: nowMs,
          firstSentAt: item.firstSentAt ?? nowMs,
          updatedAt: nowMs,
        }
        store.put(next)
        claimed.push(next)
      }
      return claimed
    })
  }

  /** Counts what a replay session could do now (without claiming). */
  async function peek(ctx, nowMs = nowFn()) {
    const tx = db.transaction('items', 'readonly')
    const items = await userItems(tx, ctx)
    return {
      eligible: items.filter(item => item.schema <= SUPPORTED_ITEM_SCHEMA && claimable(item, nowMs)).length,
      unblockable: items.filter(item => item.state === 'blocked'
        && (item.lastError?.code === 'proxy' || item.lastError?.code === 'server_old')).length,
    }
  }

  // ----- outcomes ----------------------------------------------------------------

  /**
   * Applies a classification outcome (see classify.js) to a `sending` item, only if
   * `claim.owner` still matches. Returns `{applied, state, item}`; `applied:false`
   * means someone else changed the item and nothing was written.
   */
  async function applyOutcome(id, owner, result, nowMs = nowFn()) {
    return write(['items', 'photos', 'history'], async tx => {
      const items = tx.objectStore('items')
      const item = await promisify(items.get(id))
      if (!item || item.state !== 'sending' || item.claim?.owner !== owner) {
        return { applied: false, state: item?.state ?? null, item: item || null }
      }

      if (result.next === 'sent') {
        items.delete(id)
        deletePhotos(tx, id)
        tx.objectStore('history').put({
          id: item.id,
          type: item.type,
          summary: result.summary || item.display?.title || item.type,
          completedAt: nowMs,
        })
        return { applied: true, state: 'sent', item }
      }

      const next = { ...item, claim: null, updatedAt: nowMs }
      let target = result
      next.serverErrorCount = result.serverError ? item.serverErrorCount + 1 : 0
      if (result.serverError && next.serverErrorCount >= MAX_SERVER_ERRORS_PER_ITEM) {
        target = {
          ...result,
          next: 'failed',
          code: 'server_errors',
          message: 'The server kept returning errors for this item',
        }
      }
      if (result.maybeApplied === true) next.maybeApplied = true
      next.lastError = recordError(target.kind || 'http', target, nowMs)

      if (target.next === 'retry_wait') {
        next.state = 'retry_wait'
        if (target.penalty === false) {
          next.nextAttemptAt = nowMs + (target.delayMs ?? 0)
        } else {
          next.retryCount = item.retryCount + 1
          next.nextAttemptAt = nowMs + (target.delayMs ?? nextDelayMs(next.retryCount, rng))
        }
      } else if (target.next === 'pending') {
        next.state = 'pending' // rate limited: not penalised, the engine pauses instead
      } else if (target.next === 'blocked') {
        next.state = 'blocked'
      } else {
        next.state = 'failed'
      }
      items.put(next)
      return { applied: true, state: next.state, item: next }
    })
  }

  /** Transition #7: a `sending` item whose claim expired (the app was killed mid-request). */
  async function recoverStaleClaims(owner, nowMs = nowFn()) {
    return write('items', async tx => {
      const store = tx.objectStore('items')
      let recovered = 0
      for (const item of await promisify(store.getAll())) {
        if (item.state === 'sending' && (!item.claim || item.claim.expiresAt <= nowMs)) {
          store.put({ ...item, state: 'retry_wait', maybeApplied: true, claim: null, nextAttemptAt: nowMs, updatedAt: nowMs })
          recovered += 1
        }
      }
      return recovered
    })
  }

  /** Marks every eligible item of `ctx` blocked with `code` (e.g. `server_old`). */
  async function blockEligible(ctx, code, message, nowMs = nowFn()) {
    return write('items', async tx => {
      const store = tx.objectStore('items')
      let count = 0
      for (const item of await userItems(tx, ctx)) {
        if (item.state === 'pending' || item.state === 'retry_wait') {
          store.put({ ...item, state: 'blocked', claim: null, lastError: recordError('http', { code, message }, nowMs), updatedAt: nowMs })
          count += 1
        }
      }
      return count
    })
  }

  /** Transition #8 (automatic part): `blocked(code)` → `pending`. */
  async function unblock(ctx, codes, nowMs = nowFn(), { minAgeMs = 0 } = {}) {
    return write('items', async tx => {
      const store = tx.objectStore('items')
      let count = 0
      for (const item of await userItems(tx, ctx)) {
        if (item.state === 'blocked' && codes.includes(item.lastError?.code) && nowMs - item.updatedAt >= minAgeMs) {
          store.put({ ...item, state: 'pending', claim: null, nextAttemptAt: 0, updatedAt: nowMs })
          count += 1
        }
      }
      return count
    })
  }

  // ----- user actions ------------------------------------------------------------

  /**
   * #9 / #8: `failed` or `blocked` → `pending`. The key is unchanged (failures leave no
   * server row) unless `rotateKey` is set after the "may already be applied" confirmation;
   * an item whose outcome went stale can only be retried with a rotated key.
   */
  async function retry(id, { rotateKey = false, now: nowMs = nowFn() } = {}) {
    return write('items', async tx => {
      const store = tx.objectStore('items')
      const item = await promisify(store.get(id))
      if (!item) throw new OutboxError('not_found')
      if (item.state !== 'failed' && item.state !== 'blocked') throw new OutboxError('bad_state', `Cannot retry from ${item.state}`)
      if (item.schema > SUPPORTED_ITEM_SCHEMA) throw new OutboxError('newer_schema', 'Created by a newer version of the app')
      const stale = item.lastError?.code === 'outcome_unknown_stale'
      if (stale && !rotateKey) throw new OutboxError('confirm_required', 'Rotating the key needs explicit confirmation')
      if (rotateKey && !(item.maybeApplied && item.firstSentAt && nowMs - item.firstSentAt > STALE_UNKNOWN_OUTCOME_MS)) {
        throw new OutboxError('rotate_not_allowed', 'The key can only be rotated for a stale unknown outcome')
      }
      const next = {
        ...item,
        state: 'pending',
        claim: null,
        nextAttemptAt: 0,
        retryCount: 0,
        serverErrorCount: 0,
        updatedAt: nowMs,
        ...(rotateKey ? { idempotencyKey: uuid(), maybeApplied: false, firstSentAt: null, attempts: 0, lastError: null } : {}),
      }
      store.put(next)
      return next
    })
  }

  /**
   * #12 (`pending`, key unchanged) and #10 (`failed` and never possibly applied: key
   * regenerated, counters reset). Add types only.
   */
  async function editPending(id, { payload, display, now: nowMs = nowFn() } = {}) {
    return write('items', async tx => {
      const store = tx.objectStore('items')
      const item = await promisify(store.get(id))
      if (!item) throw new OutboxError('not_found')
      if (item.type !== ITEM_TYPES.COLLECTION_ADD && item.type !== ITEM_TYPES.WISHLIST_ADD) {
        throw new OutboxError('not_editable', 'This item cannot be edited')
      }
      const next = { ...item, updatedAt: nowMs }
      if (item.state === 'pending') {
        // key unchanged
      } else if (item.state === 'failed' && !item.maybeApplied) {
        Object.assign(next, {
          state: 'pending',
          idempotencyKey: uuid(),
          retryCount: 0,
          serverErrorCount: 0,
          attempts: 0,
          firstSentAt: null,
          nextAttemptAt: 0,
          lastError: null,
          claim: null,
        })
      } else {
        throw new OutboxError('bad_state', `Cannot edit from ${item.state}`)
      }
      if (payload !== undefined) next.payload = clone(payload)
      if (display !== undefined) next.display = { ...item.display, ...display }
      store.put(next)
      return next
    })
  }

  /** #11: delete item + photos; refused while a live claim is sending it. */
  async function discard(id, nowMs = nowFn()) {
    return write(['items', 'photos'], async tx => {
      const store = tx.objectStore('items')
      const item = await promisify(store.get(id))
      if (!item) return false
      if (item.state === 'sending' && item.claim && item.claim.expiresAt > nowMs) {
        throw new OutboxError('in_flight', 'This item is being sent right now')
      }
      store.delete(id)
      deletePhotos(tx, id)
      return true
    })
  }

  /** Deletes all of this user's items on this origin, except ones being sent right now. */
  async function discardAllForUser(ctx, nowMs = nowFn()) {
    return write(['items', 'photos'], async tx => {
      const store = tx.objectStore('items')
      let count = 0
      for (const item of await userItems(tx, ctx)) {
        if (item.state === 'sending' && item.claim && item.claim.expiresAt > nowMs) continue
        store.delete(item.id)
        deletePhotos(tx, item.id)
        count += 1
      }
      return count
    })
  }

  // ----- history and meta -------------------------------------------------------

  async function addHistory(entry) {
    return write('history', tx => { tx.objectStore('history').put(entry) })
  }

  async function listHistory() {
    const tx = db.transaction('history', 'readonly')
    const rows = await promisify(tx.objectStore('history').getAll())
    return rows.sort((a, b) => b.completedAt - a.completedAt)
  }

  /** Keeps the newest `HISTORY_MAX` rows no older than `HISTORY_MAX_AGE_MS`. */
  async function trimHistory(nowMs = nowFn()) {
    return write('history', async tx => {
      const store = tx.objectStore('history')
      const rows = (await promisify(store.getAll())).sort((a, b) => b.completedAt - a.completedAt)
      let removed = 0
      rows.forEach((row, index) => {
        if (index >= HISTORY_MAX || nowMs - row.completedAt > HISTORY_MAX_AGE_MS) {
          store.delete(row.id)
          removed += 1
        }
      })
      return removed
    })
  }

  async function getMeta(key) {
    const tx = db.transaction('meta', 'readonly')
    const row = await promisify(tx.objectStore('meta').get(key))
    return row ? row.value : undefined
  }

  async function setMeta(key, value) {
    return write('meta', tx => { tx.objectStore('meta').put({ key, value }) })
  }

  async function deleteMeta(key) {
    return write('meta', tx => { tx.objectStore('meta').delete(key) })
  }

  return {
    enqueue,
    listItems,
    getItem,
    countOthers,
    totals,
    readPhotos,
    claimNext,
    claimByIds,
    peek,
    applyOutcome,
    recoverStaleClaims,
    blockEligible,
    unblock,
    retry,
    editPending,
    discard,
    discardAllForUser,
    addHistory,
    listHistory,
    trimHistory,
    getMeta,
    setMeta,
    deleteMeta,
  }
}
