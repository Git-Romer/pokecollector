import { CloudOff } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useOffline } from '../../offline/useOffline'

/** Strip at the top of the layout once the server has been unreachable twice or the device says offline. */
export default function OfflineBanner() {
  const { t } = useSettings()
  const offline = useOffline()

  if (!offline) return null

  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="flex items-start gap-2 pb-2 px-4 text-xs text-text-primary sm:text-sm"
      style={{
        paddingTop: 'max(0.5rem, env(safe-area-inset-top))',
        backgroundColor: 'color-mix(in srgb, var(--color-yellow) 18%, var(--color-bg))',
        borderBottom: '1px solid color-mix(in srgb, var(--color-yellow) 45%, transparent)',
      }}
    >
      <CloudOff size={16} className="mt-0.5 flex-shrink-0 text-yellow" aria-hidden />
      <p className="min-w-0 flex-1 break-words leading-snug">{t('sync.offlineBanner')} <span className="text-text-muted">{t('sync.artworkOfflineHint')}</span></p>
    </div>
  )
}
