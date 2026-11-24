import { createContext, useContext } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Clock } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useOutbox } from '../../offline/useOutbox'

/** When the data restored from the read cache was saved (ms), or null. Provided by OfflineProvider. */
export const SavedAtContext = createContext(null)
export const useSavedAt = () => useContext(SavedAtContext)

/** "Showing saved data from …" above the page while the server is not reachable (D10). */
export default function StaleDataLabel() {
  const { t } = useSettings()
  const savedAt = useSavedAt()
  const { enabled, reachability } = useOutbox()

  if (!enabled || !savedAt || reachability.state === 'reachable') return null

  return (
    <p data-testid="stale-data-label" className="mb-3 flex items-center gap-1.5 text-xs text-text-muted">
      <Clock size={13} aria-hidden />
      {`${t('sync.staleData')} ${formatDistanceToNow(savedAt, { addSuffix: true })}`}
    </p>
  )
}
