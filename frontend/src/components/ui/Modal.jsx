import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import Sheet from './Sheet'
import { useSettings } from '../../contexts/SettingsContext'

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
}) {
  const { t } = useSettings()
  const [isDesktop, setIsDesktop] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(DESKTOP_MEDIA_QUERY).matches
  ))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mediaQuery = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const updateViewport = event => setIsDesktop(event.matches)
    setIsDesktop(mediaQuery.matches)
    mediaQuery.addEventListener('change', updateViewport)
    return () => mediaQuery.removeEventListener('change', updateViewport)
  }, [])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handle = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [isOpen, onClose])

  // Lock body scroll
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
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
        <Sheet isOpen={isOpen} onClose={onClose} title={title} className={className}>
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
    >
      {children}
    </DesktopModal>
  )
}

function DesktopModal({ isOpen, onClose, title, children, sizeClass, className = '', closeLabel = 'Close' }) {
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
          aria-modal="true"
        >
          {/* Header */}
          {title && (
            <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
              <h2 className="text-base font-semibold text-text-primary">{title}</h2>
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
