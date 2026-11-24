import { Loader2, UploadCloud } from 'lucide-react'
import Modal from '../ui/Modal'
import { useSettings } from '../../contexts/SettingsContext'

/** Four-way dialog shown by the logout guard (docs/PWA_OFFLINE_DESIGN.md D7, §6.6 A6). */
export default function LogoutGuardDialog({ isOpen, busy = false, onSync, onKeep, onDiscard, onCancel }) {
  const { t } = useSettings()

  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? undefined : onCancel}
      title={t('sync.logoutTitle')}
      size="sm"
      mobileSheet={false}
      overlayClassName="z-[500]"
    >
      <div className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-yellow/10 text-yellow">
            <UploadCloud size={18} aria-hidden />
          </span>
          <p className="text-sm leading-relaxed text-text-secondary" aria-live="polite">
            {busy ? t('sync.syncingLabel') : t('sync.logoutMessage')}
          </p>
        </div>
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <button type="button" className="btn-primary w-full justify-center" disabled={busy} onClick={onSync}>
            {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
            {t('sync.logoutSyncFirst')}
          </button>
          <button type="button" className="btn-ghost w-full justify-center" disabled={busy} onClick={onKeep}>
            {t('sync.logoutKeep')}
          </button>
          <button
            type="button"
            className="btn-ghost w-full justify-center border-brand-red/30 text-brand-red hover:bg-brand-red/10"
            disabled={busy}
            onClick={onDiscard}
          >
            {t('sync.logoutDiscard')}
          </button>
          <button type="button" className="btn-ghost w-full justify-center" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
