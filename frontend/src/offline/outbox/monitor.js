// Reachability monitor (docs/PWA_OFFLINE_DESIGN.md §6.2.8). The replay engine only probes when
// something is queued, so with an empty outbox nothing would ever notice a dead connection on iOS
// (where `navigator.onLine` stays true in Airplane Mode). The monitor probes `/api/health` on its
// own, feeding the same `createReachability` instance: banner, outbox snapshot and TanStack's
// `onlineManager` stay in one place. While reachable it never polls.

import {
  MONITOR_CONFIRM_DELAY_MS,
  MONITOR_MAX_RETRY_MS,
  MONITOR_PROBE_TIMEOUT_MS,
} from '../constants.js'
import { onNetworkFailure } from '../networkFailure.js'

export function createReachabilityMonitor({
  reachability,
  probe,
  isEnabled = () => true,
  isReplayRunning = () => false,
  notify = () => {},
  target = globalThis.window,
  doc = globalThis.document,
  subscribeFailures = onNetworkFailure,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = id => globalThis.clearTimeout(id),
  now = Date.now,
  failureGapMs = 2000,
  timeoutMs = MONITOR_PROBE_TIMEOUT_MS,
  confirmDelayMs = MONITOR_CONFIRM_DELAY_MS,
  maxRetryMs = MONITOR_MAX_RETRY_MS,
} = {}) {
  let running = false
  let inFlight = null
  let timer = null
  let detach = []
  let lockTail = Promise.resolve()
  let lastProbeAt = 0

  function clearScheduled() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function schedule(ms) {
    clearScheduled()
    timer = setTimer(() => {
      timer = null
      check()
    }, ms)
  }

  /** Serialises every probe (monitor and replay) so two never run at the same moment. */
  function withLock(fn) {
    const result = lockTail.then(fn, fn)
    lockTail = result.catch(() => {})
    return result
  }

  async function check() {
    if (!running || !isEnabled()) return
    if (inFlight) return inFlight
    if (isReplayRunning()) {
      // the engine probes (and records) itself; look again shortly
      schedule(confirmDelayMs)
      return undefined
    }
    clearScheduled()
    inFlight = withLock(async () => {
      const result = await probe({ timeoutMs })
      if (!running) return
      const after = reachability.record(result)
      lastProbeAt = now()
      notify()
      if (result.state === 'reachable') return
      const failures = after.consecutiveFailures
      // The second failure confirms quickly; after that the §6.2.8 backoff applies (capped).
      schedule(failures < 2 ? confirmDelayMs : Math.min(reachability.nextDelayMs(), maxRetryMs))
    }).finally(() => { inFlight = null })
    return inFlight
  }

  const trigger = () => { check() }
  const onVisible = () => {
    if (!doc || doc.visibilityState === 'visible') check()
  }

  return {
    start() {
      if (running || !isEnabled()) return
      running = true
      target?.addEventListener?.('online', trigger)
      target?.addEventListener?.('offline', trigger)
      target?.addEventListener?.('focus', trigger)
      target?.addEventListener?.('pageshow', trigger)
      doc?.addEventListener?.('visibilitychange', onVisible)
      // A failed request is a hint, not proof: deduplicate bursts with a short gap.
      const unsubscribe = subscribeFailures?.(() => {
        if (now() - lastProbeAt >= failureGapMs) check()
      })
      detach = [
        () => target?.removeEventListener?.('online', trigger),
        () => target?.removeEventListener?.('offline', trigger),
        () => target?.removeEventListener?.('focus', trigger),
        () => target?.removeEventListener?.('pageshow', trigger),
        () => doc?.removeEventListener?.('visibilitychange', onVisible),
        () => unsubscribe?.(),
      ]
      check()
    },
    stop() {
      running = false
      clearScheduled()
      detach.forEach(fn => fn())
      detach = []
    },
    check,
    /**
     * The startup auth check already gave up (degraded mode): the server is proven unreachable,
     * so the banner shows at once; the probe that follows clears it if the server is back.
     */
    assumeUnreachable() {
      if (!running || !isEnabled() || reachability.snapshot().state === 'reachable') return
      reachability.record({ state: 'unreachable' })
      reachability.record({ state: 'unreachable' })
      notify()
      check()
    },
    /** Wrap the replay engine's probe so it never overlaps a monitor probe. */
    wrapProbe: probeImpl => (...args) => withLock(() => probeImpl(...args)),
  }
}
