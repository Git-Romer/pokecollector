import clsx from 'clsx'
import { Check, Circle, Heart, Medal, Sparkles, SquareAsterisk } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'
import { getCardOwnedVariants, hasGenericOwnership, VARIANT_PILL_META } from '../utils/cardVariants'

const VARIANT_ICONS = { Normal: Circle, Holo: Sparkles, 'Reverse Holo': SquareAsterisk, 'First Edition': Medal }

export const getCardState = (card = {}, showOwnership = true, showWishlist = true) => {
  const variants = showOwnership ? getCardOwnedVariants(card) : []
  return {
    variants,
    genericOwned: showOwnership && variants.length === 0 && hasGenericOwnership(card),
    wishlisted: showWishlist && (card.wishlisted === true || Number(card.wishlist_count || 0) > 0),
  }
}

/** Reusable, non-positioned ownership and wishlist indicators for card art. */
export default function CardStateIndicators({ card, compact = false, showOwnership = true, showWishlist = true, className = '' }) {
  const { t } = useSettings()
  const { variants, genericOwned, wishlisted } = getCardState(card, showOwnership, showWishlist)
  if (!variants.length && !genericOwned && !wishlisted) return null

  return <div className={clsx('pointer-events-none flex items-start justify-between gap-1', className)}>
    <div className="flex flex-wrap items-start gap-1">
      {variants.map(({ variant, quantity }) => {
        const Icon = VARIANT_ICONS[variant]
        const meta = VARIANT_PILL_META[variant]
        const key = `variants.${variant}`
        const translated = t(key)
        const label = translated === key ? variant : translated
        const title = quantity > 1 ? `${label} ×${quantity}` : label
        return <span key={variant} title={title} aria-label={title} className={clsx('inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] font-bold leading-none shadow-sm', meta?.className || 'bg-zinc-700 text-white border-zinc-500')}>
          {Icon ? <Icon size={compact ? 10 : 11} strokeWidth={2.5} aria-hidden /> : (meta?.code || variant.slice(0, 3).toUpperCase())}
          {quantity > 1 && <span>×{quantity}</span>}
        </span>
      })}
      {genericOwned && <span title={t('pokedex.owned')} aria-label={t('pokedex.owned')} className="inline-flex items-center rounded-full border border-green/40 bg-green/90 p-1 text-white shadow-lg"><Check size={compact ? 10 : 11} strokeWidth={3} aria-hidden /></span>}
    </div>
    {wishlisted && <span title={t('nav.wishlist')} aria-label={t('nav.wishlist')} className="inline-flex shrink-0 items-center rounded-full border border-pink-400/40 bg-pink-500/90 p-1 text-white shadow-lg"><Heart size={compact ? 10 : 11} fill="currentColor" aria-hidden /></span>}
  </div>
}
