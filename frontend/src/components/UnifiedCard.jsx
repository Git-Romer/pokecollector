import clsx from 'clsx'
import { Plus } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'
import { getCardVariantEffectClass } from '../utils/cardVariantEffect'
import CardImage from './CardImage'
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
  overlay,
  className = '',
  imageClassName = 'w-full h-full object-cover',
  loading = 'lazy',
}) {
  const { t } = useSettings()
  const kinds = getCardFallbackKinds(card)
  const label = fallbackAriaLabel(t, kinds)
  const handleKeyDown = (event) => {
    if (!interactive) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onClick?.(event)
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
        className,
      )}
      style={{
        '--card-frame-gradient': getFallbackBorderGradient(kinds),
        '--card-frame-hover-gradient': getFallbackBorderGradient(kinds, true),
      }}
      onClick={interactive ? onClick : undefined}
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
            className="absolute left-2 right-2 top-2 z-20"
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
        />
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

export function CardCaption({
  card,
  name = card?.name,
  setNumber = getCardSetNumber(card),
  price,
  languageLabel,
  custom = card?.is_custom,
  className = '',
}) {
  return (
    <div className={clsx('unified-card-caption', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        {name && <h3 className="truncate text-sm font-semibold text-text-primary">{name}</h3>}
        {custom && <span className="badge-yellow px-1.5 py-0.5 text-[9px]">Custom</span>}
        {languageLabel && <span className="badge-gray px-1.5 py-0.5 text-[9px]">{languageLabel}</span>}
      </div>
      {(setNumber || price) && (
        <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
          <span className="truncate font-mono text-[11px] font-bold text-brand-red">{setNumber}</span>
          {price && <span className="shrink-0 text-xs font-extrabold text-green">{price}</span>}
        </div>
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
  overlay,
  compact = false,
  className = '',
}) {
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
        overlay={overlay}
      />
      {!compact && (
        <CardCaption
          card={card}
          price={price}
          languageLabel={languageLabel}
        />
      )}
    </div>
  )
}
