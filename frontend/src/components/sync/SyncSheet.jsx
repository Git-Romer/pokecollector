import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, Camera, Clock3, Heart, Loader2, PlusCircle, RefreshCw, ShieldCheck,
} from 'lucide-react'
import toast from 'react-hot-toast'
import ConfirmDialog from '../ui/ConfirmDialog'
import { useSettings } from '../../contexts/SettingsContext'
import { useOutbox } from '../../offline/useOutbox'
import { isStandalone } from '../../offline/capabilities'
import { ageWarning } from '../../offline/durability'
import { readLastSynced } from '../../offline/syncToasts'

const MIB = 1024 * 1024

export const megabytes = bytes => ((Number(bytes) || 0) / MIB).toFixed(1)

const formatSize = bytes => (bytes >= 1024 * MIB ? `${(bytes / (1024 * MIB)).toFixed(1)} GB` : `${megabytes(bytes)} MB`)

export function formatAge(timestamp, language, now = Date.now()) {
  const seconds = Math.round((timestamp - now) / 1000)
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]]
  let formatter
  try {
    formatter = new Intl.RelativeTimeFormat(language || 'en', { numeric: 'auto' })
  } catch {
    formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  }
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit)
  }
  return formatter.format(0, 'second')
}

const TYPE_ICONS = { 'scan.upload': Camera, 'collection.add': PlusCircle, 'wishlist.add': Heart }

function itemSummary(item, t) {
  if (item.type === 'scan.upload') {
    const photos = `${item.photoCount} ${t('sync.item.photos')}`
    return `${t('sync.item.scan')} · ${photos}`
  }
  const label = item.type === 'wishlist.add' ? t('sync.item.wishlistAdd') : t('sync.item.collectionAdd')
  return item.display?.title ? `${label} · ${item.display.title}` : label
}

function stateChip(item, t) {
  switch (item.state) {
    case 'sending': return { Icon: Loader2, text: t('sync.state.sending'), tone: 'text-blue', spin: true }
    case 'retry_wait': return { Icon: Clock3, text: t('sync.state.retry'), tone: 'text-yellow' }
    case 'blocked': return { Icon: AlertTriangle, text: t('sync.state.blocked'), tone: 'text-yellow' }
    case 'failed': return { Icon: AlertTriangle, text: t('sync.state.failed'), tone: 'text-brand-red' }
    default: return { Icon: Clock3, text: t('sync.state.pending'), tone: 'text-text-muted' }
  }
}

function itemProblem(item, t) {
  const code = item.lastError?.code
  if (item.state === 'blocked') {
    if (code === 'proxy') return t('sync.blockedProxy')
    if (code === 'wrong_account') return t('sync.wrongAccount')
    if (code === 'server_old') return t('sync.serverTooOld')
    if (code === 'newer_schema') return t('sync.newerVersion')
    return t('sync.blockedAuth')
  }
  if (item.state === 'failed') {
    if (code === 'corrupted') return t('sync.corrupted')
    return item.lastError?.message || ''
  }
  return ''
}

