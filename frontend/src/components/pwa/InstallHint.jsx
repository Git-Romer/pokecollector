import { useState } from 'react'
import { Share } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { isStandalone } from '../../offline/capabilities'
import { useOutbox } from '../../offline/useOutbox'

const DISMISS_KEY = 'pc.installHint.dismissed'

export function isIosDevice(nav = globalThis.navigator) {
  if (!nav) return false
  if (/iPhone|iPad|iPod/.test(nav.userAgent || '')) return true
  // iPadOS reports a Mac user agent but has a touch screen.
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1
}

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

/** "Add to Home Screen" card for iPhone/iPad Safari; `force` ignores the dismissal (the /offline page). */
export default function InstallHint({ force = false }) {
  const { t } = useSettings()
  const { enabled, items } = useOutbox()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (!enabled || isStandalone() || !isIosDevice() || (dismissed && !force)) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // dismissal just lasts until reload
    }
  }

  return (
    <aside data-testid="install-hint" className="mx-auto my-3 flex max-w-md items-start gap-3 rounded-xl border border-border bg-card p-4 text-sm">
      <Share size={18} className="mt-0.5 flex-shrink-0 text-blue" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium text-text-primary">{t('pwa.installTitle')}</p>
        <p className="text-text-secondary">{t('pwa.installSteps')}</p>
        {items.length > 0 && <p className="text-xs text-yellow">{t('sync.syncBeforeInstall')}</p>}
      </div>
      {!force && (
        <button type="button" className="btn-ghost-sm shrink-0" onClick={dismiss}>{t('pwa.installDismiss')}</button>
      )}
    </aside>
  )
}
