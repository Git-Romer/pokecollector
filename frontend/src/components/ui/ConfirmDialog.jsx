import { AlertTriangle, Loader2 } from 'lucide-react'
import Modal from './Modal'

export default function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  cancelLabel,
  isPending = false,
  destructive = false,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={isPending ? undefined : onClose}
      title={title}
      size="sm"
      mobileSheet={false}
      overlayClassName="z-[500]"
    >
      <div className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 grid h-9 w-9 flex-shrink-0 place-items-center rounded-full ${
            destructive ? 'bg-brand-red/10 text-brand-red' : 'bg-yellow/10 text-yellow'
          }`}>
            <AlertTriangle size={18} aria-hidden />
          </span>
          <p className="text-sm leading-relaxed text-text-secondary">{message}</p>
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost w-full justify-center sm:w-auto" disabled={isPending} onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`w-full justify-center sm:w-auto ${
              destructive
                ? 'btn-ghost border-brand-red/30 text-brand-red hover:bg-brand-red/10'
                : 'btn-primary'
            }`}
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending && <Loader2 size={15} className="animate-spin" aria-hidden />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
