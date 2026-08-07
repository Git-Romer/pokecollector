import clsx from 'clsx'
import { useSettings } from '../contexts/SettingsContext'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'

const sourceLabel = (lang) => (lang ? tcgdexLanguageLabel(lang) : '')

export default function FallbackBadges({ card, className = '', compact = false, variant = 'default' }) {
  const { t } = useSettings()
  if (!card) return null
  const dataLang = card.data_source_lang
  const priceLang = card.price_source_lang
  const imageLang = card.image_source_lang
  const hasCustomImage = Boolean(card.custom_image_url) && !(card.images_small || card.images_large || card.images?.small || card.images?.large || card.image)
  if (!dataLang && !priceLang && !imageLang && !hasCustomImage) return null

  const overlay = variant === 'overlay'
  const baseClass = compact
    ? 'inline-flex min-h-[16px] items-center justify-center rounded px-1.5 py-0.5 text-[9px] leading-none'
    : 'inline-flex min-h-[18px] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] leading-none'
  const badgeClass = (tone) => clsx(
    baseClass,
    'font-bold whitespace-nowrap',
    overlay && 'shadow-[0_1px_3px_rgba(0,0,0,0.85)] backdrop-blur-sm',
    tone === 'data' && (overlay
      ? 'bg-purple-950/95 text-purple-50 border border-purple-200/80'
      : 'bg-purple-500/15 text-purple-300 border border-purple-500/30'),
    tone === 'price' && (overlay
      ? 'bg-amber-950/95 text-amber-50 border border-amber-200/80'
      : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'),
    tone === 'image' && (overlay
      ? 'bg-sky-950/95 text-sky-50 border border-sky-200/80'
      : 'bg-sky-500/15 text-sky-300 border border-sky-500/30'),
    tone === 'customImage' && (overlay
      ? 'bg-violet-950/95 text-violet-50 border border-violet-200/80'
      : 'bg-violet-500/15 text-violet-300 border border-violet-500/30'),
  )

  return (
    <div className={clsx('flex flex-wrap items-center gap-1', className)}>
      {dataLang && (
        <span
          className={badgeClass('data')}
          title={t('fallback.dataFrom').replace('{lang}', sourceLabel(dataLang))}
        >
          {t('fallback.data')} {sourceLabel(dataLang)}
        </span>
      )}
      {priceLang && (
        <span
          className={badgeClass('price')}
          title={t('fallback.priceFrom').replace('{lang}', sourceLabel(priceLang))}
        >
          {t('fallback.price')} {sourceLabel(priceLang)}
        </span>
      )}
      {imageLang && (
        <span
          className={badgeClass('image')}
          title={t('fallback.imageFrom').replace('{lang}', sourceLabel(imageLang))}
        >
          {t('fallback.image')} {sourceLabel(imageLang)}
        </span>
      )}
      {hasCustomImage && (
        <span
          className={badgeClass('customImage')}
          title={t('fallback.customImageDesc')}
        >
          🖼 {t('fallback.customImage')}
        </span>
      )}
    </div>
  )
}
