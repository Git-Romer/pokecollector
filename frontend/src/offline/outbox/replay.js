// Replay engine (docs/PWA_OFFLINE_DESIGN.md §6.2.6). Page-context only; raw
// `fetch` (not axios) so a 401 can never delete the token and so redirects and
// HTML answers are detectable.

import {
  CIRCUIT_BREAKER_THRESHOLD,
  CONSECUTIVE_NETWORK_ERRORS_LIMIT,
  PACE_MS,
  RATE_LIMIT_DEFAULT_PAUSE_MS,
  RATE_LIMIT_MAX_PAUSE_MS,
  REQUIRED_SERVER_FEATURE,
  PROBE_BACKOFF_MS,
  attemptTimeoutMs,
} from '../constants.js'
import { debugFlag } from '../debug.js'
import { classifyResponse } from './classify.js'
import { probe as defaultProbe } from './probe.js'

const PROXY_UNBLOCK_MIN_AGE_MS = PROBE_BACKOFF_MS[PROBE_BACKOFF_MS.length - 1]

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function readToken() {
  try {
    return globalThis.localStorage?.getItem('token') ?? null
  } catch {
    return null
  }
}

export function createReplayer({
  store,
  lease,
  ops,
  reachability,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = Date.now,
  sleep = defaultSleep,
  queryClient = null,
  getToken = readToken,
  probeImpl = defaultProbe,
  debug = debugFlag,
  origin = globalThis.location?.origin,
  notify = () => {},
  attemptTimeout = attemptTimeoutMs,
}) {
  const state = {
    running: false,
    pausedUntil: 0,
    consecutive429: 0,
    nextProbeAt: 0,
    stopped: false,
    lastSession: null,
  }

  function applyPause(outcome) {
    state.consecutive429 += 1
    const base = outcome.retryAfterMs ?? RATE_LIMIT_DEFAULT_PAUSE_MS
    const pause = Math.min(RATE_LIMIT_MAX_PAUSE_MS, base * 2 ** (state.consecutive429 - 1))
    state.pausedUntil = now() + pause
  }

  /** Steps 7–9 for one claimed item. Returns `{outcome, json, applied}`. */
  async function attempt(item, owner) {
    const op = ops[item.type]
    let outcome = null
    let json
    if (!op) {
      outcome = {
        next: 'failed', kind: 'local', code: 'unsupported_op', detailKey: 'unsupported_op',
        message: `This version of the app cannot send "${item.type}"`,
      }
    } else {
      let request = null
      try {
        request = await op.buildRequest(item, store.readPhotos)
      } catch (error) {
        outcome = {
          next: 'failed', kind: 'local', code: 'corrupted', detailKey: 'corrupted',
          message: error?.message || 'The stored item could not be read',
        }
      }
      if (request) {
        const headers = { ...(request.headers || {}) }
        const token = getToken()
        if (token) headers.Authorization = `Bearer ${token}`
        headers['Idempotency-Key'] = item.idempotencyKey
        headers['X-Expected-User-Id'] = String(item.userId)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), attemptTimeout(item))
        let response = null
        let error = null
        try {
          response = await fetchImpl(request.url, {
            method: request.method,
            headers,
            body: request.body,
            redirect: 'manual',
            cache: 'no-store',
            signal: controller.signal,
          })
          if (debug('forceLostResponse')) throw new TypeError('Response discarded (forceLostResponse)')
          if (/json/i.test(response.headers?.get?.('content-type') || '')) {
            json = await response.json().catch(() => undefined)
          }
        } catch (caught) {
          error = caught
          response = null
          json = undefined
        } finally {
          clearTimeout(timer)
        }
        outcome = classifyResponse(item.type, { error, response, json, now: now() })
      }
    }
    if (outcome.next === 'sent') outcome.summary = op.summarize(item)
    const result = await store.applyOutcome(item.id, owner, outcome, now())
    if (outcome.next === 'sent' && result.applied) {
      try {
        op.onSynced(queryClient, json)
      } catch {
        // a failing cache invalidation must never undo a successful send
      }
    }
    notify({ type: 'changed' })
    return { outcome, json, applied: result.applied }
  }

  async function run({ ctx, trigger = 'auto', autoSync = true } = {}) {
    // 1
    if (state.stopped) return skip('stopped')
    if (!ctx || ctx.userId === undefined || ctx.userId === null || !ctx.origin) return skip('no_user')
    if (state.running) return skip('running')
    if (!autoSync && trigger !== 'manual') return skip('auto_sync_off')
    if (state.pausedUntil > now()) return skip('paused')
    if (trigger !== 'manual' && now() < state.nextProbeAt) return skip('probe_backoff')

    state.running = true
    notify({ type: 'engine' })
    let acquired = false
    const summary = { ran: true, processed: 0, outcomes: [], circuitBreaker: null, stoppedBy: null }
    try {
      // 2
      acquired = await lease.acquire()
      if (!acquired) return skip('lease')
      // 3
      await store.recoverStaleClaims(lease.owner, now())
      if (trigger === 'login') await store.unblock(ctx, ['auth'], now())
      // 4
      const waiting = await store.peek(ctx, now())
      if (waiting.eligible === 0 && waiting.unblockable === 0) return skip('idle')
      // 5
      const probed = await probeImpl({ fetchImpl, now })
      reachability?.record(probed)
      if (probed.state !== 'reachable') {
        state.nextProbeAt = now() + (reachability ? reachability.nextDelayMs() : PROBE_BACKOFF_MS[0])
        notify({ type: 'unreachable', state: probed.state })
        return skip(probed.state)
      }
      state.nextProbeAt = 0
      await store.setMeta('serverInfo', probed.serverInfo)
      const info = probed.serverInfo
      if (!info.features.includes(REQUIRED_SERVER_FEATURE)) {
        await store.blockEligible(ctx, 'server_old', 'The server is too old to accept queued items', now())
        return skip('server_old')
      }
      await store.unblock(ctx, ['server_old'], now())
      await store.unblock(ctx, ['proxy'], now(), { minAgeMs: PROXY_UNBLOCK_MIN_AGE_MS })

      // 6–11
      let networkErrors = 0
      let streak = { key: null, count: 0 }
      while (!state.stopped) {
        const item = await store.claimNext(ctx, lease.owner, now(), { apiLevel: info.apiLevel })
        if (!item) break
        if (item.userId !== ctx.userId || item.serverOrigin !== origin) {
          await store.applyOutcome(item.id, lease.owner, {
            next: 'pending', kind: 'local', code: 'skipped', message: 'Belongs to another account or server',
          }, now())
          summary.stoppedBy = 'identity_mismatch'
          break
        }
        const { outcome } = await attempt(item, lease.owner)
        summary.processed += 1
        summary.outcomes.push({ id: item.id, next: outcome.next, code: outcome.code, rowId: outcome.rowId })

        // 10
        networkErrors = outcome.networkError ? networkErrors + 1 : 0
        if (outcome.next === 'failed') {
          const key = `${item.type}|${outcome.status}|${outcome.detailKey ?? outcome.message}`
          streak = streak.key === key ? { key, count: streak.count + 1 } : { key, count: 1 }
        } else {
          streak = { key: null, count: 0 }
        }
        if (outcome.next === 'sent') state.consecutive429 = 0

        if (outcome.rateLimited) {
          applyPause(outcome)
          summary.stoppedBy = 'rate_limited'
          break
        }
        if (networkErrors >= CONSECUTIVE_NETWORK_ERRORS_LIMIT) {
          reachability?.record({ state: 'unreachable' })
          state.nextProbeAt = now() + (reachability ? reachability.nextDelayMs() : PROBE_BACKOFF_MS[0])
          summary.stoppedBy = 'unreachable'
          break
        }
        if (outcome.next === 'blocked' && (outcome.code === 'auth' || outcome.code === 'proxy')) {
          summary.stoppedBy = `blocked_${outcome.code}`
          break
        }
        if (streak.count >= CIRCUIT_BREAKER_THRESHOLD) {
          summary.circuitBreaker = { type: item.type, status: outcome.status, message: outcome.message }
          summary.stoppedBy = 'circuit_breaker'
          break
        }

        // 11
        if (!(await lease.heartbeat())) {
          summary.stoppedBy = 'lease_lost'
          break
        }
        if ((await store.peek(ctx, now())).eligible === 0) break
        await sleep(PACE_MS)
      }
      state.lastSession = summary
      return summary
    } finally {
      // 12
      if (acquired) {
        try {
          await lease.release()
        } catch {
          // an unreleased lease simply expires
        }
      }
      state.running = false
      notify({ type: 'changed' })
    }
  }

  function skip(reason) {
    return { ran: false, skipped: reason }
  }

  /**
   * Persist-then-send: claims exactly `ids` and sends them now (no pacing, no lease,
   * no probe — a lost connection just leaves the item in `retry_wait`). One result per id.
   */
  async function sendNow(ctx, ids, owner) {
    const claimed = await store.claimByIds(ctx, ids, owner, now())
    const byId = new Map(claimed.map(item => [item.id, item]))
    const results = []
    for (const id of ids) {
      const item = byId.get(id)
      if (!item) {
        results.push({ id, outcome: 'skipped', json: undefined })
        continue
      }
      const { outcome, json } = await attempt(item, owner)
      if (outcome.rateLimited) applyPause(outcome)
      else if (outcome.next === 'sent') state.consecutive429 = 0
      results.push({ id, outcome: outcome.next, code: outcome.code, message: outcome.message, json })
    }
    return results
  }

  return {
    run,
    sendNow,
    stop() {
      state.stopped = true
    },
    resume() {
      state.stopped = false
    },
    getEngineState: () => ({ running: state.running, pausedUntil: state.pausedUntil, lastSession: state.lastSession }),
    /** Test and UI hook: ends a rate-limit pause early (manual Sync now does not bypass it). */
    clearPause() {
      state.pausedUntil = 0
      state.consecutive429 = 0
    },
  }
}
