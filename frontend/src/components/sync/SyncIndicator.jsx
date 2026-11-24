import { useEffect, useState } from 'react'
import { AlertTriangle, Clock3, CloudOff, Loader2, RefreshCw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useSettings } from '../../contexts/SettingsContext'
import { useOffline } from '../../offline/useOffline'
import { useOutbox } from '../../offline/useOutbox'


function describe(snapshot, offline, t) {
  const { items, counts, engine } = snapshot
  const attention = counts.failed + counts.blocked
  if (attention > 0) {
    return { kind: 'attention', Icon: AlertTriangle, count: attention, label: `${t('sync.attentionLabel')}: ${attention}`, tone: 'text-brand-red' }
  }
  if (counts.sending > 0 || (engine.running && items.length > 0)) {
    return { kind: 'syncing', Icon: Loader2, count: items.length, label: t('sync.syncingLabel'), tone: 'text-blue' }
  }
  if (offline) {
    const label = items.length > 0 ? `${t('sync.offlineShort')}: ${items.length}` : t('sync.offlineShort')
    return { kind: 'offline', Icon: CloudOff, count: items.length, label, tone: 'text-yellow' }
  }
  if (items.length > 0) {
    return { kind: 'waiting', Icon: Clock3, count: items.length, label: `${t('sync.waitingLabel')}: ${items.length}`, tone: 'text-text-secondary' }
  }
  return null
}

// One polite announcement per second at most, so a burst of state changes is read once.
function useDebounced(value, delay) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** Persistent Sync center entry, with pending/failed/offline status when available. */
export default function SyncIndicator({ belowNav = false }) {
  const { t } = useSettings()
  const navigate = useNavigate()
  const snapshot = useOutbox()
  const offline = useOffline()
  const state = (snapshot.enabled ? describe(snapshot, offline, t) : null) || {
    kind: 'idle', Icon: RefreshCw, count: 0, label: t('sync.centerTitle'), tone: 'text-text-secondary',
  }
  const announcement = useDebounced(state?.label ?? '', 1000)


  return (
    <>
      <span role="status" className="sr-only" data-testid="sync-live-region">{announcement}</span>
      {state && (
        <button
          type="button"
          data-testid="sync-indicator"
          data-state={state.kind}
          aria-label={state.label}
          title={t('sync.centerTitle')}
          onClick={() => navigate('/offline')}
          className={`fixed right-3 ${belowNav ? 'top-[calc(max(1.25rem,env(safe-area-inset-top))_+_2.75rem)]' : 'top-[max(0.5rem,env(safe-area-inset-top))]'} z-[45] inline-flex h-10 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium shadow-lg`}
        >
          <state.Icon
            size={16}
            className={`${state.tone} ${state.kind === 'syncing' ? 'motion-safe:animate-spin' : ''}`}
            aria-hidden
          />
          {state.count > 0 && (
            <span className="min-w-[1.25rem] rounded-full bg-elevated px-1.5 text-center text-text-primary">{state.count}</span>
          )}
        </button>
      )}

    </>
  )
}
