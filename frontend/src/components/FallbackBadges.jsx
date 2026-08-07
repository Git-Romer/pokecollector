import clsx from 'clsx'
import { Flag } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'

const sourceLabel = (lang) => (lang ? tcgdexLanguageLabel(lang) : '')

export default function FallbackBadges({ card, className = '', compact = false, variant = 'default' }) {
  const { t } = useSettings()
  if (!card) return null
  const dataLang = card.data_source_lang
  const priceLang = card.price_source_lang
  const imageLang = card.image_source_lang
  if (!dataLang && !priceLang && !imageLang) return null

  const fallbackDescriptions = [
    dataLang && t('fallback.dataFrom').replace('{lang}', sourceLabel(dataLang)),
    priceLang && t('fallback.priceFrom').replace('{lang}', sourceLabel(priceLang)),
    imageLang && t('fallback.imageFrom').replace('{lang}', sourceLabel(imageLang)),
    hasCustomImage && t('fallback.customImageDesc'),
  ].filter(Boolean)

  if (compact) {
    const description = fallbackDescriptions.join(' · ')
    return (
      <span
        className={clsx('group/fallback relative inline-flex flex-shrink-0', className)}
        tabIndex={0}
        aria-label={description}
      >
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-300">
          <Flag size={10} strokeWidth={2.5} aria-hidden="true" />
        </span>
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full right-0 z-30 mb-2 hidden w-max max-w-56 rounded-lg border border-border bg-bg-elevated px-2.5 py-2 text-left text-[10px] font-medium leading-relaxed text-text-secondary shadow-xl group-hover/fallback:block group-focus/fallback:block"
        >
          {fallbackDescriptions.map((item) => <span key={item} className="block">{item}</span>)}
        </span>
      </span>
    )
  }

  const overlay = variant === 'overlay'
  const baseClass = 'inline-flex min-h-[18px] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] leading-none'
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
  )
  const dotClass = (tone) => clsx(
    'mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full',
    tone === 'data' && 'bg-purple-300',
    tone === 'price' && 'bg-amber-300',
    tone === 'image' && 'bg-sky-300',
  )

  return (
    <div className={clsx('flex flex-wrap items-center gap-1', className)}>
      {dataLang && (
        <span
          className={badgeClass('data')}
          title={t('fallback.dataFrom').replace('{lang}', sourceLabel(dataLang))}
        >
          <span className={dotClass('data')} aria-hidden />
          {t('fallback.data')} {sourceLabel(dataLang)}
        </span>
      )}
      {priceLang && (
        <span
          className={badgeClass('price')}
          title={t('fallback.priceFrom').replace('{lang}', sourceLabel(priceLang))}
        >
          <span className={dotClass('price')} aria-hidden />
          {t('fallback.price')} {sourceLabel(priceLang)}
        </span>
      )}
      {imageLang && (
        <span
          className={badgeClass('image')}
          title={t('fallback.imageFrom').replace('{lang}', sourceLabel(imageLang))}
        >
          <span className={dotClass('image')} aria-hidden />
          {t('fallback.image')} {sourceLabel(imageLang)}
        </span>
      )}
    </div>
  )
}
