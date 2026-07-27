import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, HelpCircle } from 'lucide-react'
import clsx from 'clsx'
import { getPublicBinder } from '../api/publicClient'
import { formatEur } from '../utils/formatEur'
import { groupCardsByPrint } from '../utils/groupCardsByPrint'
import { useSettings } from '../contexts/SettingsContext'
import CardStateIndicators, { CardStateLegend } from '../components/CardStateIndicators'
import { getCardVariantEffectClass } from '../utils/cardVariantEffect'

export default function PublicBinderView() {
  const { handle, binderId } = useParams()
  const [binder, setBinder] = useState(null)
  const [error, setError] = useState(null)
  const [badgeLegendOpen, setBadgeLegendOpen] = useState(false)
  const { t } = useSettings()

  useEffect(() => {
    let cancelled = false
    setBinder(null)
    setError(null)
    getPublicBinder(handle, binderId)
      .then(data => { if (!cancelled) setBinder(data) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [handle, binderId])

  if (error) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('publicProfiles.binderUnavailable')}</div>
  if (!binder) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('common.loading')}</div>

  const tiles = groupCardsByPrint(binder.cards)

  return (
    <main className="min-h-screen bg-bg-primary px-3 py-6 text-text-primary sm:px-4">
      <div className="mx-auto max-w-5xl">
        <Link to={`/u/${handle}`} className="btn-ghost inline-flex py-1.5 text-sm">
          <ArrowLeft size={14} /> {t('publicProfiles.backToProfile')}
        </Link>
        <div className="my-4 flex flex-wrap items-baseline justify-between gap-2 rounded-2xl border border-border bg-bg-secondary p-4 shadow-sm">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-text-muted">{t('publicProfiles.sharedBinder')}</p>
            <h1 className="text-2xl font-bold">{binder.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {binder.unique_card_count} {binder.unique_card_count === 1 ? t('binders.uniqueCard') : t('binders.uniqueCards')}
            </p>
          </div>
          {binder.total_value != null && (
            <span className="text-lg font-semibold">{formatEur(binder.total_value)}</span>
          )}
        </div>

        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => setBadgeLegendOpen(open => !open)}
            className={clsx(
              'btn-ghost px-3 py-2 text-sm',
              badgeLegendOpen && 'border-brand-red/30 bg-brand-red/10 text-brand-red'
            )}
            aria-expanded={badgeLegendOpen}
            aria-controls="public-card-badge-legend"
          >
            <HelpCircle size={15} />
            <span>{t('setDetail.badgeLegend')}</span>
          </button>
        </div>
        {badgeLegendOpen && (
          <div id="public-card-badge-legend" className="card mb-4 p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t('setDetail.badgeLegend')}
            </p>
            <CardStateLegend showOwnershipFallback={false} showWishlist={false} />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {tiles.map(tile => {
          // Depth follows distinct prints: 1 layer behind for 2 variants, 2 for 3+.
          const backLayers = Math.min(tile.variantCount - 1, 2)
          const layerOffset = 8
          return (
            <article key={tile.id} className="rounded-xl border border-border bg-bg-secondary p-2 shadow-sm">
              <div className="relative" style={{ marginRight: backLayers * layerOffset, marginBottom: backLayers * layerOffset }}>
                {Array.from({ length: backLayers }).map((_, idx) => {
                  const depth = idx + 1
                  return (
                    <div
                      key={idx}
                      aria-hidden
                      className="absolute inset-0 overflow-hidden rounded border border-border bg-bg-secondary shadow-sm"
                      style={{
                        transform: `translate(${depth * layerOffset}px, ${depth * layerOffset}px) rotate(${depth * 2}deg)`,
                        zIndex: backLayers - idx,
                      }}
                    >
                      {tile.image && (
                        <img src={tile.image} alt="" className="h-full w-full object-cover" loading="lazy" />
                      )}
                    </div>
                  )
                })}
                <div className={clsx(
                  'relative z-10 aspect-[5/7] overflow-hidden rounded bg-bg-secondary',
                  getCardVariantEffectClass(tile.prints)
                )}>
                  {tile.image
                    ? <img src={tile.image} alt={tile.name} className="w-full h-full object-cover" loading="lazy" />
                    : <div className="w-full h-full" />}
                  <CardStateIndicators
                    card={{ owned_variants: tile.prints }}
                    compact
                    showWishlist={false}
                    alwaysShowQuantity
                    className="absolute left-1 right-1 top-1 z-20"
                  />
                </div>
              </div>
              <div className="mt-1 text-sm font-medium truncate">{tile.name}</div>
              <div className="text-xs text-text-secondary">{tile.set_name} · #{tile.number}</div>
              {tile.total_value != null && (
                <div className="text-xs font-semibold">{formatEur(tile.total_value)}</div>
              )}
            </article>
          )
        })}
        </div>
      </div>
    </main>
  )
}
