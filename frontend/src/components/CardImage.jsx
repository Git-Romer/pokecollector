/**
 * CardImage — uses the Pokemon card back when artwork is missing and shows an
 * explicit retry state when a supplied image URL fails to load.
 *
 * Usage: <CardImage src={url} alt={card.name} className="w-full h-full object-cover" />
 */
import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../contexts/SettingsContext'
import { ARTWORK_RETRY_EVENT, artworkRetryAttempt, markArtworkMissing, markArtworkLoaded } from '../utils/artworkRetry'

const CARD_BACK = '/cardback.jpg'
const VIEWPORT_MARGIN = 300
const webkitViewportFallbacks = new Map()
let webkitViewportFrame = null
let webkitViewportListenersAttached = false
let webkitViewportRetryTimers = []

function clearWebKitViewportRetries() {
  webkitViewportRetryTimers.forEach(window.clearTimeout)
  webkitViewportRetryTimers = []
}

function scheduleWebKitViewportRetries() {
  if (webkitViewportRetryTimers.length > 0) return
  webkitViewportRetryTimers = [0, 80, 300].map(delay => window.setTimeout(() => {
    if (webkitViewportFallbacks.size > 0) checkWebKitViewportFallbacks()
  }, delay))
}

function isWebKitBrowser() {
  if (typeof navigator === 'undefined') return false
  return /AppleWebKit/i.test(navigator.userAgent)
    && !/(?:Chrome|Chromium|Edg|OPR|Android)\//i.test(navigator.userAgent)
}

function isNearViewport(element) {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  return rect.bottom >= -VIEWPORT_MARGIN
    && rect.top <= window.innerHeight + VIEWPORT_MARGIN
    && rect.right >= -VIEWPORT_MARGIN
    && rect.left <= window.innerWidth + VIEWPORT_MARGIN
}

function detachWebKitViewportListeners() {
  if (!webkitViewportListenersAttached || webkitViewportFallbacks.size > 0) return
  window.removeEventListener('scroll', scheduleWebKitViewportCheck, true)
  window.removeEventListener('resize', scheduleWebKitViewportCheck)
  window.removeEventListener('pageshow', scheduleWebKitViewportCheck)
  document.removeEventListener('visibilitychange', scheduleWebKitViewportCheck)
  webkitViewportListenersAttached = false
  clearWebKitViewportRetries()
}

function checkWebKitViewportFallbacks() {
  webkitViewportFrame = null
  for (const [element, reveal] of webkitViewportFallbacks) {
    if (!element.isConnected) {
      webkitViewportFallbacks.delete(element)
    } else if (isNearViewport(element)) {
      webkitViewportFallbacks.delete(element)
      reveal()
    }
  }
  detachWebKitViewportListeners()
}

function scheduleWebKitViewportCheck() {
  if (webkitViewportFrame !== null) return
  webkitViewportFrame = window.requestAnimationFrame(checkWebKitViewportFallbacks)
}

function observeWebKitViewport(element, reveal) {
  if (!isWebKitBrowser()) return () => {}

  webkitViewportFallbacks.set(element, reveal)
  if (!webkitViewportListenersAttached) {
    window.addEventListener('scroll', scheduleWebKitViewportCheck, true)
    window.addEventListener('resize', scheduleWebKitViewportCheck)
    window.addEventListener('pageshow', scheduleWebKitViewportCheck)
    document.addEventListener('visibilitychange', scheduleWebKitViewportCheck)
    webkitViewportListenersAttached = true
  }
  scheduleWebKitViewportCheck()
  scheduleWebKitViewportRetries()

  return () => {
    webkitViewportFallbacks.delete(element)
    detachWebKitViewportListeners()
  }
}

