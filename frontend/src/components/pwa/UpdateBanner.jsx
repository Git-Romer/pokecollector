import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../../contexts/SettingsContext'
import { applyUpdate } from '../../pwa/register'
import { updateStore } from '../../pwa/updateStore'
import PokeBallLoader from '../PokeBallLoader'

const RELOAD_FALLBACK_MS = 15000

// Non-blocking bar shown when a new service worker is waiting. Nothing activates on its own.
// After Update is tapped it gives way to a full-screen notice until the page reloads.
// Both render into document.body: index.css gives every direct child of #root
// `position: relative`, which would otherwise override `fixed` and drop them to the end of the page.
export default function UpdateBanner() {
  const { t } = useSettings()
  const { registration, blocked } = useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot)
  const [updating, setUpdating] = useState(false)
  const [showReload, setShowReload] = useState(false)

  useEffect(() => {
    if (!updating) return undefined
    const timer = setTimeout(() => setShowReload(true), RELOAD_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [updating])

  if (!registration) return null

  const handleUpdate = () => {
    const result = applyUpdate(registration)
    updateStore.setBlocked(result.blocked)
    if (!result.blocked) setUpdating(true)
  }

  if (updating) {
    return createPortal(
      <div
        role="status"
        aria-live="polite"
        data-testid="update-overlay"
        className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-bg px-6 text-center text-text-primary"
      >
        <PokeBallLoader size={48} />
        <h1 className="mt-5 text-xl font-semibold">{t('pwa.updatingTitle')}</h1>
        <p className="mt-2 text-sm text-text-muted">{t('pwa.updatingMessage')}</p>
        {showReload && (
          <button type="button" onClick={() => window.location.reload()} className="btn-primary mt-6">
            {t('pwa.updatingReload')}
          </button>
        )}
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div
      role="status"
      data-testid="update-banner"
      className="fixed inset-x-0 top-0 z-[60] flex justify-center px-4"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
    >
      <div
        className="flex w-full max-w-md items-center gap-3 rounded-xl border border-border px-4 py-3 shadow-xl"
        style={{ backgroundColor: 'var(--color-card)' }}
      >
        <div className="min-w-0 flex-1 text-sm text-text-primary">
          <p>{t('pwa.updateAvailable')}</p>
          {blocked && <p className="text-xs text-text-muted">{t('pwa.updateBlocked')}</p>}
        </div>
        <button type="button" onClick={handleUpdate} className="btn-primary shrink-0">
          {t('pwa.updateNow')}
        </button>
      </div>
    </div>,
    document.body,
  )
}
