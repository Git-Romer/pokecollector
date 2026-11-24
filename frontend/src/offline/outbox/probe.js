// Reachability probe (docs/PWA_OFFLINE_DESIGN.md §6.2.8). `navigator.onLine` is
// only a hint; the only proof of reachability is a valid `/api/health` answer.

import {
  BANNER_AFTER_FAILED_PROBES,
  PROBE_BACKOFF_MS,
  PROBE_TIMEOUT_MS,
} from '../constants.js'
import { debugFlag } from '../debug.js'

export const SERVICE_NAME = 'pokemon-tcg-collection'

/**
 * → `{state: 'reachable'|'unreachable'|'captive', serverInfo?}`. No `Authorization`
 * header. 200 + JSON + `{status:'ok', service}` is reachable; a rejected request,
 * a timeout or a 5xx is unreachable; anything else that answered (HTML login page,
 * other JSON, opaque redirect, other status) is captive.
 */
export async function probe({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = Date.now,
  timeoutMs = PROBE_TIMEOUT_MS,
  debug = debugFlag,
  url = '/api/health',
} = {}) {
  if (debug('forceUnreachable')) return { state: 'unreachable' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.type === 'opaqueredirect') return { state: 'captive' }
    if (response.status >= 500) return { state: 'unreachable' }
    if (response.status !== 200) return { state: 'captive' }
    if (!/json/i.test(response.headers?.get?.('content-type') || '')) return { state: 'captive' }
    const body = await response.json()
    if (!body || body.status !== 'ok' || body.service !== SERVICE_NAME) return { state: 'captive' }
    return {
      state: 'reachable',
      serverInfo: {
        version: body.version ?? null,
        apiLevel: Number.isFinite(body.api_level) ? body.api_level : 0,
        features: Array.isArray(body.features) ? body.features : [],
        fetchedAt: now(),
      },
    }
  } catch {
    return { state: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Tracks consecutive probe results: the offline banner shows after two non-reachable
 * results (or `navigator.onLine === false`) and clears on the first reachable one;
 * `nextDelayMs()` walks `PROBE_BACKOFF_MS` (stretched when `onLine === false`, never
 * trusted as proof of reachability). `onlineManager` (TanStack) is told the real state.
 */
export function createReachability({ onlineManager = null, isOnLine = () => globalThis.navigator?.onLine !== false } = {}) {
  let state = 'unknown'
  let failures = 0
  let step = 0

  function record(result) {
    state = result.state
    if (result.state === 'reachable') {
      failures = 0
      step = 0
    } else {
      failures += 1
      step = Math.min(step + 1, PROBE_BACKOFF_MS.length)
    }
    onlineManager?.setOnline?.(state === 'reachable')
    return snapshot()
  }

  function snapshot() {
    return {
      state,
      consecutiveFailures: failures,
      bannerVisible: failures >= BANNER_AFTER_FAILED_PROBES || !isOnLine(),
    }
  }

  return {
    record,
    snapshot,
    /** Delay before the next probe after the results recorded so far. */
    nextDelayMs() {
      const base = PROBE_BACKOFF_MS[Math.max(0, Math.min(step - 1, PROBE_BACKOFF_MS.length - 1))]
      return isOnLine() ? base : Math.max(base, PROBE_BACKOFF_MS[PROBE_BACKOFF_MS.length - 1])
    },
  }
}
