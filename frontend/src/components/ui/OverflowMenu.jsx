import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'

export const overflowMenuItemClass = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50'

export default function OverflowMenu({ label, children }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsideClick = event => {
      if (!containerRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="btn-ghost px-3"
        onClick={() => setOpen(value => !value)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <MoreHorizontal size={18} />
        <span className="hidden sm:inline">{label}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-border bg-bg-card p-1.5 shadow-2xl">
          {children(close)}
        </div>
      )}
    </div>
  )
}
