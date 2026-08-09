import {useEffect, useRef} from 'react'
import {Link} from 'react-router-dom'

/**
 * Adapted from Originkit's Magnetic Hover Button. The behaviour is theirs - a
 * pull toward the cursor from a distance, and a colour sweep that opens from
 * wherever the pointer crossed the edge. The implementation is not.
 *
 * Three things had to change for this codebase:
 *
 * - It shipped as a plain <a href>. Inside a router that is a full page
 *   reload, so the primary call to action would have thrown away the SPA on
 *   every click. This wraps react-router's Link instead.
 * - It depended on framer-motion. Every other animated component here runs on
 *   CSS, and a spring library is a poor trade for one button, so the transform
 *   rides on custom properties and the sweep is a scaled pseudo-element.
 * - John John's PC keeps one motion language, so the pull remains active
 *   instead of adding optional motion modes.
 */

// How far outside itself the button starts reacting, and how far it travels.
const REACH_PER_POINT = 18
const MAX_PULL = 0.5


export default function MagneticLink({to, children, className = '', magnet = 10, ...rest}) {
    const ref = useRef(null)
    const frame = useRef(0)

    useEffect(() => {
        const node = ref.current
        if (!node) return undefined

        const pull = (magnet / 20) * MAX_PULL
        const reach = magnet * REACH_PER_POINT

        // The pointer fires far more often than the screen refreshes, and each
        // read of the box forces layout, so coalesce to one measurement a frame.
        const onPointerMove = (event) => {
            if (frame.current) return
            frame.current = requestAnimationFrame(() => {
                frame.current = 0

                const rect = node.getBoundingClientRect()
                const dx = event.clientX - (rect.left + rect.width / 2)
                const dy = event.clientY - (rect.top + rect.height / 2)

                const gapX = Math.max(0, Math.abs(dx) - rect.width / 2)
                const gapY = Math.max(0, Math.abs(dy) - rect.height / 2)
                const gap = Math.hypot(gapX, gapY)

                const falloff = gap > reach ? 0 : 1 - gap / reach
                node.style.setProperty('--magnet-x', `${dx * pull * falloff}px`)
                node.style.setProperty('--magnet-y', `${dy * pull * falloff}px`)

                // Open the sweep from wherever the pointer actually is, clamped to the
                // box so a fast entry still starts on an edge rather than off-centre.
                node.style.setProperty('--sweep-x', `${Math.max(0, Math.min(rect.width, event.clientX - rect.left))}px`)
                node.style.setProperty('--sweep-y', `${Math.max(0, Math.min(rect.height, event.clientY - rect.top))}px`)
            })
        }

        const release = () => {
            node.style.setProperty('--magnet-x', '0px')
            node.style.setProperty('--magnet-y', '0px')
        }

        window.addEventListener('pointermove', onPointerMove, {passive: true})
        document.addEventListener('pointerleave', release)

        return () => {
            window.removeEventListener('pointermove', onPointerMove)
            document.removeEventListener('pointerleave', release)
            if (frame.current) cancelAnimationFrame(frame.current)
            release()
        }
    }, [magnet])

    return (
        <Link ref={ref} to={to} className={`magnetic-link ${className}`.trim()} {...rest}>
            {/* Decorative wash. The label below carries the accessible name. */}
            <span className="magnetic-link-sweep" aria-hidden="true"/>
            <span className="magnetic-link-label">{children}</span>
        </Link>
    )
}
