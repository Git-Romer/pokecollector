import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { sendTestPush } from '../../api/client'
import { useSettings } from '../../contexts/SettingsContext'
import { readPwaFlags } from '../../pwa/flags'
import {
  disablePush, enablePush, getCurrentSubscription, isIosBrowserTab, pushPermission, pushSupported,
} from '../../pwa/push'

// Settings → Notifications. Hidden without HTTPS or without the opt-in service worker.
export default function NotificationsCard() {
  const { t } = useSettings()
  const visible = readPwaFlags().sw && (pushSupported() || isIosBrowserTab())
  const supported = pushSupported()
  const [subscribed, setSubscribed] = useState(false)
  const [permission, setPermission] = useState(() => pushPermission())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!visible || !supported) return undefined
    let cancelled = false
    getCurrentSubscription().then(subscription => {
      if (!cancelled) setSubscribed(Boolean(subscription))
    })
    return () => { cancelled = true }
  }, [visible, supported])

  if (!visible) return null

  const run = async action => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
      setPermission(pushPermission())
    }
  }

  const handleEnable = () => run(async () => {
    const result = await enablePush()
    if (result.ok) {
      setSubscribed(true)
      toast.success(t('pwa.pushEnabled'))
    } else if (result.reason !== 'denied') {
      toast.error(t('pwa.pushFailed'))
    }
  })

  const handleDisable = () => run(async () => {
    const result = await disablePush()
    if (result.ok) {
      setSubscribed(false)
      toast.success(t('pwa.pushDisabled'))
    } else {
      toast.error(t('pwa.pushFailed'))
    }
  })

  const handleTest = () => run(async () => {
    try {
      const result = await sendTestPush()
      if (result.sent > 0) toast.success(t('pwa.pushTestSent'))
      else toast.error(t('pwa.pushTestNone'))
    } catch {
      toast.error(t('pwa.pushFailed'))
    }
  })

  let hint = null
  if (!supported) hint = t('pwa.pushIosHint')
  else if (permission === 'denied') hint = t('pwa.pushDenied')

  return (
    <section className="space-y-1" data-testid="notifications-card">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted px-1 mb-3">
        {t('pwa.pushTitle')}
      </p>
      <div
        className="rounded-2xl overflow-hidden px-4 py-3.5 space-y-3"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        <p className="text-xs text-text-muted" style={{ overflowWrap: 'anywhere' }}>{t('pwa.pushDesc')}</p>
        {hint && <p className="text-xs text-text-secondary" role="status">{hint}</p>}
        {supported && permission !== 'denied' && (
          <div className="flex flex-wrap gap-2">
            {subscribed ? (
              <>
                <button type="button" className="btn-primary-sm" disabled={busy} onClick={handleTest}>
                  {t('pwa.pushTest')}
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={handleDisable}>
                  {t('pwa.pushDisable')}
                </button>
              </>
            ) : (
              <button type="button" className="btn-primary-sm" disabled={busy} onClick={handleEnable}>
                {t('pwa.pushEnable')}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
