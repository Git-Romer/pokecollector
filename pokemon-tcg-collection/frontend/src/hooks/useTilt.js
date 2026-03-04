import { useRef, useCallback } from 'react'

export function useTilt(maxTilt = 12) {
  const ref = useRef(null)

  const onMouseMove = useCallback((e) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const cx = rect.width / 2
    const cy = rect.height / 2
    const rotateY = ((x - cx) / cx) * maxTilt
    const rotateX = -((y - cy) / cy) * maxTilt
    el.style.transition = 'transform 0.08s ease-out'
    el.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.03)`
  }, [maxTilt])

  const onMouseLeave = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.transition = 'transform 0.3s ease'
    el.style.transform = 'perspective(700px) rotateX(0deg) rotateY(0deg) scale(1)'
  }, [])

  return { ref, onMouseMove, onMouseLeave }
}
