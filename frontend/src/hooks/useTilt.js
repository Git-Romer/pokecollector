import { useRef, useCallback, useEffect } from 'react'

export function useTilt(maxTilt = 12) {
  const ref = useRef(null)
  const rafRef = useRef(null)

  const onMouseMove = useCallback((e) => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const cx = rect.width / 2
      const cy = rect.height / 2
      const rotateY = ((x - cx) / cx) * maxTilt
      const rotateX = -((y - cy) / cy) * maxTilt
      // No transition during movement — tracks cursor in real-time
      el.style.transition = 'none'
      el.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.04)`
    })
  }, [maxTilt])

  const onMouseLeave = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    const el = ref.current
    if (!el) return
    // Smooth ease-out back to flat only on leave
    el.style.transition = 'transform 0.4s ease'
    el.style.transform = 'perspective(700px) rotateX(0deg) rotateY(0deg) scale(1)'
  }, [])

  // Clean up RAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return { ref, onMouseMove, onMouseLeave }
}
