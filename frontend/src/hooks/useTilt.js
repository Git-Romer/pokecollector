import { useRef, useCallback, useEffect } from 'react'

/**
 * Spring-physics tilt hook.
 *
 * Features:
 * - Lerp (spring) loop: entry, tracking and exit are all eased — no hard snaps.
 * - Entry seeding: on mouseenter the target is set from the real cursor position
 *   so the lerp always starts from flat (0,0) and glides to the actual tilt.
 * - Scale lerp: scale is also interpolated, so the hit-box never suddenly
 *   expands and triggers the mouseleave flicker loop.
 * - Edge dead-zone: tilt is attenuated near the card edges so the scaled card
 *   never pushes past its original bounding box at corners.
 *
 * Returns { ref, onMouseMove, onMouseEnter, onMouseLeave }.
 * Callers must wire up all four handlers (onMouseEnter is new).
 */
export function useTilt(maxTilt = 10, lerpFactor = 0.1) {
  const ref       = useRef(null)
  const rafRef    = useRef(null)
  const hovered   = useRef(false)

  // Interpolated state (what's actually rendered)
  const cur = useRef({ x: 0, y: 0, scale: 1 })
  // Desired state (driven by mouse)
  const tgt = useRef({ x: 0, y: 0, scale: 1 })

  // Compute target rotation from a MouseEvent, with edge attenuation.
  const computeTarget = useCallback((e) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const cx = rect.width  / 2
    const cy = rect.height / 2

    // Edge attenuation: scale tilt down within `edgePct` of any edge
    // so the 1.04-scaled card never exceeds the original bounding box.
    const edgePct = 0.18          // 18% of half-width/height dead-zone
    const edgeW   = cx * edgePct
    const edgeH   = cy * edgePct
    const attX = Math.min(1, Math.min(mx, rect.width  - mx) / edgeW)
    const attY = Math.min(1, Math.min(my, rect.height - my) / edgeH)
    const att  = Math.min(attX, attY)

    tgt.current.x = -((my - cy) / cy) * maxTilt * att
    tgt.current.y =  ((mx - cx) / cx) * maxTilt * att
    tgt.current.scale = 1.04
  }, [maxTilt])

  const tick = useCallback(() => {
    const el = ref.current
    if (!el) { rafRef.current = null; return }

    const c = cur.current
    const t = tgt.current

    c.x     += (t.x     - c.x)     * lerpFactor
    c.y     += (t.y     - c.y)     * lerpFactor
    c.scale += (t.scale - c.scale) * lerpFactor

    el.style.transition = 'none'
    el.style.transform  =
      `perspective(700px) rotateX(${c.x}deg) rotateY(${c.y}deg) scale(${c.scale})`

    // Keep looping while hovered OR while values are still settling
    const settling =
      Math.abs(c.x)         > 0.03 ||
      Math.abs(c.y)         > 0.03 ||
      Math.abs(c.scale - 1) > 0.001

    if (hovered.current || settling) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      // Snap exactly to rest and stop
      el.style.transform = 'perspective(700px) rotateX(0deg) rotateY(0deg) scale(1)'
      rafRef.current = null
    }
  }, [lerpFactor])

  const startLoop = useCallback(() => {
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(tick)
    }
  }, [tick])

  const onMouseEnter = useCallback((e) => {
    hovered.current     = true
    tgt.current.scale   = 1.04
    // Seed the target from the real cursor position so the lerp starts from
    // flat (0,0) and glides toward the correct tilt — never jumps.
    computeTarget(e)
    startLoop()
  }, [computeTarget, startLoop])

  const onMouseMove = useCallback((e) => {
    computeTarget(e)
    // Ensure loop is running (it may have been stopped after a fast leave+re-enter)
    startLoop()
  }, [computeTarget, startLoop])

  const onMouseLeave = useCallback(() => {
    hovered.current   = false
    tgt.current.x     = 0
    tgt.current.y     = 0
    tgt.current.scale = 1
    // The tick loop will lerp back to 0 and stop itself.
    startLoop()
  }, [startLoop])

  // Clean up RAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return { ref, onMouseMove, onMouseEnter, onMouseLeave }
}
