import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import Sheet from './Sheet'
import { useSettings } from '../../contexts/SettingsContext'
import { useDialogBehavior } from './dialogBehavior'

const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)'

/**
 * Modal — Centered overlay modal on desktop, Sheet on mobile.
 *
 * Props:
 *   isOpen    {boolean}   — whether the modal is visible
 *   onClose   {fn}        — called when backdrop/X/Esc is clicked
 *   title     {string}    — optional header title
 *   children  {node}      — modal content
 *   size      {string}    — 'sm' | 'md' | 'lg' | 'xl' (default: 'md')
 *   className {string}    — extra classes for the inner panel
 *   mobileSheet {boolean} — if true, renders as Sheet on mobile (default: true)
 */
export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  className = '',
  mobileSheet = true,
  isObscured = false,
}) {
  const { t } = useSettings()
  const returnFocusRef = useRef(null)
  const wasOpenRef = useRef(false)
  const [isDesktop, setIsDesktop] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(DESKTOP_MEDIA_QUERY).matches
  ))

  if (isOpen && !wasOpenRef.current && typeof document !== 'undefined') {
    returnFocusRef.current = document.activeElement
  }
  wasOpenRef.current = isOpen

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mediaQuery = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const updateViewport = event => setIsDesktop(event.matches)
    setIsDesktop(mediaQuery.matches)
    mediaQuery.addEventListener('change', updateViewport)
    return () => mediaQuery.removeEventListener('change', updateViewport)
  }, [])

  // Lock body scroll
  useEffect(() => {
    if (!isOpen) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [isOpen])

  // Keep focus restoration owned by the responsive wrapper so switching
  // between Sheet and DesktopModal does not lose the original trigger.
  useLayoutEffect(() => {
    if (!isOpen) return undefined
    return () => {
      const returnFocus = returnFocusRef.current
      requestAnimationFrame(() => {
        if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus()
      })
    }
  }, [isOpen])

  if (!isOpen) return null

  const sizeClass = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }[size] || 'max-w-lg'

  // On mobile — render as bottom sheet
  if (mobileSheet) {
    if (!isDesktop) {
      return (
        <Sheet isOpen={isOpen} onClose={onClose} title={title} className={className} manageBodyScroll={false} restoreFocus={false} isObscured={isObscured}>
          {children}
        </Sheet>
      )
    }

    return (
      <DesktopModal
        isOpen={isOpen}
        onClose={onClose}
        title={title}
        sizeClass={sizeClass}
        className={className}
        closeLabel={t('common.close')}
        dialogLabel={t('common.dialog')}
        isObscured={isObscured}
      >
        {children}
      </DesktopModal>
    )
  }

  // Always render as centered modal (no sheet)
  return (
    <DesktopModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      sizeClass={sizeClass}
      className={className}
      closeLabel={t('common.close')}
      dialogLabel={t('common.dialog')}
      isObscured={isObscured}
    >
      {children}
    </DesktopModal>
  )
}

function DesktopModal({ isOpen, onClose, title, children, sizeClass, className = '', closeLabel = 'Close', dialogLabel = 'Dialog', isObscured = false }) {
  const titleId = useId()
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(isOpen, onClose, { restoreFocus: false })
  if (!isOpen) return null

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 animate-fade-in flex items-end sm:items-center justify-center p-4"
        onClick={onClose}
      >
        {/* Panel — stop propagation so clicks inside don't close */}
        <div
          ref={dialogRef}
          className={[
            'relative w-full mx-4',
            sizeClass,
            'bg-bg-card border border-border rounded-2xl',
            'max-h-[85vh] flex flex-col',
            'animate-slide-up',
            className,
          ].join(' ')}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal={isObscured ? undefined : 'true'}
          aria-hidden={isObscured ? 'true' : undefined}
          aria-labelledby={title ? titleId : undefined}
          aria-label={title ? undefined : dialogLabel}
          tabIndex={-1}
          onKeyDown={onDialogKeyDown}
        >
          {/* Header */}
          {title && (
            <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
              <h2 id={titleId} className="text-base font-semibold text-text-primary">{title}</h2>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-elevated transition-colors"
                aria-label={closeLabel}
              >
                <X size={18} />
              </button>
            </div>
          )}

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto">
            {children}
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}
