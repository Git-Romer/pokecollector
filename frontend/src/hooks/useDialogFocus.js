import {useEffect, useRef} from 'react'

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * useDialogFocus — keyboard containment for a modal surface.
 *
 * Moves focus into the dialog on open, keeps Tab and Shift+Tab inside it,
 * closes on Escape, and returns focus to whatever was focused before the
 * dialog opened. Attach the returned ref to the element carrying
 * role="dialog"; that element needs tabIndex={-1} so it can take focus when
 * it holds nothing focusable of its own.
 *
 * The spec lists predictable focus order and keyboard-complete controls as
 * acceptance criteria, so this is product behaviour rather than polish.
 */
export default function useDialogFocus(isOpen, onClose) {
    const ref = useRef(null)
    // Keep the latest onClose without re-running the effect (and so without
    // stealing focus again) when a caller passes a fresh closure each render.
    const onCloseRef = useRef(onClose)
    onCloseRef.current = onClose

    useEffect(() => {
        const node = ref.current
        if (!isOpen || !node) return undefined

        const previouslyFocused = document.activeElement

        // Elements inside a display:none subtree report no offsetParent and are
        // not reachable by Tab, so they must not be counted as stops.
        const stops = () =>
            Array.from(node.querySelectorAll(FOCUSABLE)).filter(
                (el) => el.offsetParent !== null || el === document.activeElement
            )

        const first = stops()[0]
        ;(first || node).focus()

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation()
                onCloseRef.current?.()
                return
            }
            if (event.key !== 'Tab') return

            const items = stops()
            if (items.length === 0) {
                event.preventDefault()
                node.focus()
                return
            }

            const firstItem = items[0]
            const lastItem = items[items.length - 1]

            // Focus can sit outside the dialog — the backdrop, or a click on inert
            // chrome. Pull it back rather than letting Tab walk into the page.
            if (!node.contains(document.activeElement)) {
                event.preventDefault()
                ;(event.shiftKey ? lastItem : firstItem).focus()
                return
            }

            if (event.shiftKey && document.activeElement === firstItem) {
                event.preventDefault()
                lastItem.focus()
            } else if (!event.shiftKey && document.activeElement === lastItem) {
                event.preventDefault()
                firstItem.focus()
            }
        }

        document.addEventListener('keydown', handleKeyDown, true)
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true)
            if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
        }
    }, [isOpen])

    return ref
}