/** Sync now, Automatic sync, waiting size and last-synced line. */
export function SyncControls() {
  const { t } = useSettings()
  const { outbox, items, engine, autoSync } = useOutbox()
  const [busy, setBusy] = useState(false)
  const waitingBytes = items.reduce((sum, item) => sum + (item.photoBytes || 0), 0)
  const lastSynced = readLastSynced()
  const running = busy || engine.running

  const syncNow = async () => {
    if (running) return
    setBusy(true)
    try {
      await outbox.syncNow('manual')
    } catch {
      // the item list shows what is left
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* aria-disabled, not disabled: a disabled button would drop keyboard focus out of the dialog */}
        <button type="button" className={`btn-primary ${running ? 'opacity-60' : ''}`} aria-disabled={running} onClick={syncNow}>
          {running ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden /> : <RefreshCw size={15} aria-hidden />}
          {t('sync.syncNow')}
        </button>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            role="switch"
            checked={autoSync}
            onChange={event => outbox.setAutoSync(event.target.checked).catch(() => {})}
            className="h-4 w-4 accent-brand-red"
          />
          {t('sync.autoSync')}
        </label>
      </div>
      {!autoSync && <p className="text-xs text-yellow">{t('sync.autoSyncPaused')}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>{`${t('sync.waitingSize')}: ${megabytes(waitingBytes)} MB`}</span>
        <span>
          {`${t('sync.lastSynced')}: `}
          {lastSynced ? new Date(lastSynced).toLocaleString() : t('sync.never')}
        </span>
      </div>
    </div>
  )
}

/** Items of the signed-in account, each with Retry / Discard. */
export function SyncItemList() {
  const { t, language } = useSettings()
  const { outbox, items } = useOutbox()
  const [discarding, setDiscarding] = useState(null)
  const [confirmRetry, setConfirmRetry] = useState(null)

  const fail = error => toast.error(error?.message || t('sync.failedToast'))

  const retry = async (item, options) => {
    try {
      await outbox.retry(item.id, options)
    } catch (error) {
      if (error?.code === 'confirm_required') setConfirmRetry(item)
      else fail(error)
    }
  }

  const discard = async () => {
    const target = discarding
    setDiscarding(null)
    try {
      await outbox.discard(target.id)
    } catch (error) {
      fail(error)
    }
  }

  if (items.length === 0) return <p className="text-sm text-text-secondary">{t('sync.empty')}</p>

  return (
    <>
      <ul className="divide-y divide-border" data-testid="sync-items">
        {items.map(item => {
          const Icon = TYPE_ICONS[item.type] || Clock3
          const chip = stateChip(item, t)
          const problem = itemProblem(item, t)
          const canRetry = (item.state === 'failed' && item.lastError?.code !== 'corrupted')
            || (item.state === 'blocked' && item.lastError?.code !== 'newer_schema')
          return (
            <li key={item.id} data-testid="sync-item" data-state={item.state} className="space-y-2 py-3">
              <div className="flex items-start gap-3">
                <Icon size={18} className="mt-0.5 flex-shrink-0 text-text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{itemSummary(item, t)}</p>
                  <p className="text-xs text-text-muted">{`${t('sync.item.captured')} ${formatAge(item.createdAt, language)}`}</p>
                </div>
                <span className={`inline-flex flex-shrink-0 items-center gap-1 text-xs font-medium ${chip.tone}`}>
                  <chip.Icon size={13} className={chip.spin ? 'motion-safe:animate-spin' : ''} aria-hidden />
                  {chip.text}
                </span>
              </div>
              {problem && <p className="pl-8 text-xs text-text-secondary">{problem}</p>}
              {item.maybeApplied && (item.state === 'failed' || item.state === 'blocked') && (
                <p className="pl-8 text-xs text-yellow">{t('sync.maybeApplied')}</p>
              )}
              {(canRetry || item.state !== 'sending') && (
                <div className="flex gap-2 pl-8">
                  {canRetry && (
                    <button type="button" className="btn-ghost-sm" onClick={() => retry(item)}>{t('sync.retry')}</button>
                  )}
                  {item.state !== 'sending' && (
                    <button
                      type="button"
                      className="btn-ghost-sm text-brand-red"
                      onClick={() => setDiscarding(item)}
                    >
                      {t('sync.discard')}
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <ConfirmDialog
        isOpen={Boolean(discarding)}
        onClose={() => setDiscarding(null)}
        onConfirm={discard}
        title={t('sync.discard')}
        message={t('sync.discardConfirm')}
        confirmLabel={t('sync.discard')}
        cancelLabel={t('common.cancel')}
        destructive
      />
      <ConfirmDialog
        isOpen={Boolean(confirmRetry)}
        onClose={() => setConfirmRetry(null)}
        onConfirm={() => {
          const target = confirmRetry
          setConfirmRetry(null)
          retry(target, { rotateKey: true })
        }}
        title={t('sync.retry')}
        message={t('sync.maybeApplied')}
        confirmLabel={t('sync.retry')}
        cancelLabel={t('common.cancel')}
      />
    </>
  )
}

/** Storage usage, persistence state and the honest "only copy" wording (D12). */
export function StorageSummary({ showSafari = true, showTitle = true }) {
  const { t } = useSettings()
  const { outbox, items } = useOutbox()
  const [info, setInfo] = useState(null)
  const standalone = isStandalone()
  const oldest = items.reduce((min, item) => Math.min(min, item.createdAt), Infinity)
  const warning = ageWarning(oldest, standalone)

  const load = useCallback(() => {
    outbox?.storageInfo().then(setInfo).catch(() => setInfo(null))
  }, [outbox])
  useEffect(() => { load() }, [load, items.length])

  const known = info && (info.usage !== null || info.persisted !== null)
  return (
    <div className="space-y-2 text-xs text-text-secondary">
      {showTitle && <p className="text-sm font-medium text-text-primary">{t('sync.storageTitle')}</p>}
      {info && <p>{`${t('sync.storageUsed')}: ${megabytes(info.photoBytes)} MB`}</p>}
      {known ? (
        <>
          {info.usage !== null && (
            <p>{`${t('sync.storageTotalUsed')}: ${formatSize(info.usage)}`}</p>
          )}
          {info.quota != null && (
            <>
              <p>{`${t('sync.storageQuota')}: ${formatSize(info.quota)}`}</p>
              <p className="text-text-muted">{t('sync.storageQuotaHint')}</p>
            </>
          )}
          {info.persisted !== null && (
            <p className="flex items-center gap-1.5">
              <ShieldCheck size={13} className={info.persisted ? 'text-green' : 'text-yellow'} aria-hidden />
              {info.persisted ? t('sync.storagePersistent') : t('sync.storageNotPersistent')}
            </p>
          )}
        </>
      ) : (
        <p>{t('sync.storageUnavailable')}</p>
      )}
      <p>{t('sync.onlyCopyWarning')}</p>
      {showSafari && warning !== 'none' && (
        <p className={warning === 'strong' ? 'font-medium text-brand-red' : 'text-yellow'} data-testid="safari-warning">
          {t('sync.safariWarning')}
        </p>
      )}
    </div>
  )
}
