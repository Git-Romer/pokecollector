// Coalesced toasts for replay results (docs/PWA_OFFLINE_DESIGN.md §6.4.4): at most one
// "synced" summary per 60 s, one error toast per item that enters `failed`, none for retry_wait.

export const SYNCED_TOAST_INTERVAL_MS = 60000
export const LAST_SYNCED_KEY = 'pc.sync.lastSyncedAt'

/** Time of the last send this browser saw succeed (a per-viewer convenience), or `null`. */
export function readLastSynced(storage = globalThis.localStorage) {
  try {
    const value = Number(storage?.getItem(LAST_SYNCED_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** `getT()` returns the current `t` so a language change is picked up. */
export function createSyncReporter({ toast, getT, now = Date.now, storage = globalThis.localStorage }) {
  let lastSyncedToastAt = -Infinity

  return function report(result) {
    const outcomes = Array.isArray(result?.outcomes) ? result.outcomes : []
    const t = getT()
    if (outcomes.some(outcome => outcome.next === 'sent')) {
      try {
        storage?.setItem(LAST_SYNCED_KEY, String(now()))
      } catch {
        // storage can be unavailable
      }
      if (now() - lastSyncedToastAt >= SYNCED_TOAST_INTERVAL_MS) {
        lastSyncedToastAt = now()
        toast.success(t('sync.syncedToast'), { id: 'sync-synced' })
      }
    }
    for (const outcome of outcomes) {
      if (outcome.next === 'failed') toast.error(t('sync.failedToast'), { id: `sync-failed-${outcome.id}` })
    }
  }
}
