/**
 * CardImage — uses the Pokemon card back when artwork is missing and shows an
 * explicit retry state when a supplied image URL fails to load.
 *
 * Usage: <CardImage src={url} alt={card.name} className="w-full h-full object-cover" />
 */
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSettings } from '../contexts/SettingsContext'

const CARD_BACK = '/cardback.jpg'

export default function CardImage({
  src,
  alt,
  className,
  showName = false,
  style,
  loading = 'lazy',
  onLoadingChange,
  compactError = false,
}) {
  const { t } = useSettings()
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setFailed(false)
    setLoaded(false)
    setAttempt(0)
  }, [src])

  useEffect(() => {
    onLoadingChange?.(!loaded)
  }, [loaded, onLoadingChange])

  const handleError = () => {
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

  const showOverlay = !src || showName
  const displaySrc = !src
    ? CARD_BACK
    : `${src}${attempt > 0 ? `${String(src).includes('?') ? '&' : '?'}retry=${attempt}` : ''}`

  return (
    <div className="unified-card-image relative w-full h-full bg-bg-elevated">
      {!loaded && <div className="unified-card-skeleton absolute inset-0" aria-hidden />}
      {!failed && (
        <img
          key={`${src || CARD_BACK}-${attempt}`}
          src={displaySrc}
          alt={alt}
          className={className || 'w-full h-full object-cover'}
          style={{ ...(src ? {} : { opacity: 0.8 }), ...style }}
          loading={loading}
          onError={handleError}
          onLoad={() => setLoaded(true)}
        />
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-elevated p-3 text-center">
          {!compactError && (
            <>
              <span className="grid h-10 w-10 place-items-center rounded-full border border-brand-red/40 bg-brand-red/15 text-brand-red">
                <AlertTriangle size={18} aria-hidden />
              </span>
              <strong className="text-xs text-text-primary">{t('card.artworkUnavailable')}</strong>
              <span className="text-[10px] leading-tight text-text-muted">{t('card.artworkUnavailableHint')}</span>
            </>
          )}
          <button
            type="button"
            className={compactError
              ? 'grid h-full w-full place-items-center text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red'
              : 'btn-ghost mt-1 min-h-8 px-3 py-1.5 text-xs'}
            onClick={retry}
            aria-label={t('card.retryImage')}
            title={compactError ? t('card.retryImage') : undefined}
          >
            {compactError ? <AlertTriangle size={14} aria-hidden /> : <><RefreshCw size={13} aria-hidden />{t('common.retry')}</>}
          </button>
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
