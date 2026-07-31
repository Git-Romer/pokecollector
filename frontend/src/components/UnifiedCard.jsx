import clsx from 'clsx'
import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../contexts/SettingsContext'
import { getCardVariantEffectClass } from '../utils/cardVariantEffect'
import CardImage from './CardImage'
import FallbackBadges from './FallbackBadges'
import CardStateIndicators from './CardStateIndicators'

export const FALLBACK_KIND_ORDER = ['data', 'price', 'image']

const FALLBACK_COLORS = {
  data: {
    base: '#a56cff',
    hover: '#d391ff',
  },
  price: {
    base: '#f0aa38',
    hover: '#ffd16b',
  },
  image: {
    base: '#55a7ff',
    hover: '#86e3ff',
  },
}

const NORMAL_BORDER = {
  base: '#717a89',
  hover: '#c6ccd7',
}

export function getCardFallbackKinds(card = {}) {
  return FALLBACK_KIND_ORDER.filter((kind) => Boolean(card?.[`${kind}_source_lang`]))
}

export function getFallbackBorderGradient(kinds = [], hovered = false) {
  const color = (kind) => FALLBACK_COLORS[kind]?.[hovered ? 'hover' : 'base'] || NORMAL_BORDER[hovered ? 'hover' : 'base']
  const normalized = FALLBACK_KIND_ORDER.filter((kind) => kinds.includes(kind))

  if (normalized.length === 0) return NORMAL_BORDER[hovered ? 'hover' : 'base']
  if (normalized.length === 1) return color(normalized[0])
  if (normalized.length === 2) {
    const [first, second] = normalized
    return `conic-gradient(from 45deg, ${color(first)} 0 46%, ${color(second)} 54% 96%, ${color(first)} 100%)`
  }
  return `conic-gradient(from -90deg, ${color('data')} 0 30%, ${color('price')} 36% 63%, ${color('image')} 69% 96%, ${color('data')} 100%)`
}

export function getCardSetNumber(card = {}) {
  const setCode = card.set?.abbreviation
    || card.set_ref?.abbreviation
    || card.set_abbreviation
    || card.set?.id
    || card.set_ref?.id
    || card.set_id
    || ''
  const number = card.localId || card.number || ''
  return [String(setCode || '').toUpperCase(), number].filter(Boolean).join(' ')
}

export function withCollectionItemState(card = {}, item = {}) {
  const quantity = Math.max(0, Number(item.quantity) || 0)
  return {
    ...card,
    owned: quantity > 0,
    owned_quantity: quantity,
    owned_variants: quantity > 0
      ? [{ variant: item.variant || 'Normal', quantity }]
      : [],
  }
}

export function shouldDimUnownedCard(card = {}, dimWhenUnowned = false) {
  return Boolean(dimWhenUnowned && !card.owned && Number(card.owned_quantity || 0) <= 0)
}

function fallbackAriaLabel(t, kinds) {
  if (kinds.length === 0) return undefined
  const labels = kinds.map((kind) => {
    const key = `fallback.${kind}`
    const translated = t(key)
    return translated === key ? kind : translated
  })
  return labels.join(', ')
}

