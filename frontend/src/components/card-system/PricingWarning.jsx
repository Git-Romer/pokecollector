import { lazy, Suspense, useContext, useState } from 'react'
import { QueryClientContext, useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { getPricingWarnings } from '../../api/client'
import { useSettings } from '../../contexts/SettingsContext'
import { getEffectiveCardPriceDetails } from '../../utils/prices'
import { createPricingWarningBatcher } from '../../utils/pricingWarningBatcher'
import { isPublicSharePath } from '../../utils/publicRoutes'

const PricingWarningDialog = lazy(() => import('./PricingWarningDialog'))
const batchers = new WeakMap()
const cardId = card => card?.card_id || card?.id
export const pricingWarningQueryKey = card => ['cards', 'pricing-warnings', cardId(card), JSON.stringify(card?.cardmarket_products || [])]

function QueriedWarnings({ card, client, children }) {
  if (!batchers.has(client)) batchers.set(client, createPricingWarningBatcher(getPricingWarnings))
  const { data = [] } = useQuery({
    queryKey: pricingWarningQueryKey(card),
    queryFn: () => batchers.get(client)(cardId(card)),
    staleTime: 60 * 1000,
    retry: false,
  })
  return children(data)
}

function Warnings({ card, children }) {
  const client = useContext(QueryClientContext)
  // Public shares must not accidentally call an authenticated endpoint. They
  // carry only the data explicitly supplied by their existing public API.
  const canQuery = client && !card?.is_custom && typeof cardId(card) === 'string'
    && cardId(card).length > 0 && card?.cardmarket_products?.length > 0
    && !(typeof window !== 'undefined' && isPublicSharePath(window.location.pathname))
  return canQuery ? <QueriedWarnings card={card} client={client}>{children}</QueriedWarnings> : children([])
}

function WarningPrice({ card, value, variant, interactive, warnings }) {
  const { t, pricePrimaryField } = useSettings()
  const [open, setOpen] = useState(false)
  if (!warnings.length || getEffectiveCardPriceDetails(card, variant, pricePrimaryField).source === 'tcgplayer') return value
  const title = t('pricingWarning.title')
  const content = <><AlertTriangle size={14} className="shrink-0 text-yellow" aria-hidden /><span>{value}</span></>
  return (
    <>
      {interactive ? (
        <button
          type="button"
          data-pricing-warning
          aria-label={`${title}: ${card.name} ${card.number || ''}`}
          aria-haspopup="dialog"
          title={title}
          className="-my-1 inline-flex min-h-6 items-center gap-1 rounded focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-yellow"
          onClick={event => { event.stopPropagation(); setOpen(true) }}
        >{content}</button>
      ) : <span data-pricing-warning className="inline-flex items-center gap-1" title={title}><AlertTriangle size={14} className="text-yellow" aria-label={title} /><span>{value}</span></span>}
      {open && <Suspense fallback={null}><PricingWarningDialog card={card} variant={variant} onClose={() => setOpen(false)} /></Suspense>}
    </>
  )
}

export function PricingWarningPrice({ card, value, variant = 'Normal', interactive = true }) {
  return <Warnings card={card}>{warnings => <WarningPrice card={card} value={value} variant={variant} interactive={interactive} warnings={warnings} />}</Warnings>
}

function WarningDetails({ warnings }) {
  const { t } = useSettings()
  if (!warnings.length) return null
  return (
    <section data-pricing-warning-details className="rounded-xl border border-yellow/30 bg-yellow/5 p-3 sm:p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-yellow"><AlertTriangle size={18} className="shrink-0" aria-hidden />{t('pricingWarning.title')}</h3>
      <p className="text-xs leading-relaxed text-text-secondary">{t('pricingWarning.explanation')}</p>
      {warnings.map(warning => (
        <div key={warning.product_id} className="mt-3 rounded-lg border border-yellow/15 bg-bg-surface/60 p-3">
          <p className="mb-2 text-[11px] text-text-secondary">{t('pricingWarning.sharedProduct').replace('{productId}', String(warning.product_id))}</p>
          <ul className="space-y-2">
            {warning.other_cards.map(other => (
              <li key={other.id} className="flex items-start justify-between gap-3 text-xs">
                <span className="min-w-0 break-words text-text-primary">{other.name}{other.rarity ? ` · ${other.rarity}` : ''}</span>
                <strong className="shrink-0 font-mono text-yellow">{other.number}</strong>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="mt-3 text-xs leading-relaxed text-text-secondary">{t('pricingWarning.caution')}</p>
    </section>
  )
}

// Resolve catalogue hints with the tile, not with image-load timing.
export function PricingWarningPrefetch({ card }) {
  return <Warnings card={card}>{() => null}</Warnings>
}

export function PricingWarningDetails({ card }) {
  return <Warnings card={card}>{warnings => <WarningDetails warnings={warnings} />}</Warnings>
}
