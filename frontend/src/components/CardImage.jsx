/**
 * CardImage — renders a card image with automatic fallback to the Pokemon card back
 * when the image is missing or fails to load (e.g. API returns 404/JSON error).
 *
 * Usage: <CardImage src={url} alt={card.name} className="w-full h-full object-cover" />
 */
const CARD_BACK = '/cardback.jpg'

export default function CardImage({ src, alt, className, showName = false, style, loading = 'lazy' }) {
  const handleError = (e) => {
    e.currentTarget.onerror = null // prevent infinite loop
    e.currentTarget.src = CARD_BACK
    e.currentTarget.style.opacity = '0.8'
  }

  return (
    <div className="relative w-full h-full">
      <img
        src={src || CARD_BACK}
        alt={alt}
        className={className || 'w-full h-full object-cover'}
        style={{ ...(src ? {} : { opacity: 0.8 }), ...style }}
        loading={loading}
        onError={handleError}
      />
      {(!src || showName) && alt && (
        <div
          className="absolute bottom-0 left-0 right-0 px-1 pb-1 pt-3"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)' }}
        >
          <span className="text-[8px] text-white font-semibold leading-tight block text-center truncate">
            {alt}
          </span>
        </div>
      )}
    </div>
  )
}
