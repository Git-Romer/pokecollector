import { CloudOff } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSettings } from '../contexts/SettingsContext'

/** Stands in for a page that needs the server while the server is unreachable. */
export default function OfflineUnavailable() {
  const { t } = useSettings()

  return (
    <div data-testid="offline-unavailable" className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-16 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-elevated text-text-muted">
        <CloudOff size={26} aria-hidden />
      </span>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-text-primary">{t('sync.unavailableOffline')}</h1>
        <p className="text-sm text-text-secondary">{t('sync.needsConnection')}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Link to="/" className="btn-ghost">{t('sync.goHome')}</Link>
      </div>
    </div>
  )
}