export function CardArtworkFrame({
  card,
  image,
  alt,
  variantEffectSource = card,
  interactive = false,
  onClick,
  onSelect,
  onAdd,
  selected = false,
  unavailableReason = '',
  showStateIndicators = true,
  stateIndicatorProps = {},
  dimmed = false,
  thumbnail = false,
  onLoadingChange,
  overlay,
  className = '',
  imageClassName = 'w-full h-full object-cover',
  loading = 'lazy',
}) {
  const { t } = useSettings()
  const kinds = getCardFallbackKinds(card)
  const label = fallbackAriaLabel(t, kinds)
  const handleKeyDown = (event) => {
    if (!interactive || unavailableReason) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (onClick) onClick(event)
      else onSelect?.(event)
    } else if (event.key === ' ' && onSelect) {
      event.preventDefault()
      onSelect(event)
    }
  }

  return (
    <div
      className={clsx(
        'unified-card-frame',
        interactive && 'unified-card-frame-interactive',
        unavailableReason && 'unified-card-frame-unavailable',
        thumbnail && 'unified-card-frame-thumbnail',
        className,
      )}
      style={{
        '--card-frame-gradient': getFallbackBorderGradient(kinds),
        '--card-frame-hover-gradient': getFallbackBorderGradient(kinds, true),
      }}
      onClick={interactive && !unavailableReason ? onClick : undefined}
      onKeyDown={handleKeyDown}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive && !unavailableReason ? 0 : undefined}
      aria-disabled={unavailableReason ? true : undefined}
      aria-label={[alt, label].filter(Boolean).join(' · ') || undefined}
      title={label}
    >
      <div className={clsx('unified-card-art', getCardVariantEffectClass(variantEffectSource))}>
        {showStateIndicators && (
          <CardStateIndicators
            card={card}
            compact
            className="absolute left-1 right-1 top-1 z-20 sm:left-2 sm:right-2 sm:top-2"
            {...stateIndicatorProps}
          />
        )}
        {selected && (
          <span className="unified-card-selection" aria-label={t('common.selected')}>
            ✓
          </span>
        )}
        <CardImage
          src={image}
          alt={alt}
          className={imageClassName}
          loading={loading}
          onLoadingChange={onLoadingChange}
          compactError={thumbnail}
        />
        {dimmed && <span className="unified-card-missing-overlay" aria-hidden />}
        {overlay}
        {onAdd && !unavailableReason && (
          <button
            type="button"
            className="unified-card-add"
            onClick={(event) => {
              event.stopPropagation()
              onAdd(event)
            }}
            aria-label={`${t('common.add')} ${alt || ''}`.trim()}
          >
            <Plus size={20} strokeWidth={2.5} aria-hidden />
          </button>
        )}
        {unavailableReason && (
          <span className="unified-card-unavailable-reason">{unavailableReason}</span>
        )}
      </div>
    </div>
  )
}

