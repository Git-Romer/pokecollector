/**
 * CardImage — renders a card image with automatic fallback to the Pokemon card back
 * when the image is missing or fails to load (e.g. API returns 404/JSON error).
 *
 * Usage: <CardImage src={url} alt={card.name} className="w-full h-full object-cover" />
 */
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSettings } from '../contexts/SettingsContext'

const CARD_BACK = '/cardback.jpg'

export default function CardImage({ src, alt, className, showName = false, style, loading = 'lazy' }) {
  const { t } = useSettings()
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setFailed(false)
    setLoaded(false)
    setAttempt(0)
  }, [src])

  const handleError = (e) => {
    e.currentTarget.onerror = null // prevent infinite loop
    e.currentTarget.src = CARD_BACK
    e.currentTarget.style.opacity = '0.8'
    setFailed(true)
    setLoaded(true)
  }

  const retry = (event) => {
    event.preventDefault()
    event.stopPropagation()
    setFailed(false)
    setLoaded(false)
    setAttempt(value => value + 1)
  }

  const showOverlay = !src || failed || showName
  const displaySrc = failed || !src
    ? CARD_BACK
    : `${src}${attempt > 0 ? `${String(src).includes('?') ? '&' : '?'}retry=${attempt}` : ''}`

  return (
    <div className="relative w-full h-full bg-bg-elevated">
      {!loaded && <div className="unified-card-skeleton absolute inset-0" aria-hidden />}
      <img
        key={`${src || CARD_BACK}-${attempt}`}
        src={displaySrc}
        alt={alt}
        className={className || 'w-full h-full object-cover'}
        style={{ ...(src && !failed ? {} : { opacity: 0.8 }), ...style }}
        loading={loading}
        onError={handleError}
        onLoad={() => setLoaded(true)}
      />
      {showOverlay && alt && (
        <div
          className="absolute bottom-0 left-0 right-0 px-1 pb-2 pt-4"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)' }}
        >
          <span className="text-sm text-white font-semibold leading-tight block text-center truncate">
            {alt}
          </span>
        </div>
      )}
      {failed && (
        <button
          type="button"
          className="absolute left-1/2 top-1/2 z-20 inline-flex -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-1.5 rounded-full border border-white/25 bg-black/85 px-3 py-2 text-xs font-bold text-white shadow-xl hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          onClick={retry}
          aria-label={t('card.retryImage')}
        >
          <RefreshCw size={13} aria-hidden />
          {t('common.retry')}
        </button>
      )}
    </div>
  )
}
