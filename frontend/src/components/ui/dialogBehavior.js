import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useDialogBehavior(isOpen, onClose, { restoreFocus = true } = {}) {
  const dialogRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return undefined
    const returnFocus = document.activeElement
    const focusFrame = requestAnimationFrame(() => dialogRef.current?.focus())

    return () => {
      cancelAnimationFrame(focusFrame)
      if (restoreFocus) {
        requestAnimationFrame(() => {
          if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus()
        })
      }
    }
  }, [isOpen, restoreFocus])

  const onDialogKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose?.()
      return
    }
    if (event.key !== 'Tab') return
    // React events from portals bubble through the component tree. Stop here
    // so a parent dialog cannot also process Tab for a nested dialog.
    event.stopPropagation()

    const dialog = dialogRef.current
    const focusable = dialog
      ? [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter(element => (
        !element.hasAttribute('hidden')
        && !element.closest('[aria-hidden="true"]')
        && element.getClientRects().length > 0
      ))
      : []
    if (!dialog || !focusable.length) {
      event.preventDefault()
      dialog?.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  return { dialogRef, onDialogKeyDown }
}
