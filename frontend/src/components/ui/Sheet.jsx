import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useDialogBehavior } from './dialogBehavior'

/**
 * Sheet — Bottom sheet that slides up from the bottom on mobile.
 *
 * Props:
 *   isOpen   {boolean}  — whether the sheet is visible
 *   onClose  {fn}       — called when backdrop or X is clicked
 *   title    {string}   — optional header title
 *   children {node}     — sheet content
 *   className {string}  — extra classes for the panel
 */
export default function Sheet({ isOpen, onClose, title, children, className = '', manageBodyScroll = true, restoreFocus = true, isObscured = false }) {
  const { t } = useSettings()
  const titleId = useId()
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(isOpen, onClose, { restoreFocus })

  // Lock body scroll while sheet is open
  useEffect(() => {
    if (!isOpen || !manageBodyScroll) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [isOpen, manageBodyScroll])

  if (!isOpen) return null

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet panel */}
      <div
        ref={dialogRef}
        className={[
          'fixed bottom-0 left-0 right-0 z-50',
          'bg-bg-surface border-t border-border',
          'rounded-t-2xl',
          'max-h-[85dvh] flex flex-col',
          'animate-slide-up',
          className,
        ].join(' ')}
        role="dialog"
        aria-modal={isObscured ? undefined : 'true'}
        aria-hidden={isObscured ? 'true' : undefined}
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : t('common.dialog')}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {/* Header */}
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <h2 id={titleId} className="text-base font-semibold text-text-primary">{title}</h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-elevated transition-colors"
              aria-label={t('common.close')}
            >
              <X size={18} />
            </button>
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto safe-area-bottom">
          {children}
        </div>
      </div>
    </>,
    document.body
  )
}
