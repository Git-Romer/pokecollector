import { useEffect, useState } from 'react'
import { useOutbox } from './useOutbox'

const deviceOffline = () => globalThis.navigator?.onLine === false

/**
 * True when the offline banner applies: two failed probes (from the outbox snapshot) or the
 * device reports `navigator.onLine === false` (live, without waiting for a probe). Never true
 * while the queue is off.
 */
export function useOffline() {
  const { enabled, reachability } = useOutbox()
  const [offlineEvent, setOfflineEvent] = useState(deviceOffline)

  useEffect(() => {
    if (!enabled) return undefined
    const update = () => setOfflineEvent(deviceOffline())
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    update()
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [enabled])

  return enabled && (reachability.bannerVisible || offlineEvent)
}
