import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Minus, Plus, RotateCcw, X } from 'lucide-react'
import { useDialogBehavior } from './ui/dialogBehavior'
import { useSettings } from '../contexts/SettingsContext'

const MIN_SCALE = 1
const MAX_SCALE = 4
const DOUBLE_TAP_SCALE = 2.5
const DOUBLE_CLICK_MS = 320

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

function distanceBetween(touches) {
  const [a, b] = touches
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function midpoint(touches) {
  const [a, b] = touches
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
}

/**
 * Full-screen pan/zoom viewer for a single image — scroll wheel or pinch to
 * zoom, drag to pan once zoomed, double-click/double-tap to toggle zoom.
 * On-screen +/-/reset controls exist both as a fallback for devices without
 * wheel/pinch input and as the visual hint that the image is zoomable.
 */
export default function ImageZoomOverlay({ src, alt = '', onClose }) {
  const { t } = useSettings()
  const [scale, setScale] = useState(MIN_SCALE)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [showHint, setShowHint] = useState(true)
  const containerRef = useRef(null)
  const imgRef = useRef(null)
  const dragState = useRef(null)
  const pinchState = useRef(null)
  const lastTapRef = useRef(0)
  const draggedRef = useRef(false)

  useEffect(() => {
    const timer = setTimeout(() => setShowHint(false), 2600)
    return () => clearTimeout(timer)
  }, [])

  const applyScale = (nextScale, anchor) => {
    const clamped = clampScale(nextScale)
    if (clamped === MIN_SCALE) {
      setPosition({ x: 0, y: 0 })
      setScale(MIN_SCALE)
      return
    }
    if (anchor && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const cx = anchor.x - rect.left - rect.width / 2
      const cy = anchor.y - rect.top - rect.height / 2
      const ratio = clamped / scale
      setPosition((prev) => ({
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      }))
    }
    setScale(clamped)
  }

  const toggleZoom = (anchor) => {
    applyScale(scale > MIN_SCALE ? MIN_SCALE : DOUBLE_TAP_SCALE, anchor)
  }

  const handleWheel = (event) => {
    event.preventDefault()
    const delta = -event.deltaY * 0.0025
    applyScale(scale * (1 + delta), { x: event.clientX, y: event.clientY })
  }

  const handleMouseDown = (event) => {
    if (scale <= MIN_SCALE) return
    dragState.current = { startX: event.clientX, startY: event.clientY, origin: position }
  }

  const handleMouseMove = (event) => {
    if (!dragState.current) return
    draggedRef.current = true
    const { startX, startY, origin } = dragState.current
    setPosition({ x: origin.x + (event.clientX - startX), y: origin.y + (event.clientY - startY) })
  }

  const endDrag = () => {
    dragState.current = null
  }

  const handleDoubleClick = (event) => {
    toggleZoom({ x: event.clientX, y: event.clientY })
  }

  // The <img> itself has pointer-events: none (its own click can't be told
  // apart from the pan surface behind it otherwise), so "clicked the image"
  // vs "clicked the backdrop around it" is decided by comparing the click
  // point against the image's actual rendered bounds instead of event.target.
  const handleBackdropClick = (event) => {
    if (draggedRef.current) {
      draggedRef.current = false
      return
    }
    const imgRect = imgRef.current?.getBoundingClientRect()
    const withinImage = imgRect
      && event.clientX >= imgRect.left && event.clientX <= imgRect.right
      && event.clientY >= imgRect.top && event.clientY <= imgRect.bottom
    if (!withinImage) onClose()
  }

  const handleTouchStart = (event) => {
    if (event.touches.length === 2) {
      pinchState.current = {
        distance: distanceBetween(event.touches),
        scale,
        origin: position,
        mid: midpoint(event.touches),
      }
      dragState.current = null
      return
    }
    if (event.touches.length === 1) {
      const now = Date.now()
      if (now - lastTapRef.current < DOUBLE_CLICK_MS) {
        const touch = event.touches[0]
        toggleZoom({ x: touch.clientX, y: touch.clientY })
        lastTapRef.current = 0
        return
      }
      lastTapRef.current = now
      if (scale > MIN_SCALE) {
        const touch = event.touches[0]
        dragState.current = { startX: touch.clientX, startY: touch.clientY, origin: position }
      }
    }
  }

  const handleTouchMove = (event) => {
    if (event.touches.length === 2 && pinchState.current) {
      event.preventDefault()
      const nextDistance = distanceBetween(event.touches)
      const ratio = nextDistance / pinchState.current.distance
      applyScale(pinchState.current.scale * ratio, pinchState.current.mid)
      return
    }
    if (event.touches.length === 1 && dragState.current) {
      event.preventDefault()
      draggedRef.current = true
      const touch = event.touches[0]
      const { startX, startY, origin } = dragState.current
      setPosition({ x: origin.x + (touch.clientX - startX), y: origin.y + (touch.clientY - startY) })
    }
  }

  const handleTouchEnd = (event) => {
    if (event.touches.length < 2) pinchState.current = null
    if (event.touches.length === 0) dragState.current = null
  }

  const { dialogRef, onDialogKeyDown } = useDialogBehavior(true, onClose)

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-sm"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-3 top-3 z-20 grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/75 text-white shadow-lg transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
        aria-label={t('common.close')}
      >
        <X size={20} aria-hidden />
      </button>

      <div
        ref={containerRef}
        className="relative h-full w-full touch-none overflow-hidden"
        style={{ cursor: scale > MIN_SCALE ? 'grab' : 'zoom-in' }}
        onClick={handleBackdropClick}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-1/2 max-h-none max-w-none select-none"
          style={{
            width: 'min(80vw, 480px)',
            transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transition: dragState.current || pinchState.current ? 'none' : 'transform 120ms ease-out',
          }}
        />

        {showHint && (
          <div className="pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-4 py-2 text-xs font-medium text-white shadow-lg">
            {t('card.zoomHint')}
          </div>
        )}

        <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2">
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); applyScale(scale - 0.75) }}
            disabled={scale <= MIN_SCALE}
            className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/75 text-white shadow-lg transition-colors hover:bg-black disabled:opacity-40"
            aria-label={t('card.zoomOut')}
          >
            <Minus size={18} aria-hidden />
          </button>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); applyScale(MIN_SCALE) }}
            disabled={scale <= MIN_SCALE}
            className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/75 text-white shadow-lg transition-colors hover:bg-black disabled:opacity-40"
            aria-label={t('card.zoomReset')}
          >
            <RotateCcw size={16} aria-hidden />
          </button>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); applyScale(scale + 0.75) }}
            disabled={scale >= MAX_SCALE}
            className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/75 text-white shadow-lg transition-colors hover:bg-black disabled:opacity-40"
            aria-label={t('card.zoomIn')}
          >
            <Plus size={18} aria-hidden />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