export function UnifiedCardDialog({
  card,
  image,
  variantEffectSource = card,
  price,
  tabs = [],
  activeTab,
  onTabChange,
  onClose,
  closeButtonRef,
  children,
  className = '',
}) {
  const { t } = useSettings()
  const internalCloseButtonRef = useRef(null)
  const resolvedCloseButtonRef = closeButtonRef || internalCloseButtonRef
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!card) return undefined
    const previousFocus = document.activeElement
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onCloseRef.current?.()
    }
    document.addEventListener('keydown', handleKeyDown)
    resolvedCloseButtonRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus?.()
    }
  }, [card?.id, resolvedCloseButtonRef])

  if (!card) return null

  const setNumber = getCardSetNumber(card)
  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={card.name}
        className={clsx(
          'relative max-h-[calc(100dvh-1.5rem)] w-full max-w-6xl overflow-y-auto rounded-2xl border border-white/10 bg-bg-surface shadow-2xl sm:max-h-[calc(100dvh-3rem)]',
          className,
        )}
        onClick={event => event.stopPropagation()}
      >
        <button
          ref={resolvedCloseButtonRef}
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-50 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/75 text-white shadow-lg transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          aria-label={t('common.close')}
        >
          <X size={18} aria-hidden />
        </button>

        <div className="grid gap-4 p-4 sm:grid-cols-[minmax(220px,300px)_minmax(0,1fr)] sm:gap-6 sm:p-6">
          <aside className="min-w-0 sm:border-r sm:border-white/8 sm:pr-6">
            <div className="flex items-start gap-4 sm:block">
              <div className="w-24 flex-shrink-0 sm:w-full">
                <CardArtworkFrame
                  card={card}
                  image={image}
                  alt={card.name}
                  variantEffectSource={variantEffectSource}
                  showStateIndicators={false}
                  loading="eager"
                />
              </div>
              <div className="min-w-0 flex-1 pr-9 sm:mt-4 sm:pr-0">
                <h2 className="break-words text-base font-black text-text-primary sm:text-xl">{card.name}</h2>
                {(setNumber || price) && (
                  <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs font-black text-brand-red">{setNumber}</span>
                    {price && <span className="shrink-0 text-sm font-black text-green">{price}</span>}
                  </div>
                )}
                {card.rarity && <p className="mt-1 text-xs text-text-muted">{card.rarity}</p>}
                <FallbackBadges card={card} className="mt-2" />
              </div>
            </div>
          </aside>

          <section className="min-w-0">
            {tabs.length > 0 && (
              <div
                className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1 pr-10"
                role="tablist"
                aria-label={card.name}
              >
                {tabs.map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.id}
                    onClick={() => onTabChange?.(tab.id)}
                    className={clsx(
                      'inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg px-3 py-2 text-center text-xs font-bold leading-tight transition-colors',
                      activeTab === tab.id
                        ? 'bg-brand-red text-white shadow-[0_0_14px_rgba(227,0,11,0.3)]'
                        : 'bg-bg-card text-text-secondary hover:bg-bg-elevated hover:text-text-primary',
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
            {children}
          </section>
        </div>
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}

export function CardCaption({
  card,
  name = card?.name,
  setNumber = getCardSetNumber(card),
  price,
  languageLabel,
  custom = card?.is_custom,
  loading = false,
  className = '',
}) {
  return (
    <div className={clsx('unified-card-caption', className)}>
      {loading ? (
        <>
          <div className="unified-card-caption-skeleton h-3 w-3/5 rounded" />
          <div className="unified-card-caption-skeleton mt-2 h-2 w-2/5 rounded" />
        </>
      ) : (
        <>
          <div className="flex h-5 min-w-0 items-center gap-1.5 overflow-hidden">
            {name && <h3 className="unified-card-caption-name" title={name}>{name}</h3>}
            {custom && <span className="badge-yellow shrink-0 px-1.5 py-0.5 text-[9px]">Custom</span>}
            {languageLabel && <span className="badge-gray shrink-0 px-1.5 py-0.5 text-[9px]">{languageLabel}</span>}
          </div>
          {(setNumber || price) && (
            <div className="mt-1 flex h-4 min-w-0 items-center justify-between gap-2 overflow-hidden">
              <span className="truncate font-mono text-[11px] font-bold text-brand-red">{setNumber}</span>
              {price && <span className="shrink-0 text-xs font-extrabold text-green">{price}</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default function UnifiedCard({
  card,
  image,
  price,
  languageLabel,
  variantEffectSource = card,
  onClick,
  onSelect,
  onAdd,
  interactive = Boolean(onClick || onSelect),
  selected = false,
  unavailableReason = '',
  showStateIndicators = true,
  stateIndicatorProps,
  dimWhenUnowned = false,
  overlay,
  compact = false,
  className = '',
}) {
  const [artworkLoading, setArtworkLoading] = useState(true)

  return (
    <div className={clsx('min-w-0', className)}>
      <CardArtworkFrame
        card={card}
        image={image}
        alt={card?.name}
        variantEffectSource={variantEffectSource}
        interactive={interactive}
        onClick={onClick}
        onSelect={onSelect}
        onAdd={onAdd}
        selected={selected}
        unavailableReason={unavailableReason}
        showStateIndicators={showStateIndicators}
        stateIndicatorProps={stateIndicatorProps}
        dimmed={shouldDimUnownedCard(card, dimWhenUnowned)}
        onLoadingChange={setArtworkLoading}
        overlay={overlay}
      />
      {!compact && (
        <CardCaption
          card={card}
          price={price}
          languageLabel={languageLabel}
          loading={artworkLoading}
        />
      )}
    </div>
  )
}