export default function CardImage({
  src,
  alt,
  className,
  showName = false,
  style,
  loading = 'lazy',
  onLoadingChange,
  onStatusChange,
  compactError = false,
}) {
  const { t } = useSettings()
  const containerRef = useRef(null)
  const imageRef = useRef(null)
  const [shouldLoad, setShouldLoad] = useState(() => (
    loading !== 'lazy' || typeof IntersectionObserver === 'undefined'
  ))
  const [status, setStatus] = useState(() => ({ source: src, failed: false, loaded: false, attempt: artworkRetryAttempt(src) }))
  const currentStatus = status.source === src
    ? status
    : { source: src, failed: false, loaded: false, attempt: artworkRetryAttempt(src) }
  const { failed, loaded, attempt } = currentStatus
  const showOverlay = !src || showName
  const displaySrc = !src
    ? CARD_BACK
    : `${src}${attempt > 0 ? `${String(src).includes('?') ? '&' : '?'}retry=${attempt}` : ''}`

  useEffect(() => {
    if (shouldLoad) return undefined
    if (loading !== 'lazy' || typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true)
      return undefined
    }

    const container = containerRef.current
    if (!container) return undefined

    const reveal = () => setShouldLoad(true)
    const stopWebKitFallback = observeWebKitViewport(container, reveal)

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      reveal()
      observer.disconnect()
    }, { rootMargin: `${VIEWPORT_MARGIN}px 0px` })

    observer.observe(container)
    return () => {
      observer.disconnect()
      stopWebKitFallback()
    }
  }, [loading, shouldLoad])

  useEffect(() => {
    onLoadingChange?.(!loaded)
  }, [loaded, onLoadingChange])

  useEffect(() => {
    onStatusChange?.({ loaded, failed, source: displaySrc })
  }, [displaySrc, failed, loaded, onStatusChange])

  useEffect(() => {
    const image = imageRef.current
    if (!image?.complete) return

    const nextFailed = image.naturalWidth === 0
    setStatus(previous => {
      const nextAttempt = previous.source === src ? previous.attempt : artworkRetryAttempt(src)
      if (
        previous.source === src
        && previous.loaded
        && previous.failed === nextFailed
        && previous.attempt === nextAttempt
      ) return previous

      return {
        source: src,
        failed: nextFailed,
        loaded: true,
        attempt: nextAttempt,
      }
    })
  }, [displaySrc, shouldLoad, src])

  const handleError = () => {
    setStatus(previous => ({
      source: src,
      failed: true,
      loaded: true,
      attempt: previous.source === src ? previous.attempt : artworkRetryAttempt(src),
    }))
  }

  useEffect(() => {
    if (!failed) {
      if (loaded) markArtworkLoaded(src)
      return undefined
    }
    markArtworkMissing(src)
    const retry = () => setStatus({
      source: src,
      failed: false,
      loaded: false,
      attempt: artworkRetryAttempt(src),
    })
    window.addEventListener(ARTWORK_RETRY_EVENT, retry)
    return () => window.removeEventListener(ARTWORK_RETRY_EVENT, retry)
  }, [failed, loaded, src])

  return (
    <div ref={containerRef} className="unified-card-image relative w-full h-full bg-bg-elevated">
      {!loaded && <div className="unified-card-skeleton absolute inset-0" aria-hidden />}
      {shouldLoad && !failed && (
        <img
          ref={imageRef}
          key={`${src || CARD_BACK}-${attempt}`}
          src={displaySrc}
          alt={alt}
          className={className || 'w-full h-full object-cover'}
          style={{ ...(src ? {} : { opacity: 0.8 }), ...style }}
          loading={loading}
          onError={handleError}
          onLoad={() => setStatus(previous => ({
            source: src,
            failed: false,
            loaded: true,
            attempt: previous.source === src ? previous.attempt : artworkRetryAttempt(src),
          }))}
        />
      )}
      {failed && (
        <div
          className="unified-card-image-error pointer-events-none absolute inset-0 grid place-items-center bg-bg-elevated"
          role="img"
          aria-label={`${alt || ''}: ${t('card.artworkUnavailable')}`}
          title={t('card.artworkUnavailable')}
        >
          <AlertTriangle size={compactError ? 14 : 20} className="max-h-full max-w-full text-text-muted" aria-hidden />
        </div>
      )}
      {!failed && showOverlay && alt && (
        <div
          className="absolute bottom-0 left-0 right-0 px-1 pb-2 pt-4"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)' }}
        >
          <span className="text-sm text-white font-semibold leading-tight block text-center truncate">
            {alt}
          </span>
        </div>
      )}
    </div>
  )
}
