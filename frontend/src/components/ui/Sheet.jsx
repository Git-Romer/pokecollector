import { useEffect } from 'react'
import { X } from 'lucide-react'

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
export default function Sheet({ isOpen, onClose, title, children, className = '' }) {
  // Lock body scroll while sheet is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet panel */}
      <div
        className={[
          'fixed bottom-0 left-0 right-0 z-50',
          'bg-bg-surface border-t border-border',
          'rounded-t-2xl',
          'max-h-[85dvh] flex flex-col',
          'animate-slide-up',
          className,
        ].join(' ')}
        role="dialog"
        aria-modal="true"
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {/* Header */}
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-elevated transition-colors"
              aria-label="Close"
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
    </>
  )
}
