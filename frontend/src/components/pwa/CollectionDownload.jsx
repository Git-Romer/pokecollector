import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import { useConfirmDialog } from '../../contexts/ConfirmDialogContext'
import { useAutomaticCollection } from '../../offline/AutomaticCollectionProvider'

export default function CollectionDownload() {
  const { t, updateSettings, loaded, downloadPreferencePending } = useSettings()
  const confirmDialog = useConfirmDialog()
  const state = useAutomaticCollection()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  if (!state) return null
  const toggle = async value => {
    if (saving) return
    setSaving(true); setError(false)
    try {
      const session = localStorage.getItem('token')
      if (!value && !await confirmDialog({
        title: t('offlineCollection.deactivateTitle'),
        message: t('offlineCollection.deactivateMessage'),
        confirmLabel: t('offlineCollection.deactivateAction'),
        destructive: true,
      })) return
      // A confirmation must not outlive its page or apply to a later sign-in.
      if (!mounted.current || session !== localStorage.getItem('token')) return
      await updateSettings({ offline_collection_enabled: String(value) })
    }
    catch { setError(true) }
    finally { setSaving(false) }
  }
  const errorKey = state.error?.message === 'metadata_not_saved' ? 'metadataFailed'
    : state.error?.message === 'storage_low' || state.error?.name === 'QuotaExceededError' ? 'storageLow' : 'failed'
  const statusKey = state.phase === 'saved' ? 'saved'
    : state.phase === 'error' ? errorKey
      : state.phase === 'cleanupFailed' ? 'cleanupFailed'
        : state.phase === 'clearing' ? 'clearing'
          : !state.enabled ? state.phase === 'disabled' ? 'disabled' : 'clearing' : 'waiting'
  return <section className="card space-y-3" data-testid="collection-offline-download" aria-busy={state.phase === 'downloading'}>
    <label className="flex items-center justify-between gap-4 font-semibold">
      <span>{t('offlineCollection.automatic')}</span>
      <input type="checkbox" role="switch" className="h-5 w-10 accent-brand-red"
        checked={state.enabled} disabled={saving || !loaded}
        onChange={event => toggle(event.target.checked)} />
    </label>
    <p className="text-sm text-text-muted">{t('offlineCollection.automaticDescription')}</p>
    <p role="status" aria-live="polite" className="text-sm text-text-muted">
      {state.phase === 'downloading' && state.total !== undefined
        ? t('offlineCollection.progress').replace('{count}', state.completed).replace('{total}', state.total)
        : t(`offlineCollection.${statusKey}`)}
    </p>
    {state.missingArtwork > 0 && <p className="text-xs text-text-muted">{t('offlineCollection.missing').replace('{count}', state.missingArtwork)}</p>}
    {downloadPreferencePending && <p role="status" className="text-xs text-text-muted">{t('offlineCollection.preferencePending')}</p>}
    <p className="text-xs text-text-muted">{t('offlineCollection.automaticNotice')}</p>
    {error && <p role="alert" className="text-sm text-red-400">{t('offlineCollection.preferenceFailed')}</p>}
  </section>
}
