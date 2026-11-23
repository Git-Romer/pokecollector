import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { Check, X } from 'lucide-react'
import InstallHint from '../components/pwa/InstallHint'
import CollectionDownload from '../components/pwa/CollectionDownload'
import ServerSyncSettings from '../components/sync/ServerSyncSettings'
import { StorageSummary, SyncControls, SyncItemList } from '../components/sync/SyncSheet'
import { useSettings } from '../contexts/SettingsContext'
import { getCapabilities } from '../offline/capabilities'
import { probe } from '../offline/outbox/probe'
import { purgeAll } from '../offline/readCache'
import { useOutbox } from '../offline/useOutbox'
import { useAutomaticCollection } from '../offline/AutomaticCollectionProvider'
import { resetServiceWorker } from '../pwa/register'
import { retryMissingArtwork } from '../utils/artworkRetry'

function appVersion() {
  // eslint-disable-next-line no-undef
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
}

// Asks the active worker for its build id; null without a controller or after 1.5 s.
function readBuildId() {
  return new Promise(resolve => {
    const controller = globalThis.navigator?.serviceWorker?.controller
    if (!controller) {
      resolve(null)
      return
    }
    const timer = window.setTimeout(() => resolve(null), 1500)
    const onMessage = event => {
      if (event.data?.type !== 'VERSION') return
      window.clearTimeout(timer)
      navigator.serviceWorker.removeEventListener('message', onMessage)
      resolve(event.data.buildId || null)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    controller.postMessage({ type: 'GET_VERSION' })
  })
}

function Section({ title, children }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  )
}

function Capability({ label, ok }) {
  const { t } = useSettings()
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className={`inline-flex items-center gap-1 text-xs font-medium ${ok ? 'text-green' : 'text-text-muted'}`}>
        {ok ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}
        {ok ? t('pwa.supported') : t('pwa.unsupported')}
      </span>
    </li>
  )
}

export default function OfflineCenter() {
  const { t } = useSettings()
  const confirmDialog = useConfirmDialog()
  const mounted = useRef(false)
  const resetPending = useRef(false)
  const [resetting, setResetting] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const { enabled, outbox, reachability, otherAccountCount } = useOutbox()
  const automaticCollection = useAutomaticCollection()
  const [unavailable, setUnavailable] = useState(false)
  const [live, setLive] = useState(null)
  const [buildId, setBuildId] = useState(null)
  const capabilities = getCapabilities()

  const check = useCallback(() => probe().then(setLive), [])

  useEffect(() => {
    if (!outbox) return
    outbox.start().catch(() => setUnavailable(true))
  }, [outbox])

  useEffect(() => {
    check()
    const disconnected = () => setLive({ state: 'unreachable' })
    window.addEventListener('online', check)
    window.addEventListener('offline', disconnected)
    return () => {
      window.removeEventListener('online', check)
      window.removeEventListener('offline', disconnected)
    }
  }, [check])

  useEffect(() => { readBuildId().then(setBuildId) }, [])

  const state = live?.state || reachability.state
  const stateText = state === 'reachable' ? t('pwa.reachable') : state === 'captive' ? t('pwa.captive') : state === 'unknown' ? '…' : t('pwa.unreachable')
  const info = live?.serverInfo

  const reset = async () => {
    if (resetPending.current) return
    resetPending.current = true
    setResetting(true)
    try {
      const session = localStorage.getItem('token')
      if (!await confirmDialog({
        title: t('pwa.resetConfirmTitle'),
        message: t('pwa.resetConfirmMessage'),
        confirmLabel: t('pwa.resetConfirmAction'),
        destructive: true,
      })) return
      // A dialog from an old page or sign-in must not reset the current session.
      if (!mounted.current || session !== localStorage.getItem('token')) return
      await automaticCollection?.stop()
      await purgeAll()
      await resetServiceWorker()
      toast.success(t('pwa.resetDone'))
    } finally {
      resetPending.current = false
      if (mounted.current) setResetting(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-6" data-testid="offline-center">
      <h1 className="text-xl font-bold text-text-primary">{t('sync.centerTitle')}</h1>

      <Section title={t('pwa.connection')}>
        <p className="text-sm text-text-primary" data-testid="connection-state" data-state={state}>{stateText}</p>
        {info && (
          <p className="text-xs text-text-muted">
            {`${t('pwa.serverVersion')}: ${info.version ?? '–'} (API ${info.apiLevel})`}
          </p>
        )}
        {live && <p className="text-xs text-text-muted">{new Date().toLocaleTimeString()}</p>}
      </Section>

      <Section title={t('sync.artworkTitle')}>
        <p className="text-xs text-text-secondary">{t('sync.artworkRetryHint')}</p>
        <button type="button" className="btn-ghost text-sm" disabled={state !== 'reachable' || automaticCollection?.phase === 'downloading'}
          onClick={() => {
            retryMissingArtwork()
            void automaticCollection?.retry()
            toast.success(t('sync.artworkRetryRequested'))
          }}>
          {t('sync.artworkRetry')}
        </button>
      </Section>

      <CollectionDownload />

      {enabled && <Section title={t('sync.queueTitle')}>
        <p className="text-xs text-text-secondary">{t('sync.queueDescription')}</p>
        {unavailable ? (
          <p className="text-sm text-text-secondary">{t('sync.unavailableQueue')}</p>
        ) : (
          <>
            <SyncControls />
            <SyncItemList />
          </>
        )}
      </Section>}

      {enabled && <Section title={t('sync.storageTitle')}>
        {unavailable ? <p className="text-sm text-text-secondary">{t('sync.storageUnavailable')}</p> : <StorageSummary showTitle={false} />}
        {otherAccountCount > 0 && (
          <p className="text-xs text-text-muted">{`${t('sync.otherAccountsNote')}: ${otherAccountCount}`}</p>
        )}
      </Section>}

      <ServerSyncSettings />

      {enabled && <Section title={t('pwa.settingsTitle')}>
        <ul className="space-y-2">
          <Capability label={t('pwa.capSecureContext')} ok={capabilities.secureContext} />
          <Capability label={t('pwa.capServiceWorker')} ok={capabilities.serviceWorker && capabilities.secureContext} />
          <Capability label={t('pwa.capStorage')} ok={capabilities.indexedDB} />
          <Capability label={t('pwa.capInstalled')} ok={capabilities.standalone} />
          <Capability label={t('pwa.capPush')} ok={capabilities.push} />
        </ul>
        {!capabilities.secureContext && <p className="text-xs text-text-secondary">{t('pwa.httpsHint')}</p>}
        <InstallHint force />
      </Section>}

      {enabled && <Section title={t('pwa.resetTitle')}>
        <p className="text-xs text-text-secondary">{t('pwa.resetDescription')}</p>
        <button type="button" className="btn-ghost" disabled={resetting} onClick={reset}>{t('pwa.resetAction')}</button>
      </Section>}

      <p className="text-center text-xs text-text-muted">
        {`${t('pwa.version')}: ${appVersion() || '–'}${buildId ? ` · ${buildId}` : ''}`}
      </p>
    </div>
  )
}
