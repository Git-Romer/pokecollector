import { AlertTriangle } from 'lucide-react'
import Modal from '../ui/Modal'
import { useSettings } from '../../contexts/SettingsContext'

/** Blocking notice shown once when the browser deleted the offline database (D12, S6). */
export default function EvictedNotice({ isOpen, onClose }) {
  const { t } = useSettings()

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('sync.attentionLabel')} size="sm" mobileSheet={false} overlayClassName="z-[500]">
      <div className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-brand-red/10 text-brand-red">
            <AlertTriangle size={18} aria-hidden />
          </span>
          <p className="text-sm leading-relaxed text-text-secondary">{t('sync.evicted')}</p>
        </div>
        <div className="flex justify-end border-t border-border pt-4">
          <button type="button" className="btn-primary w-full justify-center sm:w-auto" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
