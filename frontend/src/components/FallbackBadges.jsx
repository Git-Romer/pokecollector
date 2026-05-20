import clsx from 'clsx'
import { useSettings } from '../contexts/SettingsContext'

const sourceLabel = (lang) => (lang ? lang.toUpperCase() : '')

export default function FallbackBadges({ card, className = '', compact = false }) {
  const { t } = useSettings()
  if (!card) return null
  const priceLang = card.price_source_lang
  const imageLang = card.image_source_lang
  const hasCustomImage = Boolean(card.custom_image_url) && !(card.images_small || card.images_large || card.images?.small || card.images?.large || card.image)
  if (!priceLang && !imageLang && !hasCustomImage) return null

  const baseClass = compact
    ? 'text-[9px] px-1 py-0.5 rounded leading-none'
    : 'text-[10px] px-1.5 py-0.5 rounded-full'

  return (
    <div className={clsx('flex flex-wrap gap-1', className)}>
      {priceLang && (
        <span
          className={clsx(baseClass, 'font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30')}
          title={t('fallback.priceFrom').replace('{lang}', sourceLabel(priceLang))}
        >
          {t('fallback.price')} {sourceLabel(priceLang)}
        </span>
      )}
      {imageLang && (
        <span
          className={clsx(baseClass, 'font-bold bg-sky-500/15 text-sky-300 border border-sky-500/30')}
          title={t('fallback.imageFrom').replace('{lang}', sourceLabel(imageLang))}
        >
          🖼 {sourceLabel(imageLang)}
        </span>
      )}
      {hasCustomImage && (
        <span
          className={clsx(baseClass, 'font-bold bg-violet-500/15 text-violet-300 border border-violet-500/30')}
          title={t('fallback.customImageDesc')}
        >
          🖼 {t('fallback.customImage')}
        </span>
      )}
    </div>
  )
}
