import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'

// Context lives here (not in OfflineProvider.jsx) so the hook works without importing the provider.
export const OutboxContext = createContext(null)

const EMPTY_SNAPSHOT = Object.freeze({
  items: [],
  counts: Object.freeze({ pending: 0, sending: 0, retryWait: 0, blocked: 0, failed: 0 }),
  reachability: Object.freeze({ state: 'unknown', consecutiveFailures: 0, bannerVisible: false }),
  engine: Object.freeze({ running: false, pausedUntil: 0 }),
  autoSync: true,
  otherAccountCount: 0,
})

const noopSubscribe = () => () => {}
const getEmptySnapshot = () => EMPTY_SNAPSHOT

/**
 * → `{enabled, outbox, ...snapshot}`. `enabled` is false (and the snapshot empty) when the
 * offline queue is off or IndexedDB is unavailable.
 */
export function useOutbox() {
  const outbox = useContext(OutboxContext)
  const snapshot = useSyncExternalStore(
    outbox ? outbox.subscribe : noopSubscribe,
    outbox ? outbox.getSnapshot : getEmptySnapshot,
  )
  return useMemo(() => ({ enabled: Boolean(outbox), outbox, ...snapshot }), [outbox, snapshot])
}
